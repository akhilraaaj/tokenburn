#!/usr/bin/env node
// tokenburn — collects AI coding usage on this machine and publishes what you choose to /@username.
import './quiet.ts';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { BILLING_MODES, PROVIDERS, PROVIDER_LABELS, SOURCES, parseCursorCsv, type BillingMode, type Provider, type UsageRecord } from '../../shared/src/index.ts';
import { loadConfig, saveConfig, type Config } from './config.ts';
import { stateDir } from './paths.ts';
import { INTERVAL_MIN, installService, logPath, runningFromNpxCache, serviceStatus, uninstallService } from './service.ts';
import { LOCAL_SOURCES, type SourceContext } from './sources/index.ts';
import { autoImportCursorExports, defaultDownloadsDir } from './sources/cursor-downloads.ts';
import { collectOpenRouter } from './sources/openrouter.ts';
import { withLock } from './lock.ts';
import { loadPrices } from './prices.ts';
import { compact, renderStats } from './stats.ts';
import { Store } from './store.ts';
import { api, COLLECTOR_VERSION, planSync, runSync } from './sync.ts';

const HELP = `tokenburn ${COLLECTOR_VERSION} — your AI coding usage, collected locally, published as /@username

Getting started
  tokenburn setup                 Sign in with GitHub, preview, first sync, background service

Everyday
  tokenburn stats [--days 30]     Totals, est. cost, best day, streaks (this machine's data)
  tokenburn dashboard             Open your web dashboard (all machines)
  tokenburn status                Sources found, sync health, background service
  tokenburn sync                  Upload now (automatic sync does this every ${INTERVAL_MIN} min)

Public profile (private until you say so)
  tokenburn profile               Show settings and your profile URL
  tokenburn profile public|private
  tokenburn profile show <fields> Fields: providers, models, tokens, trend, sessions, streaks, costs (comma-separated)
  tokenburn profile hide <fields>
  tokenburn profile username <name>
  tokenburn profile name "<display name>"

Sources
  tokenburn scan                  Collect locally and preview; uploads nothing
  tokenburn import-cursor FILE    Import a Cursor usage CSV export
  tokenburn cursor auto-import on|off [--dir DIR]   Watch Downloads for new Cursor exports
  tokenburn connect openrouter    Save an OpenRouter management key locally
  tokenburn disconnect openrouter
  tokenburn config set billing-mode <provider> <subscription|api|unknown|auto>
  tokenburn config add-dir <provider> <dir>

Account & data
  tokenburn login | logout
  tokenburn devices [remove <id>]        Machines connected to your account
  tokenburn delete [--provider <name>] [--yes]   Delete uploaded usage (all providers by default)
  tokenburn delete --account             Delete your account and everything on the server
  tokenburn forget                       Delete all local state on this machine
  tokenburn service install|uninstall|status|logs   Automatic sync every ${INTERVAL_MIN} min (launchd/systemd)
  tokenburn watch                         Real-time sync while this terminal is open (optional)

Local state: ${stateDir()} (override with TOKENBURN_HOME)`;

const PROFILE_FIELDS: Record<string, string> = {
  providers: 'show_providers', models: 'show_models', tokens: 'show_token_totals', trend: 'show_daily_trend', sessions: 'show_sessions',
  streaks: 'show_streaks', costs: 'show_costs',
};

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const ctxOf = (cfg: Config): SourceContext => ({ extraDirs: cfg.extra_dirs, billingOverrides: cfg.billing_overrides });

async function ask(q: string): Promise<string> {
  if (!process.stdin.isTTY) return '';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(q);
  rl.close();
  return a.trim();
}

const confirm = async (q: string) => /^y(es)?$/i.test(await ask(`${q} [y/N] `));

async function askSecret(q: string): Promise<string> {
  if (!process.stdin.isTTY) return '';
  let muted = false;
  const out = new Writable({ write(chunk, _enc, cb) { if (!muted) process.stdout.write(chunk); cb(); } });
  const rl = readline.createInterface({ input: process.stdin, output: out, terminal: true });
  const p = rl.question(q);
  muted = true;
  const a = await p;
  rl.close();
  process.stdout.write('\n');
  return a.trim();
}

