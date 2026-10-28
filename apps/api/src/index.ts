import {
  BILLING_MODES, MEASUREMENT_TYPES, PROVIDERS, SOURCE_SCOPE, USAGE_SOURCES, isNonNegInt, isNonNegNumber, validateRecord,
} from '../../../packages/shared/src/schema.ts';
import {
  RESERVED, USERNAME_RE, checkOrigin, clearPendingCookie, clearStateCookie, createDevice, deleteDeviceAndData, devIdentity,
  findUserByGithub, pendingCookie, readPending, signPending, endSession, githubAuthorizeRedirect, githubCallback, githubForm,
  githubUser, requireDevice, sessionUser, startSession, upsertUser, type User,
} from './auth.ts';
import { allTimeActivity, allTimeDays, dailyRows, highlights, sessionCounts, sinceDays } from './data.ts';
import { activityStats, contributionDays } from '../../../packages/shared/src/activity.ts';
import { PROFILE_FLAGS, type DashboardData, type PublicProfile } from '../../../packages/shared/src/web.ts';
import { profileDescription, withMeta } from './meta.ts';
import { HttpError, SECURITY_HEADERS, json, now, rateLimit, randomToken, readJson, sha256Hex, type Env } from './util.ts';

const LOGIN_TTL_S = 900;
const MAX_BATCH = 1000;
const MAX_EVENT_BATCH = 500; // keeps the single JSON parameter well under D1's 2 MB value limit
const BUCKET_FIELDS = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'] as const;

type Route = (req: Request, env: Env, params: Record<string, string>, ctx?: ExecutionContext) => Promise<Response>;

function redirect(location: string, cookies: string[] = []) {
  const h = new Headers({ location, ...SECURITY_HEADERS });
  for (const c of cookies) h.append('set-cookie', c);
  return new Response(null, { status: 303, headers: h });
}

const clientIp = (req: Request) => req.headers.get('cf-connecting-ip') ?? 'local';

/** Real calendar day between 2020-01-01 and tomorrow (UTC). Rejects junk like 9999-99-99. */
function validDay(day: unknown): boolean {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const t = Date.parse(day + 'T00:00:00Z');
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === day && day >= '2020-01-01' && t <= Date.now() + 864e5;
}
const validInstant = (s: unknown) => typeof s === 'string' && !Number.isNaN(Date.parse(s)) && validDay(new Date(s).toISOString().slice(0, 10));

/** Generous per-account ceilings so one account can't fill the shared database. */
const MAX_DAILY_ROWS_PER_USER = 200_000;
const MAX_ACCOUNT_EVENTS_PER_USER = 500_000;
const MAX_HEALTH_BYTES = 4000;

/** Sign-in failures go back to the app as a fixed code, never free text from the URL. */
const signinError = (code: 'not_configured' | 'failed' | 'expired' | 'rate_limited') => redirect(`/?error=${code}`);

// ---------- shared account operations (CLI API and dashboard forms) ----------

async function setUsernameFor(env: Env, userId: string, raw: unknown) {
  const name = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!USERNAME_RE.test(name)) throw new HttpError(400, 'Usernames are 3–30 characters: a–z, 0–9, _ or -, starting with a letter or digit');
  if (RESERVED.has(name)) throw new HttpError(400, 'That username is reserved');
  if (await env.DB.prepare('SELECT 1 FROM users WHERE username = ? AND id != ?').bind(name, userId).first()) throw new HttpError(409, 'That username is taken');
  const old = await env.DB.prepare('SELECT username FROM users WHERE id = ?').bind(userId).first<{ username: string | null }>();
  await env.DB.prepare('UPDATE users SET username = ? WHERE id = ?').bind(name, userId).run();
  await purgePublic(old?.username, name);
  return name;
}

/** Partial update: only flags present in `body` change. */
async function updateProfileFor(env: Env, userId: string, body: Record<string, unknown>) {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const f of PROFILE_FLAGS) if (typeof body[f] === 'boolean') { sets.push(`${f} = ?`); vals.push(body[f] ? 1 : 0); }
  if ('display_name' in body) {
    sets.push('display_name = ?');
    vals.push(typeof body.display_name === 'string' ? body.display_name.trim().slice(0, 60) || null : null);
  }
  if (body.is_public === true) {
    const u = await env.DB.prepare('SELECT username FROM users WHERE id = ?').bind(userId).first<{ username: string | null }>();
    if (!u?.username) throw new HttpError(400, 'Set a username first');
  }
  if (!sets.length) throw new HttpError(400, 'Nothing to update');
  await env.DB.prepare(`UPDATE profiles SET ${sets.join(', ')}, updated_at = ? WHERE user_id = ?`).bind(...vals, now(), userId).run();
  await purgePublic((await env.DB.prepare('SELECT username FROM users WHERE id = ?').bind(userId).first<{ username: string | null }>())?.username);
  return env.DB.prepare('SELECT * FROM profiles WHERE user_id = ?').bind(userId).first();
}

async function deleteDataFor(env: Env, userId: string, provider: string) {
  if (provider !== 'all' && !PROVIDERS.includes(provider as any)) throw new HttpError(400, 'Unknown provider');
  const filter = provider === 'all' ? '' : ' AND provider = ?';
  const bind = (sql: string) => (provider === 'all' ? env.DB.prepare(sql).bind(userId) : env.DB.prepare(sql).bind(userId, provider));
  await env.DB.batch([
    bind(`DELETE FROM usage_daily WHERE user_id = ?${filter}`),
    bind(`DELETE FROM usage_sessions WHERE user_id = ?${filter}`),
    bind(`DELETE FROM account_events WHERE user_id = ?${filter}`),
    // Collectors see the new marker on their next sync and re-upload their full history, so the server
    // never ends up with only the days that happened to change after a deletion.
    env.DB.prepare('UPDATE users SET data_reset_at = ? WHERE id = ?').bind(now(), userId),
  ]);
}

