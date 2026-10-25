// Cursor dashboard usage-export CSV parser. Header names are not publicly documented, so the
// file is rejected when its headers can't be mapped, rather than guessing columns.
import type { BillingMode, UsageRecord } from './schema.ts';

export interface CsvRowError {
  line: number;
  reason: string;
}

export interface CursorImportResult {
  records: UsageRecord[];
  errors: CsvRowError[];
  /** Rows that hash to a dedupe key already seen earlier in the same file. */
  duplicateRowsInFile: number;
  totalRows: number;
  headerMapping: Partial<Record<CursorField, string>>;
  /** Rows whose cache-write semantics could not be confirmed from Total Tokens. */
  cacheWriteUnknownRows: number;
  /** Fatal problems (unmappable headers, team export). When set, records is empty. */
  fatal: string | null;
}

type CursorField =
  | 'date' | 'kind' | 'model' | 'max_mode' | 'input_with_cache_write' | 'input_without_cache_write'
  | 'cache_read' | 'output' | 'total' | 'user';

// Normalized header text (lowercase, non-alphanumerics collapsed) → field.
const HEADER_ALIASES: Record<string, CursorField> = {
  date: 'date', timestamp: 'date',
  kind: 'kind', type: 'kind',
  model: 'model',
  max_mode: 'max_mode', maxmode: 'max_mode',
  input_w_cache_write: 'input_with_cache_write',
  input_with_cache_write: 'input_with_cache_write',
  input_w_o_cache_write: 'input_without_cache_write',
  input_without_cache_write: 'input_without_cache_write',
  cache_read: 'cache_read', cache_read_tokens: 'cache_read',
  output_tokens: 'output', output: 'output',
  total_tokens: 'total', total: 'total',
  user: 'user', email: 'user', user_email: 'user',
};

const REQUIRED: CursorField[] = ['date', 'model', 'output'];

export function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/** RFC 4180 CSV → rows of fields, with 1-based physical line numbers of each row start. */
export function parseCsv(text: string): { fields: string[]; line: number }[] {
  const out: { fields: string[]; line: number }[] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let line = 1;
  let rowLine = 1;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else {
        if (c === '\n') line++;
        field += c;
      }
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      if (row.length > 1 || row[0] !== '') out.push({ fields: row, line: rowLine });
      row = []; field = ''; line++; rowLine = line;
    } else field += c;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '') out.push({ fields: row, line: rowLine });
  return out;
}

function parseCount(raw: string | undefined): number | null | 'invalid' {
  if (raw === undefined) return null;
  const s = raw.trim().replace(/,/g, '');
  if (s === '' || s === '-' || s.toLowerCase() === 'n/a') return null;
  if (!/^\d+$/.test(s)) return 'invalid';
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : 'invalid';
}

