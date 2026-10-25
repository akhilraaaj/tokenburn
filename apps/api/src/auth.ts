// Authentication: device tokens (CLI), browser sessions (dashboard), and GitHub sign-in for both.
import { HttpError, now, randomToken, sha256Hex, type Env } from './util.ts';

export const USERNAME_RE = /^[a-z0-9][a-z0-9_-]{2,29}$/;
export const RESERVED = new Set(['admin', 'api', 'app', 'dashboard', 'settings', 'login', 'logout', 'signup', 'device', 'auth', 'about', 'help', 'support', 'www', 'root', 'me', 'privacy', 'terms']);
/** `__Host-` prefix (Secure, Path=/, no Domain) in production; plain name on http://localhost where Secure isn't usable everywhere. */
export const sessionCookieName = (req: Request) => (new URL(req.url).protocol === 'https:' ? '__Host-tb_session' : 'tb_session');
const DEVICE_IDLE_DAYS = 180;
const SESSION_DAYS = 30;
const STATE_COOKIE = 'tb_oauth_state';

export type Device = { id: string; user_id: string };
export type User = { id: string; github_login: string; username: string | null };

export const isLocalhost = (req: Request) => ['localhost', '127.0.0.1', '[::1]'].includes(new URL(req.url).hostname);
const secure = (req: Request) => (new URL(req.url).protocol === 'https:' ? '; Secure' : '');

export function getCookie(req: Request, name: string) {
  const m = (req.headers.get('cookie') ?? '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

/** CLI routes: Bearer device token. */
export async function requireDevice(req: Request, env: Env): Promise<Device> {
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) throw new HttpError(401, 'Missing device token');
  const d = await env.DB.prepare('SELECT id, user_id, created_at, last_sync_at, revoked_at FROM devices WHERE token_hash = ?')
    .bind(await sha256Hex(token)).first<Device & { created_at: string; last_sync_at: string | null; revoked_at: string | null }>();
  if (!d || d.revoked_at) throw new HttpError(401, 'Unknown or revoked device. Run `tokenburn login`.');
  // Tokens that haven't synced for DEVICE_IDLE_DAYS stop working (limits the life of a copied config).
  // Revoking keeps the machine's uploaded history; signing in again from it resumes the same device.
  const idleSince = d.last_sync_at ?? d.created_at;
  if (Date.parse(idleSince) < Date.now() - DEVICE_IDLE_DAYS * 864e5) {
    await env.DB.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').bind(now(), d.id).run();
    throw new HttpError(401, 'Unknown or revoked device (expired after 180 days without syncing). Run `tokenburn login`.');
  }
  return { id: d.id, user_id: d.user_id };
}

/** Browser routes: session cookie. */
export async function sessionUser(req: Request, env: Env): Promise<User | null> {
  const token = getCookie(req, sessionCookieName(req));
  if (!token) return null;
  return env.DB.prepare(
    `SELECT u.id, u.github_login, u.username FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`,
  ).bind(await sha256Hex(token), now()).first<User>();
}

/** Form posts from the dashboard must come from our own origin (CSRF); SameSite=Lax covers the cookie side. */
export function checkOrigin(req: Request) {
  const origin = req.headers.get('origin');
  if (!origin || origin !== new URL(req.url).origin) throw new HttpError(403, 'Bad origin');
}

export async function startSession(env: Env, req: Request, userId: string) {
  const token = randomToken();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').bind(now()),
    env.DB.prepare('INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .bind(await sha256Hex(token), userId, new Date(Date.now() + SESSION_DAYS * 864e5).toISOString()),
  ]);
  return `${sessionCookieName(req)}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure(req)}`;
}

export async function endSession(env: Env, req: Request) {
  const token = getCookie(req, sessionCookieName(req));
  if (token) await env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(await sha256Hex(token)).run();
  return `${sessionCookieName(req)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure(req)}`;
}

/** Finds or creates the account for a GitHub identity. New accounts get the GitHub login as username when it's free. */
export async function upsertUser(env: Env, githubId: number, githubLogin: string): Promise<{ id: string; created: boolean }> {
  const existing = await env.DB.prepare('SELECT id FROM users WHERE github_id = ?').bind(githubId).first<{ id: string }>();
  if (existing) {
    await env.DB.prepare('UPDATE users SET github_login = ? WHERE id = ?').bind(githubLogin, existing.id).run();
    return { id: existing.id, created: false };
  }
  const id = crypto.randomUUID();
  const candidate = githubLogin.toLowerCase();
  const free = USERNAME_RE.test(candidate) && !RESERVED.has(candidate) &&
    !(await env.DB.prepare('SELECT 1 FROM users WHERE username = ?').bind(candidate).first());
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, github_id, github_login, username, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, githubId, githubLogin, free ? candidate : null, now()),
    env.DB.prepare('INSERT INTO profiles (user_id, updated_at) VALUES (?, ?)').bind(id, now()),
  ]);
  return { id, created: true };
}

