import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock } from '../src/lock.ts';
import { Store } from '../src/store.ts';
import { planSync, uploadableDay } from '../src/sync.ts';
import type { Config } from '../src/config.ts';
import type { UsageRecord } from '../../shared/src/index.ts';

let tmp: string;
let store: Store;
const cfg: Config = {
  api_url: 'http://x', device_token: 't', device_id: 'd', previous_token: null, session_salt: 'salt', extra_dirs: {},
  billing_overrides: {}, first_sync_approved: true, cursor_auto_import: false, downloads_dir: null, openrouter_key: null,
};
const rec = (key: string, occurred_at: string): UsageRecord => ({
  provider: 'claude_code', model_id: 'claude-opus-5-5', occurred_at, session_id: 's-' + key, input_tokens: 1, output_tokens: 2,
  cache_read_tokens: 0, cache_write_tokens: 0, usage_source: 'claude_code_jsonl', measurement_type: 'measured',
  billing_mode: 'subscription', dedupe_key: key, event_count: 1, synced_at: null, provider_fields: {},
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-'));
  process.env.TOKENBURN_HOME = path.join(tmp, 'state');
  store = new Store(path.join(tmp, 'state'));
});
afterEach(() => {
  delete process.env.TOKENBURN_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('sync robustness', () => {
  it('leaves days the server would reject out of the upload instead of failing it', () => {
    expect(uploadableDay('2026-10-01')).toBe(true);
    expect(uploadableDay('2019-12-31')).toBe(false);
    expect(uploadableDay('2999-01-01')).toBe(false);
    store.transaction(() => {
      store.insertIfNew(rec('ok', '2026-10-01T10:00:00.000Z'));
      store.insertIfNew(rec('old', '1999-01-01T10:00:00.000Z')); // wrong system clock
      store.insertIfNew(rec('future', '2999-01-01T10:00:00.000Z'));
    });
    const plan = planSync(store, cfg);
    expect(plan.bucketUpserts.map((b) => b.day)).toEqual(['2026-10-01']);
    expect(plan.sessionUpserts).toHaveLength(1);
  });

  it('keeps changes made during a sync pending for the next one', () => {
    store.markDirty();
    const planned = store.dirtyGeneration(); // a sync starts planning from here…
    store.markDirty(); // …while a manual sync or config change writes more
    store.clearDirty(planned);
    expect(store.isDirty()).toBe(true);
    store.clearDirty(store.dirtyGeneration());
    expect(store.isDirty()).toBe(false);
  });

  it('reclaims a lock that is too old even if its pid is alive', () => {
    const file = path.join(tmp, 'state', 'sync.lock');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${process.ppid} ${Date.now() - 3 * 3600e3}`); // a live pid, taken 3h ago
    const release = acquireLock();
    expect(release).not.toBeNull();
    release?.();
    fs.writeFileSync(file, `${process.ppid} ${Date.now()}`); // a live pid, taken just now
    expect(acquireLock()).toBeNull();
  });
});