function openBrowser(url: string) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  execFile(cmd, [url], () => {});
}

// ---------- collection ----------

interface CollectResult {
  lines: string[];
  changed: number;
}

async function collectAll(store: Store, cfg: Config, opts: { network: boolean }): Promise<CollectResult> {
  const ctx = ctxOf(cfg);
  const lines: string[] = [];
  let changed = 0;
  for (const src of LOCAL_SOURCES) {
    const s = src.scan(store, ctx);
    changed += s.changedEvents;
    if (s.roots.length) {
      lines.push(`  ${src.label}: ${s.files} file(s), ${s.changedEvents} new/updated requests` +
        (s.malformedLines ? `, ${s.malformedLines} malformed lines skipped` : '') + ` · billing: ${src.billing(ctx).mode}`);
    }
  }
  if (cfg.cursor_auto_import) {
    const res = await autoImportCursorExports(store, cfg.downloads_dir ?? defaultDownloadsDir());
    for (const r of res) {
      changed += r.inserted;
      lines.push(r.error ? `  Cursor export ${r.file}: rejected (${r.error})` : `  Cursor export ${r.file}: ${r.inserted} new, ${r.duplicates} already imported`);
    }
  }
  if (opts.network && cfg.openrouter_key) {
    const last = store.getMeta('openrouter_activity_last_fetch_at');
    if (!last || Date.now() - Date.parse(last) > 6 * 3600e3) {
      try {
        const r = await collectOpenRouter(store, cfg.openrouter_key);
        changed += r.changed;
        lines.push(`  OpenRouter: ${r.rows} daily rows, ${r.changed} new/updated`);
      } catch (e) {
        lines.push(`  OpenRouter: ${(e as Error).message}`);
        store.setMeta('openrouter_last_error', (e as Error).message);
      }
    }
  }
  return { lines, changed };
}

function health(store: Store, cfg: Config) {
  const ctx = ctxOf(cfg);
  const sources: Record<string, unknown> = {};
  for (const src of LOCAL_SOURCES) {
    const roots = src.roots(ctx);
    if (!roots.length) continue;
    sources[src.usageSource] = {
      found: roots.length,
      malformed: store.malformedLines(roots),
      last_scan_at: store.getMeta(`${src.usageSource}_last_scan_at`) ?? null,
      billing_basis: src.billing(ctx).basis,
    };
  }
  if (cfg.cursor_auto_import) sources.cursor_csv = { auto_import: true };
  if (cfg.openrouter_key) sources.openrouter_activity = { last_fetch_at: store.getMeta('openrouter_activity_last_fetch_at') ?? null };
  return { sources, platform: os.platform() };
}

function previewTable(records: UsageRecord[]) {
  const groups = new Map<string, { provider: string; model: string; requests: number; input: number | null; output: number | null; first: string; last: string }>();
  for (const r of records) {
    const k = `${r.provider}\u0001${r.model_id}`;
    const g = groups.get(k) ?? { provider: PROVIDER_LABELS[r.provider], model: r.model_id, requests: 0, input: null, output: null, first: r.occurred_at, last: r.occurred_at };
    g.requests += r.event_count;
    if (r.input_tokens !== null) g.input = (g.input ?? 0) + r.input_tokens;
    if (r.output_tokens !== null) g.output = (g.output ?? 0) + r.output_tokens;
    if (r.occurred_at < g.first) g.first = r.occurred_at;
    if (r.occurred_at > g.last) g.last = r.occurred_at;
    groups.set(k, g);
  }
  if (!groups.size) return console.log('  (no usage found)');
  console.table([...groups.values()].map((g) => ({
    tool: g.provider, model: g.model, requests: g.requests, input: compact(g.input), output: compact(g.output),
    from: g.first.slice(0, 10), to: g.last.slice(0, 10),
  })));
}

