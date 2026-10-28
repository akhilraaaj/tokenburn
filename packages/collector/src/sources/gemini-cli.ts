// Gemini CLI (google-gemini/gemini-cli): <GEMINI_CLI_HOME or ~>/.gemini/tmp/<project>/chats/**/*.jsonl
// (legacy: one session-*.json ConversationRecord). Verified against chatRecordingService.ts @cd1b45c.
// JSONL: first line is a header with sessionId; message records ({id, timestamp, type, model?, tokens?})
// are re-appended in full whenever they change, so the latest record per id wins.
// tokens = {input (includes cached), output, cached, thoughts, tool, total}; thoughts are separate from output.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BillingMode, UsageRecord } from '../../../shared/src/index.ts';
import { readNewLines } from '../lines.ts';
import { existingDirs, listFiles } from '../paths.ts';
import type { Store } from '../store.ts';
import { nonNeg } from './sqlite.ts';
import type { LocalSource, ScanStats, SourceContext } from './types.ts';

export function geminiMessageToRecord(sessionId: string | null, m: any, billing: BillingMode): UsageRecord | null {
  if (!m || m.type !== 'gemini' || typeof m.id !== 'string' || !m.tokens || typeof m.tokens !== 'object') return null;
  const t = m.tokens;
  const input = nonNeg(t.input), output = nonNeg(t.output), cached = nonNeg(t.cached), thoughts = nonNeg(t.thoughts);
  if (!input && !output && !thoughts) return null;
  const ts = typeof m.timestamp === 'string' && !Number.isNaN(Date.parse(m.timestamp)) ? new Date(m.timestamp).toISOString() : null;
  if (!ts) return null;
  const cachedPart = input !== null && cached !== null ? Math.min(cached, input) : null;
  return {
    provider: 'gemini_cli',
    model_id: typeof m.model === 'string' && m.model ? m.model : 'unknown',
    occurred_at: ts,
    session_id: sessionId,
    input_tokens: input === null ? null : input - (cachedPart ?? 0),
    output_tokens: output === null ? null : output + (thoughts ?? 0),
    cache_read_tokens: cachedPart,
    cache_write_tokens: null,
    usage_source: 'gemini_cli_jsonl',
    measurement_type: 'measured',
    billing_mode: billing,
    dedupe_key: `gem:${sessionId ?? 'nosession'}:${m.id}`,
    event_count: 1,
    synced_at: null,
    provider_fields: { reasoning_tokens: thoughts },
  };
}

function chatRoots(ctx: SourceContext): string[] {
  const base = process.env.GEMINI_CLI_HOME || os.homedir();
  const geminiDirs = existingDirs([...(ctx.extraDirs.gemini_cli ?? []), path.join(base, '.gemini'), path.join(os.homedir(), '.cache', '.gemini')]);
  return geminiDirs.flatMap((g) => {
    const tmp = path.join(g, 'tmp');
    try {
      return existingDirs(fs.readdirSync(tmp).map((p) => path.join(tmp, p, 'chats')));
    } catch {
      return [];
    }
  });
}

export function scanGeminiCli(store: Store, ctx: SourceContext): ScanStats {
  const billing = geminiCliSource.billing(ctx).mode;
  const roots = chatRoots(ctx);
  const jsonl = roots.flatMap((r) => listFiles(r, '.jsonl'));
  const legacy = roots.flatMap((r) => listFiles(r, '.json'));
  const stats: ScanStats = { roots, files: jsonl.length + legacy.length, filesRead: 0, bytesRead: 0, usageRows: 0, changedEvents: 0, malformedLines: 0 };
  const take = (rec: UsageRecord | null) => {
    if (!rec) return;
    stats.usageRows++;
    if (store.replaceEvent(rec)) stats.changedEvents++;
  };

  for (const file of jsonl) {
    const snapKey = `gemini:session:${file}`;
    const res = readNewLines(store, file, (lines, fileState) => {
      let session = fileState.offset > 0 ? store.getSnapshot<string>(snapKey) ?? null : null;
      for (const line of lines) {
        if (!line.trim()) continue;
        let o: any;
        try {
          o = JSON.parse(line);
        } catch {
          fileState.malformed_lines++;
          continue;
        }
        if (typeof o?.sessionId === 'string' && o.type === undefined) session = o.sessionId; // header
        else take(geminiMessageToRecord(session, o, billing));
      }
      if (session) store.setSnapshot(snapKey, session);
    });
    if (res.read) stats.filesRead++;
    stats.bytesRead += res.bytes;
  }

  for (const file of legacy) {
    let st: fs.Stats;
    try { st = fs.statSync(file); } catch { continue; } // deleted since listing
    const prev = store.importedFile(file);
    if (prev && prev.size === st.size && prev.mtime_ms === Math.floor(st.mtimeMs)) continue;
    try {
      const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
      const session = typeof rec.sessionId === 'string' ? rec.sessionId : null;
      store.transaction(() => (Array.isArray(rec.messages) ? rec.messages : []).forEach((m: unknown) => take(geminiMessageToRecord(session, m, billing))));
      stats.filesRead++;
    } catch {
      stats.malformedLines++;
    }
    store.markImportedFile(file, st.size, st.mtimeMs, 'ok');
  }
  stats.malformedLines += store.malformedLines(roots);
  store.setMeta('gemini_cli_jsonl_last_scan_at', new Date().toISOString());
  return stats;
}

export const geminiCliSource: LocalSource = {
  usageSource: 'gemini_cli_jsonl',
  provider: 'gemini_cli',
  label: 'Gemini CLI',
  roots: (ctx) => chatRoots(ctx),
  billing: (ctx) => (ctx.billingOverrides.gemini_cli ? { mode: ctx.billingOverrides.gemini_cli, basis: 'set by you (config)' } : { mode: 'unknown', basis: 'not recorded in Gemini CLI chat files' }),
  scan: (store, ctx) => scanGeminiCli(store, ctx),
  watchExtensions: ['.jsonl', '.json'],
};