export function billingModeFromKind(kind: string): BillingMode {
  const k = kind.toLowerCase();
  if (k.includes('not charged') || k.includes('errored') || k.includes('aborted')) return 'not_charged';
  if (k.includes('included')) return 'subscription';
  if (k.includes('usage-based') || k.includes('usage based') || k.includes('on-demand')) return 'usage_based';
  if (k.includes('free')) return 'free';
  return 'unknown';
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function parseCursorCsv(text: string): Promise<CursorImportResult> {
  const result: CursorImportResult = {
    records: [], errors: [], duplicateRowsInFile: 0, totalRows: 0, headerMapping: {},
    cacheWriteUnknownRows: 0, fatal: null,
  };
  const rows = parseCsv(text);
  if (rows.length === 0) return { ...result, fatal: 'File is empty.' };

  const header = rows[0].fields;
  const col: Partial<Record<CursorField, number>> = {};
  header.forEach((h, i) => {
    const f = HEADER_ALIASES[normalizeHeader(h)];
    if (f && col[f] === undefined) { col[f] = i; result.headerMapping[f] = h; }
  });
  const missing = REQUIRED.filter((f) => col[f] === undefined);
  if (missing.length) {
    return {
      ...result,
      fatal: `Unrecognized CSV format: missing column(s) ${missing.join(', ')}. Found headers: ${header.join(' | ')}`,
    };
  }

  const body = rows.slice(1);
  result.totalRows = body.length;
  if (col.user !== undefined) {
    const users = new Set(body.map((r) => (r.fields[col.user!] ?? '').trim().toLowerCase()).filter(Boolean));
    if (users.size > 1) {
      return { ...result, fatal: `This export contains ${users.size} users (team export). Export only your own usage.` };
    }
  }

  const seen = new Set<string>();
  const get = (r: string[], f: CursorField) => (col[f] === undefined ? undefined : r[col[f]!]);
  for (const { fields, line } of body) {
    if (fields.length !== header.length) {
      result.errors.push({ line, reason: `expected ${header.length} columns, got ${fields.length}` });
      continue;
    }
    const dateRaw = (get(fields, 'date') ?? '').trim();
    // Without an explicit zone, Date.parse uses the machine's local time; read it as UTC so the same export
    // yields the same timestamps (and dedupe keys) on every machine.
    const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(dateRaw);
    const t = Date.parse(!hasZone && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(dateRaw) ? dateRaw.replace(' ', 'T') + 'Z' : dateRaw);
    if (!dateRaw || Number.isNaN(t)) { result.errors.push({ line, reason: 'invalid date' }); continue; }
    const model = (get(fields, 'model') ?? '').trim();
    if (!model) { result.errors.push({ line, reason: 'missing model' }); continue; }

    const nums: Record<string, number | null> = {};
    let bad: string | null = null;
    for (const f of ['input_with_cache_write', 'input_without_cache_write', 'cache_read', 'output', 'total'] as const) {
      const v = parseCount(get(fields, f));
      if (v === 'invalid') { bad = f; break; }
      nums[f] = v;
    }
    if (bad) { result.errors.push({ line, reason: `invalid number in ${result.headerMapping[bad as CursorField]}` }); continue; }

    const inWith = nums.input_with_cache_write;
    const inWithout = nums.input_without_cache_write;
    const cacheRead = nums.cache_read;
    const output = nums.output;
    const total = nums.total;

    // Decide cache-write semantics from the row's own total; never guess.
    let input: number | null = inWithout;
    let cacheWrite: number | null = null;
    let semantics = 'unconfirmed';
    if (inWith !== null && inWithout !== null && cacheRead !== null && output !== null && total !== null) {
      if (inWith + inWithout + cacheRead + output === total) { cacheWrite = inWith; semantics = 'disjoint'; }
      else if (inWith >= inWithout && inWith + cacheRead + output === total) { cacheWrite = inWith - inWithout; semantics = 'cumulative'; }
    }
    if (semantics === 'unconfirmed' && inWith !== null) result.cacheWriteUnknownRows++;
    if (inWithout === null && inWith === null) input = null;

    const kind = (get(fields, 'kind') ?? '').trim();
    const maxMode = (get(fields, 'max_mode') ?? '').trim().toLowerCase();
    const hasTokens = input !== null || output !== null;
    const occurred = new Date(t).toISOString();
    const key = 'cur:' + (await sha256Hex(
      [occurred, kind, model, maxMode, inWith, inWithout, cacheRead, output, total].join('|'),
    )).slice(0, 40);
    if (seen.has(key)) { result.duplicateRowsInFile++; continue; }
    seen.add(key);

    result.records.push({
      provider: 'cursor',
      model_id: model,
      occurred_at: occurred,
      session_id: null,
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      usage_source: 'cursor_csv',
      measurement_type: hasTokens ? 'measured' : 'unknown',
      billing_mode: billingModeFromKind(kind),
      dedupe_key: key,
      event_count: 1,
      synced_at: null,
      provider_fields: {
        kind: kind || null,
        max_mode: maxMode === 'yes' || maxMode === 'true' ? true : maxMode === 'no' || maxMode === 'false' ? false : null,
        cache_write_semantics: semantics,
        total_tokens_reported: total,
      },
    });
  }
  return result;
}
