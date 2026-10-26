#!/usr/bin/env node
// tokenburn — collects AI coding usage on this machine and publishes what you choose to /@username.
import './quiet.ts';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { BILLING_MODES, PROVIDERS, PROVIDER_LABELS, SOURCES, parseCursorCsv, type BillingMode, type Provider, type UsageRecord } from '../../shared/src/index.ts';
import { DEFAULT_API_URL, loadConfig, saveConfig, type Config } from './config.ts';
import { stateDir } from './paths.ts';
import { INTERVAL_MIN, installService, logPath, runningFromNpxCache, serviceStatus, uninstallService } from './service.ts';
import { LOCAL_SOURCES, type SourceContext } from './sources/index.ts';
import { autoImportCursorExports, defaultDownloadsDir } from './sources/cursor-downloads.ts';
import { collectOpenRouter } from './sources/openrouter.ts';
import { withLock } from './lock.ts';
import { loadPrices } from './prices.ts';
import { compact, renderStats } from './stats.ts';
import { Store } from './store.ts';
import { api, ApiError, COLLECTOR_VERSION, NetworkError, planSync, runSync } from './sync.ts';
import * as ui from './ui.ts';

const { c, sym } = ui;

// ---------- help ----------

type HelpRow = [string, string];
const HELP_SECTIONS: [string, HelpRow[]][] = [
  ['Everyday', [
    ['stats [--days 30]', 'Your usage on this machine: tokens, cost, streaks'],
    ['status', 'Check that everything works: tools, server, auto sync'],
    ['sync', `Upload now (auto sync does this every ${INTERVAL_MIN} min)`],
    ['dashboard', 'Open your web dashboard (all your machines)'],
  ]],
  ['Public profile  ' + c.dim('(private until you publish it)'), [
    ['profile', 'See your profile link and what it shows'],
    ['profile public | private', 'Publish or hide your profile'],
    ['profile show <fields>', 'Show fields, e.g. tokens,models,streaks (or all)'],
    ['profile hide <fields>', 'Hide fields again'],
    ['profile username <name>', 'Change your /@username'],
    ['profile name "<name>"', 'Set the display name'],
  ]],
  ['Cursor & other sources', [
    ['cursor auto-import on | off', 'Import Cursor CSVs from your Downloads folder'],
    ['import-cursor <file.csv>', 'Import one Cursor CSV right now'],
    ['scan', 'Preview what would be uploaded (uploads nothing)'],
    ['connect openrouter', 'Add OpenRouter usage (needs a management key)'],
    ['disconnect openrouter', 'Remove the saved OpenRouter key'],
    ['config set billing-mode <tool> <mode>', 'subscription, api, unknown or auto'],
    ['config add-dir <tool> <dir>', 'Read a tool\'s logs from an extra folder'],
  ]],
  ['Account & data', [
    ['login [--api <url>]', 'Sign in with GitHub (or switch server)'],
    ['logout', 'Sign this machine out and stop auto sync'],
    ['devices [remove <id>]', 'Machines connected to your account'],
    ['service install | uninstall | status | logs', 'Turn auto sync on or off, read its log'],
    ['watch', 'Sync live while this terminal stays open'],
    ['delete [--provider <tool>]', 'Delete uploaded usage from the server'],
    ['delete --account', 'Delete your account and everything on the server'],
    ['forget', 'Erase everything tokenburn stored on this machine'],
  ]],
];

function printHelp() {
  const all = HELP_SECTIONS.flatMap(([, r]) => r);
  const w = Math.min(Math.max(...all.map(([k]) => k.length)), 30) + 'tokenburn '.length;
  const row = ([k, v]: HelpRow) => {
    const name = `${c.dim('tokenburn')} ${ui.cmd(k)}`;
    const len = ui.visibleLength(name);
    return len > w ? `  ${name}\n  ${' '.repeat(w)}  ${c.dim(v)}` : `  ${ui.padEnd(name, w)}  ${c.dim(v)}`;
  };
  ui.log();
  ui.log(`${ui.logo()} ${c.dim(COLLECTOR_VERSION)}`);
  ui.log(c.dim('Your AI coding usage across tools. Collected on this machine, shared only if you choose.'));
  ui.log();
  ui.log(`${c.bold('New here?')} One command does everything:`);
  ui.log(row(['setup', 'Sign in, find your tools, first upload, auto sync']));
  for (const [title, rows] of HELP_SECTIONS) {
    ui.heading(title);
    rows.forEach((r) => ui.log(row(r)));
  }
  ui.log();
  ui.log(c.dim(`Tools: Claude Code, Codex CLI, Cursor, OpenCode, Gemini CLI, Grok CLI, Hermes, OpenRouter`));
  ui.log(c.dim(`Local data: ${stateDir()}  ·  Never uploaded: prompts, code, file paths, project names`));
  ui.log();
}

const COMMANDS = [
  'setup', 'status', 'stats', 'sync', 'dashboard', 'profile', 'cursor', 'import-cursor', 'scan', 'connect', 'disconnect',
  'config', 'login', 'logout', 'devices', 'service', 'watch', 'delete', 'forget', 'help', 'version',
];

/** Closest known command for a typo (≤ 2 edits; ties go to the more common command, listed first). */
function suggest(input: string): string | null {
  const dist = (a: string, b: string) => {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        // Swapped neighbours ("stauts") count as one typo.
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
    return d[a.length][b.length];
  };
  const best = COMMANDS.map((x) => [x, dist(input, x)] as const).sort((a, b) => a[1] - b[1])[0];
  return best && best[1] <= 2 ? best[0] : null;
}

