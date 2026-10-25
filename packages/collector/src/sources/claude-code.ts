// Claude Code: incremental collection from local transcript JSONL files.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseClaudeCodeLine, type BillingMode } from '../../../shared/src/index.ts';
import { readNewLines } from '../lines.ts';
import { listFiles, existingDirs } from '../paths.ts';
import type { Store } from '../store.ts';
import type { LocalSource, ScanStats, SourceContext } from './types.ts';

/** `$CLAUDE_CONFIG_DIR/projects` (comma-separated allowed), ~/.claude/projects, ~/.config/claude/projects, plus extras. */
export function claudeProjectRoots(extra: string[] = []): string[] {
  return existingDirs([
    ...extra.map((d) => (path.basename(d) === 'projects' ? d : path.join(d, 'projects'))),
    ...(process.env.CLAUDE_CONFIG_DIR ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((d) => path.join(d, 'projects')),
    path.join(os.homedir(), '.claude', 'projects'),
    path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'claude', 'projects'),
  ]);
}

/**
 * Billing mode from the local account config, reading only `oauthAccount.billingType` from
 * ~/.claude.json and whether ANTHROPIC_API_KEY is set (never its value).
 */
export function detectClaudeBillingMode(): { mode: BillingMode; basis: string } {
  if (process.env.ANTHROPIC_API_KEY) return { mode: 'api', basis: 'ANTHROPIC_API_KEY is set' };
  const candidates = [
    ...(process.env.CLAUDE_CONFIG_DIR ?? '').split(',').filter(Boolean).map((d) => path.join(d.trim(), '.claude.json')),
    path.join(os.homedir(), '.claude.json'),
  ];
  for (const file of candidates) {
    let billingType: unknown;
    try {
      billingType = JSON.parse(fs.readFileSync(file, 'utf8'))?.oauthAccount?.billingType;
    } catch {
      continue;
    }
    if (typeof billingType === 'string' && billingType.includes('subscription')) {
      return { mode: 'subscription', basis: `oauthAccount.billingType=${billingType}` };
    }
    if (typeof billingType === 'string') return { mode: 'unknown', basis: `unrecognized billingType=${billingType}` };
  }
  return { mode: 'unknown', basis: 'no account billing info found' };
}

export function scanClaudeCode(store: Store, billingMode: BillingMode, extraDirs: string[] = [], onlyFiles?: string[]): ScanStats {
  const roots = claudeProjectRoots(extraDirs);
  const files = onlyFiles ?? roots.flatMap((r) => listFiles(r, '.jsonl'));
  const stats: ScanStats = { roots, files: files.length, filesRead: 0, bytesRead: 0, usageRows: 0, changedEvents: 0, malformedLines: 0 };
  for (const file of files) {
    const r = readNewLines(store, file, (lines, state) => {
      for (const line of lines) {
        if (!line.trim()) continue;
        const res = parseClaudeCodeLine(line, billingMode);
        if (res.kind === 'malformed') state.malformed_lines++;
        else if (res.kind === 'usage') {
          state.usage_rows++;
          stats.usageRows++;
          if (store.upsertMerged(res.record)) stats.changedEvents++;
        }
      }
    });
    if (r.read) stats.filesRead++;
    stats.bytesRead += r.bytes;
  }
  stats.malformedLines = store.malformedLines(roots);
  store.setMeta('claude_code_jsonl_last_scan_at', new Date().toISOString());
  return stats;
}

export const claudeCodeSource: LocalSource = {
  usageSource: 'claude_code_jsonl',
  provider: 'claude_code',
  label: 'Claude Code',
  roots: (ctx: SourceContext) => claudeProjectRoots(ctx.extraDirs.claude_code ?? []),
  billing: (ctx) => (ctx.billingOverrides.claude_code ? { mode: ctx.billingOverrides.claude_code, basis: 'set by you (config)' } : detectClaudeBillingMode()),
  scan: (store, ctx, onlyFiles) => scanClaudeCode(store, claudeCodeSource.billing(ctx).mode, ctx.extraDirs.claude_code ?? [], onlyFiles),
  watchExtensions: ['.jsonl'],
};