async function doSync(store: Store, cfg: Config, opts: { yes: boolean; quiet?: boolean }) {
  if (!cfg.device_token) throw new Error('Not signed in. Run `tokenburn login` (or `tokenburn setup`).');
  await collectAll(store, cfg, { network: true });
  if (!cfg.first_sync_approved) {
    console.log('\nFirst sync. This is what gets summarized and uploaded:');
    previewTable(store.events());
    console.log('Uploaded: daily token totals per model, hashed session ids with first/last times, Cursor/OpenRouter rows.');
    console.log('Never uploaded: prompts, responses, code, file paths, project names, API keys.');
    if (!opts.yes && !(await confirm('Approve this upload?'))) {
      console.log('Nothing uploaded.');
      return false;
    }
    cfg.first_sync_approved = true;
    saveConfig(cfg);
  }
  const r = await withLock(async () => runSync(store, cfg, health(store, cfg), await loadPrices(), { force: true }), () => {
    throw new Error('Another tokenburn sync is running right now. Try again in a moment.');
  });
  if (!opts.quiet) {
    console.log(`Synced: ${r.buckets} daily totals updated, ${r.deletedBuckets} removed, ${r.sessions} sessions, ` +
      `${r.accountInserted} account rows new / ${r.accountDuplicates} already on server.`);
  }
  return true;
}

// ---------- login ----------

async function login(store: Store, cfg: Config, args: string[]) {
  cfg.api_url = flag(args, '--api') ?? cfg.api_url;
  const name = flag(args, '--name') ?? `${os.platform() === 'darwin' ? 'Mac' : os.platform()} (${os.userInfo().username === 'root' ? 'root' : 'collector'})`;
  const dev = flag(args, '--dev');
  const anon = { ...cfg, device_token: null };
  // Same machine signing in again: send the old token so the server resumes this device instead of
  // creating a second one (which would upload this machine's history twice).
  const previous_token = cfg.device_token ?? cfg.previous_token ?? undefined;
  let res = await api(anon, 'POST', '/api/login/start', { name, previous_token, ...(dev ? { dev_user: dev } : {}) });
  if (res.status !== 'approved') {
    console.log(`\nSign in with GitHub: open ${res.verification_uri} and enter the code\n\n    ${res.user_code}\n`);
    if (typeof res.verification_uri === 'string' && res.verification_uri.startsWith('https://github.com/')) openBrowser(res.verification_uri);
    const deadline = Date.now() + (res.expires_in ?? 900) * 1000;
    let interval = res.interval ?? 5;
    const loginId = res.login_id;
    for (;;) {
      if (Date.now() > deadline) throw new Error('Code expired. Run `tokenburn login` again.');
      await new Promise((r) => setTimeout(r, interval * 1000));
      try {
        res = await api(anon, 'POST', '/api/login/poll', { login_id: loginId });
      } catch (e) {
        if (/→ 403/.test(String(e))) throw new Error('Sign-in was denied on GitHub.');
        if (/→ 410/.test(String(e))) throw new Error('Code expired. Run `tokenburn login` again.');
        throw e;
      }
      if (res.status === 'approved') break;
      interval = res.interval ?? interval;
    }
  }
  const sameDevice = res.resumed && cfg.device_id === res.device_id;
  if (!sameDevice) store.resetUploadState();
  Object.assign(cfg, { device_token: res.token, device_id: res.device_id, previous_token: null, first_sync_approved: sameDevice ? cfg.first_sync_approved : false });
  saveConfig(cfg);
  const me = await api(cfg, 'GET', '/api/me');
  console.log(`Signed in as ${me.user.github_login}${res.new_account ? ' (new account)' : ''}.` +
    (me.user.username ? ` Your profile URL will be ${new URL(`/@${me.user.username}`, cfg.api_url)}` : ' Pick a username: tokenburn profile username <name>'));
}

// ---------- commands ----------

