// Fixtures here are built from each tool's source-code structures (commits cited in the source modules),
// not from real user data: none of these tools had data on the development machine.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateRecord } from '../../shared/src/index.ts';
import { Store } from '../src/store.ts';
import { scanCodex } from '../src/sources/codex.ts';
import { scanOpenCode } from '../src/sources/opencode.ts';
import { scanGeminiCli } from '../src/sources/gemini-cli.ts';
import { scanGrokCli } from '../src/sources/grok-cli.ts';
import { scanHermes } from '../src/sources/hermes.ts';
import { activityToRecord } from '../src/sources/openrouter.ts';
import { autoImportCursorExports } from '../src/sources/cursor-downloads.ts';
import type { SourceContext } from '../src/sources/types.ts';

let home: string;
let store: Store;
const ctx: SourceContext = { extraDirs: {}, billingOverrides: {} };
const saved = { ...process.env };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-src-'));
  for (const k of ['CODEX_HOME', 'XDG_DATA_HOME', 'GEMINI_CLI_HOME', 'HERMES_HOME', 'OPENCODE_DB', 'CLAUDE_CONFIG_DIR']) delete process.env[k];
  process.env.HOME = home;
  store = new Store(path.join(home, 'state'));
});
afterEach(() => {
  // Restore keys individually: reassigning process.env detaches it from the real environment.
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  fs.rmSync(home, { recursive: true, force: true });
});

const write = (p: string, content: string) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};
const jl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const usage = (input: number, cached: number, output: number, reasoning: number) => ({
  input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: reasoning, total_tokens: input + output,
});
const tokenCount = (ts: string, total: object | null, last?: object) => ({
  timestamp: ts, type: 'event_msg', payload: { type: 'token_count', info: total ? { total_token_usage: total, last_token_usage: last, model_context_window: 258400 } : null, rate_limits: null },
});

describe('Codex CLI', () => {
  const A = usage(1200, 800, 300, 100);
  const totalAB = usage(2400, 1700, 600, 150);
  const B = usage(1200, 900, 300, 50);

  it('counts each response once, skipping repeats, null info and synthetic totals', () => {
    const synthetic = { ...usage(258000, 0, 400, 0), total_tokens: 258400 };
    const C = usage(1000, 500, 200, 0);
    write(path.join(home, '.codex/sessions/2026/10/01/rollout-2026-10-01T10-00-00-t1.jsonl'), jl(
      { timestamp: '2026-10-01T10:00:00.000Z', type: 'session_meta', payload: { id: 'thread-1', cwd: '/secret/project' } },
      { timestamp: '2026-10-01T10:00:01.000Z', type: 'turn_context', payload: { turn_id: 't1', model: 'gpt-5', cwd: '/secret/project' } },
      tokenCount('2026-10-01T10:00:03.000Z', A, A),
      tokenCount('2026-10-01T10:00:04.000Z', A, A), // rate-limit refresh repeat
      tokenCount('2026-10-01T10:00:05.000Z', null),
      tokenCount('2026-10-01T10:00:09.000Z', totalAB, B),
      tokenCount('2026-10-01T10:00:10.000Z', synthetic, B), // compaction: total jumps, not by `last`
      { timestamp: '2026-10-01T10:01:00.000Z', type: 'turn_context', payload: { turn_id: 't2', model: 'o3' } },
      tokenCount('2026-10-01T10:01:05.000Z', { ...synthetic, total_tokens: synthetic.total_tokens + C.total_tokens }, C),
    ));
    const s = scanCodex(store, ctx);
    const ev = store.events('codex_jsonl');
    expect(s.usageRows).toBe(3);
    expect(ev.map((e) => e.model_id)).toEqual(['gpt-5', 'gpt-5', 'o3']);
    expect(ev[0]).toMatchObject({ input_tokens: 400, cache_read_tokens: 800, output_tokens: 300, session_id: 'thread-1' });
    expect(ev[0].provider_fields.reasoning_tokens).toBe(100);
    for (const e of ev) expect(validateRecord(e)).toBeNull();
    expect(JSON.stringify(ev)).not.toContain('/secret');
  });

  it('dedupes events a forked thread copies from its parent, and resumes incrementally', () => {
    const parent = path.join(home, '.codex/sessions/2026/10/01/rollout-a.jsonl');
    const child = path.join(home, '.codex/sessions/2026/10/01/rollout-b.jsonl');
    const head = [{ timestamp: '2026-10-01T10:00:01.000Z', type: 'turn_context', payload: { model: 'gpt-5' } }, tokenCount('2026-10-01T10:00:03.000Z', A, A)];
    write(parent, jl({ timestamp: '2026-10-01T10:00:00.000Z', type: 'session_meta', payload: { id: 'p' } }, ...head));
    write(child, jl({ timestamp: '2026-10-01T11:00:00.000Z', type: 'session_meta', payload: { id: 'c', forked_from_id: 'p' } }, ...head));
    scanCodex(store, ctx);
    expect(store.events('codex_jsonl')).toHaveLength(1);
    fs.appendFileSync(parent, jl(tokenCount('2026-10-01T10:00:09.000Z', totalAB, B)));
    const s = scanCodex(store, ctx);
    expect(s.usageRows).toBe(1); // only the appended line is parsed, with model restored from saved state
    expect(store.events('codex_jsonl').map((e) => e.model_id)).toEqual(['gpt-5', 'gpt-5']);
  });
});

