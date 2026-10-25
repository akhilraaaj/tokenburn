import crypto from 'node:crypto';
import type { DatabaseSync as DatabaseSyncT } from 'node:sqlite';

// Loaded at runtime (not a static import) so the CLI's warning filter is installed first.
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = DatabaseSyncT;

/** Opens another app's SQLite database read-only. Returns null if it can't be opened (locked, missing, corrupt). */
export function openReadOnly(file: string): DatabaseSync | null {
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    return null;
  }
}

export function hasTable(db: DatabaseSync, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

export function columns(db: DatabaseSync, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
}

export const shortHash = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

export const nonNeg = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null);
