import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { aggregateDaily, parseCsv, parseCursorCsv, validateRecord } from '../src/index.ts';

const sample = fs.readFileSync(path.resolve(import.meta.dirname, '../../../fixtures/cursor/usage-events.sample.csv'), 'utf8');

describe('Cursor CSV import', () => {
  it('parses valid rows, reports invalid ones and in-file duplicates', async () => {
    const r = await parseCursorCsv(sample);
    expect(r.fatal).toBeNull();
    expect(r.totalRows).toBe(7);
    expect(r.records).toHaveLength(5);
    expect(r.duplicateRowsInFile).toBe(1);
    expect(r.errors).toEqual([{ line: 7, reason: 'invalid date' }]);
    for (const rec of r.records) expect(validateRecord(rec)).toBeNull();
  });

  it('confirms cache-write semantics from Total Tokens, else leaves it unknown', async () => {
    const r = await parseCursorCsv(sample);
    const sonnet = r.records.find((x) => x.model_id === 'claude-4.5-sonnet-thinking')!;
    expect(sonnet.cache_write_tokens).toBe(12000); // 12000+3400+45000+2100 = 62500
    expect(sonnet.input_tokens).toBe(3400);
    const grok = r.records.find((x) => x.model_id === 'grok-4.7')!;
    expect(grok.cache_write_tokens).toBeNull(); // total 999 matches neither interpretation
    expect(r.cacheWriteUnknownRows).toBe(1);
  });

  it('stores model ids verbatim and maps billing kind', async () => {
    const r = await parseCursorCsv(sample);
    expect(r.records.map((x) => x.model_id)).toContain('auto');
    expect(r.records.find((x) => x.model_id === 'gpt-5')!.billing_mode).toBe('usage_based');
    expect(r.records.find((x) => x.model_id === 'composer-2.5')!.billing_mode).toBe('not_charged');
    expect(JSON.stringify(r.records)).not.toContain('$0.42');
  });

  it('produces stable dedupe keys across imports', async () => {
    const [a, b] = await Promise.all([parseCursorCsv(sample), parseCursorCsv(sample)]);
    expect(a.records.map((x) => x.dedupe_key)).toEqual(b.records.map((x) => x.dedupe_key));
  });

  it('rejects unrecognized headers instead of guessing', async () => {
    const r = await parseCursorCsv('when,what,how many\n2026-01-01,x,3\n');
    expect(r.fatal).toMatch(/Unrecognized CSV format/);
    expect(r.records).toHaveLength(0);
  });

  it('rejects team exports with multiple users and never keeps emails', async () => {
    const team = 'User,Date,Model,Output Tokens\na@x.com,2026-01-01T00:00:00Z,gpt-5,1\nb@x.com,2026-01-01T00:00:00Z,gpt-5,1\n';
    expect((await parseCursorCsv(team)).fatal).toMatch(/team export/);
    const solo = 'User,Date,Model,Output Tokens\na@x.com,2026-01-01T00:00:00Z,gpt-5,1\n';
    expect(JSON.stringify((await parseCursorCsv(solo)).records)).not.toContain('a@x.com');
  });

  it('treats blank token cells as unavailable, not zero', async () => {
    const r = await parseCursorCsv('Date,Model,Output Tokens,Input (w/o Cache Write)\n2026-01-01T00:00:00Z,gpt-5,,\n');
    expect(r.records[0].output_tokens).toBeNull();
    expect(r.records[0].measurement_type).toBe('unknown');
    const { buckets } = aggregateDaily(r.records, () => false);
    expect(buckets[0].output_tokens).toBeNull();
    expect(buckets[0].session_count).toBeNull();
  });

  it('handles quoted fields with commas, newlines and CRLF', () => {
    const rows = parseCsv('a,b\r\n"x, y","multi\nline"\r\n');
    expect(rows).toEqual([{ fields: ['a', 'b'], line: 1 }, { fields: ['x, y', 'multi\nline'], line: 2 }]);
  });
});

describe('Cursor dates without a time zone', () => {
  it('reads them as UTC so every machine produces the same timestamps and dedupe keys', async () => {
    const r = await parseCursorCsv('Date,Model,Output Tokens\n2026-10-01 09:15:22,gpt-5,10\n');
    expect(r.records[0].occurred_at).toBe('2026-10-01T09:15:22.000Z');
  });
});
