// The Worker's page routes in the real Workers runtime (wrangler's local dev server: HTMLRewriter, Cache API, D1),
// with a small stand-in for the built app as its static assets: status codes, per-route meta tags, the profile
// page's embedded data, the sitemap.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { build } from 'esbuild';
import { getPlatformProxy, unstable_dev, type Unstable_DevWorker } from 'wrangler';

const apiDir = path.resolve(import.meta.dirname, '..');

/** A small index.html shaped like the real build: template meta tags, landing JSON-LD and a prerendered root. */
const SHELL = `<!doctype html><html><head><title>tokenburn · landing</title>
<meta name="description" content="Landing description"><link rel="canonical" href="https://tokenburn.pages.dev/">
<meta property="og:title" content="Landing"><meta property="og:type" content="website"><meta name="twitter:card" content="summary_large_image">
<script type="application/ld+json">{"@type":"FAQPage"}</script></head>
<body><div id="root"><main><h1>Every token you burn</h1></main></div></body></html>`;

let tmp: string;
let worker: Unstable_DevWorker;
let db: D1Database; // the same local database the dev server reads, for changes that bypass the API
let disposeProxy: () => Promise<void>;
const CAROL_SESSION = 'carol-session-token';
const ALICE_DEVICE = 'alice-device-token';
const BOB_DEVICE = 'bob-device-token';
const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const get = (p: string, init?: RequestInit) => worker.fetch(p, { redirect: 'manual', ...init } as any) as unknown as Promise<Response>;
const page = async (p: string) => {
  const res = await get(p);
  return { res, html: await res.text() };
};
const count = (html: string, s: string) => html.split(s).length - 1;
/** A page as a signed-in user sees it (session cookie name over http, see sessionCookieName). */
const page2 = async (p: string, session: string) => {
  const res = await get(p, { headers: { cookie: `tb_session=${session}` } });
  return { res, html: await res.text() };
};

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-worker-'));
  // The built app, as Pages serves it: files by path, index.html for any other path (single-page-application).
  fs.mkdirSync(path.join(tmp, 'public/assets'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'public/index.html'), SHELL);
  fs.writeFileSync(path.join(tmp, 'public/assets/app-abc123.js'), 'console.log(1)');
  await build({
    entryPoints: [path.join(apiDir, 'src/index.ts')], bundle: true, format: 'esm', platform: 'neutral', target: 'es2022',
    outfile: path.join(tmp, 'worker.js'), logLevel: 'error',
  });
  const config = path.join(tmp, 'wrangler.json');
  fs.writeFileSync(config, JSON.stringify({
    name: 'tokenburn-test',
    main: 'worker.js',
    compatibility_date: '2025-09-01',
    assets: { directory: 'public', binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: true },
    d1_databases: [{ binding: 'DB', database_name: 'tokenburn', database_id: 'local-test' }],
    vars: { DAILY_ROW_BUDGET: '40' }, // small, so the per-account daily write budget can be hit in a test
  }));
  const persist = path.join(tmp, 'state');

  // Schema and fixtures, written to the same local D1 the dev server then reads.
  const proxy = await getPlatformProxy<{ DB: D1Database }>({ configPath: config, persist: { path: path.join(persist, 'v3') } }); // unstable_dev's persistTo adds v3/
  db = proxy.env.DB;
  disposeProxy = () => proxy.dispose();
  for (const file of fs.readdirSync(path.join(apiDir, 'migrations')).sort()) {
    const sql = fs.readFileSync(path.join(apiDir, 'migrations', file), 'utf8').replace(/--.*$/gm, '');
    for (const stmt of sql.split(';').map((x) => x.trim()).filter(Boolean)) await db.prepare(stmt).run();
  }
  const t = new Date().toISOString();
  await db.batch([
    db.prepare("INSERT INTO users (id, github_id, github_login, username, created_at) VALUES ('u1', 1, 'alice-gh', 'alice', ?)").bind(t),
    db.prepare("INSERT INTO users (id, github_id, github_login, username, created_at) VALUES ('u2', 2, 'bob-gh', 'bob', ?)").bind(t),
    // A display name trying to break out of the embedded <script> and the summary HTML.
    db.prepare(`INSERT INTO profiles (user_id, is_public, display_name, show_providers, show_models, show_token_totals, show_streaks, updated_at)
                VALUES ('u1', 1, '</script><script>alert(1)</script>', 1, 1, 1, 1, ?)`).bind(t),
    db.prepare("INSERT INTO profiles (user_id, is_public, updated_at) VALUES ('u2', 0, ?)").bind(t),
    db.prepare("INSERT INTO users (id, github_id, github_login, username, created_at) VALUES ('u3', 3, 'carol-gh', 'carol', ?)").bind(t),
    db.prepare("INSERT INTO profiles (user_id, is_public, show_providers, updated_at) VALUES ('u3', 0, 1, ?)").bind(t),
    db.prepare('INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .bind(crypto.createHash('sha256').update(CAROL_SESSION).digest('hex'), 'u3', new Date(Date.now() + 864e5).toISOString()),
    db.prepare("INSERT INTO devices (id, user_id, name, token_hash, created_at) VALUES ('d1', 'u1', 'alice-mac', ?, ?)").bind(sha(ALICE_DEVICE), t),
    db.prepare("INSERT INTO devices (id, user_id, name, token_hash, created_at) VALUES ('d2', 'u2', 'bob-mac', ?, ?)").bind(sha(BOB_DEVICE), t),
  ]);

  worker = await unstable_dev(path.join(tmp, 'worker.js'), {
    config, persistTo: persist, logLevel: 'error', experimental: { disableExperimentalWarning: true },
  });
}, 60_000);

