export interface Env {
  DB: D1Database;
  /** Built web app (apps/web/dist), served for every non-API path. */
  ASSETS: Fetcher;
  /** GitHub OAuth App client id (device flow enabled). Public value; no secret is needed for device flow. */
  GITHUB_CLIENT_ID?: string;
  /** Secret, set with `wrangler secret put GITHUB_CLIENT_SECRET`. Needed only for dashboard (web) sign-in. */
  GITHUB_CLIENT_SECRET?: string;
  /** "1" only in local .dev.vars: enables the no-GitHub dev login on localhost. */
  DEV_LOGIN?: string;
  /** Workers rate-limit bindings, if deployed as a Worker. On Pages they don't exist and D1 is used instead. */
  LOGIN_LIMITER?: RateLimit;
  INGEST_LIMITER?: RateLimit;
}

// lookup: the public username check; the landing page debounces and caches, so 30/min is far above real typing.
const LIMITS = { login: { limit: 10, windowS: 60 }, ingest: { limit: 60, windowS: 60 }, lookup: { limit: 30, windowS: 60 } } as const;

/**
 * Fixed-window rate limit. Uses the Workers binding when present; otherwise a single atomic D1 upsert
 * (one row write per call), since Cloudflare Pages has no rate-limiting binding. Throws 429 when exceeded.
 */
export async function rateLimit(env: Env, kind: keyof typeof LIMITS, key: string) {
  const binding = kind === 'login' ? env.LOGIN_LIMITER : kind === 'ingest' ? env.INGEST_LIMITER : undefined;
  if (binding) {
    const { success } = await binding.limit({ key });
    if (!success) throw new HttpError(429, 'Too many requests. Try again in a minute.');
    return;
  }
  const { limit, windowS } = LIMITS[kind];
  const windowStart = Math.floor(Date.now() / 1000 / windowS) * windowS;
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
     ON CONFLICT (key) DO UPDATE SET count = CASE WHEN window_start = excluded.window_start THEN count + 1 ELSE 1 END,
       window_start = excluded.window_start
     RETURNING count`,
  ).bind(`${kind}:${key}`, windowStart).first<{ count: number }>();
  if ((row?.count ?? 0) > limit) throw new HttpError(429, 'Too many requests. Try again in a minute.');
}

export const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
};



export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...headers },
  });

export async function readJson<T = any>(req: Request, maxBytes = 2_000_000): Promise<T> {
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > maxBytes) throw new HttpError(413, 'Payload too large');
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, 'Payload too large');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

export const now = () => new Date().toISOString();

export function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