// ---------- small helpers ----------

const PROFILE_FIELDS: Record<string, string> = {
  providers: 'show_providers', models: 'show_models', tokens: 'show_token_totals', trend: 'show_daily_trend', sessions: 'show_sessions',
  streaks: 'show_streaks', costs: 'show_costs', github: 'show_github',
};
const FIELD_LABELS: Record<string, string> = {
  providers: 'Which tools you use', models: 'Which models you use', tokens: 'Token totals', trend: 'Daily activity chart',
  sessions: 'Session counts', streaks: 'Streaks and best day', costs: 'Estimated cost', github: 'GitHub avatar and link',
};

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const ctxOf = (cfg: Config): SourceContext => ({ extraDirs: cfg.extra_dirs, billingOverrides: cfg.billing_overrides });
const home = (p: string) => (p.startsWith(os.homedir()) ? `~${p.slice(os.homedir().length)}` : p);
const isLocalServer = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(url);
const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;

function ago(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return iso;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

async function ask(q: string): Promise<string> {
  if (!process.stdin.isTTY) return '';
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(`${c.blue('?')} ${c.bold(q)} `);
  rl.close();
  return a.trim();
}

/** Yes/no question. Enter picks the default (shown in capitals); non-interactive runs get the default too. */
async function confirm(q: string, defaultYes = false): Promise<boolean> {
  const a = await ask(`${q} ${c.dim(defaultYes ? '(Y/n)' : '(y/N)')}`);
  return a ? /^y(es)?$/i.test(a) : defaultYes && !!process.stdin.isTTY;
}

async function askSecret(q: string): Promise<string> {
  if (!process.stdin.isTTY) return '';
  let muted = false;
  const out = new Writable({ write(chunk, _enc, cb) { if (!muted) process.stdout.write(chunk); cb(); } });
  const rl = readline.createInterface({ input: process.stdin, output: out, terminal: true });
  const p = rl.question(`${c.blue('?')} ${c.bold(q)} `);
  muted = true;
  const a = await p;
  rl.close();
  process.stdout.write('\n');
  return a.trim();
}

function openBrowser(url: string) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  execFile(command, [url], () => {});
}

function requireSignIn(cfg: Config) {
  if (!cfg.device_token) throw new Error('Not signed in. Run `tokenburn login` (or `tokenburn setup`).');
}

/** Warns when this machine syncs somewhere other than the public site, e.g. a local test server. */
function serverNotice(cfg: Config) {
  if (!isLocalServer(cfg.api_url)) return;
  ui.warn(`This machine syncs to a ${c.bold('local test server')} (${cfg.api_url}), not ${new URL(DEFAULT_API_URL).host}.`);
  ui.hint('Switch to the real site:', `tokenburn login --api ${DEFAULT_API_URL}`);
}

// ---------- collection ----------

interface Found { label: string; detail: string; problem?: boolean }
interface CollectResult { found: Found[]; changed: number }

async function collectAll(store: Store, cfg: Config, opts: { network: boolean }): Promise<CollectResult> {
  const ctx = ctxOf(cfg);
  const found: Found[] = [];
  let changed = 0;
  for (const src of LOCAL_SOURCES) {
    const s = src.scan(store, ctx);
    changed += s.changedEvents;
    if (s.roots.length) {
      found.push({
        label: src.label,
        detail: `${plural(s.files, 'file')} · ${s.changedEvents ? `${plural(s.changedEvents, 'new request')}` : 'up to date'}` +
          (s.malformedLines ? ` · ${plural(s.malformedLines, 'unreadable line')} skipped` : ''),
      });
    }
  }
  if (cfg.cursor_auto_import) {
    const res = await autoImportCursorExports(store, cfg.downloads_dir ?? defaultDownloadsDir());
    for (const r of res) {
      changed += r.inserted;
      const file = home(r.file);
      found.push(r.error
        ? { label: 'Cursor CSV', detail: `${file}: not imported (${r.error})`, problem: true }
        : { label: 'Cursor CSV', detail: `${file}: ${plural(r.inserted, 'new row')}${r.duplicates ? `, ${r.duplicates} already imported` : ''}` });
    }
  }
  if (opts.network && cfg.openrouter_key) {
    const last = store.getMeta('openrouter_activity_last_fetch_at');
    if (!last || Date.now() - Date.parse(last) > 6 * 3600e3) {
      try {
        const r = await collectOpenRouter(store, cfg.openrouter_key);
        changed += r.changed;
        found.push({ label: 'OpenRouter', detail: `${plural(r.rows, 'daily row')} · ${r.changed} new or updated` });
      } catch (e) {
        found.push({ label: 'OpenRouter', detail: (e as Error).message, problem: true });
        store.setMeta('openrouter_last_error', (e as Error).message);
      }
    }
  }
  return { found, changed };
}

