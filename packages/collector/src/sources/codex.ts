// Codex CLI (openai/codex): $CODEX_HOME (default ~/.codex) sessions/YYYY/MM/DD/rollout-*.jsonl and
// archived_sessions/. Verified against codex-rs/protocol/src/protocol.rs @970111f.
//
// Each line is {timestamp, type, payload}. The model comes from the latest `turn_context`. Usage
// comes from `event_msg` payloads of type `token_count`: info.last_token_usage is one response,
// info.total_token_usage is a running sum. token_count events repeat (rate-limit refreshes) and
// can carry synthetic totals (compaction), so we count `last` only when `total` moved by exactly `last`.
// input_tokens includes cached tokens; reasoning_output_tokens is a subset of output_tokens.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { BillingMode, UsageRecord } from '../../../shared/src/index.ts';
import { readNewLines } from '../lines.ts';
import { existingDirs, listFiles } from '../paths.ts';
import type { Store } from '../store.ts';
import { nonNeg, shortHash } from './sqlite.ts';
import type { LocalSource, ScanStats, SourceContext } from './types.ts';

interface CodexUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens?: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

export interface CodexFileState {
  model: string | null;
  session: string | null;
  prevTotal: CodexUsage | null;
}

export type CodexLineResult = { kind: 'usage'; record: UsageRecord } | { kind: 'skip' } | { kind: 'malformed' };

const sameUsage = (a: CodexUsage | null, b: CodexUsage) =>
  !!a && a.input_tokens === b.input_tokens && a.output_tokens === b.output_tokens && a.cached_input_tokens === b.cached_input_tokens &&
  a.total_tokens === b.total_tokens;

function asUsage(u: any): CodexUsage | null {
  if (!u || typeof u !== 'object') return null;
  const input = nonNeg(u.input_tokens), output = nonNeg(u.output_tokens), total = nonNeg(u.total_tokens);
  if (input === null || output === null || total === null) return null;
  return {
    input_tokens: input, output_tokens: output, total_tokens: total,
    cached_input_tokens: nonNeg(u.cached_input_tokens) ?? 0,
    cache_write_input_tokens: nonNeg(u.cache_write_input_tokens) ?? 0,
    reasoning_output_tokens: nonNeg(u.reasoning_output_tokens) ?? 0,
  };
}

/** Advances `state` with one rollout line; returns a usage record for a newly completed response. */
export function processCodexLine(line: string, state: CodexFileState, billing: BillingMode): CodexLineResult {
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    return { kind: 'malformed' };
  }
  if (!o || typeof o !== 'object' || typeof o.type !== 'string') return { kind: 'malformed' };
  const p = o.payload ?? {};
  if (o.type === 'session_meta') {
    state.session = typeof p.id === 'string' ? p.id : typeof p.session_id === 'string' ? p.session_id : state.session;
    return { kind: 'skip' };
  }
  if (o.type === 'turn_context') {
    if (typeof p.model === 'string' && p.model) state.model = p.model;
    return { kind: 'skip' };
  }
  if (o.type !== 'event_msg' || p.type !== 'token_count' || !p.info) return { kind: 'skip' };

  const total = asUsage(p.info.total_token_usage);
  const last = asUsage(p.info.last_token_usage);
  if (!total || !last) return { kind: 'malformed' };
  if (sameUsage(state.prevTotal, total)) return { kind: 'skip' }; // repeated event, no new response
  const prev = state.prevTotal;
  state.prevTotal = total;
  // With no earlier event in this file (new file, or a fork that inherited the parent's total), trust `last`.
  const consistent = prev ? total.total_tokens - prev.total_tokens === last.total_tokens : true;
  if (!consistent || last.total_tokens === 0) return { kind: 'skip' }; // synthetic/compaction total
  const ts = typeof o.timestamp === 'string' && !Number.isNaN(Date.parse(o.timestamp)) ? new Date(o.timestamp).toISOString() : null;
  if (!ts) return { kind: 'malformed' };

  const cached = Math.min(last.cached_input_tokens, last.input_tokens);
  const model = state.model ?? 'unknown';
  return {
    kind: 'usage',
    record: {
      provider: 'codex',
      model_id: model,
      occurred_at: ts,
      session_id: state.session,
      input_tokens: last.input_tokens - cached,
      output_tokens: last.output_tokens,
      cache_read_tokens: cached,
      cache_write_tokens: last.cache_write_input_tokens ?? null,
      usage_source: 'codex_jsonl',
      measurement_type: 'measured',
      billing_mode: billing,
      // Forked threads copy the parent's events into a new file; the running total + delta identify
      // a response independently of which file it appears in.
      dedupe_key: `codex:${shortHash(JSON.stringify([model, total, last]))}`,
      event_count: 1,
      synced_at: null,
      provider_fields: { reasoning_tokens: last.reasoning_output_tokens },
    },
  };
}

