import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanClaudeCode } from '../src/sources/claude-code.ts';
import { Store } from '../src/store.ts';
import { planSync } from '../src/sync.ts';
import type { Config } from '../src/config.ts';

const fixtures = path.resolve(import.meta.dirname, '../../../fixtures/claude-code');
let tmp: string;
let claudeDir: string;
let store: Store;
const cfg: Config = {
  api_url: 'http://x', device_token: 't', device_id: 'd', previous_token: null, session_salt: 'salt', extra_dirs: {},
  billing_overrides: {}, first_sync_approved: true, cursor_auto_import: false, downloads_dir: null, openrouter_key: null,
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-'));
  claudeDir = path.join(tmp, 'claude');
  fs.cpSync(fixtures, claudeDir, { recursive: true });
  store = new Store(path.join(tmp, 'state'));
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  process.env.HOME = tmp; // keep the real ~/.claude out of tests
  process.env.XDG_CONFIG_HOME = path.join(tmp, 'xdg');
});
afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const projDir = () => path.join(claudeDir, 'projects', '-Users-dev-proj-a');
const line = (id: string, out: number, ts = '2026-10-04T00:00:00.000Z') =>
  JSON.stringify({ type: 'assistant', sessionId: 'sess-3', timestamp: ts, requestId: 'r' + id, message: { id, model: 'claude-sonnet-4-6', usage: { input_tokens: 1, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });

describe('incremental Claude Code collection', () => {
  it('collects fixtures from a custom CLAUDE_CONFIG_DIR with global dedupe', () => {
    const s = scanClaudeCode(store, 'subscription');
    expect(fs.realpathSync(s.roots[0])).toBe(fs.realpathSync(path.join(claudeDir, 'projects')));
    const keys = store.events().map((e) => e.dedupe_key).filter((k) => k.startsWith('cc:msg_'));
    expect(keys.sort()).toEqual(['cc:msg_A:req_A', 'cc:msg_B:req_B', 'cc:msg_C:req_C', 'cc:msg_D:req_D', 'cc:msg_S:req_S']);
    expect(s.malformedLines).toBe(1);
  });

  it('does not re-read unchanged files and resumes from the saved offset', () => {
    scanClaudeCode(store, 'subscription');
    const again = scanClaudeCode(store, 'subscription');
    expect(again.usageRows).toBe(0);
    expect(again.bytesRead).toBeLessThan(100); // only sess-2222's unfinished trailing line is re-checked
    fs.appendFileSync(path.join(projDir(), 'sess-1111.jsonl'), line('msg_N', 9) + '\n');
    const s = scanClaudeCode(store, 'subscription');
    expect(s.usageRows).toBe(1);
    expect(store.getEvent('cc:msg_N:rmsg_N')!.output_tokens).toBe(9);
  });

  it('waits for an interrupted write to complete before parsing it', () => {
    const f = path.join(projDir(), 'sess-new.jsonl');
    const full = line('msg_P', 42);
    fs.writeFileSync(f, full.slice(0, 30));
    scanClaudeCode(store, 'subscription');
    expect(store.getEvent('cc:msg_P:rmsg_P')).toBeUndefined();
    fs.appendFileSync(f, full.slice(30) + '\n');
    scanClaudeCode(store, 'subscription');
    expect(store.getEvent('cc:msg_P:rmsg_P')!.output_tokens).toBe(42);
    expect(store.getFile(f)!.malformed_lines).toBe(0);
  });

  it('completes the resumed-session partial line once it is finished', () => {
    const f = path.join(projDir(), 'sess-2222.jsonl');
    scanClaudeCode(store, 'subscription');
    fs.appendFileSync(f, ',"x":1}\n'); // finishes the dangling fixture line as malformed JSON for usage
    scanClaudeCode(store, 'subscription');
    expect(store.getFile(f)!.malformed_lines).toBe(1);
  });

  it('re-reads a truncated/rewritten file without double counting', () => {
    const f = path.join(projDir(), 'sess-1111.jsonl');
    scanClaudeCode(store, 'subscription');
    const before = store.events().length;
    fs.writeFileSync(f, line('msg_A2', 5) + '\n');
    scanClaudeCode(store, 'subscription');
    expect(store.events().length).toBe(before + 1);
  });

  it('plans idempotent syncs: second plan is empty, billing change replaces buckets', () => {
    scanClaudeCode(store, 'subscription');
    const p1 = planSync(store, cfg);
    expect(p1.bucketUpserts.length).toBeGreaterThan(0);
    expect(p1.sessionUpserts.every((s) => !s.session_key.includes('sess'))).toBe(true);
    store.setUploaded('uploaded_buckets', p1.hashes.buckets, []);
    store.setUploaded('uploaded_sessions', p1.hashes.sessions, []);
    const p2 = planSync(store, cfg);
    expect(p2.bucketUpserts).toHaveLength(0);
    expect(p2.sessionUpserts).toHaveLength(0);
    store.setBillingMode('claude_code', 'api');
    const p3 = planSync(store, cfg);
    expect(p3.bucketUpserts.every((b) => b.billing_mode === 'api')).toBe(true);
    expect(p3.bucketDeletes).toHaveLength(p1.bucketUpserts.length);
  });
});
