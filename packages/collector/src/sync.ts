// Builds and uploads the sync payload. Only daily totals and hashed session keys leave the machine.
import crypto from 'node:crypto';
import { aggregateDaily, bucketKey, estimateCost, SOURCES, USAGE_SOURCES, type DailyBucket, type PriceTable } from '../../shared/src/index.ts';
import type { Config } from './config.ts';
import type { Store } from './store.ts';

export const COLLECTOR_VERSION = '0.4.1';
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export interface SessionUpload {
  provider: string;
  session_key: string;
  first_at: string;
  last_at: string;
  event_count: number;
}

type BucketKeyFields = Pick<DailyBucket, 'provider' | 'usage_source' | 'model_id' | 'day' | 'billing_mode' | 'measurement_type'>;

export interface SyncPlan {
  /** This machine's tools (Claude Code, Codex, ...): daily totals per device. */
  bucketUpserts: DailyBucket[];
  bucketDeletes: BucketKeyFields[];
  sessionUpserts: SessionUpload[];
  /** Account-wide sources (Cursor CSV, OpenRouter): daily totals shared by all of the user's machines. */
  accountUpserts: DailyBucket[];
  accountDeletes: BucketKeyFields[];
  hashes: {
    buckets: [string, string][]; sessions: [string, string][]; deletedBuckets: string[];
    accountBuckets: [string, string][]; deletedAccountBuckets: string[];
  };
}

/**
 * Whether the server will accept a day: from 2020-01-01 to tomorrow (UTC), the same window it validates. A row from a
 * wrong system clock or a garbled timestamp in a tool's log is left out of the upload instead of failing the whole
 * batch, which would otherwise block every sync from this machine.
 */
export function uploadableDay(day: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && day >= '2020-01-01' && Date.parse(day + 'T00:00:00Z') <= Date.now() + 864e5;
}

/** Buckets that changed since this machine last uploaded them, and uploaded keys that no longer exist. */
function diffBuckets(buckets: DailyBucket[], uploaded: Map<string, string>) {
  const upserts: DailyBucket[] = [];
  const hashes: [string, string][] = [];
  const present = new Set<string>();
  for (const b of buckets) {
    if (!uploadableDay(b.day)) continue; // see uploadableDay
    const k = bucketKey(b);
    present.add(k);
    const h = sha(JSON.stringify(b));
    if (uploaded.get(k) !== h) {
      upserts.push(b);
      hashes.push([k, h]);
    }
  }
  const deletedKeys = [...uploaded.keys()].filter((k) => !present.has(k));
  const deletes = deletedKeys.map((k) => {
    const [provider, usage_source, model_id, day, billing_mode, measurement_type] = k.split('\u0001');
    return { provider, usage_source, model_id, day, billing_mode, measurement_type } as BucketKeyFields;
  });
  return { upserts, hashes, deletes, deletedKeys };
}

export function planSync(store: Store, cfg: Config, prices: PriceTable = {}): SyncPlan {
  const local = store.eventsIn(USAGE_SOURCES.filter((u) => SOURCES[u].scope === 'device'));
  const { buckets, sessions } = aggregateDaily(local, (s) => SOURCES[s].sessions, prices);
  const device = diffBuckets(buckets, store.uploadedHashes('uploaded_buckets'));
  // Cursor and OpenRouter go up as daily totals too (a long Cursor history is tens of thousands of requests but only
  // a few rows per day); the server keeps the right one when several machines upload the same day.
  const accountRecords = store.eventsIn(USAGE_SOURCES.filter((u) => SOURCES[u].scope === 'account'));
  const account = diffBuckets(aggregateDaily(accountRecords, () => false, prices).buckets, store.uploadedHashes('uploaded_account_buckets'));
  const uploadedS = store.uploadedHashes('uploaded_sessions');

  const sessionUpserts: SessionUpload[] = [];
  const hs: [string, string][] = [];
  for (const s of sessions) {
    if (!uploadableDay(s.first_at.slice(0, 10)) || !uploadableDay(s.last_at.slice(0, 10))) continue;
    const session_key = sha(cfg.session_salt + '\u0001' + s.provider + '\u0001' + s.session_id).slice(0, 32);
    const up = { provider: s.provider, session_key, first_at: s.first_at, last_at: s.last_at, event_count: s.event_count };
    const h = sha(JSON.stringify(up));
    if (uploadedS.get(session_key) !== h) {
      sessionUpserts.push(up);
      hs.push([session_key, h]);
    }
  }

  return {
    bucketUpserts: device.upserts, bucketDeletes: device.deletes, sessionUpserts,
    accountUpserts: account.upserts, accountDeletes: account.deletes,
    hashes: {
      buckets: device.hashes, sessions: hs, deletedBuckets: device.deletedKeys,
      accountBuckets: account.hashes, deletedAccountBuckets: account.deletedKeys,
    },
  };
}