/** Deletes an account. Usage rows go first by user_id (their PK prefix) to avoid a device_id cascade scan. */
async function deleteAccountFor(env: Env, userId: string) {
  const u = await env.DB.prepare('SELECT username FROM users WHERE id = ?').bind(userId).first<{ username: string | null }>();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM usage_daily WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM usage_sessions WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM account_events WHERE user_id = ?').bind(userId),
    env.DB.prepare('DELETE FROM users WHERE id = ?').bind(userId), // cascades devices, profile, sessions, sync_log
  ]);
  await purgePublic(u?.username);
}

// ----- edge cache for public profiles (60 s; purged on profile/username changes in this location) -----
const publicCacheKey = (username: string) => new Request(`https://public-cache.internal/${username.toLowerCase()}`);
const avatarCacheKey = (username: string) => new Request(`https://public-cache.internal/avatar/${username.toLowerCase()}`);
async function purgePublic(...usernames: (string | null | undefined)[]) {
  for (const u of usernames) {
    if (!u) continue;
    await caches.default.delete(publicCacheKey(u)).catch(() => false);
    await caches.default.delete(avatarCacheKey(u)).catch(() => false);
  }
}

const deviceList = (env: Env, userId: string) =>
  env.DB.prepare('SELECT id, name, created_at, last_sync_at, collector_version, health_json FROM devices WHERE user_id = ? ORDER BY created_at').bind(userId).all<any>()
    .then((r) => r.results.map((d) => ({ ...d, health: safeJson(d.health_json), health_json: undefined })));

function safeJson(s: string | null): any {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

// ---------- CLI login (server-mediated GitHub device flow; the GitHub token never reaches the CLI) ----------

const loginStart: Route = async (req, env) => {
  await rateLimit(env, 'login', `start:${clientIp(req)}`);
  const body = await readJson(req);
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 60) : 'Collector';
  const previousTokenHash = typeof body.previous_token === 'string' && body.previous_token ? await sha256Hex(body.previous_token) : null;
  if (body.dev_user !== undefined) {
    const id = await devIdentity(env, req, String(body.dev_user));
    const u = await upsertUser(env, id.githubId, id.githubLogin);
    return json({ status: 'approved', ...(await createDevice(env, u.id, name, previousTokenHash)), new_account: u.created });
  }
  if (!env.GITHUB_CLIENT_ID) throw new HttpError(503, 'GitHub login is not configured on this server');
  const gh = await githubForm('https://github.com/login/device/code', { client_id: env.GITHUB_CLIENT_ID, scope: '' });
  if (!gh.device_code) throw new HttpError(502, gh.error_description ?? 'GitHub device flow failed');
  const loginId = randomToken();
  const interval = Number(gh.interval) || 5;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM login_requests WHERE expires_at < ?').bind(now()),
    env.DB.prepare('INSERT INTO login_requests (login_id_hash, github_device_code, device_name, previous_token_hash, interval_s, next_poll_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(await sha256Hex(loginId), gh.device_code, name, previousTokenHash, interval, now(),
        new Date(Date.now() + Math.min(Number(gh.expires_in) || LOGIN_TTL_S, LOGIN_TTL_S) * 1000).toISOString()),
  ]);
  return json({ status: 'pending', login_id: loginId, user_code: gh.user_code, verification_uri: gh.verification_uri, interval, expires_in: gh.expires_in });
};

const loginPoll: Route = async (req, env) => {
  await rateLimit(env, 'ingest', `poll:${clientIp(req)}`);
  const { login_id } = await readJson(req);
  const h = await sha256Hex(String(login_id ?? ''));
  const row = await env.DB.prepare('SELECT * FROM login_requests WHERE login_id_hash = ?').bind(h)
    .first<{ github_device_code: string; device_name: string; previous_token_hash: string | null; interval_s: number; next_poll_at: string; expires_at: string }>();
  if (!row || row.expires_at < now()) return json({ status: 'expired' }, 410);
  if (row.next_poll_at > now()) return json({ status: 'pending', interval: row.interval_s });
  const gh = await githubForm('https://github.com/login/oauth/access_token', {
    client_id: env.GITHUB_CLIENT_ID!, device_code: row.github_device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  });
  if (gh.error === 'authorization_pending' || gh.error === 'slow_down') {
    const interval = gh.error === 'slow_down' ? row.interval_s + 5 : row.interval_s;
    await env.DB.prepare('UPDATE login_requests SET interval_s = ?, next_poll_at = ? WHERE login_id_hash = ?')
      .bind(interval, new Date(Date.now() + interval * 1000).toISOString(), h).run();
    return json({ status: 'pending', interval });
  }
  await env.DB.prepare('DELETE FROM login_requests WHERE login_id_hash = ?').bind(h).run();
  if (!gh.access_token) return json({ status: gh.error === 'access_denied' ? 'denied' : 'expired' }, gh.error === 'access_denied' ? 403 : 410);
  const ghUser = await githubUser(gh.access_token);
  const u = await upsertUser(env, ghUser.id, ghUser.login);
  return json({ status: 'approved', ...(await createDevice(env, u.id, row.device_name, row.previous_token_hash)), new_account: u.created });
};

// ---------- CLI account API (device token) ----------

const me: Route = async (req, env) => {
  const d = await requireDevice(req, env);
  const [user, profile, devices] = await Promise.all([
    env.DB.prepare('SELECT github_login, username, created_at FROM users WHERE id = ?').bind(d.user_id).first(),
    env.DB.prepare('SELECT * FROM profiles WHERE user_id = ?').bind(d.user_id).first(),
    deviceList(env, d.user_id),
  ]);
  return json({ user, profile, devices: devices.map((x: any) => ({ id: x.id, name: x.name, created_at: x.created_at, last_sync_at: x.last_sync_at, collector_version: x.collector_version, current: x.id === d.id })) });
};