async function profileCmd(cfg: Config, args: string[]) {
  if (!cfg.device_token) throw new Error('Not signed in. Run `tokenburn login`.');
  const [sub, ...rest] = args;
  const value = rest.join(' ').trim();
  if (sub === 'username') {
    const r = await api(cfg, 'PUT', '/api/me/username', { username: value });
    console.log(`Username set: ${new URL(`/@${r.username}`, cfg.api_url)}`);
  } else if (sub === 'name') {
    await api(cfg, 'PATCH', '/api/me/profile', { display_name: value || null });
  } else if (sub === 'public' || sub === 'private') {
    await api(cfg, 'PATCH', '/api/me/profile', { is_public: sub === 'public' });
  } else if (sub === 'show' || sub === 'hide') {
    const fields = value.split(/[,\s]+/).filter(Boolean);
    const unknown = fields.filter((f) => !PROFILE_FIELDS[f] && f !== 'all');
    if (!fields.length || unknown.length) throw new Error(`Fields: ${Object.keys(PROFILE_FIELDS).join(', ')}, all`);
    const keys = fields.includes('all') ? Object.values(PROFILE_FIELDS) : fields.map((f) => PROFILE_FIELDS[f]);
    await api(cfg, 'PATCH', '/api/me/profile', Object.fromEntries(keys.map((k) => [k, sub === 'show'])));
  } else if (sub) {
    throw new Error('Unknown profile command. See `tokenburn help`.');
  }
  const me = await api(cfg, 'GET', '/api/me');
  const p = me.profile;
  const url = me.user.username ? new URL(`/@${me.user.username}`, cfg.api_url).toString() : '(no username yet)';
  console.log(`Profile: ${url}  ${p.is_public ? '[PUBLIC]' : '[private]'}`);
  if (p.display_name) console.log(`Display name: ${p.display_name}`);
  console.log('Shown publicly:');
  for (const [field, key] of Object.entries(PROFILE_FIELDS)) console.log(`  ${p[key] ? '✓' : '·'} ${field}`);
  if (!p.is_public) console.log('Nothing is visible until you run `tokenburn profile public`.');
}

async function statusCmd(store: Store, cfg: Config) {
  const ctx = ctxOf(cfg);
  console.log(`Server:   ${cfg.api_url} (${cfg.device_token ? 'signed in' : 'not signed in'})`);
  console.log(`Auto sync: ${serviceStatus()}`);
  console.log(`Last sync: ${store.getMeta('last_sync_at') ?? 'never'}`);
  const err = store.getMeta('last_sync_error');
  if (err) console.log(`Last error: ${err}`);
  console.log('\nSources on this machine:');
  for (const src of LOCAL_SOURCES) {
    const roots = src.roots(ctx);
    console.log(`  ${roots.length ? '✓' : '·'} ${src.label.padEnd(14)} ${roots.length ? `${roots.length} location(s), billing ${src.billing(ctx).mode} (${src.billing(ctx).basis})` : 'not found'}`);
  }
  console.log(`  ${cfg.cursor_auto_import ? '✓' : '·'} Cursor         ${cfg.cursor_auto_import ? `auto-import from ${cfg.downloads_dir ?? defaultDownloadsDir()}` : 'manual: tokenburn import-cursor FILE (or cursor auto-import on)'}`);
  console.log(`  ${cfg.openrouter_key ? '✓' : '·'} OpenRouter     ${cfg.openrouter_key ? `last fetch ${store.getMeta('openrouter_activity_last_fetch_at') ?? 'never'}` : 'not connected (tokenburn connect openrouter)'}`);
  if (cfg.device_token) {
    try {
      const s = await api(cfg, 'GET', '/api/me/summary');
      console.log('\nOn the server:');
      for (const x of s.sources) console.log(`  ${SOURCES[x.usage_source as keyof typeof SOURCES]?.label ?? x.usage_source}: ${x.events.toLocaleString('en-US')} requests, ${x.first_day} → ${x.last_day}`);
      if (!s.sources.length) console.log('  nothing yet');
    } catch (e) {
      console.log(`\nServer unreachable: ${(e as Error).message}`);
    }
  }
}