function codexHomes(ctx: SourceContext): string[] {
  return existingDirs([...(ctx.extraDirs.codex ?? []), ...(process.env.CODEX_HOME ? [process.env.CODEX_HOME] : []), path.join(os.homedir(), '.codex')]);
}

function codexFiles(ctx: SourceContext) {
  const roots = codexHomes(ctx).flatMap((h) => existingDirs([path.join(h, 'sessions'), path.join(h, 'archived_sessions')]));
  return { roots, jsonl: roots.flatMap((r) => listFiles(r, '.jsonl')), zst: roots.flatMap((r) => listFiles(r, '.jsonl.zst')) };
}

export function scanCodex(store: Store, ctx: SourceContext, onlyFiles?: string[]): ScanStats {
  const { roots, jsonl, zst } = codexFiles(ctx);
  const billing = codexSource.billing(ctx).mode;
  const files = onlyFiles ?? jsonl;
  const stats: ScanStats = { roots, files: jsonl.length + zst.length, filesRead: 0, bytesRead: 0, usageRows: 0, changedEvents: 0, malformedLines: 0 };
  const handle = (lines: string[], state: CodexFileState, onMalformed: () => void) => {
    for (const line of lines) {
      if (!line.trim()) continue;
      const r = processCodexLine(line, state, billing);
      if (r.kind === 'malformed') onMalformed();
      else if (r.kind === 'usage') {
        stats.usageRows++;
        if (store.insertIfNew(r.record)) stats.changedEvents++;
      }
    }
  };
  for (const file of files) {
    const snapKey = `codex:file:${file}`;
    const res = readNewLines(store, file, (lines, fileState) => {
      // A re-read from offset 0 (rewritten file) must start from a clean parser state.
      const state = (fileState.offset > 0 && store.getSnapshot<CodexFileState>(snapKey)) || { model: null, session: null, prevTotal: null };
      handle(lines, state, () => fileState.malformed_lines++);
      store.setSnapshot(snapKey, state);
    });
    if (res.read) stats.filesRead++;
    stats.bytesRead += res.bytes;
  }
  // Compressed archives (opt-in Codex feature) are read whole, once per size/mtime.
  if (!onlyFiles) {
    for (const file of zst) {
      const st = fs.statSync(file);
      const prev = store.importedFile(file);
      if (prev && prev.size === st.size && prev.mtime_ms === Math.floor(st.mtimeMs)) continue;
      let text: string;
      try {
        text = (zlib as any).zstdDecompressSync(fs.readFileSync(file)).toString('utf8');
      } catch {
        store.markImportedFile(file, st.size, st.mtimeMs, 'zstd decode failed');
        continue;
      }
      const lines = text.slice(0, text.lastIndexOf('\n') + 1).split('\n');
      store.transaction(() => handle(lines, { model: null, session: null, prevTotal: null }, () => stats.malformedLines++));
      store.markImportedFile(file, st.size, st.mtimeMs, 'ok');
      stats.filesRead++;
    }
  }
  stats.malformedLines += store.malformedLines(roots);
  store.setMeta('codex_jsonl_last_scan_at', new Date().toISOString());
  return stats;
}

export const codexSource: LocalSource = {
  usageSource: 'codex_jsonl',
  provider: 'codex',
  label: 'Codex CLI',
  roots: (ctx) => codexFiles(ctx).roots,
  billing: (ctx) => (ctx.billingOverrides.codex ? { mode: ctx.billingOverrides.codex, basis: 'set by you (config)' } : { mode: 'unknown', basis: 'not recorded in Codex session files' }),
  scan: (store, ctx, onlyFiles) => scanCodex(store, ctx, onlyFiles?.filter((f) => f.endsWith('.jsonl'))),
  watchExtensions: ['.jsonl'],
};