const apiSetUsername: Route = async (req, env) => {
  const d = await requireDevice(req, env);
  return json({ username: await setUsernameFor(env, d.user_id, (await readJson(req)).username) });
};

const apiUpdateProfile: Route = async (req, env) => json(await updateProfileFor(env, (await requireDevice(req, env)).user_id, await readJson(req)));

const apiDeleteDevice: Route = async (req, env, p) => {
  const d = await requireDevice(req, env);
  if (!(await deleteDeviceAndData(env, d.user_id, p.id))) throw new HttpError(404, 'Device not found');
  return json({ ok: true });
};

/** Sign-out from the CLI: this device's token stops working; its uploaded history is kept. */
const apiRevokeSelf: Route = async (req, env) => {
  const d = await requireDevice(req, env);
  await env.DB.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').bind(now(), d.id).run();
  return json({ ok: true });
};

const apiDeleteData: Route = async (req, env) => {
  const d = await requireDevice(req, env);
  await deleteDataFor(env, d.user_id, new URL(req.url).searchParams.get('provider') ?? 'all');
  return json({ ok: true });
};

const apiDeleteAccount: Route = async (req, env) => {
  const d = await requireDevice(req, env);
  if ((await readJson(req)).confirm !== 'delete my account') throw new HttpError(400, 'Confirmation text required');
  await deleteAccountFor(env, d.user_id);
  return json({ ok: true });
};

const serverSummary: Route = async (req, env) => {
  const d = await requireDevice(req, env);
  const daily = await dailyRows(env, d.user_id, '0000-01-01');
  const bySource = new Map<string, any>();
  for (const r of daily) {
    const s = bySource.get(r.usage_source) ?? { usage_source: r.usage_source, provider: r.provider, events: 0, first_day: r.day, last_day: r.day };
    s.events += r.events;
    if (r.day < s.first_day) s.first_day = r.day;
    if (r.day > s.last_day) s.last_day = r.day;
    bySource.set(r.usage_source, s);
  }
  return json({ sources: [...bySource.values()] });
};

// ---------- ingest ----------

function validBucketKey(b: any): boolean {
  return (
    PROVIDERS.includes(b?.provider) && USAGE_SOURCES.includes(b?.usage_source) && BILLING_MODES.includes(b?.billing_mode) &&
    MEASUREMENT_TYPES.includes(b?.measurement_type) && typeof b?.model_id === 'string' && b.model_id.length > 0 &&
    b.model_id.length <= 200 && validDay(b.day)
  );
}

const nullableNum = (v: unknown) => v === null || v === undefined || isNonNegNumber(v);

function validBucket(b: any): boolean {
  return (
    validBucketKey(b) && SOURCE_SCOPE[b.usage_source as keyof typeof SOURCE_SCOPE] === 'device' &&
    isNonNegInt(b.event_count) && isNonNegInt(b.incomplete_events) &&
    BUCKET_FIELDS.every((f) => b[f] === null || isNonNegInt(b[f])) && (b.session_count === null || isNonNegInt(b.session_count)) &&
    nullableNum(b.cost_usd) && nullableNum(b.billed_cost_usd) && (b.unpriced_events === undefined || isNonNegInt(b.unpriced_events))
  );
}

