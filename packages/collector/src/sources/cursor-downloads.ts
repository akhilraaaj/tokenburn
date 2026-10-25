// Auto-import of Cursor usage CSV exports dropped into a folder (default ~/Downloads).
// Only files whose header looks like Cursor's usage export are considered; everything else is ignored unread.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeHeader, parseCursorCsv } from '../../../shared/src/index.ts';
import type { Store } from '../store.ts';

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_AGE_MS = 45 * 864e5;
// Headers specific to Cursor's export, so an unrelated CSV with "Date" and "Model" columns isn't imported.
const CURSOR_MARKERS = ['max_mode', 'input_w_cache_write', 'input_w_o_cache_write', 'input_with_cache_write'];

export const defaultDownloadsDir = () => path.join(os.homedir(), 'Downloads');

export function looksLikeCursorExport(file: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(2048);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const firstLine = buf.subarray(0, n).toString('utf8').replace(/^﻿/, '').split(/\r?\n/)[0];
    const headers = firstLine.split(',').map((h) => normalizeHeader(h.replace(/^"|"$/g, '')));
    return headers.includes('model') && CURSOR_MARKERS.some((m) => headers.includes(m));
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export interface AutoImportResult {
  file: string;
  inserted: number;
  duplicates: number;
  invalid: number;
  error?: string;
}

export async function autoImportCursorExports(store: Store, dir: string): Promise<AutoImportResult[]> {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.csv'));
  } catch {
    return [];
  }
  const results: AutoImportResult[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size > MAX_BYTES || Date.now() - st.mtimeMs > MAX_AGE_MS) continue;
    const prev = store.importedFile(file);
    if (prev && prev.size === st.size && prev.mtime_ms === Math.floor(st.mtimeMs)) continue;
    if (!looksLikeCursorExport(file)) {
      store.markImportedFile(file, st.size, st.mtimeMs, 'not a Cursor export');
      continue;
    }
    const parsed = await parseCursorCsv(fs.readFileSync(file, 'utf8'));
    if (parsed.fatal) {
      store.markImportedFile(file, st.size, st.mtimeMs, `rejected: ${parsed.fatal.slice(0, 200)}`);
      results.push({ file, inserted: 0, duplicates: 0, invalid: parsed.totalRows, error: parsed.fatal });
      continue;
    }
    let inserted = 0;
    store.transaction(() => {
      for (const rec of parsed.records) if (store.insertIfNew(rec)) inserted++;
    });
    const r = { file, inserted, duplicates: parsed.records.length - inserted, invalid: parsed.errors.length };
    store.markImportedFile(file, st.size, st.mtimeMs, JSON.stringify(r));
    results.push(r);
  }
  return results;
}