/**
 * Rows one sync run uploads at most. Even years of history are usually a few thousand rows; anything larger goes up
 * over the next runs (every 30 minutes) instead of all at once, so one machine can't spend the account's daily
 * server budget, or the shared database's, in a single burst.
 */
export const MAX_ROWS_PER_RUN = 2000;

/** The part of `plan` that fits in `max` rows (deletes first, then daily totals, then sessions), and whether any is left. */
export function capPlan(plan: SyncPlan, max = MAX_ROWS_PER_RUN): { plan: SyncPlan; more: boolean } {
  let room = max;
  const take = (n: number) => {
    const k = Math.min(n, room);
    room -= k;
    return k;
  };
  const bd = take(plan.bucketDeletes.length), ad = take(plan.accountDeletes.length);
  const bu = take(plan.bucketUpserts.length), au = take(plan.accountUpserts.length), su = take(plan.sessionUpserts.length);
  const more = bd < plan.bucketDeletes.length || ad < plan.accountDeletes.length || bu < plan.bucketUpserts.length ||
    au < plan.accountUpserts.length || su < plan.sessionUpserts.length;
  if (!more) return { plan, more };
  return {
    more,
    plan: {
      bucketDeletes: plan.bucketDeletes.slice(0, bd), accountDeletes: plan.accountDeletes.slice(0, ad),
      bucketUpserts: plan.bucketUpserts.slice(0, bu), accountUpserts: plan.accountUpserts.slice(0, au),
      sessionUpserts: plan.sessionUpserts.slice(0, su),
      hashes: {
        deletedBuckets: plan.hashes.deletedBuckets.slice(0, bd), deletedAccountBuckets: plan.hashes.deletedAccountBuckets.slice(0, ad),
        buckets: plan.hashes.buckets.slice(0, bu), accountBuckets: plan.hashes.accountBuckets.slice(0, au),
        sessions: plan.hashes.sessions.slice(0, su),
      },
    },
  };
}

export function assertSafeApiUrl(apiUrl: string) {
  const u = new URL(apiUrl);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new Error(`Refusing to talk to ${apiUrl}: use https:// (plain http is only allowed for localhost).`);
  }
}

/** The server answered with an error; `message` is its explanation, `status` the HTTP status. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The server couldn't be reached at all (offline, wrong URL, local server not running). */
export class NetworkError extends Error {}

export async function api(cfg: Config, method: string, p: string, body?: unknown): Promise<any> {
  assertSafeApiUrl(cfg.api_url);
  let res: Response;
  try {
    res = await fetch(new URL(p, cfg.api_url), {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cfg.device_token ? { authorization: `Bearer ${cfg.device_token}` } : {}),
    },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    const why = (e as Error).cause ? String((e as any).cause.code ?? (e as any).cause) : (e as Error).message;
    throw new NetworkError(`Can't reach ${cfg.api_url} (${why}). Will retry on the next sync.`);
  }
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) throw new ApiError(res.status, json?.error ?? (text.slice(0, 200) || `Request failed (${res.status})`));
  return json;
}

const BATCH = 500;

const HEARTBEAT_MS = 6 * 3600e3;

