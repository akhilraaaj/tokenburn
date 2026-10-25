// Claude Code transcript parser. Extracts only allowlisted usage metadata from one JSONL row.
import { isNonNegInt, type BillingMode, type UsageRecord } from './schema.ts';

export type LineResult =
  | { kind: 'usage'; record: UsageRecord }
  | { kind: 'skip' } // valid JSON, not a usage row (user, attachment, system, ...)
  | { kind: 'malformed' }; // not parseable / usage row missing required fields

const SYNTHETIC_MODELS = new Set(['<synthetic>']);

export function parseClaudeCodeLine(line: string, billingMode: BillingMode): LineResult {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return { kind: 'malformed' };
  }
  if (!row || typeof row !== 'object') return { kind: 'malformed' };
  const o = row as Record<string, any>;
  if (o.type !== 'assistant') return { kind: 'skip' };
  if (o.isApiErrorMessage === true) return { kind: 'skip' };

  const m = o.message;
  if (!m || typeof m !== 'object') return { kind: 'malformed' };
  const model = typeof m.model === 'string' ? m.model : null;
  if (!model) return { kind: 'malformed' };
  if (SYNTHETIC_MODELS.has(model)) return { kind: 'skip' };

  const u = m.usage;
  if (!u || typeof u !== 'object') return { kind: 'skip' }; // assistant row without usage: nothing to count
  const input = isNonNegInt(u.input_tokens) ? u.input_tokens : null;
  const output = isNonNegInt(u.output_tokens) ? u.output_tokens : null;
  if (input === null && output === null) return { kind: 'malformed' };

  const messageId = typeof m.id === 'string' ? m.id : null;
  const ts = typeof o.timestamp === 'string' && !Number.isNaN(Date.parse(o.timestamp)) ? o.timestamp : null;
  if (!messageId || !ts) return { kind: 'malformed' };
  const requestId = typeof o.requestId === 'string' ? o.requestId : null;

  return {
    kind: 'usage',
    record: {
      provider: 'claude_code',
      model_id: model,
      occurred_at: new Date(ts).toISOString(),
      session_id: typeof o.sessionId === 'string' ? o.sessionId : null,
      input_tokens: input,
      output_tokens: output,
      cache_read_tokens: isNonNegInt(u.cache_read_input_tokens) ? u.cache_read_input_tokens : null,
      cache_write_tokens: isNonNegInt(u.cache_creation_input_tokens) ? u.cache_creation_input_tokens : null,
      usage_source: 'claude_code_jsonl',
      measurement_type: 'measured',
      billing_mode: billingMode,
      // One API response is written as several content-block rows sharing message.id + requestId.
      dedupe_key: requestId ? `cc:${messageId}:${requestId}` : `cc:${messageId}`,
      event_count: 1,
      synced_at: null,
      provider_fields: {
        is_sidechain: o.isSidechain === true,
        service_tier: typeof u.service_tier === 'string' ? u.service_tier : null,
      },
    },
  };
}

/**
 * Merges two rows with the same dedupe key. Token fields come from the row with the larger
 * output_tokens (later streaming rows carry the final count; ties keep `next`). Session and
 * timestamp come from the earliest occurrence (resumed sessions copy history into new files).
 */
export function mergeClaudeCodeRecords(prev: UsageRecord, next: UsageRecord): UsageRecord {
  const tokensFrom = (next.output_tokens ?? -1) >= (prev.output_tokens ?? -1) ? next : prev;
  const earliest = next.occurred_at < prev.occurred_at ? next : prev;
  return {
    ...tokensFrom,
    occurred_at: earliest.occurred_at,
    session_id: earliest.session_id,
    synced_at: prev.synced_at,
  };
}