const ingestDaily: Route = async (req, env) => {
  const d = await requireDevice(req, env);
  await rateLimit(env, 'ingest', `ingest:${d.id}`);
  const body = await readJson(req);
  const buckets: any[] = Array.isArray(body.buckets) ? body.buckets : [];
  const deletes: any[] = Array.isArray(body.deletes) ? body.deletes : [];
  if (buckets.length > MAX_BATCH || deletes.length > MAX_BATCH) throw new HttpError(413, 'Too many items');
  const badB = buckets.findIndex((b) => !validBucket(b));
  if (badB >= 0) throw new HttpError(400, `Invalid bucket at index ${badB}`);
  if (deletes.some((b) => !validBucketKey(b))) throw new HttpError(400, 'Invalid delete key');
  const healthJson = body.health && typeof body.health === 'object' ? JSON.stringify(body.health) : null;
  if (healthJson && healthJson.length > MAX_HEALTH_BYTES) throw new HttpError(413, 'health too large');
  if (buckets.length) {
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM usage_daily WHERE user_id = ?').bind(d.user_id).first<{ n: number }>();
    if ((n?.n ?? 0) + buckets.length > MAX_DAILY_ROWS_PER_USER) throw new HttpError(413, 'Account storage limit reached. Contact support.');
  }

  // D1 caps bound parameters per query, so batches travel as one JSON parameter through json_each.
  const at = now();
  const stmts: D1PreparedStatement[] = [];
  if (deletes.length) {
    stmts.push(env.DB.prepare(
      `DELETE FROM usage_daily WHERE user_id = ?1 AND device_id = ?2 AND
        (provider || char(1) || usage_source || char(1) || model_id || char(1) || day || char(1) || billing_mode || char(1) || measurement_type)
        IN (SELECT json_extract(value, '$.provider') || char(1) || json_extract(value, '$.usage_source') || char(1) ||
                   json_extract(value, '$.model_id') || char(1) || json_extract(value, '$.day') || char(1) ||
                   json_extract(value, '$.billing_mode') || char(1) || json_extract(value, '$.measurement_type')
            FROM json_each(?3))`,
    ).bind(d.user_id, d.id, JSON.stringify(deletes)));
  }
  if (buckets.length) {
    stmts.push(env.DB.prepare(
      `INSERT INTO usage_daily (user_id, device_id, provider, usage_source, model_id, day, billing_mode, measurement_type,
         event_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, incomplete_events,
         cost_usd, billed_cost_usd, unpriced_events, session_count, synced_at)
       SELECT ?1, ?2, json_extract(value, '$.provider'), json_extract(value, '$.usage_source'), json_extract(value, '$.model_id'),
         json_extract(value, '$.day'), json_extract(value, '$.billing_mode'), json_extract(value, '$.measurement_type'),
         json_extract(value, '$.event_count'), json_extract(value, '$.input_tokens'), json_extract(value, '$.output_tokens'),
         json_extract(value, '$.cache_read_tokens'), json_extract(value, '$.cache_write_tokens'), json_extract(value, '$.incomplete_events'),
         json_extract(value, '$.cost_usd'), json_extract(value, '$.billed_cost_usd'), COALESCE(json_extract(value, '$.unpriced_events'), 0),
         json_extract(value, '$.session_count'), ?3
       FROM json_each(?4) WHERE true
       ON CONFLICT (user_id, device_id, provider, usage_source, model_id, day, billing_mode, measurement_type) DO UPDATE SET
         event_count = excluded.event_count, input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
         cache_read_tokens = excluded.cache_read_tokens, cache_write_tokens = excluded.cache_write_tokens,
         incomplete_events = excluded.incomplete_events, cost_usd = excluded.cost_usd, billed_cost_usd = excluded.billed_cost_usd,
         unpriced_events = excluded.unpriced_events, session_count = excluded.session_count, synced_at = excluded.synced_at`,
    ).bind(d.user_id, d.id, at, JSON.stringify(buckets)));
  }
  stmts.push(env.DB.prepare('UPDATE devices SET last_sync_at = ?, collector_version = ?, health_json = COALESCE(?, health_json) WHERE id = ?')
    .bind(at, String(body.collector_version ?? '').slice(0, 20) || null, healthJson, d.id));
  if (buckets.length || deletes.length) {
    stmts.push(env.DB.prepare('INSERT INTO sync_log (user_id, device_id, kind, at, detail_json) VALUES (?, ?, ?, ?, ?)')
      .bind(d.user_id, d.id, 'daily_sync', at, JSON.stringify({ buckets: buckets.length, deletes: deletes.length })));
  }
  await env.DB.batch(stmts);
  const reset = await env.DB.prepare('SELECT data_reset_at FROM users WHERE id = ?').bind(d.user_id).first<{ data_reset_at: string | null }>();
  return json({ ok: true, upserted: buckets.length, deleted: deletes.length, data_reset_at: reset?.data_reset_at ?? null });
};

const ingestSessions: Route = async (req, env) => {
  const d = await requireDevice(req, env);
  await rateLimit(env, 'ingest', `ingest:${d.id}`);
  const { sessions } = await readJson(req);
  if (!Array.isArray(sessions) || sessions.length > MAX_BATCH) throw new HttpError(400, 'Invalid sessions');
  const ok = sessions.every((s: any) =>
    PROVIDERS.includes(s?.provider) && typeof s.session_key === 'string' && /^[0-9a-f]{32}$/.test(s.session_key) &&
    validInstant(s.first_at) && validInstant(s.last_at) && isNonNegInt(s.event_count));
  if (!ok) throw new HttpError(400, 'Invalid session row');
  if (sessions.length) {
    await env.DB.prepare(
      `INSERT INTO usage_sessions (user_id, device_id, provider, session_key, first_at, last_at, event_count)
       SELECT ?1, ?2, json_extract(value, '$.provider'), json_extract(value, '$.session_key'), json_extract(value, '$.first_at'),
              json_extract(value, '$.last_at'), json_extract(value, '$.event_count')
       FROM json_each(?3) WHERE true
       ON CONFLICT (user_id, device_id, session_key) DO UPDATE SET
         first_at = excluded.first_at, last_at = excluded.last_at, event_count = excluded.event_count`,
    ).bind(d.user_id, d.id, JSON.stringify(sessions)).run();
  }
  return json({ ok: true, upserted: sessions.length });
};

