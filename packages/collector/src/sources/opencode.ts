// OpenCode (sst/opencode): $XDG_DATA_HOME/opencode (default ~/.local/share/opencode).
// Three layouts, verified against packages/schema + packages/core @b79dce4 (v2.1.4), v1.19.4 and v1.1.65:
//   v2  opencode*.db  table session_message(id, session_id, type, time_updated, data JSON) — data.model.id, data.tokens
//   v1  opencode*.db  table message(id, session_id, time_updated, data JSON)               — data.modelID, data.tokens
//   old storage/message/<session>/<msg>.json                                               — same fields as v1 plus id/sessionID
// tokens = {input, output, reasoning, cache:{read, write}}; input excludes cache, output excludes reasoning.
// The same message id can exist in several layouts after migrations, so records are keyed by message id.
// Only the message tables are read; the database also holds credentials, which are never queried.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isoFromMs, type BillingMode, type UsageRecord } from '../../../shared/src/index.ts';
import { existingDirs, listFiles } from '../paths.ts';
import type { Store } from '../store.ts';
import { columns, hasTable, nonNeg, openReadOnly } from './sqlite.ts';
import type { LocalSource, ScanStats, SourceContext } from './types.ts';

/** Normalizes an assistant message's JSON (v1 or v2 shape) into a record, or null if it has no usage. */
export function openCodeMessageToRecord(id: string, sessionId: string | null, data: any, billing: BillingMode): UsageRecord | null {
  if (!data || typeof data !== 'object') return null;
  if (data.role !== undefined && data.role !== 'assistant') return null;
  const t = data.tokens;
  if (!t || typeof t !== 'object') return null; // in-flight or failed
  const model = typeof data.model?.id === 'string' ? data.model.id : typeof data.modelID === 'string' ? data.modelID : null;
  const providerID = typeof data.model?.providerID === 'string' ? data.model.providerID : typeof data.providerID === 'string' ? data.providerID : null;
  const created = typeof data.time?.created === 'number' ? data.time.created : null;
  const occurred = created === null ? null : isoFromMs(created);
  if (!model || occurred === null) return null; // a garbled time is malformed, not a crash
  const input = nonNeg(t.input), output = nonNeg(t.output), reasoning = nonNeg(t.reasoning);
  const cacheRead = nonNeg(t.cache?.read), cacheWrite = nonNeg(t.cache?.write);
  if (!input && !output && !reasoning && !cacheRead && !cacheWrite) return null;
  return {
    provider: 'opencode',
    model_id: model,
    occurred_at: occurred,
    session_id: sessionId,
    input_tokens: input,
    output_tokens: output === null ? null : output + (reasoning ?? 0),
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    usage_source: 'opencode_local',
    measurement_type: 'measured',
    billing_mode: billing,
    dedupe_key: `oc:${id}`,
    event_count: 1,
    // OpenCode's own cost, computed from its model price catalog.
    cost_usd: typeof data.cost === 'number' && Number.isFinite(data.cost) && data.cost >= 0 ? data.cost : null,
    cost_kind: typeof data.cost === 'number' && Number.isFinite(data.cost) && data.cost > 0 ? 'tool_estimate' : null,
    synced_at: null,
    provider_fields: { reasoning_tokens: reasoning, provider_name: providerID?.slice(0, 40) ?? null },
  };
}

function dataDirs(ctx: SourceContext): string[] {
  return existingDirs([
    ...(ctx.extraDirs.opencode ?? []),
    path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'opencode'),
  ]);
}

function dbFiles(ctx: SourceContext): string[] {
  const fromEnv = process.env.OPENCODE_DB && path.isAbsolute(process.env.OPENCODE_DB) ? [process.env.OPENCODE_DB] : [];
  const globbed = dataDirs(ctx).flatMap((d) => {
    try {
      return fs.readdirSync(d).filter((n) => /^opencode.*\.db$/.test(n)).map((n) => path.join(d, n));
    } catch {
      return [];
    }
  });
  return [...new Set([...fromEnv, ...globbed])].filter((f) => fs.existsSync(f));
}