/**
 * Issues a device token. If `previousTokenHash` belongs to one of this user's devices (also a revoked one,
 * e.g. after `tokenburn logout`), that device is resumed with a fresh token instead of creating a
 * second device, which would otherwise upload the same machine's history twice.
 */
export async function createDevice(env: Env, userId: string, name: string, previousTokenHash: string | null = null) {
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  if (previousTokenHash) {
    const prev = await env.DB.prepare('SELECT id FROM devices WHERE token_hash = ? AND user_id = ?').bind(previousTokenHash, userId).first<{ id: string }>();
    if (prev) {
      await env.DB.prepare('UPDATE devices SET token_hash = ?, revoked_at = NULL, name = ? WHERE id = ?').bind(tokenHash, name, prev.id).run();
      return { token, device_id: prev.id, resumed: true };
    }
  }
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO devices (id, user_id, name, token_hash, created_at) VALUES (?, ?, ?, ?, ?)').bind(id, userId, name, tokenHash, now()).run();
  return { token, device_id: id, resumed: false };
}

/** Deletes a device and its uploaded rows. Child rows go first by (user_id, device_id), which matches the
 *  tables' primary-key prefix, so this never scans other users' rows (FK cascade by device_id would). */
export async function deleteDeviceAndData(env: Env, userId: string, deviceId: string): Promise<boolean> {
  const [, , del] = await env.DB.batch([
    env.DB.prepare('DELETE FROM usage_daily WHERE user_id = ? AND device_id = ?').bind(userId, deviceId),
    env.DB.prepare('DELETE FROM usage_sessions WHERE user_id = ? AND device_id = ?').bind(userId, deviceId),
    env.DB.prepare('DELETE FROM devices WHERE id = ? AND user_id = ?').bind(deviceId, userId),
  ]);
  return (del.meta.changes ?? 0) > 0;
}

/** Local development stand-in for GitHub: a stable negative id per name (never collides with GitHub ids). */
export async function devIdentity(env: Env, req: Request, login: string) {
  if (env.DEV_LOGIN !== '1' || !isLocalhost(req)) throw new HttpError(403, 'Dev login is disabled');
  const name = login.toLowerCase();
  if (!USERNAME_RE.test(name)) throw new HttpError(400, 'Invalid dev username');
  return { githubId: -parseInt((await sha256Hex(name)).slice(0, 8), 16), githubLogin: name };
}

export async function githubForm(url: string, body: Record<string, string>) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'tokenburn' },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new HttpError(502, `GitHub returned ${res.status}`);
  return res.json<any>();
}

/** Reads the GitHub user for an access token, then the token is dropped by the caller. */
export async function githubUser(accessToken: string) {
  const res = await fetch('https://api.github.com/user', {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/vnd.github+json', 'user-agent': 'tokenburn' },
  });
  if (!res.ok) throw new HttpError(502, 'Could not read GitHub user');
  return res.json<{ id: number; login: string }>();
}

// ----- GitHub web sign-in (authorization code flow; needs GITHUB_CLIENT_SECRET) -----

export function githubAuthorizeRedirect(env: Env, req: Request): Response {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) throw new HttpError(503, 'GitHub sign-in is not configured on this server');
  const state = randomToken(16);
  const origin = new URL(req.url).origin;
  const u = new URL('https://github.com/login/oauth/authorize');
  u.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  u.searchParams.set('redirect_uri', `${origin}/auth/callback`);
  u.searchParams.set('state', state);
  u.searchParams.set('scope', ''); // public profile only
  return new Response(null, {
    status: 302,
    headers: { location: u.toString(), 'set-cookie': `${STATE_COOKIE}=${state}; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=600${secure(req)}` },
  });
}

export const clearStateCookie = (req: Request) => `${STATE_COOKIE}=; Path=/auth; HttpOnly; SameSite=Lax; Max-Age=0${secure(req)}`;

export async function githubCallback(env: Env, req: Request): Promise<{ id: number; login: string }> {
  const url = new URL(req.url);
  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  if (!state || !code || state !== getCookie(req, STATE_COOKIE)) throw new HttpError(400, 'Sign-in expired or was tampered with. Try again.');
  const gh = await githubForm('https://github.com/login/oauth/access_token', {
    client_id: env.GITHUB_CLIENT_ID!, client_secret: env.GITHUB_CLIENT_SECRET!, code, redirect_uri: `${url.origin}/auth/callback`,
  });
  if (!gh.access_token) throw new HttpError(400, gh.error_description ?? 'GitHub sign-in failed');
  return githubUser(gh.access_token);
}