describe('OpenCode', () => {
  it('reads v2 session_message and v1 message tables, dedupes across layouts, never touches credentials', () => {
    const dir = path.join(home, '.local/share/opencode');
    fs.mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(path.join(dir, 'opencode.db'));
    db.exec(`CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
             CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
             CREATE TABLE credential (id TEXT, value TEXT);
             INSERT INTO credential VALUES ('x', 'sk-SECRET');`);
    const v2 = { agent: 'build', model: { id: 'claude-sonnet-4', providerID: 'anthropic' }, content: [{ type: 'text', text: 'hello secret' }], tokens: { input: 10, output: 200, reasoning: 50, cache: { read: 9000, write: 500 } }, time: { created: 1790000000000 } };
    const v1 = { role: 'assistant', modelID: 'claude-sonnet-4', providerID: 'anthropic', time: { created: 1790000000000 }, tokens: { input: 10, output: 200, reasoning: 50, cache: { read: 9000, write: 500 } } };
    db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)').run('msg_1', 'ses_1', 'assistant', 1, 1, 1, JSON.stringify(v2));
    db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)').run('msg_u', 'ses_1', 'user', 2, 1, 1, JSON.stringify({ text: 'hi' }));
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run('msg_1', 'ses_1', 1, 1, JSON.stringify(v1)); // migrated copy
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run('msg_2', 'ses_2', 1, 2, JSON.stringify({ ...v1, modelID: 'gpt-5', providerID: 'openai' }));
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run('msg_3', 'ses_2', 1, 3, JSON.stringify({ role: 'assistant', modelID: 'gpt-5', time: { created: 1 } })); // in flight, no tokens
    db.close();
    write(path.join(dir, 'storage/message/ses_0/msg_0.json'), JSON.stringify({ id: 'msg_0', sessionID: 'ses_0', ...v1, modelID: 'qwen3-coder' }));

    scanOpenCode(store, ctx);
    const ev = store.events('opencode_local');
    expect(ev.map((e) => e.dedupe_key).sort()).toEqual(['oc:msg_0', 'oc:msg_1', 'oc:msg_2']);
    const m1 = ev.find((e) => e.dedupe_key === 'oc:msg_1')!;
    expect(m1).toMatchObject({ model_id: 'claude-sonnet-4', input_tokens: 10, output_tokens: 250, cache_read_tokens: 9000, cache_write_tokens: 500 });
    expect(JSON.stringify(ev)).not.toMatch(/SECRET|hello secret/);
    expect(scanOpenCode(store, ctx).changedEvents).toBe(0);
  });
});

