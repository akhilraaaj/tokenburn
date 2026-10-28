// Local collector database (node:sqlite). Holds normalized usage records only — never content.
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';

// Loaded at runtime (not a static import) so the CLI's warning filter is installed first.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = DatabaseSyncT;
import fs from 'node:fs';
import path from 'node:path';
import { mergeClaudeCodeRecords, type UsageRecord } from '../../shared/src/index.ts';

export interface FileState {
  path: string;
  ino: string;
  size: number;
  offset: number;
  malformed_lines: number;
  usage_rows: number;
}

export class Store {
  db: DatabaseSync;

  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700); // mode on mkdir only applies when created; enforce for existing dirs too
    // Wait up to 5 s if another tokenburn process is writing, instead of failing with SQLITE_BUSY.
    this.db = new DatabaseSync(path.join(dir, 'collector.db'), { timeout: 5000 });
    for (const f of ['collector.db', 'collector.db-wal', 'collector.db-shm']) {
      try { fs.chmodSync(path.join(dir, f), 0o600); } catch {}
    }
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (
        dedupe_key TEXT PRIMARY KEY, provider TEXT NOT NULL, model_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
        session_id TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER,
        usage_source TEXT NOT NULL, measurement_type TEXT NOT NULL, billing_mode TEXT NOT NULL,
        provider_fields TEXT NOT NULL DEFAULT '{}', synced_at TEXT, event_count INTEGER NOT NULL DEFAULT 1,
        cost_usd REAL, cost_kind TEXT, est_cost_usd REAL
      );
      CREATE INDEX IF NOT EXISTS events_time ON events(occurred_at);
      CREATE INDEX IF NOT EXISTS events_source ON events(usage_source, synced_at);
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY, ino TEXT NOT NULL, size INTEGER NOT NULL, offset INTEGER NOT NULL,
        malformed_lines INTEGER NOT NULL DEFAULT 0, usage_rows INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS uploaded_buckets (bucket_key TEXT PRIMARY KEY, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS uploaded_sessions (session_key TEXT PRIMARY KEY, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      -- Last-seen cumulative values for sources that only expose running totals (e.g. Hermes).
      CREATE TABLE IF NOT EXISTS snapshots (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      -- Export files already auto-imported (Cursor CSVs in Downloads).
      CREATE TABLE IF NOT EXISTS imported_files (path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, result TEXT NOT NULL);
    `);
    const cols = (this.db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes('event_count')) this.db.exec('ALTER TABLE events ADD COLUMN event_count INTEGER NOT NULL DEFAULT 1');
    if (!cols.includes('cost_usd')) this.db.exec('ALTER TABLE events ADD COLUMN cost_usd REAL; ALTER TABLE events ADD COLUMN cost_kind TEXT;');
    if (!cols.includes('est_cost_usd')) this.db.exec('ALTER TABLE events ADD COLUMN est_cost_usd REAL;');
  }

  getFile(p: string): FileState | undefined {
    return this.db.prepare('SELECT * FROM files WHERE path = ?').get(p) as FileState | undefined;
  }

  putFile(f: FileState) {
    this.db
      .prepare('INSERT OR REPLACE INTO files (path, ino, size, offset, malformed_lines, usage_rows) VALUES (?, ?, ?, ?, ?, ?)')
      .run(f.path, f.ino, f.size, f.offset, f.malformed_lines, f.usage_rows);
  }

  malformedLines(roots: string[]): number {
    return this.files().filter((f) => roots.some((r) => f.path.startsWith(r))).reduce((n, f) => n + f.malformed_lines, 0);
  }

  /** Replaces a record outright (sources whose rows are authoritative snapshots, e.g. OpenRouter days). */
  replaceEvent(rec: UsageRecord): boolean {
    const existing = this.getEvent(rec.dedupe_key);
    if (existing && sameEvent(existing, rec)) return false;
    this.writeEvent({ ...rec, synced_at: null });
    return true;
  }

  getSnapshot<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM snapshots WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }

  setSnapshot(key: string, value: unknown) {
    this.db.prepare('INSERT OR REPLACE INTO snapshots (key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
  }

  importedFile(p: string): { size: number; mtime_ms: number; result: string } | undefined {
    return this.db.prepare('SELECT size, mtime_ms, result FROM imported_files WHERE path = ?').get(p) as any;
  }

  markImportedFile(p: string, size: number, mtimeMs: number, result: string) {
    this.db.prepare('INSERT OR REPLACE INTO imported_files (path, size, mtime_ms, result) VALUES (?, ?, ?, ?)').run(p, size, Math.floor(mtimeMs), result);
  }

  files(): FileState[] {
    return this.db.prepare('SELECT * FROM files ORDER BY path').all() as unknown as FileState[];
  }

  transaction<T>(fn: () => T): T {
    // IMMEDIATE takes the write lock up front: a deferred BEGIN that reads, then writes, fails with SQLITE_BUSY at
    // once if another process committed in between, instead of waiting out the busy timeout.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Inserts or merges a Claude Code record (see mergeClaudeCodeRecords). Returns true if stored data changed. */
  upsertMerged(rec: UsageRecord): boolean {
    const existing = this.getEvent(rec.dedupe_key);
    const next = existing ? mergeClaudeCodeRecords(existing, rec) : rec;
    if (existing && sameEvent(existing, next)) return false;
    this.writeEvent(next);
    return true;
  }

  /** Inserts if new. Returns true when inserted. Used for account-level imports (Cursor CSV). */
  insertIfNew(rec: UsageRecord): boolean {
    if (this.getEvent(rec.dedupe_key)) return false;
    this.writeEvent(rec);
    return true;
  }

  getEvent(key: string): UsageRecord | undefined {
    const row = this.db.prepare('SELECT * FROM events WHERE dedupe_key = ?').get(key) as Record<string, any> | undefined;
    return row ? rowToRecord(row) : undefined;
  }

  /** Set whenever local usage changes; sync skips planning and uploading while it's clear. */
  // A change counter rather than a flag: a sync records the count it planned from and clears only up to it, so
  // events written while it was uploading (a manual sync, a config change) keep the store dirty for the next run.
  markDirty() {
    this.setMeta('plan_dirty', String(this.dirtyGeneration() + 1));
  }
  dirtyGeneration() {
    return Number(this.getMeta('plan_dirty') ?? 0) || 0;
  }
  isDirty() {
    return this.dirtyGeneration() !== (Number(this.getMeta('plan_clean') ?? 0) || 0);
  }
  clearDirty(generation: number) {
    this.setMeta('plan_clean', String(generation));
  }

  /** Freezes API list-price estimates for events that don't have one yet. Returns how many were priced. */
  fillEstimates(estimate: (r: UsageRecord) => number | null): number {
    const rows = this.db.prepare('SELECT * FROM events WHERE est_cost_usd IS NULL AND cost_kind IS NULL').all() as Record<string, any>[];
    const upd = this.db.prepare('UPDATE events SET est_cost_usd = ? WHERE dedupe_key = ?');
    let n = 0;
    this.transaction(() => {
      for (const row of rows) {
        const c = estimate(rowToRecord(row));
        if (c !== null) { upd.run(c, row.dedupe_key); n++; }
      }
    });
    if (n) this.markDirty();
    return n;
  }

  private writeEvent(r: UsageRecord) {
    this.markDirty();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO events (dedupe_key, provider, model_id, occurred_at, session_id, input_tokens, output_tokens,
          cache_read_tokens, cache_write_tokens, usage_source, measurement_type, billing_mode, provider_fields, synced_at, event_count, cost_usd, cost_kind, est_cost_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.dedupe_key, r.provider, r.model_id, r.occurred_at, r.session_id, r.input_tokens, r.output_tokens,
        r.cache_read_tokens, r.cache_write_tokens, r.usage_source, r.measurement_type, r.billing_mode,
        JSON.stringify(r.provider_fields), r.synced_at, r.event_count, r.cost_usd ?? null, r.cost_kind ?? null, r.est_cost_usd ?? null,
      );
  }

  /** Events from the given sources only (used for planning: device-scoped sources). */
  eventsIn(usageSources: string[]): UsageRecord[] {
    if (!usageSources.length) return [];
    const q = `SELECT * FROM events WHERE usage_source IN (${usageSources.map(() => '?').join(',')})`;
    return (this.db.prepare(q).all(...usageSources) as Record<string, any>[]).map(rowToRecord);
  }

  events(usageSource?: string): UsageRecord[] {
    const rows = usageSource
      ? this.db.prepare('SELECT * FROM events WHERE usage_source = ? ORDER BY occurred_at').all(usageSource)
      : this.db.prepare('SELECT * FROM events ORDER BY occurred_at').all();
    return (rows as Record<string, any>[]).map(rowToRecord);
  }

  unsyncedEvents(usageSources: string[]): UsageRecord[] {
    if (!usageSources.length) return [];
    const q = `SELECT * FROM events WHERE synced_at IS NULL AND usage_source IN (${usageSources.map(() => '?').join(',')})`;
    return (this.db.prepare(q).all(...usageSources) as Record<string, any>[]).map(rowToRecord);
  }

  deleteEvents(provider?: string) {
    if (provider) this.db.prepare('DELETE FROM events WHERE provider = ?').run(provider);
    else this.db.exec('DELETE FROM events');
    this.markDirty();
  }

  markSynced(keys: string[], at: string) {
    const stmt = this.db.prepare('UPDATE events SET synced_at = ? WHERE dedupe_key = ?');
    this.transaction(() => keys.forEach((k) => stmt.run(at, k)));
  }

  setBillingMode(provider: string, mode: string) {
    this.db.prepare('UPDATE events SET billing_mode = ? WHERE provider = ?').run(mode, provider);
    this.markDirty();
  }

  /**
   * Forgets parse progress for one provider only, so it's re-collected from scratch. State of other
   * providers is untouched (clearing e.g. Hermes snapshots while keeping its events would double count).
   */
  clearSourceState(roots: string[], snapshotPrefixes: string[]) {
    this.transaction(() => {
      for (const r of roots) {
        this.db.prepare("DELETE FROM files WHERE path = ? OR path LIKE ? ESCAPE '\\'").run(r, r.replace(/[%_\\]/g, '\\$&') + '/%');
        this.db.prepare("DELETE FROM imported_files WHERE path = ? OR path LIKE ? ESCAPE '\\'").run(r, r.replace(/[%_\\]/g, '\\$&') + '/%');
      }
      for (const p of snapshotPrefixes) this.db.prepare("DELETE FROM snapshots WHERE key LIKE ? ESCAPE '\\'").run(p.replace(/[%_\\]/g, '\\$&') + '%');
    });
  }

  getMeta(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  setMeta(key: string, value: string) {
    this.db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(key, value);
  }

  uploadedHashes(table: 'uploaded_buckets' | 'uploaded_sessions'): Map<string, string> {
    const col = table === 'uploaded_buckets' ? 'bucket_key' : 'session_key';
    const rows = this.db.prepare(`SELECT ${col} AS k, hash FROM ${table}`).all() as { k: string; hash: string }[];
    return new Map(rows.map((r) => [r.k, r.hash]));
  }

  setUploaded(table: 'uploaded_buckets' | 'uploaded_sessions', upserts: [string, string][], deletes: string[]) {
    const col = table === 'uploaded_buckets' ? 'bucket_key' : 'session_key';
    const put = this.db.prepare(`INSERT OR REPLACE INTO ${table} (${col}, hash) VALUES (?, ?)`);
    const del = this.db.prepare(`DELETE FROM ${table} WHERE ${col} = ?`);
    this.transaction(() => {
      upserts.forEach(([k, h]) => put.run(k, h));
      deletes.forEach((k) => del.run(k));
    });
  }

  /** Forget what the server has, e.g. after re-login or server-side deletion. */
  resetUploadState() {
    this.db.exec("DELETE FROM uploaded_buckets; DELETE FROM uploaded_sessions; UPDATE events SET synced_at = NULL;");
    this.markDirty();
  }
}

function rowToRecord(row: Record<string, any>): UsageRecord {
  return {
    provider: row.provider,
    model_id: row.model_id,
    occurred_at: row.occurred_at,
    session_id: row.session_id,
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    cache_read_tokens: row.cache_read_tokens,
    cache_write_tokens: row.cache_write_tokens,
    usage_source: row.usage_source,
    measurement_type: row.measurement_type,
    billing_mode: row.billing_mode,
    dedupe_key: row.dedupe_key,
    event_count: row.event_count,
    cost_usd: row.cost_usd ?? null,
    cost_kind: row.cost_kind ?? null,
    est_cost_usd: row.est_cost_usd ?? null,
    synced_at: row.synced_at,
    provider_fields: JSON.parse(row.provider_fields),
  };
}

const COMPARED = [
  'model_id', 'occurred_at', 'session_id', 'input_tokens', 'output_tokens', 'cache_read_tokens',
  'cache_write_tokens', 'billing_mode', 'measurement_type', 'event_count', 'cost_usd', 'cost_kind',
] as const;

function sameEvent(a: UsageRecord, b: UsageRecord) {
  return COMPARED.every((k) => (a[k] ?? null) === (b[k] ?? null));
}
