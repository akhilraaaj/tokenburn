import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireLock } from '../src/lock.ts';
import { Store } from '../src/store.ts';
import { capPlan, planSync, uploadableDay } from '../src/sync.ts';
import type { Config } from '../src/config.ts';
import type { UsageRecord } from '../../shared/src/index.ts';

let tmp: string;
let store: Store;
const cfg: Config = {
  api_url: 'http://x', device_token: 't', device_id: 'd', previous_token: null, session_salt: 'salt', extra_dirs: {},
  billing_overrides: {}, claude_api_key_seen: false, first_sync_approved: true, cursor_auto_import: false, downloads_dir: null, openrouter_key: null,
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

describe('state that is unreadable for a moment', () => {
  it('refuses to replace a config it cannot parse (it would lose the sign-in and salt)', async () => {
    const { loadConfig, saveConfig } = await import('../src/config.ts');
    saveConfig(cfg);
    const file = path.join(tmp, 'state', 'config.json');
    fs.writeFileSync(file, ''); // as seen mid-write by an older, non-atomic writer
    expect(() => loadConfig()).toThrow(/Can't read/);
    fs.writeFileSync(file, JSON.stringify(cfg));
    expect(loadConfig().device_token).toBe('t');
  });

  it('a missing config still starts fresh', async () => {
    const { loadConfig } = await import('../src/config.ts');
    expect(loadConfig().device_token).toBeNull();
  });

  it('reclaims nothing from a lock file that is still being written', () => {
    fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'state', 'sync.lock'), '');
    expect(acquireLock()).toBeNull();
  });
});

describe('Cursor and OpenRouter upload as daily totals', () => {
  const cursor = (key: string, at: string, out: number, billing: UsageRecord['billing_mode'] = 'subscription'): UsageRecord => ({
    ...rec(key, at), provider: 'cursor', usage_source: 'cursor_csv', model_id: 'claude-4-sonnet', session_id: null, output_tokens: out,
    billing_mode: billing, cost_usd: 0.01, cost_kind: 'tool_estimate',
  });

  it('sums a day\'s requests into one row, uploads it once, and re-sends only days that changed', () => {
    store.transaction(() => {
      for (let i = 0; i < 1000; i++) store.insertIfNew(cursor(`c${i}`, `2026-10-0${1 + (i % 3)}T10:00:00.000Z`, 2));
    });
    const p1 = planSync(store, cfg);
    expect(p1.accountUpserts).toHaveLength(3); // 1,000 requests over 3 days → 3 rows
    expect(p1.accountUpserts.reduce((n, b) => n + b.event_count, 0)).toBe(1000);
    expect(p1.accountUpserts[0]).toMatchObject({ provider: 'cursor', usage_source: 'cursor_csv', session_count: null });
    expect(p1.bucketUpserts).toHaveLength(0); // never mixed into this machine's device totals
    store.setUploaded('uploaded_account_buckets', p1.hashes.accountBuckets, []);
    expect(planSync(store, cfg).accountUpserts).toHaveLength(0);

    store.insertIfNew(cursor('late', '2026-10-02T23:00:00.000Z', 2)); // a later export completes Oct 2
    expect(planSync(store, cfg).accountUpserts.map((b) => [b.day, b.event_count])).toEqual([['2026-10-02', 334]]);
  });

  it('deletes the old key when a day is re-keyed (say, a billing-mode change), and forgets everything after a server reset', () => {
    store.insertIfNew(cursor('a', '2026-10-01T10:00:00.000Z', 2));
    const p1 = planSync(store, cfg);
    store.setUploaded('uploaded_account_buckets', p1.hashes.accountBuckets, []);
    store.setBillingMode('cursor', 'api');
    const p2 = planSync(store, cfg);
    expect(p2.accountUpserts.map((b) => b.billing_mode)).toEqual(['api']);
    expect(p2.accountDeletes.map((b) => b.billing_mode)).toEqual(['subscription']);
    store.setUploaded('uploaded_account_buckets', p2.hashes.accountBuckets, p2.hashes.deletedAccountBuckets);
    store.resetUploadState();
    expect(planSync(store, cfg).accountUpserts).toHaveLength(1);
  });

  it('spreads a very large upload over several runs, with hashes matching what each run sends', () => {
    store.transaction(() => {
      for (let d = 0; d < 30; d++) store.insertIfNew(cursor(`d${d}`, new Date(Date.UTC(2026, 8, 1 + d, 12)).toISOString(), 1));
      store.insertIfNew(rec('claude', '2026-10-01T10:00:00.000Z'));
    });
    const full = planSync(store, cfg);
    const { plan, more } = capPlan(full, 10);
    expect(more).toBe(true);
    expect(plan.bucketUpserts.length + plan.accountUpserts.length + plan.sessionUpserts.length).toBe(10);
    expect(plan.hashes.accountBuckets).toHaveLength(plan.accountUpserts.length);
    expect(plan.hashes.buckets).toHaveLength(plan.bucketUpserts.length);
    // Record what went up; the next run plans only the rest.
    store.setUploaded('uploaded_buckets', plan.hashes.buckets, []);
    store.setUploaded('uploaded_account_buckets', plan.hashes.accountBuckets, []);
    store.setUploaded('uploaded_sessions', plan.hashes.sessions, []);
    const next = planSync(store, cfg);
    expect(next.accountUpserts.length + next.bucketUpserts.length + next.sessionUpserts.length)
      .toBe(full.accountUpserts.length + full.bucketUpserts.length + full.sessionUpserts.length - 10);
    expect(capPlan(next, 1000).more).toBe(false);
  });
});