describe('Gemini CLI', () => {
  it('takes the latest record per message id and normalizes cached/thoughts', () => {
    const chats = path.join(home, '.gemini/tmp/my-project/chats');
    const file = path.join(chats, 'session-2026-10-01T10-00-abcd1234.jsonl');
    write(file, jl(
      { sessionId: 'abcd1234-full', projectHash: 'h', startTime: '2026-10-01T10:00:00.000Z', lastUpdated: '2026-10-01T10:00:00.000Z' },
      { id: 'u1', timestamp: '2026-10-01T10:00:01.000Z', type: 'user', content: 'private prompt' },
      { id: 'g1', timestamp: '2026-10-01T10:00:02.000Z', type: 'gemini', content: '', model: 'gemini-2.5-pro' },
    ));
    scanGeminiCli(store, ctx);
    expect(store.events('gemini_cli_jsonl')).toHaveLength(0); // tokens not attached yet
    fs.appendFileSync(file, jl({ id: 'g1', timestamp: '2026-10-01T10:00:02.000Z', type: 'gemini', content: 'answer', model: 'gemini-2.5-pro', tokens: { input: 5000, output: 200, cached: 3000, thoughts: 150, tool: 0, total: 5350 } }));
    scanGeminiCli(store, ctx);
    const [e] = store.events('gemini_cli_jsonl');
    expect(e).toMatchObject({ model_id: 'gemini-2.5-pro', input_tokens: 2000, cache_read_tokens: 3000, output_tokens: 350, session_id: 'abcd1234-full' });
    expect(JSON.stringify(e)).not.toContain('private');
  });

  it('reads legacy single-JSON session files', () => {
    write(path.join(home, '.gemini/tmp/abc/chats/session-old.json'), JSON.stringify({
      sessionId: 's-old', messages: [{ id: 'g', timestamp: '2026-09-01T00:00:00Z', type: 'gemini', model: 'gemini-2.5-flash', tokens: { input: 10, output: 5, cached: 0, thoughts: 0, total: 15 } }],
    }));
    scanGeminiCli(store, ctx);
    expect(store.events('gemini_cli_jsonl')[0]).toMatchObject({ model_id: 'gemini-2.5-flash', input_tokens: 10, output_tokens: 5 });
  });
});