function printFound(found: Found[]) {
  const w = Math.max(0, ...found.map((f) => f.label.length));
  for (const f of found) ui.log(`  ${f.problem ? sym.warn : sym.ok} ${ui.padEnd(f.label, w)}  ${c.dim(f.detail)}`);
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

/** What's been collected, one row per tool + model. */
function previewTable(records: UsageRecord[], max = 12) {
  const groups = new Map<string, { tool: string; model: string; requests: number; input: number | null; output: number | null; first: string; last: string }>();
  for (const r of records) {
    const k = `${r.provider}\u0001${r.model_id}`;
    const g = groups.get(k) ?? { tool: PROVIDER_LABELS[r.provider], model: r.model_id, requests: 0, input: null, output: null, first: r.occurred_at, last: r.occurred_at };
    g.requests += r.event_count;
    if (r.input_tokens !== null) g.input = (g.input ?? 0) + r.input_tokens;
    if (r.output_tokens !== null) g.output = (g.output ?? 0) + r.output_tokens;
    if (r.occurred_at < g.first) g.first = r.occurred_at;
    if (r.occurred_at > g.last) g.last = r.occurred_at;
    groups.set(k, g);
  }
  if (!groups.size) return ui.note('No usage found yet.');
  const list = [...groups.values()].sort((a, b) => b.requests - a.requests);
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const head = ['Tool', 'Model', 'Requests', 'Input', 'Output', 'Dates'];
  const body = list.slice(0, max).map((g) => [
    g.tool, cut(g.model, 28), g.requests.toLocaleString('en-US'), compact(g.input), compact(g.output),
    g.first.slice(0, 10) === g.last.slice(0, 10) ? g.first.slice(0, 10) : `${g.first.slice(0, 10)} → ${g.last.slice(0, 10)}`,
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((r) => r[i].length)));
  const right = [false, false, true, true, true, false];
  const fmtRow = (r: string[]) => r.map((v, i) => (right[i] ? v.padStart(widths[i]) : i === r.length - 1 ? v : v.padEnd(widths[i]))).join('   ');
  ui.log(`  ${c.dim(fmtRow(head))}`);
  body.forEach((r) => ui.log(`  ${fmtRow(r)}`));
  if (list.length > max) ui.note(`+ ${plural(list.length - max, 'more model')}`);
}

function privacyBox() {
  ui.box([
    `${sym.ok} Uploaded   daily token totals per model, request counts,`,
    `             hashed session ids, Cursor and OpenRouter usage rows`,
    `${sym.fail} Never      prompts, responses, code, file paths,`,
    `             project names, API keys`,
  ], { title: c.bold('What gets uploaded') });
}

function syncSummary(r: { buckets: number; deletedBuckets: number; sessions: number; accountInserted: number; accountDuplicates: number }) {
  if (!r.buckets && !r.deletedBuckets && !r.sessions && !r.accountInserted) {
    return `Up to date. Nothing new since the last sync${r.accountDuplicates ? ` (${r.accountDuplicates} rows already on the server)` : ''}.`;
  }
  const parts = [
    r.buckets && plural(r.buckets, 'daily total'),
    r.deletedBuckets && `${r.deletedBuckets} removed`,
    r.sessions && plural(r.sessions, 'session'),
    r.accountInserted && plural(r.accountInserted, 'account row'),
  ].filter(Boolean);
  return `Synced ${parts.join(' · ')}${r.accountDuplicates ? c.dim(` (${r.accountDuplicates} rows already on the server)`) : ''}`;
}

async function doSync(store: Store, cfg: Config, opts: { yes: boolean; quiet?: boolean }) {
  requireSignIn(cfg);
  await ui.withSpinner('Collecting usage on this machine…', () => collectAll(store, cfg, { network: true }));
  if (!cfg.first_sync_approved) {
    ui.log();
    ui.log(`${c.bold('Your first upload.')} Here's what tokenburn found on this machine:`);
    ui.log();
    previewTable(store.events());
    ui.log();
    privacyBox();
    if (!opts.yes && !(await confirm('Upload this to your account?'))) {
      ui.info('Nothing uploaded. Run `tokenburn sync` whenever you\'re ready.');
      return false;
    }
    cfg.first_sync_approved = true;
    saveConfig(cfg);
  }
  const spin = ui.spinner(`Uploading to ${new URL(cfg.api_url).host}…`);
  try {
    const r = await withLock(async () => runSync(store, cfg, health(store, cfg), await loadPrices(), { force: true }), () => {
      throw new Error('Another tokenburn sync is running right now. Try again in a moment.');
    });
    if (opts.quiet) spin.stop();
    else spin.succeed(syncSummary(r));
  } catch (e) {
    spin.stop();
    throw e;
  }
  return true;
}

// ---------- login ----------

async function login(store: Store, cfg: Config, args: string[], opts: { inSetup?: boolean } = {}) {
  cfg.api_url = flag(args, '--api') ?? cfg.api_url;
  const name = flag(args, '--name') ?? (os.hostname().replace(/\.(local|lan|home)$/i, '') || `${os.platform()} machine`);
  const dev = flag(args, '--dev');
  const anon = { ...cfg, device_token: null };
  // Same machine signing in again: send the old token so the server resumes this device instead of
  // creating a second one (which would upload this machine's history twice).
  const previous_token = cfg.device_token ?? cfg.previous_token ?? undefined;
  let res = await ui.withSpinner(`Connecting to ${new URL(cfg.api_url).host}…`,
    () => api(anon, 'POST', '/api/login/start', { name, previous_token, ...(dev ? { dev_user: dev } : {}) }));
  if (res.status !== 'approved') {
    const url = String(res.verification_uri);
    ui.log();
    ui.box([
      `${c.dim('1.')} Open      ${ui.link(url)}`,
      `${c.dim('2.')} Enter     ${c.bold(c.orange(String(res.user_code)))}`,
      `${c.dim('3.')} Approve   ${c.dim('tokenburn on GitHub')}`,
    ], { title: c.bold('Sign in with GitHub') });
    if (url.startsWith('https://github.com/')) {
      openBrowser(url);
      ui.note('Opened in your browser. Use the same GitHub account as on the website.');
    }
    ui.log();
    const deadline = Date.now() + (res.expires_in ?? 900) * 1000;
    let interval = res.interval ?? 5;
    const loginId = res.login_id;
    const spin = ui.spinner(`Waiting for you to approve on GitHub… ${c.dim('(Ctrl+C to cancel)')}`);
    try {
      for (;;) {
        if (Date.now() > deadline) throw new Error('The code expired before it was approved. Run `tokenburn login` to get a new one.');
        await new Promise((r) => setTimeout(r, interval * 1000));
        try {
          res = await api(anon, 'POST', '/api/login/poll', { login_id: loginId });
        } catch (e) {
          if (e instanceof ApiError && e.status === 403) throw new Error('Sign-in was cancelled on GitHub. Run `tokenburn login` to try again.');
          if (e instanceof ApiError && e.status === 410) throw new Error('The code expired before it was approved. Run `tokenburn login` to get a new one.');
          throw e;
        }
        if (res.status === 'approved') break;
        interval = res.interval ?? interval;
      }
    } finally {
      spin.stop();
    }
  }
  const sameDevice = res.resumed && cfg.device_id === res.device_id;
  if (!sameDevice) store.resetUploadState();
  Object.assign(cfg, { device_token: res.token, device_id: res.device_id, previous_token: null, first_sync_approved: sameDevice ? cfg.first_sync_approved : false });
  saveConfig(cfg);
  const me = await api(cfg, 'GET', '/api/me');
  ui.ok(`Signed in as ${c.bold(me.user.github_login)}${res.new_account ? c.dim(' · new account created') : ''}`);
  if (cfg.api_url !== DEFAULT_API_URL) ui.note(`Server: ${cfg.api_url}`);
  serverNotice(cfg);
  if (opts.inSetup) return;
  ui.log();
  if (!cfg.first_sync_approved) ui.hint('Next, review and upload your usage:', 'tokenburn sync');
  if (!me.user.username) ui.hint('Pick a username for your profile:', 'tokenburn profile username <name>');
}

// ---------- commands ----------

async function profileCmd(cfg: Config, args: string[]) {
  requireSignIn(cfg);
  const [sub, ...rest] = args;
  const value = rest.join(' ').trim();
  let done = '';
  if (sub === 'username') {
    if (!value) throw new Error('Usage: tokenburn profile username <name>');
    const r = await api(cfg, 'PUT', '/api/me/username', { username: value });
    done = `Username set to @${r.username}`;
  } else if (sub === 'name') {
    await api(cfg, 'PATCH', '/api/me/profile', { display_name: value || null });
    done = value ? `Display name set to "${value}"` : 'Display name removed';
  } else if (sub === 'public' || sub === 'private') {
    await api(cfg, 'PATCH', '/api/me/profile', { is_public: sub === 'public' });
    done = sub === 'public' ? 'Your profile is now public' : 'Your profile is now private';
  } else if (sub === 'show' || sub === 'hide') {
    const fields = value.split(/[,\s]+/).filter(Boolean);
    const unknown = fields.filter((f) => !PROFILE_FIELDS[f] && f !== 'all');
    if (!fields.length || unknown.length) {
      throw new Error(`${unknown.length ? `Unknown field "${unknown[0]}". ` : ''}Fields: ${Object.keys(PROFILE_FIELDS).join(', ')}, or all.\n  Example: tokenburn profile ${sub} tokens,models,streaks`);
    }
    const keys = fields.includes('all') ? Object.values(PROFILE_FIELDS) : fields.map((f) => PROFILE_FIELDS[f]);
    await api(cfg, 'PATCH', '/api/me/profile', Object.fromEntries(keys.map((k) => [k, sub === 'show'])));
    done = `${sub === 'show' ? 'Now showing' : 'Now hiding'}: ${fields.includes('all') ? 'everything' : fields.join(', ')}`;
  } else if (sub) {
    throw new Error(`Unknown profile command "${sub}". Run \`tokenburn help\` to see them all.`);
  }
  const me = await api(cfg, 'GET', '/api/me');
  const p = me.profile;
  if (done) ui.ok(done);
  ui.log();
  const url = me.user.username ? new URL(`/@${me.user.username}`, cfg.api_url).toString() : null;
  ui.rows([
    ['Profile', url ? ui.link(url) : c.dim('no username yet')],
    ['Visibility', p.is_public ? c.green('● Public') : c.gray('○ Private')],
    ...(p.display_name ? [['Display name', p.display_name] as [string, string]] : []),
  ]);
  ui.heading(p.is_public ? 'Shown on your profile' : 'Will be shown when public');
  const w = Math.max(...Object.keys(PROFILE_FIELDS).map((f) => f.length));
  for (const [field, key] of Object.entries(PROFILE_FIELDS)) {
    ui.log(`  ${p[key] ? sym.ok : sym.off} ${ui.padEnd(p[key] ? field : c.dim(field), w)}  ${c.dim(FIELD_LABELS[field])}`);
  }
  ui.log();
  if (!me.user.username) ui.hint('Pick a username first:', 'tokenburn profile username <name>');
  else if (!p.is_public) ui.hint('Publish it:', 'tokenburn profile public');
  if (!Object.values(PROFILE_FIELDS).some((k) => p[k] && k !== 'show_github')) ui.hint('Choose what to show:', 'tokenburn profile show tokens,models,streaks');
  else ui.hint('Change what\'s shown:', 'tokenburn profile show|hide <fields>');
}

async function statusCmd(store: Store, cfg: Config) {
  const ctx = ctxOf(cfg);
  ui.log();
  ui.log(`${ui.logo()} ${c.dim(COLLECTOR_VERSION)}`);
  ui.heading('This machine');
  const svc = serviceStatus();
  const svcOn = svc.startsWith('on');
  const err = store.getMeta('last_sync_error');
  ui.rows([
    ['Server', cfg.api_url + (isLocalServer(cfg.api_url) ? c.yellow('  (local test server)') : '')],
    ['Signed in', cfg.device_token ? `${sym.ok} yes` : `${sym.fail} no  ${c.dim('→')} ${ui.cmd('tokenburn login')}`],
    ['Auto sync', svcOn ? `${sym.ok} ${svc}` : `${sym.off} ${svc}  ${c.dim('→')} ${ui.cmd('tokenburn service install')}`],
    ['Last sync', ago(store.getMeta('last_sync_at'))],
    ...(err ? [['Last error', c.red(err)] as [string, string]] : []),
  ]);
  if (isLocalServer(cfg.api_url)) {
    ui.log();
    serverNotice(cfg);
  }

  ui.heading('AI tools on this machine');
  const lines: [string, string, string][] = [];
  for (const src of LOCAL_SOURCES) {
    const roots = src.roots(ctx);
    lines.push(roots.length
      ? [sym.ok, src.label, `${plural(roots.length, 'location')} · billing: ${src.billing(ctx).mode}`]
      : [sym.off, c.dim(src.label), c.dim('not found')]);
  }
  lines.push(cfg.cursor_auto_import
    ? [sym.ok, 'Cursor', `auto-import from ${home(cfg.downloads_dir ?? defaultDownloadsDir())}`]
    : [sym.off, c.dim('Cursor'), `${c.dim('off')}  ${c.dim('→')} ${ui.cmd('tokenburn cursor auto-import on')}`]);
  lines.push(cfg.openrouter_key
    ? [sym.ok, 'OpenRouter', `last fetched ${ago(store.getMeta('openrouter_activity_last_fetch_at'))}`]
    : [sym.off, c.dim('OpenRouter'), `${c.dim('not connected')}  ${c.dim('→')} ${ui.cmd('tokenburn connect openrouter')}`]);
  const w = Math.max(...lines.map(([, l]) => ui.visibleLength(l)));
  for (const [s, l, d] of lines) ui.log(`  ${s} ${ui.padEnd(l, w)}  ${d}`);

  if (cfg.device_token) {
    ui.heading('On the server');
    try {
      const s = await api(cfg, 'GET', '/api/me/summary');
      if (!s.sources.length) ui.note(`nothing yet  ${c.dim('→')} run tokenburn sync`);
      const sw = Math.max(0, ...s.sources.map((x: any) => (SOURCES[x.usage_source as keyof typeof SOURCES]?.label ?? x.usage_source).length));
      for (const x of s.sources) {
        const label = SOURCES[x.usage_source as keyof typeof SOURCES]?.label ?? x.usage_source;
        ui.log(`  ${ui.padEnd(label, sw)}  ${plural(x.events, 'request')} ${c.dim(`· ${x.first_day} → ${x.last_day}`)}`);
      }
    } catch (e) {
      ui.warn(`Couldn't reach the server: ${(e as Error).message}`);
    }
  }
  ui.log();
}

async function setup(store: Store, cfg: Config, args: string[]) {
  const TOTAL = 5;
  ui.log();
  ui.log(`${ui.logo()} ${c.dim('setup')}`);
  ui.log(c.dim('Five quick steps. Nothing is uploaded until you approve it.'));

  ui.step(1, TOTAL, 'Sign in with GitHub');
  if (!cfg.device_token || flag(args, '--api')) await login(store, cfg, args, { inSetup: true });
  else {
    const me = await api(cfg, 'GET', '/api/me');
    ui.ok(`Already signed in as ${c.bold(me.user.github_login)}`);
    serverNotice(cfg);
  }

  ui.step(2, TOTAL, 'Find your AI coding tools');
  const found = await ui.withSpinner('Scanning this machine…', () => collectAll(store, cfg, { network: true }));
  if (found.found.length) printFound(found.found);
  else {
    ui.warn('No supported tools found yet.');
    ui.note('Supported: Claude Code, Codex CLI, OpenCode, Gemini CLI, Grok CLI, Hermes. Use one, then run `tokenburn sync`.');
  }

  ui.step(3, TOTAL, 'Cursor (optional)');
  if (cfg.cursor_auto_import) ui.ok(`Cursor auto-import is on (${home(cfg.downloads_dir ?? defaultDownloadsDir())})`);
  else if (!process.stdin.isTTY) ui.note('Skipped. Turn it on later with `tokenburn cursor auto-import on`.');
  else {
    ui.log(c.dim('  Cursor doesn\'t share usage with other apps, so tokenburn reads the CSV you download:'));
    ui.log(`  ${c.dim('1.')} Open ${ui.link('cursor.com/dashboard?tab=usage')} and click ${c.bold('Export CSV')}`);
    ui.log(`  ${c.dim('2.')} Leave the file in ${c.bold(home(defaultDownloadsDir()))} ${c.dim('(any name, don\'t move it)')}`);
    ui.log(`  ${c.dim('3.')} Every sync imports new exports. Download a fresh one at least monthly.`);
    if (await confirm('Do you use Cursor? Turn on auto-import?')) {
      cfg.cursor_auto_import = true;
      saveConfig(cfg);
      ui.ok('Cursor auto-import on');
      const more = await collectAll(store, cfg, { network: false });
      printFound(more.found.filter((f) => f.label === 'Cursor CSV'));
    } else ui.note('Skipped. Turn it on later with `tokenburn cursor auto-import on`.');
  }

  ui.step(4, TOTAL, 'Review and upload');
  const synced = await doSync(store, cfg, { yes: args.includes('--yes') });
  if (!synced) return;

  ui.step(5, TOTAL, 'Automatic sync');
  let auto = svcIsOn();
  if (auto) ui.ok(`Already on: every ${INTERVAL_MIN} minutes`);
  else if (args.includes('--no-service')) ui.note('Skipped. Turn it on later with `tokenburn service install`.');
  else if (runningFromNpxCache()) {
    ui.warn('Automatic sync needs tokenburn installed permanently:');
    ui.hint('Install, then turn it on:', 'npm install -g use-tokenburn && tokenburn service install');
  } else {
    ui.log(c.dim(`  Your computer runs a quick sync every ${INTERVAL_MIN} minutes. Nothing stays running in between.`));
    if (args.includes('--yes') || (await confirm('Turn on automatic sync?', true))) {
      printService(installService());
      auto = true;
    } else ui.note('Skipped. Turn it on later with `tokenburn service install`.');
  }

  const me = await api(cfg, 'GET', '/api/me').catch(() => null);
  const profileUrl = me?.user.username ? new URL(`/@${me.user.username}`, cfg.api_url).toString() : null;
  ui.log();
  ui.box([
    `${c.dim('Dashboard')}   ${ui.link(new URL('/dashboard', cfg.api_url).toString())}`,
    `${c.dim('Profile')}     ${profileUrl ? `${ui.link(profileUrl)} ${c.dim(me?.profile?.is_public ? '(public)' : '(private)')}` : c.dim('pick a username first')}`,
    `${c.dim('Auto sync')}   ${auto ? `on, every ${INTERVAL_MIN} min` : 'off'}`,
    '',
    `${c.bold('Try next')}`,
    `${ui.cmd('tokenburn stats')}            ${c.dim('your usage in the terminal')}`,
    `${ui.cmd('tokenburn profile public')}   ${c.dim('share your /@profile')}`,
    `${ui.cmd('tokenburn status')}           ${c.dim('check everything is working')}`,
  ], { title: c.green(c.bold('✔ You\'re all set')), tone: c.green });
  ui.log();
}

const svcIsOn = () => serviceStatus().startsWith('on');
function printService(msg: string) {
  const [first, ...rest] = msg.split('\n');
  ui.ok(first);
  rest.forEach((l) => ui.note(l));
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
  const time = () => c.dim(new Date().toLocaleTimeString());
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const fresh = loadConfig(); // pick up `profile`/`cursor` changes made from another terminal
      const r = await withLock(async () => {
        await collectAll(store, fresh, { network: true });
        return runSync(store, fresh, health(store, fresh), await loadPrices());
      }, () => null);
      if (r && (r.buckets || r.sessions || r.accountInserted)) ui.log(`${time()} ${sym.ok} ${syncSummary(r)}`);
      store.setMeta('last_sync_error', '');
    } catch (e) {
      store.setMeta('last_sync_error', String((e as Error).message ?? e));
      ui.log(`${time()} ${sym.fail} ${(e as Error).message ?? e}`);
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
        ui.log(`${time()} ${sym.warn} can't watch ${home(root)}; checking every 2 minutes instead`);
      }
    }
  }
  // Poll fallback for missed events, SQLite-based sources, Downloads and OpenRouter. Unchanged files cost one stat().
  setInterval(() => schedule(0), 120_000);
  const watched = LOCAL_SOURCES.filter((s) => s.roots(ctx).length).map((s) => s.label).join(', ') || 'no local tools yet';
  ui.log(`${ui.logo()} ${c.dim('watch')}`);
  ui.log(`${sym.info} Syncing live: ${watched}. ${c.dim('Press Ctrl+C to stop.')}`);
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
    if (!(e instanceof ApiError && e.status === 401)) {
      ui.warn(`Couldn't revoke this machine on the server (${(e as Error).message}). Remove it in Settings → Machines.`);
    }
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') return printHelp();
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') return console.log(COLLECTOR_VERSION);
  const cfg = loadConfig();

  if (cmd === 'forget') {
    ui.warn(`This erases ${c.bold(home(stateDir()))}: collected usage, settings, sign-in and saved keys.`);
    ui.note('Usage already uploaded stays on the server (delete it first with `tokenburn delete`).');
    if (!(await confirm('Erase everything on this machine?'))) return ui.info('Nothing erased.');
    await revokeThisDevice(cfg);
    uninstallService();
    fs.rmSync(stateDir(), { recursive: true, force: true });
    ui.ok('Erased local data, signed this machine out and turned off auto sync.');
    return ui.note('Its uploaded history stays on the server. Remove it in Settings → Machines if you like.');
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
      ui.ok('Signed out: this machine\'s token is revoked and automatic sync is off.');
      return ui.note('Uploaded usage stays on your account. Run `tokenburn login` to sign back in.');
    }
    case 'scan': {
      const found = await ui.withSpinner('Scanning this machine…', () => collectAll(store, cfg, { network: true }));
      ui.heading('Tools found');
      if (found.found.length) printFound(found.found);
      else ui.note('none yet');
      ui.heading('Collected on this machine (nothing uploaded)');
      previewTable(store.events());
      const plan = planSync(store, cfg, await loadPrices());
      ui.log();
      ui.info(`The next sync would upload ${plural(plan.bucketUpserts.length, 'daily total')}, ` +
        `${plan.sessionUpserts.length.toLocaleString('en-US')} hashed session ${plan.sessionUpserts.length === 1 ? 'summary' : 'summaries'} and ${plural(plan.accountEvents.length, 'account row')}.`);
      return;
    }
    case 'sync':
      if (args.includes('--auto')) return autoSync(store, cfg);
      serverNotice(cfg);
      await doSync(store, cfg, { yes: args.includes('--yes') });
      return;
    case 'watch':
      return watch(store, cfg);
    case 'stats': {
      await collectAll(store, cfg, { network: false });
      ui.log();
      return console.log(renderStats(store.events(), Math.min(Math.max(Number(flag(args, '--days') ?? 30) || 30, 1), 365), await loadPrices()));
    }
    case 'status':
      return statusCmd(store, cfg);
    case 'dashboard': {
      const url = new URL('/dashboard', cfg.api_url).toString();
      openBrowser(url);
      ui.ok(`Opening ${ui.link(url)}`);
      return ui.note('Sign in with the same GitHub account you used here.');
    }
    case 'profile':
      return profileCmd(cfg, args);

    case 'import-cursor': {
      const file = args[0];
      if (!file) throw new Error('Usage: tokenburn import-cursor <file.csv>\n  Download it from cursor.com → Dashboard → Usage → Export CSV.');
      if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
      const r = await parseCursorCsv(fs.readFileSync(file, 'utf8'));
      if (r.fatal) throw new Error(`That doesn't look like a Cursor usage export: ${r.fatal}`);
      ui.ok(`Read ${plural(r.totalRows, 'row')}: ${r.records.length} valid` +
        (r.errors.length ? `, ${c.yellow(`${r.errors.length} skipped`)}` : '') + (r.duplicateRowsInFile ? `, ${r.duplicateRowsInFile} duplicates in the file` : ''));
      ui.note(`Columns: ${Object.entries(r.headerMapping).map(([k, v]) => `${k}→${v}`).join(', ')}`);
      r.errors.slice(0, 10).forEach((e) => ui.note(`line ${e.line}: ${e.reason}`));
      if (r.cacheWriteUnknownRows) ui.note(`Cache-write tokens unknown for ${r.cacheWriteUnknownRows} rows (the file's totals didn't confirm the column).`);
      const fresh = r.records.filter((rec) => !store.getEvent(rec.dedupe_key));
      if (r.records.length - fresh.length) ui.note(`${r.records.length - fresh.length} rows were already imported earlier.`);
      if (!fresh.length) return ui.info('Nothing new to import.');
      ui.log();
      previewTable(fresh);
      ui.log();
      if (!args.includes('--yes') && !(await confirm(`Import ${plural(fresh.length, 'row')}?`, true))) return ui.info('Nothing imported.');
      store.transaction(() => fresh.forEach((rec) => store.insertIfNew(rec)));
      ui.ok(`Imported ${plural(fresh.length, 'row')}`);
      if (cfg.device_token && cfg.first_sync_approved) await doSync(store, cfg, { yes: true });
      else ui.note('Saved on this machine. It uploads on your next sync.');
      return;
    }

    case 'cursor': {
      if (args[0] !== 'auto-import' || !['on', 'off'].includes(args[1])) throw new Error('Usage: tokenburn cursor auto-import on|off [--dir <folder>]');
      cfg.cursor_auto_import = args[1] === 'on';
      const dir = flag(args, '--dir');
      if (dir) cfg.downloads_dir = dir;
      saveConfig(cfg);
      if (!cfg.cursor_auto_import) return ui.ok('Cursor auto-import off.');
      ui.ok(`Cursor auto-import on. Watching ${c.bold(home(cfg.downloads_dir ?? defaultDownloadsDir()))}`);
      ui.log();
      ui.log(`  ${c.dim('1.')} Open ${ui.link('cursor.com/dashboard?tab=usage')} and click ${c.bold('Export CSV')}`);
      ui.log(`  ${c.dim('2.')} Leave the file in that folder ${c.dim('(any name, don\'t move it)')}`);
      ui.log(`  ${c.dim('3.')} The next sync imports it. Files older than 45 days are skipped.`);
      return;
    }

    case 'connect':
    case 'disconnect': {
      if (args[0] !== 'openrouter') throw new Error(`Usage: tokenburn ${cmd} openrouter`);
      if (cmd === 'disconnect') {
        cfg.openrouter_key = null;
        saveConfig(cfg);
        ui.ok('OpenRouter key removed from this machine.');
        return ui.note('Rows already uploaded stay until you run `tokenburn delete --provider openrouter`.');
      }
      ui.log(`${c.bold('Connect OpenRouter')}`);
      ui.note('OpenRouter usage comes from its activity API, which needs a management key:');
      ui.log(`  ${ui.link('https://openrouter.ai/settings/management-keys')}`);
      ui.note('The key stays on this machine (~/.tokenburn/config.json, readable only by you) and is sent only to openrouter.ai.');
      ui.warn('A management key can create and delete API keys. Keep it private.');
      const key = await askSecret('Paste your management key:');
      if (!key) return ui.info('Cancelled.');
      const r = await ui.withSpinner('Checking the key…', () => collectOpenRouter(store, key));
      cfg.openrouter_key = key;
      saveConfig(cfg);
      ui.ok(`Connected. Pulled ${plural(r.rows, 'daily row')} from the last 30 days.`);
      return ui.note('They upload on the next sync.');
    }

    case 'delete': {
      requireSignIn(cfg);
      if (args.includes('--account')) {
        ui.warn(`This ${c.bold('permanently')} deletes your account, profile and all uploaded usage.`);
        const typed = flag(args, '--confirm') ?? await ask('Type "delete my account" to confirm:');
        await api(cfg, 'DELETE', '/api/me', { confirm: typed });
        uninstallService();
        Object.assign(cfg, { device_token: null, device_id: null, first_sync_approved: false });
        saveConfig(cfg);
        store.resetUploadState();
        ui.ok('Account deleted.');
        return ui.note('Usage collected on this machine is kept. Run `tokenburn forget` to erase it too.');
      }
      const provider = flag(args, '--provider') ?? 'all';
      if (provider !== 'all' && !PROVIDERS.includes(provider as Provider)) throw new Error(`Unknown tool "${provider}". Use one of: ${PROVIDERS.join(', ')}`);
      const what = provider === 'all' ? 'all your uploaded usage' : `your uploaded ${PROVIDER_LABELS[provider as Provider]} usage`;
      if (!args.includes('--yes') && !(await confirm(`Delete ${what} from the server?`))) return ui.info('Nothing deleted.');
      await api(cfg, 'DELETE', `/api/me/data?provider=${provider}`);
      store.resetUploadState();
      store.deleteEvents(provider === 'all' ? undefined : provider);
      clearProviderState(store, cfg, provider === 'all' ? null : (provider as Provider));
      ui.ok(`Deleted ${what} on the server and on this machine.`);
      return ui.note('The next sync collects it again from your tools. Run `tokenburn logout` to stop syncing.');
    }

    case 'devices': {
      requireSignIn(cfg);
      if (args[0] === 'remove') {
        if (!args[1]) throw new Error('Usage: tokenburn devices remove <id>  (see the ids with `tokenburn devices`)');
        await api(cfg, 'DELETE', `/api/devices/${encodeURIComponent(args[1])}`);
        return ui.ok('Machine removed and the usage it uploaded deleted.');
      }
      const me = await api(cfg, 'GET', '/api/me');
      ui.heading('Machines on your account');
      const w = Math.max(...me.devices.map((d: any) => d.name.length));
      for (const d of me.devices) {
        ui.log(`  ${d.current ? c.green('*') : ' '} ${ui.padEnd(d.current ? c.bold(d.name) : d.name, w)}  ${c.dim(`synced ${ago(d.last_sync_at)}`)}  ${c.gray(d.id)}${d.current ? c.green('  this machine') : ''}`);
      }
      ui.log();
      return ui.hint('Remove one (and the usage it uploaded):', 'tokenburn devices remove <id>');
    }

    case 'service': {
      const sub = args[0];
      if (sub === 'install') return printService(installService());
      if (sub === 'uninstall') return ui.ok(uninstallService());
      if (sub === 'logs') return console.log(fs.existsSync(logPath()) ? fs.readFileSync(logPath(), 'utf8').split('\n').slice(-40).join('\n') : 'No log yet.');
      const s = serviceStatus();
      return ui.log(`${s.startsWith('on') ? sym.ok : sym.off} Automatic sync: ${s}`);
    }

    case 'config': {
      const [sub, a, b, d] = args;
      if (sub === 'set' && a === 'billing-mode') {
        if (!PROVIDERS.includes(b as Provider)) throw new Error(`Tool must be one of ${PROVIDERS.join(', ')}`);
        if (d === 'auto') delete cfg.billing_overrides[b as Provider];
        else if (BILLING_MODES.includes(d as BillingMode)) cfg.billing_overrides[b as Provider] = d as BillingMode;
        else throw new Error(`billing-mode must be auto or one of ${BILLING_MODES.join(', ')}`);
        saveConfig(cfg);
        const src = LOCAL_SOURCES.find((s) => s.provider === b);
        if (src) store.setBillingMode(b, src.billing(ctxOf(cfg)).mode);
        return ui.ok(`${PROVIDER_LABELS[b as Provider]} billing mode: ${d}`);
      }
      if (sub === 'set' && a === 'api-url' && b) {
        cfg.api_url = b;
        saveConfig(cfg);
        ui.ok(`Server: ${b}`);
        return ui.note('Sign in to it with `tokenburn login`.');
      }
      if (sub === 'add-dir' && PROVIDERS.includes(a as Provider) && b) {
        cfg.extra_dirs[a as Provider] = [...new Set([...(cfg.extra_dirs[a as Provider] ?? []), b])];
        saveConfig(cfg);
        return ui.ok(`Added ${b} for ${PROVIDER_LABELS[a as Provider]}`);
      }
      throw new Error('Unknown config command. Run `tokenburn help` to see the options.');
    }

    default: {
      const guess = suggest(cmd);
      ui.fail(`Unknown command "${cmd}".`);
      if (guess) ui.hint('Did you mean', `tokenburn ${guess}`);
      ui.hint('See all commands:', 'tokenburn help');
      process.exitCode = 1;
    }
  }
}

/** Plain-language error plus what to do about it. */
function explain(e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  const [first, ...rest] = msg.split('\n');
  ui.fail(first);
  rest.forEach((l) => console.error(c.dim(l)));
  const hintErr = (text: string, command?: string) => console.error(`  ${sym.arrow} ${text}${command ? `  ${ui.cmd(command)}` : ''}`);
  if (e instanceof NetworkError) {
    hintErr('Check your internet connection and try again.');
    const url = loadConfig().api_url;
    if (isLocalServer(url)) hintErr('This machine points at a local test server. To use the real site:', `tokenburn login --api ${DEFAULT_API_URL}`);
  } else if (e instanceof ApiError) {
    if (e.status === 401) hintErr('This machine needs to sign in again:', 'tokenburn login');
    else if (e.status === 429) hintErr('Too many requests. Wait a minute and try again.');
    else if (e.status >= 500) hintErr('The server had a problem. Try again in a few minutes.');
  }
}

main().catch((e) => {
  explain(e);
  process.exit(1);
});
