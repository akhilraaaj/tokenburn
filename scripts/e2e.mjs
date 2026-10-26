// End-to-end check: the real CLI against a running local API (npm run dev:api, with DEV_LOGIN=1 in
// apps/api/.dev.vars). Fixtures only, in an isolated HOME.
//   node scripts/e2e.mjs [http://localhost:8787]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const API = process.argv[2] ?? 'http://localhost:8787';
const root = path.resolve(import.meta.dirname, '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-e2e-'));
const env = {
  ...process.env,
  HOME: home, // isolate from the real ~/.claude, ~/.codex, ...
  XDG_CONFIG_HOME: path.join(home, 'xdg'),
  XDG_DATA_HOME: path.join(home, 'xdg-data'),
  TOKENBURN_HOME: path.join(home, 'state'),
  TOKENBURN_API_URL: API,
  CLAUDE_CONFIG_DIR: path.join(root, 'fixtures/claude-code'),
  ANTHROPIC_API_KEY: '',
};
delete env.CODEX_HOME;
delete env.OPENROUTER_MANAGEMENT_KEY;
const cli = (...args) => execFileSync(process.execPath, [path.join(root, 'packages/collector/src/cli.ts'), ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const step = (s) => console.log(`✓ ${s}`);
// Deterministic prices: only claude-sonnet-4-6 is priced (values in LiteLLM's format, compacted).
fs.mkdirSync(env.TOKENBURN_HOME, { recursive: true });
fs.writeFileSync(path.join(env.TOKENBURN_HOME, 'prices.json'), JSON.stringify({
  fetched_at: new Date().toISOString(), table: { 'claude-sonnet-4-6': { input: 3e-6, output: 1.5e-5, cache_read: 3e-7, cache_write: 3.75e-6 } },
}));
// Browser session helper (what the React app does): manual redirects so we can read Set-Cookie.
let cookie = '';
async function web(method, p, body, origin = API) {
  const res = await fetch(API + p, {
    method, redirect: 'manual',
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { origin } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  // The sign-in rate limit (10/min per IP) may still be full from an earlier run: wait for the next window.
  if (res.status === 303 && (res.headers.get('location') ?? '').includes('rate_limited')) {
    await new Promise((r) => setTimeout(r, 61_000 - (Date.now() % 60_000)));
    return web(method, p, body, origin);
  }
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0].endsWith('=') ? '' : sc.split(';')[0];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, location: res.headers.get('location'), text, json };
}
const page = async (p) => {
  const r = await fetch(API + p);
  return { status: r.status, text: await r.text() };
};
const pub = async (u) => {
  const r = await fetch(`${API}/api/public/${u}?days=730`);
  return { status: r.status, json: r.ok ? await r.json() : null };
};

// A Codex session too, so the profile shows two tools (fixture built from codex-rs structs).
const codexFile = path.join(home, '.codex/sessions/2026/10/02/rollout-x.jsonl');
fs.mkdirSync(path.dirname(codexFile), { recursive: true });
const u = { input_tokens: 1200, cached_input_tokens: 800, cache_write_input_tokens: 0, output_tokens: 300, reasoning_output_tokens: 100, total_tokens: 1500 };
fs.writeFileSync(codexFile, [
  { timestamp: '2026-10-02T09:00:00.000Z', type: 'session_meta', payload: { id: 'codex-thread', cwd: '/Users/dev/secret-repo' } },
  { timestamp: '2026-10-02T09:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5-codex' } },
  { timestamp: '2026-10-02T09:00:05.000Z', type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: u, last_token_usage: u } } },
].map((x) => JSON.stringify(x)).join('\n') + '\n');