describe('Grok CLI (community grok-cli)', () => {
  it('reads usage_events incrementally by id', () => {
    fs.mkdirSync(path.join(home, '.grok'));
    const db = new DatabaseSync(path.join(home, '.grok/grok.db'));
    db.exec(`CREATE TABLE usage_events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, message_seq INTEGER, source TEXT NOT NULL,
      model TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_micros INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL)`);
    const ins = db.prepare('INSERT INTO usage_events (session_id, source, model, input_tokens, output_tokens, total_tokens, cost_micros, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    ins.run('s1', 'message', 'grok-code-fast-1', 1000, 200, 1200, 55, '2026-10-01T10:00:00.000Z');
    scanGrokCli(store, ctx);
    ins.run('s1', 'title', 'grok-code-fast-1', 50, 5, 55, 1, '2026-10-01T10:00:05.000Z');
    expect(scanGrokCli(store, ctx).usageRows).toBe(1);
    db.close();
    const ev = store.events('grok_cli_sqlite');
    expect(ev).toHaveLength(2);
    expect(ev[0]).toMatchObject({ input_tokens: 1000, output_tokens: 200, cache_read_tokens: null });
    expect(ev[0].provider_fields.input_includes_cache).toBe(true);
  });
});

describe('Hermes Agent', () => {
  it('records growth of per-session/model running totals as deltas', () => {
    fs.mkdirSync(path.join(home, '.hermes'));
    const db = new DatabaseSync(path.join(home, '.hermes/state.db'));
    db.exec(`CREATE TABLE session_model_usage (session_id TEXT NOT NULL, model TEXT NOT NULL, billing_provider TEXT NOT NULL DEFAULT '',
      billing_base_url TEXT NOT NULL DEFAULT '', billing_mode TEXT NOT NULL DEFAULT '', task TEXT NOT NULL DEFAULT '', api_call_count INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0, reasoning_tokens INTEGER NOT NULL DEFAULT 0, estimated_cost_usd REAL NOT NULL DEFAULT 0,
      actual_cost_usd REAL NOT NULL DEFAULT 0, cost_status TEXT, cost_source TEXT, first_seen REAL, last_seen REAL,
      PRIMARY KEY (session_id, model, billing_provider, billing_base_url, billing_mode, task))`);
    db.prepare(`INSERT INTO session_model_usage (session_id, model, billing_provider, api_call_count, input_tokens, output_tokens, cache_read_tokens, first_seen, last_seen)
      VALUES ('s1', 'anthropic/claude-sonnet-4', 'openrouter', 3, 300, 90, 1000, 1790000000, 1790000100)`).run();
    scanHermes(store, ctx);
    expect(scanHermes(store, ctx).changedEvents).toBe(0);
    db.prepare("UPDATE session_model_usage SET api_call_count = 5, input_tokens = 500, output_tokens = 150, last_seen = 1790090000 WHERE session_id = 's1'").run();
    scanHermes(store, ctx);
    db.close();
    const ev = store.events('hermes_sqlite');
    expect(ev.map((e) => [e.event_count, e.input_tokens, e.output_tokens])).toEqual([[3, 300, 90], [2, 200, 60]]);
    expect(ev.reduce((n, e) => n + (e.input_tokens ?? 0), 0)).toBe(500);
  });
});

describe('OpenRouter activity', () => {
  it('maps a daily row and keeps input unknown when cached exceeds prompt', () => {
    const row = { date: '2026-10-01', model: 'openai/gpt-4.1', model_permaslug: 'openai/gpt-4.1-2025-04-14', endpoint_id: 'e1', provider_name: 'OpenAI', requests: 5, prompt_tokens: 50, completion_tokens: 125, reasoning_tokens: 25, cached_tokens: 10 };
    const r = activityToRecord(row)!;
    expect(r).toMatchObject({ model_id: 'openai/gpt-4.1', input_tokens: 40, cache_read_tokens: 10, output_tokens: 125, event_count: 5, occurred_at: '2026-10-01T00:00:00.000Z' });
    expect(validateRecord(r)).toBeNull();
    expect(activityToRecord({ ...row, cached_tokens: 80 })!.input_tokens).toBeNull();
    expect(activityToRecord({ ...row, requests: 0 })).toBeNull();
  });
});

describe('Cursor auto-import from Downloads', () => {
  it('imports only Cursor exports, once per file version', async () => {
    const dl = path.join(home, 'Downloads');
    const sample = fs.readFileSync(path.resolve(import.meta.dirname, '../../../fixtures/cursor/usage-events.sample.csv'), 'utf8');
    write(path.join(dl, 'usage-events-2026-10-25.csv'), sample);
    write(path.join(dl, 'bank-statement.csv'), 'Date,Model,Amount\n2026-01-01,x,3\n');
    const r1 = await autoImportCursorExports(store, dl);
    expect(r1).toHaveLength(1);
    expect(r1[0].inserted).toBe(5);
    expect(await autoImportCursorExports(store, dl)).toHaveLength(0);
    expect(store.importedFile(path.join(dl, 'bank-statement.csv'))!.result).toBe('not a Cursor export');
  });
});

describe('review fixes', () => {
  it('Hermes: a rebuilt (shrunk) row resets the baseline instead of double counting', () => {
    fs.mkdirSync(path.join(home, '.hermes'));
    const db = new DatabaseSync(path.join(home, '.hermes/state.db'));
    db.exec(`CREATE TABLE session_model_usage (session_id TEXT, model TEXT, billing_provider TEXT DEFAULT '', billing_base_url TEXT DEFAULT '',
      billing_mode TEXT DEFAULT '', task TEXT DEFAULT '', api_call_count INTEGER DEFAULT 0, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0,
      cache_read_tokens INTEGER DEFAULT 0, cache_write_tokens INTEGER DEFAULT 0, reasoning_tokens INTEGER DEFAULT 0, first_seen REAL, last_seen REAL)`);
    db.exec("INSERT INTO session_model_usage (session_id, model, api_call_count, input_tokens, output_tokens, last_seen) VALUES ('s', 'm', 10, 1000, 500, 1790000000)");
    scanHermes(store, ctx);
    db.exec("UPDATE session_model_usage SET api_call_count = 2, input_tokens = 100, output_tokens = 50, last_seen = 1790000100"); // rebuilt
    scanHermes(store, ctx);
    db.exec("UPDATE session_model_usage SET api_call_count = 3, input_tokens = 150, output_tokens = 70, last_seen = 1790000200"); // real growth
    scanHermes(store, ctx);
    db.close();
    expect(store.events('hermes_sqlite').reduce((n, e) => n + (e.input_tokens ?? 0), 0)).toBe(1000 + 50);
  });

  it('frozen list-price estimates do not change when the price list changes', () => {
    write(path.join(home, '.grok/grok.db'), '');
    fs.rmSync(path.join(home, '.grok/grok.db'));
    store.transaction(() => store.insertIfNew({
      provider: 'codex', model_id: 'gpt-5', occurred_at: '2026-10-01T00:00:00.000Z', session_id: 's', input_tokens: 1000, output_tokens: 100,
      cache_read_tokens: 0, cache_write_tokens: 0, usage_source: 'codex_jsonl', measurement_type: 'measured', billing_mode: 'unknown',
      dedupe_key: 'codex:x1', event_count: 1, synced_at: null, provider_fields: {},
    }));
    store.fillEstimates(() => 0.5);
    store.fillEstimates(() => 9.99); // later, different prices
    expect(store.getEvent('codex:x1')!.est_cost_usd).toBe(0.5);
  });

  it('clearSourceState only forgets the named source', () => {
    store.putFile({ path: '/a/claude/projects/x.jsonl', ino: '1', size: 1, offset: 1, malformed_lines: 0, usage_rows: 0 });
    store.putFile({ path: '/a/codex/sessions/y.jsonl', ino: '2', size: 1, offset: 1, malformed_lines: 0, usage_rows: 0 });
    store.setSnapshot('hermes:abc', { x: 1 });
    store.setSnapshot('codex:file:/a/codex/sessions/y.jsonl', { model: 'm' });
    store.clearSourceState(['/a/codex/sessions'], ['codex:']);
    expect(store.getFile('/a/codex/sessions/y.jsonl')).toBeUndefined();
    expect(store.getFile('/a/claude/projects/x.jsonl')).toBeDefined();
    expect(store.getSnapshot('hermes:abc')).toEqual({ x: 1 });
    expect(store.getSnapshot('codex:file:/a/codex/sessions/y.jsonl')).toBeUndefined();
  });

  it('only one sync holds the lock at a time; a stale lock is reclaimed', async () => {
    process.env.TOKENBURN_HOME = path.join(home, 'lockstate');
    const { acquireLock } = await import('../src/lock.ts');
    const release = acquireLock();
    expect(release).not.toBeNull();
    fs.writeFileSync(path.join(home, 'lockstate', 'sync.lock'), '1'); // pid 1 (launchd/init) is alive and not us
    expect(acquireLock()).toBeNull();
    fs.writeFileSync(path.join(home, 'lockstate', 'sync.lock'), '999999'); // dead pid
    const r2 = acquireLock();
    expect(r2).not.toBeNull();
    r2!();
  });
});