async function setup(store: Store, cfg: Config, args: string[]) {
  console.log('tokenburn setup\n');
  if (!cfg.device_token || flag(args, '--api')) await login(store, cfg, args);
  console.log('\nLooking for AI coding tools on this machine…');
  const c = await collectAll(store, cfg, { network: true });
  c.lines.forEach((l) => console.log(l));
  if (!c.lines.length) console.log('  none found yet (Claude Code, Grok CLI, Hermes). You can still import Cursor exports.');

  if (!cfg.cursor_auto_import && process.stdin.isTTY) {
    console.log('\nCursor has no usage API. Export your usage CSV from cursor.com → Dashboard → Usage when you like;');
    if (await confirm(`Automatically import Cursor exports saved to ${defaultDownloadsDir()}?`)) {
      cfg.cursor_auto_import = true;
      saveConfig(cfg);
      (await collectAll(store, cfg, { network: false })).lines.forEach((l) => console.log(l));
    }
  }
  const synced = await doSync(store, cfg, { yes: args.includes('--yes') });
  if (!synced) return;

  if (args.includes('--no-service')) {
    console.log('\nAutomatic sync not turned on. Run `tokenburn sync` when you like, or `tokenburn service install` later.');
  } else if (runningFromNpxCache()) {
    console.log('\nTo sync automatically, install it permanently first:\n  npm install -g tokenburn && tokenburn service install');
  } else if (args.includes('--yes') || (await confirm(`\nSync automatically every ${INTERVAL_MIN} minutes? (nothing stays running between syncs)`))) {
    console.log(installService());
  }
  console.log('\nDone. Next:\n  tokenburn stats              see your usage\n  tokenburn profile public     publish /@username (choose fields with `profile show`)');
}

/**
 * Run by the OS scheduler every few minutes. Never prompts; logs one line when something changed
 * or failed. Skips silently until the user has approved a first sync interactively.
 */
async function autoSync(store: Store, cfg: Config) {
  const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
  try {
    fs.chmodSync(logPath(), 0o600);
    const st = fs.statSync(logPath());
    if (st.size > 1_000_000) fs.writeFileSync(logPath(), fs.readFileSync(logPath(), 'utf8').slice(-100_000));
  } catch {}
  if (!cfg.device_token || !cfg.first_sync_approved) return log('skipped: run `tokenburn setup` to sign in and approve the first sync');
  try {
    const r = await withLock(async () => {
      await collectAll(store, cfg, { network: true });
      return runSync(store, cfg, health(store, cfg), await loadPrices());
    }, () => null);
    if (!r) return; // another sync (manual, watch) is running; the next scheduled run catches up
    store.setMeta('last_sync_error', '');
    if (r.buckets || r.deletedBuckets || r.sessions || r.accountInserted) {
      log(`synced ${r.buckets} daily totals, ${r.sessions} sessions, ${r.accountInserted} account rows`);
    }
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    store.setMeta('last_sync_error', `${new Date().toISOString()} ${msg}`);
    log(`error: ${msg}`);
    process.exitCode = 1;
  }
}

async function watch(store: Store, cfg: Config) {
  if (!cfg.device_token || !cfg.first_sync_approved) throw new Error('Run `tokenburn setup` (or login + an approved sync) first.');
  const ctx = ctxOf(cfg);
  let timer: NodeJS.Timeout | null = null;
  let busy = false;
  const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const fresh = loadConfig(); // pick up `profile`/`cursor` changes made from another terminal
      const r = await withLock(async () => {
        await collectAll(store, fresh, { network: true });
        return runSync(store, fresh, health(store, fresh), await loadPrices());
      }, () => null);
      if (r && (r.buckets || r.sessions || r.accountInserted)) log(`synced ${r.buckets} daily totals, ${r.sessions} sessions, ${r.accountInserted} account rows`);
      store.setMeta('last_sync_error', '');
    } catch (e) {
      store.setMeta('last_sync_error', String((e as Error).message ?? e));
      log(`error: ${(e as Error).message ?? e}`);
    } finally {
      busy = false;
    }
  };
  const schedule = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(tick, ms);
  };
  for (const src of LOCAL_SOURCES) {
    if (!src.watchExtensions.length) continue;
    for (const root of src.roots(ctx)) {
      try {
        fs.watch(root, { recursive: true }, (_e, name) => {
          if (name && src.watchExtensions.some((x) => name.toString().endsWith(x))) schedule(5000);
        });
      } catch {
        log(`can't watch ${root}; polling instead`);
      }
    }
  }
  // Poll fallback for missed events, SQLite-based sources, Downloads and OpenRouter. Unchanged files cost one stat().
  setInterval(() => schedule(0), 120_000);
  log(`watching (${LOCAL_SOURCES.filter((s) => s.roots(ctx).length).map((s) => s.label).join(', ') || 'no local sources yet'})`);
  await tick();
  await new Promise(() => {});
}