afterAll(async () => {
  await worker?.stop();
  await disposeProxy?.();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe('landing and app routes', () => {
  it('serves / as built: prerendered content and its structured data', async () => {
    const { res, html } = await page('/');
    expect(res.status).toBe(200);
    expect(html).toContain('<h1>Every token you burn</h1>');
    expect(html).toContain('FAQPage');
  });

  it('serves app routes as a bare, noindexed shell with one set of meta tags', async () => {
    for (const p of ['/dashboard', '/dashboard/settings', '/welcome', '/settings']) {
      const { res, html } = await page(p);
      expect(res.status, p).toBe(200);
      expect(html, p).toContain('<div id="root"></div>');
      expect(html, p).not.toContain('FAQPage');
      expect(html, p).toContain('<meta name="robots" content="noindex">');
      expect(count(html, 'name="description"'), p).toBe(1);
      expect(count(html, 'rel="canonical"'), p).toBe(0);
    }
  });

  it('answers unknown paths with a real 404', async () => {
    const { res, html } = await page('/no-such-page');
    expect(res.status).toBe(404);
    expect(html).toContain('<title>Not found · tokenburn</title>');
    expect(html).toContain('noindex');
    expect(html).toContain('<div id="root"></div>');
  });

  it('caches content-hashed assets for good', async () => {
    const res = await get('/assets/app-abc123.js');
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    await res.text();
  });
});

describe('/@username', () => {
  it('redirects other spellings to the one canonical URL', async () => {
    for (const p of ['/@Alice', '/@alice/', '/%40alice']) {
      const res = await get(p);
      expect(res.status, p).toBe(301);
      expect(res.headers.get('location'), p).toBe('/@alice');
      await res.text();
    }
  });

  it('renders a public profile: its own meta, canonical, JSON-LD, data and crawler summary', async () => {
    const { res, html } = await page('/@alice');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(html).toContain('<title>@alice · AI coding usage</title>');
    expect(count(html, 'name="description"')).toBe(1);
    expect(count(html, 'property="og:title"')).toBe(1);
    expect(html).not.toContain('Landing description');
    expect(html).toContain('<link rel="canonical" href="https://tokenburn.pages.dev/@alice">');
    expect(html).toContain('<meta property="og:type" content="profile">');
    expect(html).toContain('"@type":"ProfilePage"');
    expect(html).not.toContain('FAQPage');
    expect(html).not.toContain('Every token you burn');
    const data = /<script type="application\/json" id="profile-data">(.*?)<\/script>/.exec(html)?.[1];
    expect(JSON.parse(data!).username).toBe('alice');
    expect(html).toMatch(/<div id="root"><article [^>]*><h1>/);
  });

  it('escapes owner-provided text everywhere it lands', async () => {
    const { html } = await page('/@alice');
    // Only the shell's own JSON-LD/data scripts open; the display name never closes or opens one.
    expect(count(html, '<script>alert(1)')).toBe(0);
    expect(html).toContain('&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt; · AI coding usage</h1>');
    expect(html).toContain('\\u003c/script>\\u003cscript>alert(1)\\u003c/script>');
  });

  it('404s private, missing and malformed profiles without leaking data', async () => {
    for (const p of ['/@bob', '/@nobody', '/@ab']) {
      const { res, html } = await page(p);
      expect(res.status, p).toBe(404);
      expect(html, p).toContain('noindex');
      expect(html, p).not.toContain('profile-data');
      expect(html, p).not.toContain('bob-gh');
    }
  });
});

describe('publishing a profile', () => {
  it('shows the owner the change at once, even where a stale "private" answer is still cached', async () => {
    expect((await page('/@carol')).res.status).toBe(404); // a visitor's view while private: cached at the edge
    // Published, as seen from a data center the save's cache purge never reached.
    await db.prepare("UPDATE profiles SET is_public = 1 WHERE user_id = 'u3'").run();
    const visitor = await get('/api/public/carol');
    expect(visitor.status).toBe(404); // other visitors: up to 60 s stale, by design
    await visitor.text();

    const owner = await page2('/@carol', CAROL_SESSION);
    expect(owner.res.status).toBe(200);
    expect(owner.res.headers.get('cache-control')).toBe('no-cache'); // and browsers never reuse a stale copy
    expect(owner.html).toContain('id="profile-data"');
    // The owner's fresh read also refreshed this location's cache for everyone.
    const after = await get('/api/public/carol');
    expect(after.status).toBe(200);
    await after.text();
  });
});

describe('account-wide daily totals (Cursor, OpenRouter)', () => {
  const post = (p: string, device: string, body: unknown) =>
    get(p, { method: 'POST', headers: { authorization: `Bearer ${device}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const day = (usage_source: string, provider: string, model_id: string, event_count: number, output_tokens: number, extra = {}) => ({
    provider, usage_source, model_id, day: '2026-10-05', billing_mode: 'api', measurement_type: 'measured', event_count,
    input_tokens: 10, output_tokens, cache_read_tokens: 0, cache_write_tokens: null, incomplete_events: 0, cost_usd: 0.5,
    billed_cost_usd: null, unpriced_events: 0, session_count: null, ...extra,
  });
  const stored = (model: string) =>
    db.prepare("SELECT event_count, output_tokens FROM account_daily WHERE user_id = 'u1' AND model_id = ?").bind(model).first<{ event_count: number; output_tokens: number }>();

  it('keeps the larger Cursor day: overlapping exports from several machines never lower or double a day', async () => {
    for (const [events, out] of [[5, 500], [3, 300], [8, 800], [8, 999]]) {
      const res = await post('/api/ingest/account-daily', ALICE_DEVICE, { buckets: [day('cursor_csv', 'cursor', 'cursor-model', events, out)] });
      expect(res.status).toBe(200);
      await res.text();
    }
    // 5 → 3 (less complete export) ignored → 8 → a tie keeps what's there
    expect(await stored('cursor-model')).toEqual({ event_count: 8, output_tokens: 800 });
  });

  it('takes the latest OpenRouter day, which the provider can revise either way', async () => {
    for (const [events, out] of [[4, 400], [2, 250]]) {
      await (await post('/api/ingest/account-daily', ALICE_DEVICE, { buckets: [day('openrouter_activity', 'openrouter', 'or-model', events, out, { billed_cost_usd: 0.5 })] })).text();
    }
    expect(await stored('or-model')).toEqual({ event_count: 2, output_tokens: 250 });
  });

  it('deletes the keys a machine no longer has, and rejects device sources, bad days and bad keys', async () => {
    const del = await post('/api/ingest/account-daily', ALICE_DEVICE, { deletes: [{ provider: 'openrouter', usage_source: 'openrouter_activity', model_id: 'or-model', day: '2026-10-05', billing_mode: 'api', measurement_type: 'measured' }] });
    expect(del.status).toBe(200);
    await del.text();
    expect(await stored('or-model')).toBeNull();
    for (const body of [
      { buckets: [day('claude_code_jsonl', 'claude_code', 'x', 1, 1)] }, // device-scoped: goes to /api/ingest/daily
      { buckets: [day('cursor_csv', 'cursor', 'x', 1, 1, { day: '9999-01-01' })] },
      { buckets: [day('cursor_csv', 'cursor', 'x', -1, 1)] },
      { deletes: [{ provider: 'claude_code', usage_source: 'claude_code_jsonl', model_id: 'x', day: '2026-10-05', billing_mode: 'api', measurement_type: 'measured' }] },
    ]) {
      const res = await post('/api/ingest/account-daily', ALICE_DEVICE, body);
      expect(res.status).toBe(400);
      await res.text();
    }
  });

  it('feeds the stored days into the read side (the query behind dashboards and profiles)', async () => {
    // /api/me/summary is uncached and built on dailyRows, like the dashboard and the public profile.
    const res = await get('/api/me/summary', { headers: { authorization: `Bearer ${ALICE_DEVICE}` } });
    const { sources } = await res.json() as { sources: { usage_source: string; events: number; first_day: string }[] };
    expect(sources.find((x) => x.usage_source === 'cursor_csv')).toMatchObject({ events: 8, first_day: '2026-10-05' });
  });

  it('tells CLI 0.3.x to update instead of storing per-request rows', async () => {
    const res = await post('/api/ingest/events', ALICE_DEVICE, { events: [] });
    expect(res.status).toBe(426);
    expect((await res.json() as any).error).toContain('npm install -g use-tokenburn');
  });

  it("stops an account at its daily write budget without touching other accounts' uploads", async () => {
    const many = (n: number, from = 0) => Array.from({ length: n }, (_, i) => day('cursor_csv', 'cursor', `budget-${from + i}`, 1, 1));
    const first = await post('/api/ingest/account-daily', BOB_DEVICE, { buckets: many(30) });
    expect(first.status).toBe(200); // 30 of the test budget's 40
    await first.text();
    const over = await post('/api/ingest/account-daily', BOB_DEVICE, { buckets: many(20, 30) });
    expect(over.status).toBe(429);
    expect((await over.json() as any).error).toContain('tomorrow');
    const other = await post('/api/ingest/account-daily', ALICE_DEVICE, { buckets: [day('cursor_csv', 'cursor', 'still-fine', 1, 1)] });
    expect(other.status).toBe(200);
    await other.text();
  });
});

describe('sitemap and API errors', () => {
  it('lists the landing page and public profiles only', async () => {
    const res = await get('/sitemap.xml');
    expect(res.headers.get('content-type')).toContain('application/xml');
    const xml = await res.text();
    expect(xml).toContain('<loc>https://tokenburn.pages.dev/</loc>');
    expect(xml).toContain('<loc>https://tokenburn.pages.dev/@alice</loc>');
    expect(xml).not.toContain('@bob');
  });

  it('rejects a JSON body that is not an object with 400, not 500', async () => {
    const res = await get('/api/login/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Expected a JSON object' });
  });
});
