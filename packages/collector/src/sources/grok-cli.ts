// Grok CLI (community superagent-ai/grok-cli, npm `grok-dev`): ~/.grok/grok.db, table usage_events.
// Verified against src/storage/migrations.ts @fb97af8. Not the official xAI "Grok Build" CLI, whose
// on-disk format is undocumented. input_tokens comes from the AI SDK and includes cached tokens.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UsageRecord } from '../../../shared/src/index.ts';
import { existingDirs } from '../paths.ts';
import type { Store } from '../store.ts';
import { columns, hasTable, nonNeg, openReadOnly, shortHash } from './sqlite.ts';
import type { LocalSource, ScanStats, SourceContext } from './types.ts';

const REQUIRED = ['id', 'session_id', 'model', 'input_tokens', 'output_tokens', 'created_at'];

function dbFiles(ctx: SourceContext): string[] {
  const dirs = existingDirs([...(ctx.extraDirs.grok_cli ?? []), path.join(os.homedir(), '.grok')]);
  return dirs.map((d) => path.join(d, 'grok.db')).filter((f) => fs.existsSync(f));
}

export function scanGrokCli(store: Store, ctx: SourceContext): ScanStats {
  const files = dbFiles(ctx);
  const stats: ScanStats = { roots: files, files: files.length, filesRead: 0, bytesRead: 0, usageRows: 0, changedEvents: 0, malformedLines: 0 };
  const billing = grokCliSource.billing(ctx).mode;
  for (const file of files) {
    const db = openReadOnly(file);
    if (!db) continue;
    try {
      if (!hasTable(db, 'usage_events') || REQUIRED.some((c) => !columns(db, 'usage_events').has(c))) {
        store.setMeta(`grok_cli_schema_warning:${file}`, 'usage_events table missing or changed');
        continue;
      }
      const dbKey = shortHash(fs.realpathSync(file));
      const wmKey = `grok_cli:last_id:${dbKey}`;
      let lastId = store.getSnapshot<number>(wmKey) ?? 0;
      const maxId = (db.prepare('SELECT MAX(id) AS m FROM usage_events').get() as { m: number | null }).m ?? 0;
      if (maxId < lastId) lastId = 0; // database was recreated
      const rows = db.prepare(
        `SELECT id, session_id, source, model, input_tokens, output_tokens, created_at${columns(db, 'usage_events').has('cost_micros') ? ', cost_micros' : ''} FROM usage_events WHERE id > ? ORDER BY id`,
      ).all(lastId) as Record<string, any>[];
      stats.filesRead++;
      store.transaction(() => {
        for (const r of rows) {
          const t = Date.parse(r.created_at);
          if (!r.model || Number.isNaN(t)) {
            stats.malformedLines++;
            continue;
          }
          const rec: UsageRecord = {
            provider: 'grok_cli',
            model_id: String(r.model),
            occurred_at: new Date(t).toISOString(),
            session_id: r.session_id ? String(r.session_id) : null,
            input_tokens: nonNeg(r.input_tokens),
            output_tokens: nonNeg(r.output_tokens),
            cache_read_tokens: null,
            cache_write_tokens: null,
            usage_source: 'grok_cli_sqlite',
            measurement_type: 'measured',
            billing_mode: billing,
            dedupe_key: `grok:${dbKey}:${r.id}`,
            event_count: 1,
            // grok-cli's own estimate from its price table.
            cost_usd: typeof r.cost_micros === 'number' && r.cost_micros > 0 ? r.cost_micros / 1e6 : null,
            cost_kind: typeof r.cost_micros === 'number' && r.cost_micros > 0 ? 'tool_estimate' : null,
            synced_at: null,
            provider_fields: { source: typeof r.source === 'string' ? r.source.slice(0, 20) : null, input_includes_cache: true },
          };
          stats.usageRows++;
          if (store.insertIfNew(rec)) stats.changedEvents++;
          lastId = r.id;
        }
        store.setSnapshot(wmKey, lastId);
      });
    } finally {
      db.close();
    }
  }
  store.setMeta('grok_cli_sqlite_last_scan_at', new Date().toISOString());
  return stats;
}

export const grokCliSource: LocalSource = {
  usageSource: 'grok_cli_sqlite',
  provider: 'grok_cli',
  label: 'Grok CLI',
  roots: (ctx) => dbFiles(ctx),
  billing: (ctx) => (ctx.billingOverrides.grok_cli ? { mode: ctx.billingOverrides.grok_cli, basis: 'set by you (config)' } : { mode: 'unknown', basis: 'not recorded by grok-cli' }),
  scan: (store, ctx) => scanGrokCli(store, ctx),
  watchExtensions: [],
};