export async function runSync(
  store: Store, cfg: Config, health: Record<string, unknown>, prices: PriceTable = {}, opts: { force?: boolean; isRetry?: boolean } = {},
): Promise<SyncResult> {
  // Freeze list-price estimates for newly seen events (only these; history keeps the price it was first given).
  store.fillEstimates((r) => estimateCost(prices, r));
  const at = new Date().toISOString();
  const lastSync = store.getMeta('last_sync_at');
  // Nothing new locally: skip planning and the network entirely, except a periodic check-in so the
  // dashboard's "last sync" stays meaningful and server-side deletions are noticed.
  if (!opts.force && !store.isDirty() && lastSync && Date.now() - Date.parse(lastSync) < HEARTBEAT_MS) {
    return { buckets: 0, deletedBuckets: 0, sessions: 0, accountDays: 0, more: false, skipped: true };
  }
  // A device's very first upload already sends everything, so a reset marker seen then needs no re-upload. Judged by
  // any past sync, not by uploaded buckets: a machine with only Cursor/OpenRouter rows never has any.
  const firstUpload = !lastSync;
  const generation = store.dirtyGeneration(); // what this run uploads; later writes stay pending
  const { plan, more } = capPlan(planSync(store, cfg, prices));
  let serverReset: string | null = null;

  // Buckets are replace-by-key, so partial failure is safe to retry.
  for (let i = 0; i < Math.max(plan.bucketUpserts.length, plan.bucketDeletes.length, 1); i += BATCH) {
    const r = await api(cfg, 'POST', '/api/ingest/daily', {
      buckets: plan.bucketUpserts.slice(i, i + BATCH),
      deletes: plan.bucketDeletes.slice(i, i + BATCH),
      health,
      collector_version: COLLECTOR_VERSION,
    });
    serverReset = r?.data_reset_at ?? null;
  }
  // Uploaded data was deleted on the server (dashboard/CLI) since our last sync: re-upload everything once,
  // so the server holds complete history again rather than only days that change later.
  const seenReset = store.getMeta('server_reset_at') ?? null;
  if (serverReset && serverReset !== seenReset) {
    store.setMeta('server_reset_at', serverReset);
    if (!firstUpload && !opts.isRetry) {
      store.resetUploadState();
      return runSync(store, cfg, health, prices, { force: true, isRetry: true });
    }
  }
  store.setUploaded('uploaded_buckets', plan.hashes.buckets, plan.hashes.deletedBuckets);

  for (let i = 0; i < plan.sessionUpserts.length; i += BATCH) {
    await api(cfg, 'POST', '/api/ingest/sessions', { sessions: plan.sessionUpserts.slice(i, i + BATCH) });
  }
  store.setUploaded('uploaded_sessions', plan.hashes.sessions, []);

  // Also replace-by-key (the server decides which of several machines' day totals to keep), so safe to retry.
  for (let i = 0; i < Math.max(plan.accountUpserts.length, plan.accountDeletes.length); i += BATCH) {
    await api(cfg, 'POST', '/api/ingest/account-daily', {
      buckets: plan.accountUpserts.slice(i, i + BATCH),
      deletes: plan.accountDeletes.slice(i, i + BATCH),
    });
  }
  store.setUploaded('uploaded_account_buckets', plan.hashes.accountBuckets, plan.hashes.deletedAccountBuckets);
  store.setMeta('last_sync_at', at);
  if (!more) store.clearDirty(generation); // otherwise the next run picks up where this one stopped
  return {
    buckets: plan.bucketUpserts.length,
    deletedBuckets: plan.bucketDeletes.length + plan.accountDeletes.length,
    sessions: plan.sessionUpserts.length,
    accountDays: plan.accountUpserts.length,
    more,
    skipped: false,
  };
}

export interface SyncResult {
  buckets: number;
  deletedBuckets: number;
  sessions: number;
  /** Cursor/OpenRouter daily totals uploaded. */
  accountDays: number;
  /** The run hit MAX_ROWS_PER_RUN; the rest goes up on the next sync. */
  more: boolean;
  skipped: boolean;
}