/** Account-scoped events (Cursor CSV, OpenRouter), deduped per user by dedupe_key. */
const ingestEvents: Route = async (req, env) => {
  const d = await requireDevice(req, env);
  await rateLimit(env, 'ingest', `ingest:${d.id}`);
  const { events } = await readJson(req, 5_000_000);
  if (!Array.isArray(events) || events.length > MAX_EVENT_BATCH) throw new HttpError(400, `Send 1–${MAX_EVENT_BATCH} events per request`);
  for (let i = 0; i < events.length; i++) {
    const { cost_usd, billed_cost_usd, ...rest } = events[i] ?? {};
    const err = validateRecord({ ...rest, synced_at: null });
    if (err) throw new HttpError(400, `Event ${i}: ${err}`);
    if (!nullableNum(cost_usd) || !nullableNum(billed_cost_usd)) throw new HttpError(400, `Event ${i}: invalid cost`);
    if (!validInstant(rest.occurred_at)) throw new HttpError(400, `Event ${i}: occurred_at out of range`);
    if (SOURCE_SCOPE[rest.usage_source as keyof typeof SOURCE_SCOPE] !== 'account') {
      throw new HttpError(400, `Event ${i}: ${rest.usage_source} is uploaded as daily aggregates, not events`);
    }
  }
  const existing = await env.DB.prepare('SELECT COUNT(*) AS n FROM account_events WHERE user_id = ?').bind(d.user_id).first<{ n: number }>();
  if ((existing?.n ?? 0) + events.length > MAX_ACCOUNT_EVENTS_PER_USER) throw new HttpError(413, 'Account storage limit reached. Contact support.');
  const at = now();
  const rows = events.map((e: any) => ({
    dedupe_key: e.dedupe_key, provider: e.provider, model_id: e.model_id, occurred_at: new Date(e.occurred_at).toISOString(),
    input_tokens: e.input_tokens, output_tokens: e.output_tokens, cache_read_tokens: e.cache_read_tokens,
    cache_write_tokens: e.cache_write_tokens, event_count: e.event_count, usage_source: e.usage_source, measurement_type: e.measurement_type,
    billing_mode: e.billing_mode, provider_fields: JSON.stringify(sanitizeProviderFields(e.provider_fields)),
    cost_usd: e.cost_usd ?? null, billed_cost_usd: e.billed_cost_usd ?? null,
  }));
  const res = await env.DB.prepare(
    `INSERT INTO account_events (user_id, dedupe_key, provider, model_id, occurred_at, input_tokens, output_tokens,
       cache_read_tokens, cache_write_tokens, event_count, usage_source, measurement_type, billing_mode, provider_fields, cost_usd, billed_cost_usd, synced_at)
     SELECT ?1, json_extract(value, '$.dedupe_key'), json_extract(value, '$.provider'), json_extract(value, '$.model_id'),
       json_extract(value, '$.occurred_at'), json_extract(value, '$.input_tokens'), json_extract(value, '$.output_tokens'),
       json_extract(value, '$.cache_read_tokens'), json_extract(value, '$.cache_write_tokens'), json_extract(value, '$.event_count'),
       json_extract(value, '$.usage_source'), json_extract(value, '$.measurement_type'), json_extract(value, '$.billing_mode'),
       json_extract(value, '$.provider_fields'), json_extract(value, '$.cost_usd'), json_extract(value, '$.billed_cost_usd'), ?2
     FROM json_each(?3) WHERE true
     -- Cursor rows are immutable (duplicates ignored). OpenRouter days can be revised by the provider, so they upsert.
     ON CONFLICT (user_id, dedupe_key) DO UPDATE SET
       input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, cache_read_tokens = excluded.cache_read_tokens,
       cache_write_tokens = excluded.cache_write_tokens, event_count = excluded.event_count, cost_usd = excluded.cost_usd,
       billed_cost_usd = excluded.billed_cost_usd, provider_fields = excluded.provider_fields, synced_at = excluded.synced_at
     WHERE account_events.usage_source = 'openrouter_activity'`,
  ).bind(d.user_id, at, JSON.stringify(rows)).run();
  const inserted = res.meta.changes ?? 0;
  await env.DB.prepare('INSERT INTO sync_log (user_id, device_id, kind, at, detail_json) VALUES (?, ?, ?, ?, ?)')
    .bind(d.user_id, d.id, 'account_import', at, JSON.stringify({ received: events.length, inserted, duplicates: events.length - inserted })).run();
  return json({ inserted, duplicates: events.length - inserted });
};