export function scanOpenCode(store: Store, ctx: SourceContext): ScanStats {
  const billing = openCodeSource.billing(ctx).mode;
  const dbs = dbFiles(ctx);
  const legacyRoots = dataDirs(ctx).flatMap((d) => existingDirs([path.join(d, 'storage', 'message')]));
  const stats: ScanStats = { roots: [...dbs, ...legacyRoots], files: dbs.length, filesRead: 0, bytesRead: 0, usageRows: 0, changedEvents: 0, malformedLines: 0 };
  const take = (rec: UsageRecord | null) => {
    if (!rec) return;
    stats.usageRows++;
    if (store.replaceEvent(rec)) stats.changedEvents++; // messages are updated in place until complete
  };

  for (const file of dbs) {
    const db = openReadOnly(file);
    if (!db) continue;
    try {
      stats.filesRead++;
      for (const [table, typeFilter] of [['session_message', "AND type IN ('assistant', 'compaction')"], ['message', '']] as const) {
        if (!hasTable(db, table)) continue;
        const cols = columns(db, table);
        if (!['id', 'session_id', 'time_updated', 'data'].every((c) => cols.has(c))) continue;
        const wmKey = `opencode:wm:${file}:${table}`;
        const since = store.getSnapshot<number>(wmKey) ?? 0;
        const rows = db.prepare(`SELECT id, session_id, time_updated, data FROM ${table} WHERE time_updated >= ? ${typeFilter} ORDER BY time_updated`).all(since) as Record<string, any>[];
        let wm = since;
        store.transaction(() => {
          for (const r of rows) {
            let data: unknown;
            try {
              data = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
            } catch {
              stats.malformedLines++;
              continue;
            }
            take(openCodeMessageToRecord(String(r.id), r.session_id ? String(r.session_id) : null, data, billing));
            if (typeof r.time_updated === 'number' && r.time_updated > wm) wm = r.time_updated;
          }
          store.setSnapshot(wmKey, wm);
        });
      }
    } finally {
      db.close();
    }
  }

  // Pre-SQLite JSON layout: one file per message; re-read only when size/mtime change.
  for (const root of legacyRoots) {
    const files = listFiles(root, '.json');
    store.transaction(() => {
      for (const f of files) {
        let st: fs.Stats;
        try {
          st = fs.statSync(f);
        } catch {
          continue;
        }
        const prev = store.importedFile(f);
        if (prev && prev.size === st.size && prev.mtime_ms === Math.floor(st.mtimeMs)) continue;
        try {
          const data = JSON.parse(fs.readFileSync(f, 'utf8'));
          take(openCodeMessageToRecord(String(data.id ?? path.basename(f, '.json')), data.sessionID ?? path.basename(path.dirname(f)), data, billing));
        } catch {
          stats.malformedLines++;
        }
        store.markImportedFile(f, st.size, st.mtimeMs, 'ok');
      }
    });
    stats.files += files.length;
  }
  store.setMeta('opencode_local_last_scan_at', new Date().toISOString());
  return stats;
}

export const openCodeSource: LocalSource = {
  usageSource: 'opencode_local',
  provider: 'opencode',
  label: 'OpenCode',
  roots: (ctx) => [...dbFiles(ctx), ...dataDirs(ctx).flatMap((d) => existingDirs([path.join(d, 'storage', 'message')]))],
  billing: (ctx) => (ctx.billingOverrides.opencode ? { mode: ctx.billingOverrides.opencode, basis: 'set by you (config)' } : { mode: 'unknown', basis: 'depends on the provider you use in OpenCode' }),
  scan: (store, ctx) => scanOpenCode(store, ctx),
  watchExtensions: [],
};