// GitHub CLI login: with no OAuth app configured the server says so (503); with one, it returns a device code.
const gh = await fetch(`${API}/api/login/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"x"}' });
const ghBody = await gh.json();
assert.ok(gh.status === 503 || (gh.status === 200 && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(ghBody.user_code)), `login/start ${gh.status} ${JSON.stringify(ghBody)}`);
step(gh.status === 503 ? 'GitHub login not configured → 503 with explanation' : 'GitHub device flow starts against the real OAuth app (code issued)');

const user = `e2e${Date.now().toString(36)}`;
let w = await web('GET', '/dashboard');
assert.equal(w.status, 200);
assert.match(w.text, /<div id="root">/); // SPA shell
assert.equal((await web('GET', '/api/web/dashboard')).status, 401);
w = await web('GET', `/login?dev=${user}`);
assert.equal(w.location, '/dashboard');
assert.ok(cookie.startsWith('tb_session='));
assert.equal((await web('GET', '/api/web/session')).json.user.username, user);
w = await web('GET', '/api/web/dashboard');
assert.equal(w.json.has_data, false);
assert.equal(w.json.devices.length, 0); // → React shows the get-started steps
step('web: GitHub-style sign-in (dev stand-in); dashboard API reports no machines yet (get-started)');

assert.match(cli('login', '--dev', user, '--name', 'E2E Mac'), new RegExp(`Signed in as ${user}`));
step('CLI sign-in with the same identity joins the same account');

const scan = cli('scan');
assert.match(scan, /Claude Code\s+\d+ files?/);
assert.match(scan, /Codex CLI\s+1 file/);
assert.match(scan, /nothing uploaded/);
assert.match(cli('status'), /On the server\n {2}nothing yet/);
step('scan collects Claude Code + Codex locally, uploads nothing');

assert.match(cli('sync', '--yes'), /Synced \d+ daily totals/);
assert.match(cli('sync', '--yes'), /Up to date\. Nothing new since the last sync/);
step('first sync (approved with --yes) + idempotent re-sync');

assert.match(cli('import-cursor', path.join(root, 'fixtures/cursor/usage-events.sample.csv'), '--yes'), /Synced 5 account rows/);
const st = cli('status');
assert.match(st, /Claude Code local transcripts\s+5 requests/);
assert.match(st, /Codex CLI local session files\s+1 request\b/);
assert.match(st, /Cursor usage CSV export\s+5 requests/);
step('Cursor import uploads immediately; server summary matches fixtures');

const stats = cli('stats', '--days', '365');
assert.match(stats, /Claude Code/);
assert.match(stats, /2\.7K output/); // 1519 + 734 + 300 + 100 + 60 = 2713
assert.match(stats, /Codex CLI/);
assert.match(stats, /\$0\.04 estimated cost/); // only claude-sonnet-4-6 priced: A 0.023844 + B 0.0115875 + D 0.00171
assert.match(stats, /longest 3 days/); // Oct 1-3 (Claude, Codex, Cursor fixtures)
step('stats renders totals, estimated cost, streaks');

w = await web('GET', '/api/web/dashboard?days=365');
const hl = w.json.highlights;
assert.ok(Math.abs(hl.costUsd - 0.0371415) < 1e-6, `cost ${hl.costUsd}`);
assert.equal(hl.longestStreak, 3);
assert.equal(hl.totalTokens, w.json.rows.reduce((n, r) => n + (r.input_tokens ?? 0) + (r.output_tokens ?? 0) + (r.cache_read_tokens ?? 0) + (r.cache_write_tokens ?? 0), 0));
assert.ok(hl.unpricedEvents > 0);
assert.equal(w.json.devices[0].name, 'E2E Mac'); // own dashboard may show device names
assert.ok(w.json.rows.some((r) => r.provider === 'cursor') && w.json.rows.some((r) => r.provider === 'codex'));
step('web dashboard API: highlights (tokens, cost, streaks), rows for all tools, machines');

assert.equal((await web('PATCH', '/api/web/profile', { is_public: true }, 'https://evil.example')).status, 403);
step('cross-site mutation rejected');

// Accounts are never created silently from a GitHub redirect: sign-up needs a valid, signed pending token.
assert.equal((await fetch(`${API}/api/web/pending`)).status, 404);
const forgedSignup = await fetch(`${API}/api/web/signup`, { method: 'POST', headers: { origin: API, cookie: 'tb_pending_signup=eyJpZCI6MSwibG9naW4iOiJ4IiwiZXhwIjo5OTk5OTk5OTk5OTk5fQ.forged' } });
assert.equal(forgedSignup.status, 400);
assert.equal((await fetch(`${API}/api/web/signup`, { method: 'POST', headers: { origin: 'https://evil.example' } })).status, 403);
step('sign-up requires a signed pending GitHub identity (forged/missing rejected)');

const avail = async (n) => (await web('GET', `/api/web/username-available?name=${encodeURIComponent(n)}`)).json;
assert.equal((await avail(user)).available, true); // your own current name counts as available
assert.equal((await avail(`${user}-free`)).available, true);
assert.deepEqual(await avail('admin'), { available: false, reason: 'That name is reserved' });
assert.equal((await avail('a!')).available, false);
assert.equal((await fetch(`${API}/api/web/username-available?name=x`)).status, 401);
step('username availability check (free, own, reserved, invalid, signed-out)');

assert.equal((await page(`/@${user}`)).status, 404);
assert.equal((await pub(user)).status, 404);
cli('profile', 'public');
let p = await pub(user);
assert.equal(p.status, 200);
// Only the GitHub account (on by default) is shown until usage fields are approved.
assert.deepEqual(Object.keys(p.json).sort(), ['display_name', 'github', 'shows', 'since', 'username']);
assert.equal(p.json.github.avatar_url, `/api/avatar/${user}`);
cli('profile', 'hide', 'github');
p = await pub(user);
assert.deepEqual(Object.keys(p.json).sort(), ['display_name', 'shows', 'since', 'username']); // nothing approved
assert.equal((await fetch(`${API}/api/avatar/${user}`)).status, 404); // hidden GitHub account: no avatar either
cli('profile', 'show', 'models');
p = await pub(user);
const models = p.json.breakdown.map((b) => b.model_id);
assert.ok(models.includes('claude-sonnet-4-6') && models.includes('gpt-5-codex'));
assert.ok(p.json.breakdown.every((b) => b.output_tokens === undefined && b.cost_usd === undefined)); // tokens/costs not approved
assert.equal(p.json.daily, undefined);
cli('profile', 'show', 'tokens,trend,providers,sessions');
assert.equal((await pub(user)).json.highlights.currentStreak, undefined); // streaks not approved
w = await web('PATCH', '/api/web/profile', { show_streaks: true });
assert.equal(w.status, 200);
p = await pub(user);
assert.equal(p.json.highlights.longestStreak, 3);
assert.equal(p.json.highlights.costUsd, undefined); // costs still off
assert.equal(p.json.sessions.claude_code, 2);
const shell = await page(`/@${user}`);
assert.equal(shell.status, 200);
assert.match(shell.text, new RegExp(`<title>@${user} · AI coding usage</title>`));
assert.match(shell.text, /property="og:description" content="Uses /);
for (const secret of ['E2E Mac', 'sess-1111', 'codex-thread', '/Users/dev', 'secret-repo', 'REDACTED']) {
  assert.ok(!JSON.stringify(p.json).includes(secret) && !shell.text.includes(secret), `profile leaks ${secret}`);
}
step('/@username: private by default, share-preview tags, only approved fields, leaks nothing');

assert.match(cli('profile', 'username', `${user}x`), new RegExp(`/@${user}x`));
assert.equal((await page(`/@${user}`)).status, 404);
assert.equal((await page(`/@${user}x`)).status, 200);
cli('profile', 'private');
assert.equal((await page(`/@${user}x`)).status, 404);
assert.equal((await pub(`${user}x`)).status, 404);
step('username change and going private take effect immediately');

// Same machine signs in again: device is resumed, nothing double counted.
const before = (await web('GET', '/api/web/dashboard?days=365')).json;
assert.match(cli('login', '--dev', user, '--name', 'E2E Mac'), /Signed in/);
cli('sync', '--yes');
let after = (await web('GET', '/api/web/dashboard?days=365')).json;
assert.equal(after.devices.length, 1);
assert.equal(after.highlights.totalTokens, before.highlights.totalTokens);
step('re-login on the same machine resumes its device (no double counting)');

// Sign out revokes the token but keeps history; signing back in resumes the same device.
assert.match(cli('logout'), /token is revoked/);
assert.throws(() => cli('sync', '--yes'), /Not signed in/);
after = (await web('GET', '/api/web/dashboard?days=365')).json;
assert.equal(after.highlights.totalTokens, before.highlights.totalTokens); // data kept
assert.match(cli('login', '--dev', user, '--name', 'E2E Mac'), /Signed in/);
cli('sync', '--yes');
after = (await web('GET', '/api/web/dashboard?days=365')).json;
assert.equal(after.devices.length, 1);
assert.equal(after.highlights.totalTokens, before.highlights.totalTokens);
step('logout revokes the token, keeps history; login resumes the same device');

// Deleting on the server makes collectors re-upload their full history on the next sync.
assert.equal((await web('DELETE', '/api/web/data?provider=claude_code')).status, 200);
assert.ok(!(await web('GET', '/api/web/dashboard?days=365')).json.rows.some((r) => r.provider === 'claude_code'));
cli('sync', '--yes');
after = (await web('GET', '/api/web/dashboard?days=365')).json;
assert.equal(after.highlights.totalTokens, before.highlights.totalTokens);
step('after a server-side delete, the next sync restores full history (not just changed days)');

// OpenRouter days can be revised by the provider: the server keeps the latest values.
const token = JSON.parse(fs.readFileSync(path.join(env.TOKENBURN_HOME, 'config.json'), 'utf8')).device_token;
const orEvent = (out) => ({
  provider: 'openrouter', model_id: 'openai/gpt-4.1', occurred_at: '2026-10-05T00:00:00.000Z', session_id: null, input_tokens: 10, output_tokens: out,
  cache_read_tokens: 0, cache_write_tokens: null, usage_source: 'openrouter_activity', measurement_type: 'measured', billing_mode: 'api',
  dedupe_key: 'or:e2e0000000000001', event_count: 2, provider_fields: {}, cost_usd: 0.01, billed_cost_usd: 0.01,
});
for (const out of [100, 250]) {
  const r = await fetch(`${API}/api/ingest/events`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ events: [orEvent(out)] }) });
  assert.equal(r.status, 200);
}
const orRows = (await web('GET', '/api/web/dashboard?days=365')).json.rows.filter((r) => r.provider === 'openrouter');
assert.equal(orRows.reduce((n, r) => n + r.output_tokens, 0), 250);
const badDay = await fetch(`${API}/api/ingest/events`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ events: [{ ...orEvent(1), occurred_at: '9999-01-01T00:00:00.000Z', dedupe_key: 'or:e2e0000000000002' }] }) });
assert.equal(badDay.status, 400);
step('OpenRouter revisions upsert; out-of-range dates rejected');

cli('delete', '--provider', 'cursor', '--yes');
assert.doesNotMatch(cli('status'), /Cursor usage CSV export/);
const devId = cli('devices').match(/\*.*?([0-9a-f-]{36})/)[1];
cli('devices', 'remove', devId);
assert.throws(() => cli('sync', '--yes'), /Unknown or revoked device/);
step('provider deletion and device revocation');

cli('login', '--dev', user, '--name', 'E2E Mac 2');
assert.match(cli('delete', '--account', '--confirm', 'delete my account'), /Account deleted/);
assert.equal((await page(`/@${user}x`)).status, 404);
step('account deletion');

fs.rmSync(home, { recursive: true, force: true });
console.log('\nAll end-to-end checks passed.');