function sanitizeProviderFields(pf: unknown): Record<string, string | number | boolean | null> {
  const allowed = ['kind', 'max_mode', 'cache_write_semantics', 'total_tokens_reported', 'reasoning_tokens', 'provider_name', 'input_includes_cache'];
  const out: Record<string, string | number | boolean | null> = {};
  if (pf && typeof pf === 'object') {
    for (const k of allowed) {
      const v = (pf as any)[k];
      if (v === null || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
      else if (typeof v === 'string') out[k] = v.slice(0, 80);
    }
  }
  return out;
}

// ---------- public profile ----------

/** Public pages always show the last 90 days, matching what the profile says. */
const PUBLIC_SINCE = () => new Date(Date.now() - 89 * 864e5).toISOString().slice(0, 10);

/** Only fields the owner explicitly enabled leave the server. */
async function publicProfile(env: Env, username: string, since: string): Promise<PublicProfile | null> {
  const row = await env.DB.prepare(
    'SELECT u.id, u.username, u.github_login, p.* FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.username = ? AND p.is_public = 1',
  ).bind(username.toLowerCase()).first<any>();
  if (!row) return null;
  const daily = await dailyRows(env, row.id, since);
  const shows = { tokens: !!row.show_token_totals, costs: !!row.show_costs, streaks: !!row.show_streaks };
  const out: PublicProfile = { username: row.username, display_name: row.display_name, since, shows };
  // When tracking started is activity information: only shared alongside the daily trend or streaks.
  if (row.show_daily_trend || row.show_streaks) out.first_day = daily.reduce<string | null>((min, r) => (min === null || r.day < min ? r.day : min), null);
  if (row.show_github) out.github = { login: row.github_login, avatar_url: `/api/avatar/${row.username}` };
  const pick = (r: any) => ({
    ...(row.show_providers ? { provider: r.provider, usage_source: r.usage_source } : {}),
    ...(row.show_models ? { model_id: r.model_id } : {}),
    ...(shows.tokens ? { input_tokens: r.input_tokens, output_tokens: r.output_tokens, cache_read_tokens: r.cache_read_tokens, cache_write_tokens: r.cache_write_tokens } : {}),
    ...(shows.costs ? { cost_usd: r.cost_usd, unpriced_events: r.unpriced_events } : {}),
  });
  // One history read serves both the contribution graph (past year) and the streak highlights.
  const history = row.show_daily_trend || shows.tokens || shows.costs || shows.streaks ? await allTimeDays(env, row.id) : [];
  if (row.show_daily_trend) {
    out.daily = daily.map((r) => ({ day: r.day, events: r.events, ...pick(r) }));
    out.contributions = contributionDays(history, shows.tokens);
  }
  if (row.show_models || row.show_providers || shows.tokens || shows.costs) {
    const groups = new Map<string, any>();
    for (const r of daily) {
      const k = [row.show_providers ? r.provider : '', row.show_models ? r.model_id : ''].join('\u0001');
      const base = pick(r);
      const g = groups.get(k) ?? { ...Object.fromEntries(Object.entries(base).map(([key, v]) => [key, typeof v === 'number' ? null : v])), events: 0 };
      g.events += r.events;
      for (const [key, v] of Object.entries(base)) if (typeof v === 'number') g[key] = (g[key] ?? 0) + v;
      groups.set(k, g);
    }
    out.breakdown = [...groups.values()];
  }
  if (row.show_sessions) {
    // Per-tool counts would reveal which tools are used; only split them when tools are public too.
    const counts = await sessionCounts(env, row.id, since);
    out.sessions = row.show_providers ? counts : { all: Object.values(counts).reduce((a, b) => a + b, 0) };
  }
  if (shows.tokens || shows.costs || shows.streaks) {
    const h = highlights(daily, activityStats(history));
    out.highlights = {
      ...(shows.tokens ? { totalTokens: h.totalTokens } : {}),
      ...(shows.costs ? { costUsd: h.costUsd, billedUsd: h.billedUsd } : {}),
      ...(shows.streaks ? {
        currentStreak: h.currentStreak, longestStreak: h.longestStreak, activeDays: h.activeDays,
        bestDay: h.bestDay ? (shows.tokens ? h.bestDay : { day: h.bestDay.day }) : null,
      } : {}),
    };
  }
  return out;
}

/** Public profile with a 60 s edge cache, shared by the JSON route and the share-preview shell. */
async function cachedPublicProfile(env: Env, ctx: ExecutionContext | undefined, username: string): Promise<PublicProfile | null> {
  const key = publicCacheKey(username);
  const hit = await caches.default.match(key).catch(() => undefined);
  if (hit) return hit.status === 404 ? null : hit.json<PublicProfile>();
  const prof = await publicProfile(env, username, PUBLIC_SINCE());
  const res = new Response(prof ? JSON.stringify(prof) : 'null', { status: prof ? 200 : 404, headers: { 'cache-control': 'public, max-age=60' } });
  const put = caches.default.put(key, res).catch(() => {});
  if (ctx) ctx.waitUntil(put); else await put;
  return prof;
}

/** A GitHub user's avatar, re-served from our origin (only real image types pass), or null. */
async function githubAvatar(githubId: number, cacheControl: string): Promise<Response | null> {
  const gh = await fetch(`https://avatars.githubusercontent.com/u/${githubId}?s=160&v=4`).catch(() => null);
  const type = gh?.headers.get('content-type') ?? '';
  if (!gh?.ok || !/^image\/(png|jpeg|gif|webp)$/.test(type)) return null;
  return new Response(gh.body, {
    headers: { 'content-type': type, 'cache-control': cacheControl, 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" },
  });
}

/**
 * GitHub avatar for a public profile that shows its GitHub account, served same-origin so the page's CSP stays
 * 'self' and viewers' browsers never contact GitHub. Cached for an hour; purged at the edge on profile changes.
 */
const publicAvatar: Route = async (req, env, p, ctx) => {
  const key = avatarCacheKey(p.username);
  const hit = await caches.default.match(key).catch(() => undefined);
  if (hit) return hit;
  const row = await env.DB.prepare(
    'SELECT u.github_id FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.username = ? AND p.is_public = 1 AND p.show_github = 1',
  ).bind(p.username.toLowerCase()).first<{ github_id: number }>();
  if (!row) throw new HttpError(404, 'Not found');
  const res = await githubAvatar(row.github_id, 'public, max-age=3600');
  if (!res) throw new HttpError(404, 'Not found');
  const put = caches.default.put(key, res.clone()).catch(() => {});
  if (ctx) ctx.waitUntil(put); else await put;
  return res;
};

/** The signed-in user's own GitHub avatar, whatever their profile settings; only ever cached by their browser. */
const webAvatar: Route = async (req, env) => {
  const u = await requireWebUser(req, env);
  const row = await env.DB.prepare('SELECT github_id FROM users WHERE id = ?').bind(u.id).first<{ github_id: number }>();
  const res = row && (await githubAvatar(row.github_id, 'private, max-age=3600'));
  if (!res) throw new HttpError(404, 'Not found');
  return res;
};

const publicProfileJson: Route = async (req, env, p, ctx) => {
  const prof = await cachedPublicProfile(env, ctx, p.username);
  if (!prof) throw new HttpError(404, 'Profile not found');
  return json(prof, 200, { 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
};

// ---------- web app (cookie session; the SPA in apps/web calls these) ----------

async function requireWebUser(req: Request, env: Env): Promise<User> {
  if (req.method !== 'GET' && req.method !== 'HEAD') checkOrigin(req);
  const u = await sessionUser(req, env);
  if (!u) throw new HttpError(401, 'Not signed in');
  return u;
}

const webSession: Route = async (req, env) => {
  const u = await sessionUser(req, env);
  return json({ user: u ? { github_login: u.github_login, username: u.username } : null });
};

const webDashboard: Route = async (req, env) => {
  const u = await requireWebUser(req, env);
  const { days, since } = sinceDays(req, 30);
  const [devices, rows, activity, profile, anyData, sessions] = await Promise.all([
    deviceList(env, u.id),
    dailyRows(env, u.id, since),
    allTimeActivity(env, u.id),
    env.DB.prepare('SELECT is_public FROM profiles WHERE user_id = ?').bind(u.id).first<{ is_public: number }>(),
    env.DB.prepare('SELECT EXISTS(SELECT 1 FROM usage_daily WHERE user_id = ?1) OR EXISTS(SELECT 1 FROM account_events WHERE user_id = ?1) AS any').bind(u.id).first<{ any: number }>(),
    sessionCounts(env, u.id, since),
  ]);
  const data: DashboardData = {
    origin: new URL(req.url).origin, since, days, has_data: !!anyData?.any, rows, sessions,
    highlights: highlights(rows, activity), devices, profile_public: !!profile?.is_public,
  };
  return json(data);
};

const webSettings: Route = async (req, env) => {
  const u = await requireWebUser(req, env);
  const [profile, devices] = await Promise.all([env.DB.prepare('SELECT * FROM profiles WHERE user_id = ?').bind(u.id).first<any>(), deviceList(env, u.id)]);
  return json({ user: { github_login: u.github_login, username: u.username }, profile, devices, origin: new URL(req.url).origin });
};

const webSetUsername: Route = async (req, env) => {
  const u = await requireWebUser(req, env);
  return json({ username: await setUsernameFor(env, u.id, (await readJson(req)).username) });
};

/** Live availability check for the onboarding/settings username field. */
const webUsernameAvailable: Route = async (req, env) => {
  const u = await requireWebUser(req, env);
  const name = (new URL(req.url).searchParams.get('name') ?? '').trim().toLowerCase();
  if (!USERNAME_RE.test(name)) return json({ available: false, reason: '3–30 characters: a–z, 0–9, _ or -, starting with a letter or digit' });
  if (RESERVED.has(name)) return json({ available: false, reason: 'That name is reserved' });
  const taken = await env.DB.prepare('SELECT 1 FROM users WHERE username = ? AND id != ?').bind(name, u.id).first();
  return json(taken ? { available: false, reason: 'Already taken' } : { available: true });
};

const webUpdateProfile: Route = async (req, env) => json(await updateProfileFor(env, (await requireWebUser(req, env)).id, await readJson(req)));

const webDeleteDevice: Route = async (req, env, p) => {
  const u = await requireWebUser(req, env);
  if (!(await deleteDeviceAndData(env, u.id, p.id))) throw new HttpError(404, 'Device not found');
  return json({ ok: true });
};

const webDeleteData: Route = async (req, env) => {
  const u = await requireWebUser(req, env);
  await deleteDataFor(env, u.id, new URL(req.url).searchParams.get('provider') ?? 'all');
  return json({ ok: true });
};

const webDeleteAccount: Route = async (req, env) => {
  const u = await requireWebUser(req, env);
  if ((await readJson(req)).confirm !== 'delete my account') throw new HttpError(400, 'Type "delete my account" to confirm.');
  await deleteAccountFor(env, u.id);
  return json({ ok: true }, 200, { 'set-cookie': await endSession(env, req) });
};

const webLogout: Route = async (req, env) => {
  checkOrigin(req);
  return json({ ok: true }, 200, { 'set-cookie': await endSession(env, req) });
};

// ---------- sign-in redirects ----------

const loginPage: Route = async (req, env) => {
  await rateLimit(env, 'login', `web:${clientIp(req)}`);
  if (await sessionUser(req, env)) return redirect('/dashboard');
  const dev = new URL(req.url).searchParams.get('dev');
  if (dev) {
    const id = await devIdentity(env, req, dev);
    const u = await upsertUser(env, id.githubId, id.githubLogin);
    return redirect('/dashboard', [await startSession(env, req, u.id)]);
  }
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return signinError('not_configured');
  return githubAuthorizeRedirect(env, req);
};

const authCallback: Route = async (req, env) => {
  let gh: { id: number; login: string };
  try {
    gh = await githubCallback(env, req);
  } catch (e) {
    console.error('github callback', e);
    return signinError('failed');
  }
  const existing = await findUserByGithub(env, gh.id);
  if (existing) {
    await upsertUser(env, gh.id, gh.login); // refreshes the stored GitHub login
    return redirect('/dashboard', [await startSession(env, req, existing.id), clearStateCookie(req)]);
  }
  // No account for this GitHub user: ask before creating one (see auth.ts, "Pending sign-up").
  return redirect('/welcome', [pendingCookie(req, await signPending(env.GITHUB_CLIENT_SECRET!, gh)), clearStateCookie(req)]);
};

/** The GitHub identity waiting for confirmation, if any (for the /welcome page). */
const webPending: Route = async (req, env) => {
  const p = await readPending(env, req);
  if (!p) throw new HttpError(404, 'No pending sign-up');
  return json({ github_login: p.login });
};

/** Creates the account for the pending GitHub identity and signs in. */
const webSignup: Route = async (req, env) => {
  checkOrigin(req);
  const p = await readPending(env, req);
  if (!p) throw new HttpError(400, 'This sign-up expired. Sign in with GitHub again.');
  const u = await upsertUser(env, p.id, p.login); // also safe if the account was created meanwhile
  const h = new Headers({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS });
  h.append('set-cookie', await startSession(env, req, u.id));
  h.append('set-cookie', clearPendingCookie(req));
  return new Response(JSON.stringify({ ok: true, created: u.created }), { headers: h });
};

const webSignupCancel: Route = async (req) => {
  checkOrigin(req);
  return json({ ok: true }, 200, { 'set-cookie': clearPendingCookie(req) });
};

/** /@username: the SPA shell with this profile's title and share-preview tags. */
const profileShell: Route = async (req, env, p, ctx) => {
  const username = decodeURIComponent(p.username).toLowerCase();
  const shell = await env.ASSETS.fetch(new Request(new URL('/', req.url)));
  const prof = await cachedPublicProfile(env, ctx, username);
  const res = new Response(shell.body, { status: prof ? 200 : 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': CSP, ...SECURITY_HEADERS } });
  return prof
    ? withMeta(res, { title: `@${prof.username} · AI coding usage`, description: profileDescription(prof), url: `${new URL(req.url).origin}/@${prof.username}` })
    : withMeta(res, { title: 'Not found · tokenburn', noindex: true });
};

/** Same policy as apps/web/public/_headers. Inline styles are allowed (UI libraries inject <style>; CSS cannot run code); scripts are same-origin only. */
const CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** Daily housekeeping: expired sign-ins/sessions, old sync history, old rate-limit windows. */
async function cleanup(env: Env) {
  const t = now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(Math.floor(Date.now() / 1000) - 3600),
    env.DB.prepare('DELETE FROM login_requests WHERE expires_at < ?').bind(t),
    env.DB.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').bind(t),
    env.DB.prepare('DELETE FROM sync_log WHERE at < ?').bind(new Date(Date.now() - 90 * 864e5).toISOString()),
    env.DB.prepare('DELETE FROM usage_sessions WHERE last_at < ?').bind(new Date(Date.now() - 730 * 864e5).toISOString()),
  ]);
}

/**
 * Pages has no cron triggers, so cleanup piggybacks on traffic: a small share of upload requests check
 * when it last ran and, if more than a day ago, run it after the response is sent.
 */
async function maybeCleanup(env: Env) {
  const last = await env.DB.prepare("SELECT value FROM app_meta WHERE key = 'last_cleanup'").first<{ value: string }>();
  if (last && Date.now() - Date.parse(last.value) < 864e5) return;
  await env.DB.prepare("INSERT INTO app_meta (key, value) VALUES ('last_cleanup', ?1) ON CONFLICT (key) DO UPDATE SET value = ?1").bind(now()).run();
  await cleanup(env);
}

/** Static files and SPA routes, with the same security headers as the Worker's own responses. */
async function serveAsset(req: Request, env: Env): Promise<Response> {
  const res = await env.ASSETS.fetch(req);
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  if ((out.headers.get('content-type') ?? '').includes('text/html')) out.headers.set('content-security-policy', CSP);
  if (new URL(req.url).protocol === 'https:') out.headers.set('strict-transport-security', 'max-age=31536000; includeSubDomains');
  return out;
}

// ---------- router ----------

const routes: [string, RegExp, Route][] = [
  ['GET', /^\/login$/, loginPage],
  ['GET', /^\/auth\/callback$/, authCallback],
  ['GET', /^\/(?:@|%40)(?<username>[\w-]+)\/?$/, profileShell],
  ['GET', /^\/api\/web\/session$/, webSession],
  ['GET', /^\/api\/web\/avatar$/, webAvatar],
  ['GET', /^\/api\/web\/pending$/, webPending],
  ['POST', /^\/api\/web\/signup$/, webSignup],
  ['POST', /^\/api\/web\/signup\/cancel$/, webSignupCancel],
  ['GET', /^\/api\/web\/dashboard$/, webDashboard],
  ['GET', /^\/api\/web\/settings$/, webSettings],
  ['PUT', /^\/api\/web\/username$/, webSetUsername],
  ['GET', /^\/api\/web\/username-available$/, webUsernameAvailable],
  ['PATCH', /^\/api\/web\/profile$/, webUpdateProfile],
  ['DELETE', /^\/api\/web\/devices\/(?<id>[\w-]+)$/, webDeleteDevice],
  ['DELETE', /^\/api\/web\/data$/, webDeleteData],
  ['DELETE', /^\/api\/web\/account$/, webDeleteAccount],
  ['POST', /^\/api\/web\/logout$/, webLogout],
  ['POST', /^\/api\/login\/start$/, loginStart],
  ['POST', /^\/api\/login\/poll$/, loginPoll],
  ['GET', /^\/api\/me$/, me],
  ['GET', /^\/api\/me\/summary$/, serverSummary],
  ['PUT', /^\/api\/me\/username$/, apiSetUsername],
  ['PATCH', /^\/api\/me\/profile$/, apiUpdateProfile],
  ['DELETE', /^\/api\/me\/data$/, apiDeleteData],
  ['DELETE', /^\/api\/me$/, apiDeleteAccount],
  ['DELETE', /^\/api\/devices\/(?<id>[\w-]+)$/, apiDeleteDevice],
  ['POST', /^\/api\/me\/revoke$/, apiRevokeSelf],
  ['POST', /^\/api\/ingest\/daily$/, ingestDaily],
  ['POST', /^\/api\/ingest\/sessions$/, ingestSessions],
  ['POST', /^\/api\/ingest\/events$/, ingestEvents],
  ['GET', /^\/api\/public\/(?<username>[\w-]+)$/, publicProfileJson],
  ['GET', /^\/api\/avatar\/(?<username>[\w-]+)$/, publicAvatar],
];

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const isApi = url.pathname.startsWith('/api/');
    if (url.pathname.startsWith('/api/ingest/') && Math.random() < 0.02) ctx.waitUntil(maybeCleanup(env).catch(() => {}));
    for (const [method, re, handler] of routes) {
      const m = re.exec(url.pathname);
      if (m && (req.method === method || (method === 'GET' && req.method === 'HEAD'))) {
        try {
          return await handler(req, env, m.groups ?? {}, ctx);
        } catch (e) {
          if (!(e instanceof HttpError)) console.error(e);
          const status = e instanceof HttpError ? e.status : 500;
          const message = e instanceof HttpError ? e.message : 'Internal error';
          return isApi ? json({ error: message }, status) : signinError(status === 503 ? 'not_configured' : status === 429 ? 'rate_limited' : 'failed');
        }
      }
    }
    if (isApi) return json({ error: 'Not found' }, 404);
    return serveAsset(req, env); // SPA routes and static files
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(cleanup(env));
  },
} satisfies ExportedHandler<Env>;
