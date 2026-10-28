// Normalized usage schema shared by the collector, the browser importer and the API.
// Token fields are `null` when the source does not report them — never 0 as a stand-in.

export const PROVIDERS = ['claude_code', 'cursor', 'codex', 'opencode', 'gemini_cli', 'grok_cli', 'hermes', 'openrouter'] as const;
export type Provider = (typeof PROVIDERS)[number];

export const USAGE_SOURCES = [
  'claude_code_jsonl', 'cursor_csv', 'codex_jsonl', 'opencode_local', 'gemini_cli_jsonl', 'grok_cli_sqlite', 'hermes_sqlite', 'openrouter_activity',
] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

export const MEASUREMENT_TYPES = ['measured', 'estimated', 'unknown'] as const;
export type MeasurementType = (typeof MEASUREMENT_TYPES)[number];

export const BILLING_MODES = ['subscription', 'api', 'usage_based', 'free', 'not_charged', 'unknown'] as const;
export type BillingMode = (typeof BILLING_MODES)[number];

export const COST_KINDS = ['billed', 'tool_estimate'] as const;
export type CostKind = (typeof COST_KINDS)[number];

export interface UsageRecord {
  provider: Provider;
  /** Exactly as supplied by the provider. */
  model_id: string;
  /** ISO-8601 UTC. */
  occurred_at: string;
  session_id: string | null;
  /** Uncached input where the source allows (see SourceDef.inputNote). */
  input_tokens: number | null;
  /** All generated tokens, including reasoning/thinking (added in when a source reports them separately). */
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  usage_source: UsageSource;
  measurement_type: MeasurementType;
  billing_mode: BillingMode;
  dedupe_key: string;
  /** Requests this record represents: 1 for per-request sources, more for pre-aggregated ones (OpenRouter days, Hermes deltas). */
  event_count: number;
  synced_at: string | null;
  /**
   * Cost reported by the tool itself, when it reports one: `billed` = an actual charge (OpenRouter),
   * `tool_estimate` = the tool's own estimate (OpenCode, Hermes, grok-cli). API-equivalent estimates
   * from the public price list are computed at aggregation time, not stored here.
   */
  cost_usd?: number | null;
  cost_kind?: CostKind | null;
  /**
   * Local only: API list-price estimate frozen when the record was first priced, so later price-list
   * updates don't rewrite history (or re-upload it). Never sent as-is; folded into bucket costs.
   */
  est_cost_usd?: number | null;
  /** Allowlisted provider-specific metadata. Never content. */
  provider_fields: Record<string, string | number | boolean | null>;
}

export const PROVIDER_LABELS: Record<Provider, string> = {
  claude_code: 'Claude Code',
  cursor: 'Cursor',
  codex: 'Codex CLI',
  opencode: 'OpenCode',
  gemini_cli: 'Gemini CLI',
  grok_cli: 'Grok CLI',
  hermes: 'Hermes Agent',
  openrouter: 'OpenRouter',
};

export interface SourceDef {
  label: string;
  /**
   * `device`: collected from one machine's local files; uploaded as replace-by-key daily aggregates per device.
   * `account`: account-wide data that may arrive from several machines; uploaded as server-deduped events.
   */
  scope: 'device' | 'account';
  /** `false` = the source can't report it at all ("not available", distinct from zero). */
  sessions: boolean;
  cache: boolean;
  automatic: boolean;
  /** What `input_tokens` means for this source; shown next to totals. */
  inputNote: string;
}

export const SOURCES: Record<UsageSource, SourceDef> = {
  claude_code_jsonl: { label: 'Claude Code local transcripts', scope: 'device', sessions: true, cache: true, automatic: true, inputNote: 'excludes cache reads/writes' },
  cursor_csv: { label: 'Cursor usage CSV export', scope: 'account', sessions: false, cache: true, automatic: false, inputNote: 'excludes cache reads/writes' },
  codex_jsonl: { label: 'Codex CLI local session files', scope: 'device', sessions: true, cache: true, automatic: true, inputNote: 'input minus cached tokens' },
  opencode_local: { label: 'OpenCode local database', scope: 'device', sessions: true, cache: true, automatic: true, inputNote: 'excludes cache reads/writes' },
  gemini_cli_jsonl: { label: 'Gemini CLI local chat recordings', scope: 'device', sessions: true, cache: true, automatic: true, inputNote: 'prompt minus cached tokens; main chat turns only' },
  grok_cli_sqlite: { label: 'Grok CLI local database (community grok-cli)', scope: 'device', sessions: true, cache: false, automatic: true, inputNote: 'includes cached tokens (no split reported)' },
  hermes_sqlite: { label: 'Hermes Agent local state database', scope: 'device', sessions: true, cache: true, automatic: true, inputNote: 'as normalized by Hermes; dated by last activity in the session' },
  openrouter_activity: { label: 'OpenRouter activity API (your key, kept locally)', scope: 'account', sessions: false, cache: true, automatic: true, inputNote: 'prompt tokens minus cached tokens; daily totals' },
};

export const SOURCE_LABELS = Object.fromEntries(Object.entries(SOURCES).map(([k, v]) => [k, v.label])) as Record<UsageSource, string>;
export const SOURCE_SCOPE = Object.fromEntries(Object.entries(SOURCES).map(([k, v]) => [k, v.scope])) as Record<UsageSource, 'device' | 'account'>;

export function isNonNegNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1e9;
}

export function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && Number.isSafeInteger(v);
}

/** Validates a record coming over the wire. Returns an error string or null. */
export function validateRecord(r: unknown): string | null {
  if (!r || typeof r !== 'object') return 'not an object';
  const o = r as Record<string, unknown>;
  if (!PROVIDERS.includes(o.provider as Provider)) return 'invalid provider';
  if (typeof o.model_id !== 'string' || !o.model_id || o.model_id.length > 200) return 'invalid model_id';
  if (typeof o.occurred_at !== 'string' || Number.isNaN(Date.parse(o.occurred_at))) return 'invalid occurred_at';
  if (!(o.session_id === null || (typeof o.session_id === 'string' && o.session_id.length <= 200))) return 'invalid session_id';
  for (const k of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens']) {
    if (!(o[k] === null || isNonNegInt(o[k]))) return `invalid ${k}`;
  }
  if (!USAGE_SOURCES.includes(o.usage_source as UsageSource)) return 'invalid usage_source';
  if (!MEASUREMENT_TYPES.includes(o.measurement_type as MeasurementType)) return 'invalid measurement_type';
  if (!BILLING_MODES.includes(o.billing_mode as BillingMode)) return 'invalid billing_mode';
  if (!isNonNegInt(o.event_count) || o.event_count < 1) return 'invalid event_count';
  if (!(o.cost_usd === undefined || o.cost_usd === null || isNonNegNumber(o.cost_usd))) return 'invalid cost_usd';
  if (!(o.cost_kind === undefined || o.cost_kind === null || COST_KINDS.includes(o.cost_kind as CostKind))) return 'invalid cost_kind';
  if (typeof o.dedupe_key !== 'string' || !/^[\w:.\-]{8,200}$/.test(o.dedupe_key)) return 'invalid dedupe_key';
  if (o.measurement_type === 'measured' && o.input_tokens === null && o.output_tokens === null) {
    return 'measured record without token fields';
  }
  return null;
}

/** ISO-8601 for a millisecond timestamp, or null when it's out of range (new Date(...).toISOString() would throw). */
export function isoFromMs(ms: number): string | null {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
