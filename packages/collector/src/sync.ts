// Builds and uploads the sync payload. Only aggregates, hashed session keys and normalized
// Cursor events leave the machine.
import crypto from 'node:crypto';
import { aggregateDaily, bucketKey, estimateCost, uploadModelId, SOURCES, USAGE_SOURCES, type DailyBucket, type PriceTable, type UsageRecord } from '../../shared/src/index.ts';
import type { Config } from './config.ts';
import type { Store } from './store.ts';

export const COLLECTOR_VERSION = '0.3.1';
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export interface SessionUpload {
  provider: string;
  session_key: string;
  first_at: string;
  last_at: string;
  event_count: number;
}

export interface SyncPlan {
  bucketUpserts: DailyBucket[];
  bucketDeletes: Pick<DailyBucket, 'provider' | 'usage_source' | 'model_id' | 'day' | 'billing_mode' | 'measurement_type'>[];
  sessionUpserts: SessionUpload[];
  accountEvents: UsageRecord[];
  hashes: { buckets: [string, string][]; sessions: [string, string][]; deletedBuckets: string[] };
}

export function planSync(store: Store, cfg: Config, prices: PriceTable = {}): SyncPlan {
  const local = store.eventsIn(USAGE_SOURCES.filter((u) => SOURCES[u].scope === 'device'));
  const { buckets, sessions } = aggregateDaily(local, (s) => SOURCES[s].sessions, prices);
  const uploadedB = store.uploadedHashes('uploaded_buckets');
  const uploadedS = store.uploadedHashes('uploaded_sessions');

  const bucketUpserts: DailyBucket[] = [];
  const hb: [string, string][] = [];
  const present = new Set<string>();
  for (const b of buckets) {
    const k = bucketKey(b);
    present.add(k);
    const h = sha(JSON.stringify(b));
    if (uploadedB.get(k) !== h) {
      bucketUpserts.push(b);
      hb.push([k, h]);
    }
  }
  const deletedBuckets = [...uploadedB.keys()].filter((k) => !present.has(k));
  const bucketDeletes = deletedBuckets.map((k) => {
    const [provider, usage_source, model_id, day, billing_mode, measurement_type] = k.split('\u0001');
    return { provider, usage_source, model_id, day, billing_mode, measurement_type } as SyncPlan['bucketDeletes'][number];
  });

  const sessionUpserts: SessionUpload[] = [];
  const hs: [string, string][] = [];
  for (const s of sessions) {
    const session_key = sha(cfg.session_salt + '\u0001' + s.provider + '\u0001' + s.session_id).slice(0, 32);
    const up = { provider: s.provider, session_key, first_at: s.first_at, last_at: s.last_at, event_count: s.event_count };
    const h = sha(JSON.stringify(up));
    if (uploadedS.get(session_key) !== h) {
      sessionUpserts.push(up);
      hs.push([session_key, h]);
    }
  }

  return {
    bucketUpserts, bucketDeletes, sessionUpserts,
    accountEvents: store.unsyncedEvents(USAGE_SOURCES.filter((u) => SOURCES[u].scope === 'account')),
    hashes: { buckets: hb, sessions: hs, deletedBuckets },
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

/** Account events go up with their best-known cost (tool-reported, else list-price estimate) and the billed part. */
export function accountEventPayload(e: UsageRecord, prices: PriceTable) {
  const { synced_at, cost_usd, cost_kind, ...rest } = e;
  const known = cost_kind && typeof cost_usd === 'number' ? cost_usd : null;
  const { est_cost_usd, ...upload } = rest;
  return {
    ...upload,
    model_id: uploadModelId(e.model_id),
    cost_usd: known ?? est_cost_usd ?? estimateCost(prices, e),
    billed_cost_usd: cost_kind === 'billed' ? known : null,
  };
}

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
    return { buckets: 0, deletedBuckets: 0, sessions: 0, accountInserted: 0, accountDuplicates: 0, skipped: true };
  }
  // A device's very first upload already sends everything, so a reset marker seen then needs no re-upload.
  const firstUpload = store.uploadedHashes('uploaded_buckets').size === 0;
  const plan = planSync(store, cfg, prices);
  let accountInserted = 0;
  let accountDuplicates = 0;
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

  for (let i = 0; i < plan.accountEvents.length; i += BATCH) {
    const chunk = plan.accountEvents.slice(i, i + BATCH);
    const r = await api(cfg, 'POST', '/api/ingest/events', { events: chunk.map((e) => accountEventPayload(e, prices)) });
    accountInserted += r.inserted;
    accountDuplicates += r.duplicates;
    store.markSynced(chunk.map((e) => e.dedupe_key), at);
  }
  store.setMeta('last_sync_at', at);
  store.clearDirty();
  return {
    buckets: plan.bucketUpserts.length,
    deletedBuckets: plan.bucketDeletes.length,
    sessions: plan.sessionUpserts.length,
    accountInserted,
    accountDuplicates,
    skipped: false,
  };
}

export interface SyncResult {
  buckets: number;
  deletedBuckets: number;
  sessions: number;
  accountInserted: number;
  accountDuplicates: number;
  skipped: boolean;
}
