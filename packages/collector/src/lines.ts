// Incremental line reader shared by JSONL-based sources.
import fs from 'node:fs';
import type { FileState, Store } from './store.ts';

const CHUNK = 8 * 1024 * 1024;

export interface ReadResult {
  read: boolean;
  bytes: number;
}

/**
 * Feeds only complete, not-yet-seen lines of `file` to `onLines`, inside one transaction per chunk.
 * A trailing partial line (an in-progress write) is left for the next call. A replaced or truncated
 * file is re-read from the start; sources must dedupe so that is safe.
 */
export function readNewLines(
  store: Store,
  file: string,
  onLines: (lines: string[], state: FileState) => void,
): ReadResult {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return { read: false, bytes: 0 }; // deleted between listing and stat
  }
  const ino = `${st.dev}:${st.ino}`;
  let state = store.getFile(file);
  if (!state || state.ino !== ino || st.size < state.offset) {
    state = { path: file, ino, size: 0, offset: 0, malformed_lines: 0, usage_rows: 0 };
  }
  if (st.size === state.offset) {
    if (state.size !== st.size) store.putFile({ ...state, size: st.size });
    return { read: false, bytes: 0 };
  }
  let bytes = 0;
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return { read: false, bytes: 0 }; // unreadable (say root-owned) or deleted since listing: skip, retry next run
  }
  try {
    let pending = Buffer.alloc(0);
    let pos = state.offset;
    while (pos < st.size) {
      const buf = Buffer.alloc(Math.min(CHUNK, st.size - pos));
      const n = fs.readSync(fd, buf, 0, buf.length, pos);
      if (n === 0) break;
      pos += n;
      bytes += n;
      const data = pending.length ? Buffer.concat([pending, buf.subarray(0, n)]) : buf.subarray(0, n);
      const lastNl = data.lastIndexOf(0x0a);
      if (lastNl === -1) {
        pending = Buffer.from(data);
        continue;
      }
      const lines = data.subarray(0, lastNl).toString('utf8').split('\n');
      pending = Buffer.from(data.subarray(lastNl + 1));
      const s = state;
      store.transaction(() => {
        onLines(lines, s);
        s.offset = pos - pending.length;
        s.size = st.size;
        store.putFile(s);
      });
    }
  } finally {
    fs.closeSync(fd);
  }
  return { read: true, bytes };
}
