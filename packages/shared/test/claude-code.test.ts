import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { aggregateDaily, mergeClaudeCodeRecords, parseClaudeCodeLine, validateRecord, type UsageRecord } from '../src/index.ts';

const dir = path.resolve(import.meta.dirname, '../../../fixtures/claude-code/projects/-Users-dev-proj-a');

function collect(files: string[]) {
  const byKey = new Map<string, UsageRecord>();
  let malformed = 0;
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    const complete = text.slice(0, text.lastIndexOf('\n') + 1); // trailing partial line = in-progress write
    for (const line of complete.split('\n')) {
      if (!line.trim()) continue;
      const r = parseClaudeCodeLine(line, 'subscription');
      if (r.kind === 'malformed') malformed++;
      if (r.kind !== 'usage') continue;
      const prev = byKey.get(r.record.dedupe_key);
      byKey.set(r.record.dedupe_key, prev ? mergeClaudeCodeRecords(prev, r.record) : r.record);
    }
  }
  return { byKey, malformed };
}

const ALL = ['sess-1111.jsonl', 'sess-2222.jsonl', 'sess-1111/subagents/agent-x.jsonl'];

describe('Claude Code parser', () => {
  it('dedupes repeated content-block rows and keeps the final output count', () => {
    const { byKey } = collect(['sess-1111.jsonl']);
    const a = byKey.get('cc:msg_A:req_A')!;
    expect(a.output_tokens).toBe(1519);
    expect(a.input_tokens).toBe(3);
    expect(a.cache_read_tokens).toBe(1000);
    expect(a.cache_write_tokens).toBe(200);
    expect(a.occurred_at).toBe('2026-10-01T10:00:05.000Z');
  });

  it('ignores later zero-output rows for the same response', () => {
    expect(collect(['sess-1111.jsonl']).byKey.get('cc:msg_B:req_B')!.output_tokens).toBe(734);
  });

  it('skips synthetic error rows and non-assistant rows; counts malformed lines', () => {
    const { byKey, malformed } = collect(['sess-1111.jsonl']);
    expect([...byKey.keys()].sort()).toEqual(['cc:msg_A:req_A', 'cc:msg_B:req_B', 'cc:msg_C:req_C']);
    expect(malformed).toBe(1);
  });

  it('dedupes across resumed sessions, crediting the earliest occurrence', () => {
    const { byKey } = collect(ALL);
    expect(byKey.size).toBe(5); // A, B, C, D, S
    expect(byKey.get('cc:msg_A:req_A')!.session_id).toBe('sess-1111');
  });

  it('keeps exact model ids, including switches inside a session', () => {
    const models = new Set([...collect(ALL).byKey.values()].map((r) => r.model_id));
    expect(models).toEqual(new Set(['claude-sonnet-4-6', 'claude-opus-4-5-20251101', 'claude-haiku-4-5']));
  });

  it('extracts only allowlisted fields', () => {
    const rec = collect(ALL).byKey.get('cc:msg_A:req_A')!;
    expect(Object.keys(rec).sort()).toEqual([
      'billing_mode', 'cache_read_tokens', 'cache_write_tokens', 'dedupe_key', 'event_count', 'input_tokens', 'measurement_type',
      'model_id', 'occurred_at', 'output_tokens', 'provider', 'provider_fields', 'session_id', 'synced_at', 'usage_source',
    ]);
    const json = JSON.stringify([...collect(ALL).byKey.values()]);
    expect(json).not.toContain('REDACTED');
    expect(json).not.toContain('/Users/dev');
    expect(json).not.toContain('main'); // git branch
    expect(validateRecord(rec)).toBeNull();
  });

  it('aggregates per UTC day and model with distinct sessions', () => {
    const { buckets, sessions } = aggregateDaily(collect(ALL).byKey.values(), () => true);
    const sonnetDay1 = buckets.find((b) => b.model_id === 'claude-sonnet-4-6' && b.day === '2026-10-01')!;
    expect(sonnetDay1.event_count).toBe(2);
    expect(sonnetDay1.output_tokens).toBe(1519 + 734);
    expect(sonnetDay1.session_count).toBe(1);
    expect(sessions.map((s) => s.session_id).sort()).toEqual(['sess-1111', 'sess-2222']);
  });
});