/** Snapshot-key prefixes each source uses for parse progress (see sources/*.ts). */
const SNAPSHOT_PREFIXES: Partial<Record<Provider, string[]>> = {
  codex: ['codex:'], gemini_cli: ['gemini:'], opencode: ['opencode:'], grok_cli: ['grok_cli:'], hermes: ['hermes:'],
};

/** Clears parse progress for one provider (or all), so its data is re-collected without touching others. */
function clearProviderState(store: Store, cfg: Config, provider: Provider | null) {
  if (!provider) {
    store.db.exec('DELETE FROM files; DELETE FROM snapshots; DELETE FROM imported_files;');
    return;
  }
  const ctx = ctxOf(cfg);
  const roots = [
    ...LOCAL_SOURCES.filter((s) => s.provider === provider).flatMap((s) => s.roots(ctx)),
    ...(provider === 'cursor' ? [cfg.downloads_dir ?? defaultDownloadsDir()] : []),
  ];
  store.clearSourceState(roots, SNAPSHOT_PREFIXES[provider] ?? []);
  if (provider === 'openrouter') store.setMeta('openrouter_activity_last_fetch_at', '');
}

/**
 * Revokes this machine's token on the server so a copied config can't keep using it. The machine's
 * uploaded history is kept; signing in again from here resumes the same device.
 */
