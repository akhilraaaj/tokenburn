// Hermes Agent (NousResearch/hermes-agent): <HERMES_HOME>/state.db (+ profiles/<name>/state.db),
// table session_model_usage. Verified against hermes_state_common.py @7e15778.
// Rows are running totals per (session, model, billing route, task), so we record the change since
// the previous scan, dated by the row's last_seen. History before the first scan lands on last_seen.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UsageRecord } from '../../../shared/src/index.ts';
import { existingDirs } from '../paths.ts';
import type { Store } from '../store.ts';
import { columns, hasTable, nonNeg, openReadOnly, shortHash } from './sqlite.ts';
import type { LocalSource, ScanStats, SourceContext } from './types.ts';

const FIELDS = ['api_call_count', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens', 'reasoning_tokens'] as const;
const COSTS = ['actual_cost_usd', 'estimated_cost_usd'] as const;
type Totals = Record<(typeof FIELDS)[number] | (typeof COSTS)[number], number>;

function hermesHomes(ctx: SourceContext): string[] {
  const suffix = process.env.HERMES_DATA_DIR_SUFFIX ?? '';
  const homes = existingDirs([
    ...(ctx.extraDirs.hermes ?? []),
    ...(process.env.HERMES_HOME ? [process.env.HERMES_HOME] : []),
    path.join(os.homedir(), `.hermes${suffix}`),
    // Hermes' Windows default (hermes_constants.py): %LOCALAPPDATA%\hermes
    ...(process.platform === 'win32' ? [path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), `hermes${suffix}`)] : []),
  ]);
  const withProfiles = homes.flatMap((h) => {
    let profiles: string[] = [];
    try {
      profiles = fs.readdirSync(path.join(h, 'profiles')).map((p) => path.join(h, 'profiles', p));
    } catch {}
    return [h, ...profiles];
  });
  return withProfiles.map((h) => path.join(h, 'state.db')).filter((f) => fs.existsSync(f));
}

export function scanHermes(store: Store, ctx: SourceContext): ScanStats {
  const files = hermesHomes(ctx);
  const stats: ScanStats = { roots: files, files: files.length, filesRead: 0, bytesRead: 0, usageRows: 0, changedEvents: 0, malformedLines: 0 };
  for (const file of files) {
    const db = openReadOnly(file);
    if (!db) continue;
    try {
      if (!hasTable(db, 'session_model_usage')) continue; // Hermes < schema v20
      const cols = columns(db, 'session_model_usage');
      if (!['session_id', 'model', 'last_seen', ...FIELDS].every((c) => cols.has(c))) {
        store.setMeta(`hermes_schema_warning:${file}`, 'session_model_usage columns changed');
        continue;
      }
      const dbKey = shortHash(fs.realpathSync(file));
      const rows = db.prepare(
        `SELECT session_id, model, billing_provider, billing_base_url, billing_mode, task, last_seen, ${FIELDS.join(', ')}${COSTS.every((c) => cols.has(c)) ? `, ${COSTS.join(', ')}` : ''}
         FROM session_model_usage`,
      ).all() as Record<string, any>[];
      stats.filesRead++;
      store.transaction(() => {
        for (const r of rows) {
          if (!r.model || typeof r.last_seen !== 'number') {
            stats.malformedLines++;
            continue;
          }
          const rowKey = shortHash([dbKey, r.session_id, r.model, r.billing_provider, r.billing_base_url, r.billing_mode, r.task].join('\u0001'));
          const snapKey = `hermes:${rowKey}`;
          const cur = {
            ...Object.fromEntries(FIELDS.map((f) => [f, nonNeg(r[f]) ?? 0])),
            ...Object.fromEntries(COSTS.map((c) => [c, typeof r[c] === 'number' && r[c] > 0 ? r[c] : 0])),
          } as Totals;
          const prev = store.getSnapshot<Totals>(snapKey);
          // Totals only grow. If any shrank, Hermes rebuilt the row: take the new values as the baseline
          // without counting them (counting would add usage we already recorded a second time).
          if (prev && FIELDS.some((f) => cur[f] < (prev[f] ?? 0))) {
            store.setSnapshot(snapKey, cur);
            continue;
          }
          const base = prev ?? null;
          const delta = Object.fromEntries([...FIELDS, ...COSTS].map((f) => [f, cur[f] - (base?.[f] ?? 0)])) as Totals;
          if (FIELDS.every((f) => delta[f] === 0)) continue;
          const rec: UsageRecord = {
            provider: 'hermes',
            model_id: String(r.model),
            occurred_at: new Date(r.last_seen * 1000).toISOString(),
            session_id: r.session_id ? String(r.session_id) : null,
            input_tokens: delta.input_tokens,
            output_tokens: delta.output_tokens,
            cache_read_tokens: delta.cache_read_tokens,
            cache_write_tokens: delta.cache_write_tokens,
            usage_source: 'hermes_sqlite',
            measurement_type: 'measured',
            billing_mode: 'unknown',
            dedupe_key: `hermes:${rowKey}:${cur.api_call_count}:${cur.input_tokens}:${cur.output_tokens}`,
            event_count: Math.max(1, delta.api_call_count),
            // Hermes records provider-reported charges when available, else its own estimate.
            cost_usd: delta.actual_cost_usd > 0 ? delta.actual_cost_usd : delta.estimated_cost_usd > 0 ? delta.estimated_cost_usd : null,
            cost_kind: delta.actual_cost_usd > 0 ? 'billed' : delta.estimated_cost_usd > 0 ? 'tool_estimate' : null,
            synced_at: null,
            provider_fields: {
              reasoning_tokens: delta.reasoning_tokens,
              provider_name: typeof r.billing_provider === 'string' && r.billing_provider ? r.billing_provider.slice(0, 40) : null,
            },
          };
          stats.usageRows++;
          if (store.insertIfNew(rec)) stats.changedEvents++;
          store.setSnapshot(snapKey, cur);
        }
      });
    } finally {
      db.close();
    }
  }
  store.setMeta('hermes_sqlite_last_scan_at', new Date().toISOString());
  return stats;
}

export const hermesSource: LocalSource = {
  usageSource: 'hermes_sqlite',
  provider: 'hermes',
  label: 'Hermes Agent',
  roots: (ctx) => hermesHomes(ctx),
  billing: (ctx) => (ctx.billingOverrides.hermes ? { mode: ctx.billingOverrides.hermes, basis: 'set by you (config)' } : { mode: 'unknown', basis: 'varies by Hermes provider route' }),
  scan: (store, ctx) => scanHermes(store, ctx),
  watchExtensions: [],
};