async function revokeThisDevice(cfg: Config) {
  if (!cfg.device_token) return;
  try {
    await api(cfg, 'POST', '/api/me/revoke');
  } catch (e) {
    if (!/→ 401/.test(String(e))) console.warn(`Warning: couldn't revoke this device on the server (${(e as Error).message}). Remove it in Settings → Machines.`);
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return console.log(HELP);
  if (cmd === '--version' || cmd === 'version') return console.log(COLLECTOR_VERSION);
  const cfg = loadConfig();

  if (cmd === 'forget') {
    if (!(await confirm(`Delete ${stateDir()} (local usage DB, config, device token, saved keys)?`))) return;
    await revokeThisDevice(cfg);
    uninstallService();
    fs.rmSync(stateDir(), { recursive: true, force: true });
    return console.log('Local state deleted and this machine signed out. Its uploaded history stays on the server\n' +
      '(remove it in Settings → Machines, or run `tokenburn delete` before `forget` next time).');
  }

  const store = new Store(stateDir());
  switch (cmd) {
    case 'setup':
      return setup(store, cfg, args);
    case 'login':
      return login(store, cfg, args);
    case 'logout': {
      await revokeThisDevice(cfg);
      // Keep device_id and the old token locally so a later login resumes this device (no double counting).
      Object.assign(cfg, { previous_token: cfg.device_token, device_token: null, first_sync_approved: false });
      saveConfig(cfg);
      uninstallService();
      return console.log('Signed out: this machine\'s token is revoked and automatic sync is off. Uploaded data stays until you delete it.');
    }
    case 'scan': {
      const c = await collectAll(store, cfg, { network: true });
      console.log('Sources:');
      c.lines.forEach((l) => console.log(l));
      if (!c.lines.length) console.log('  none found');
      console.log('\nCollected on this machine (nothing uploaded):');
      previewTable(store.events());
      const plan = planSync(store, cfg, await loadPrices());
      console.log(`Next sync would upload ${plan.bucketUpserts.length} daily totals, ${plan.sessionUpserts.length} hashed session summaries, ${plan.accountEvents.length} account rows.`);
      return;
    }
    case 'sync':
      if (args.includes('--auto')) return autoSync(store, cfg);
      await doSync(store, cfg, { yes: args.includes('--yes') });
      return;
    case 'watch':
      return watch(store, cfg);
    case 'stats': {
      await collectAll(store, cfg, { network: false });
      return console.log(renderStats(store.events(), Math.min(Math.max(Number(flag(args, '--days') ?? 30) || 30, 1), 365), await loadPrices()));
    }
    case 'status':
      return statusCmd(store, cfg);
    case 'dashboard': {
      const url = new URL('/dashboard', cfg.api_url).toString();
      openBrowser(url);
      return console.log(`Opening ${url} (sign in with the same GitHub account)`);
    }
    case 'profile':
      return profileCmd(cfg, args);

    case 'import-cursor': {
      const file = args[0];
      if (!file) throw new Error('Usage: tokenburn import-cursor FILE.csv');
      const r = await parseCursorCsv(fs.readFileSync(file, 'utf8'));
      if (r.fatal) throw new Error(r.fatal);
      console.log(`Rows: ${r.totalRows}, valid: ${r.records.length}, invalid: ${r.errors.length}, duplicate rows in file: ${r.duplicateRowsInFile}`);
      console.log('Column mapping:', r.headerMapping);
      r.errors.slice(0, 10).forEach((e) => console.log(`  line ${e.line}: ${e.reason}`));
      if (r.cacheWriteUnknownRows) console.log(`Cache-write tokens unknown for ${r.cacheWriteUnknownRows} rows (totals didn't confirm column semantics).`);
      const fresh = r.records.filter((rec) => !store.getEvent(rec.dedupe_key));
      console.log(`Already imported: ${r.records.length - fresh.length}`);
      previewTable(fresh);
      if (!fresh.length) return;
      if (!args.includes('--yes') && !(await confirm(`Import ${fresh.length} records?`))) return;
      store.transaction(() => fresh.forEach((rec) => store.insertIfNew(rec)));
      if (cfg.device_token && cfg.first_sync_approved) await doSync(store, cfg, { yes: true });
      else console.log('Imported locally. It uploads on your next sync.');
      return;
    }

    case 'cursor': {
      if (args[0] !== 'auto-import' || !['on', 'off'].includes(args[1])) throw new Error('Usage: tokenburn cursor auto-import on|off [--dir DIR]');
      cfg.cursor_auto_import = args[1] === 'on';
      const dir = flag(args, '--dir');
      if (dir) cfg.downloads_dir = dir;
      saveConfig(cfg);
      return console.log(cfg.cursor_auto_import
        ? `Cursor exports saved to ${cfg.downloads_dir ?? defaultDownloadsDir()} will be imported automatically. Export from cursor.com → Dashboard → Usage.`
        : 'Cursor auto-import off.');
    }

    case 'connect':
    case 'disconnect': {
      if (args[0] !== 'openrouter') throw new Error(`Usage: tokenburn ${cmd} openrouter`);
      if (cmd === 'disconnect') {
        cfg.openrouter_key = null;
        saveConfig(cfg);
        return console.log('OpenRouter key removed from this machine. Already-uploaded rows stay until `tokenburn delete --provider openrouter`.');
      }
      console.log('OpenRouter usage comes from its /activity API, which needs a management key (openrouter.ai/settings/management-keys).');
      console.log('The key is saved only in ~/.tokenburn/config.json (readable by you only) and sent only to openrouter.ai.');
      console.log('A management key can also create and delete API keys: keep it private.');
      const key = await askSecret('Management key: ');
      if (!key) return console.log('Cancelled.');
      const r = await collectOpenRouter(store, key);
      cfg.openrouter_key = key;
      saveConfig(cfg);
      return console.log(`Connected. Pulled ${r.rows} daily rows (last 30 days). They upload on the next sync.`);
    }

    case 'delete': {
      if (!cfg.device_token) throw new Error('Not signed in.');
      if (args.includes('--account')) {
        const typed = flag(args, '--confirm') ?? await ask('This deletes your account, profile and all uploaded usage. Type "delete my account" to confirm: ');
        await api(cfg, 'DELETE', '/api/me', { confirm: typed });
        uninstallService();
        Object.assign(cfg, { device_token: null, device_id: null, first_sync_approved: false });
        saveConfig(cfg);
        store.resetUploadState();
        return console.log('Account deleted. Local data on this machine is kept; run `tokenburn forget` to remove it.');
      }
      const provider = flag(args, '--provider') ?? 'all';
      if (provider !== 'all' && !PROVIDERS.includes(provider as Provider)) throw new Error(`Providers: ${PROVIDERS.join(', ')}`);
      if (!args.includes('--yes') && !(await confirm(`Delete ${provider === 'all' ? 'all uploaded usage' : `uploaded ${provider} usage`} from the server?`))) return;
      await api(cfg, 'DELETE', `/api/me/data?provider=${provider}`);
      store.resetUploadState();
      store.deleteEvents(provider === 'all' ? undefined : provider);
      clearProviderState(store, cfg, provider === 'all' ? null : (provider as Provider));
      return console.log('Deleted on the server and locally. The collector will re-collect from your tools on the next sync unless you `tokenburn logout`.');
    }

    case 'devices': {
      if (!cfg.device_token) throw new Error('Not signed in.');
      if (args[0] === 'remove' && args[1]) {
        await api(cfg, 'DELETE', `/api/devices/${encodeURIComponent(args[1])}`);
        return console.log('Device removed and its uploaded usage deleted.');
      }
      const me = await api(cfg, 'GET', '/api/me');
      for (const d of me.devices) {
        console.log(`${d.current ? '*' : ' '} ${d.id}  ${d.name.padEnd(24)} last sync ${d.last_sync_at ?? 'never'}${d.current ? '  (this machine)' : ''}`);
      }
      return console.log('\nRemove one (and the usage it uploaded): tokenburn devices remove <id>');
    }

    case 'service': {
      const sub = args[0];
      if (sub === 'install') return console.log(installService());
      if (sub === 'uninstall') return console.log(uninstallService());
      if (sub === 'logs') return console.log(fs.existsSync(logPath()) ? fs.readFileSync(logPath(), 'utf8').split('\n').slice(-40).join('\n') : 'No log yet.');
      return console.log(`Automatic sync: ${serviceStatus()}`);
    }

    case 'config': {
      const [sub, a, b, c] = args;
      if (sub === 'set' && a === 'billing-mode') {
        if (!PROVIDERS.includes(b as Provider)) throw new Error(`Provider must be one of ${PROVIDERS.join(', ')}`);
        if (c === 'auto') delete cfg.billing_overrides[b as Provider];
        else if (BILLING_MODES.includes(c as BillingMode)) cfg.billing_overrides[b as Provider] = c as BillingMode;
        else throw new Error(`billing-mode must be auto or one of ${BILLING_MODES.join(', ')}`);
        saveConfig(cfg);
        const src = LOCAL_SOURCES.find((s) => s.provider === b);
        if (src) store.setBillingMode(b, src.billing(ctxOf(cfg)).mode);
        return console.log(`${PROVIDER_LABELS[b as Provider]} billing mode: ${c}`);
      }
      if (sub === 'set' && a === 'api-url' && b) {
        cfg.api_url = b;
        saveConfig(cfg);
        return console.log(`Server: ${b}`);
      }
      if (sub === 'add-dir' && PROVIDERS.includes(a as Provider) && b) {
        cfg.extra_dirs[a as Provider] = [...new Set([...(cfg.extra_dirs[a as Provider] ?? []), b])];
        saveConfig(cfg);
        return console.log(`Added ${b} for ${a}`);
      }
      throw new Error('Unknown config command. See `tokenburn help`.');
    }

    default:
      console.log(HELP);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`Error: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
