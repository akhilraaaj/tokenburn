// API-equivalent cost estimates from a public price list (LiteLLM's model_prices_and_context_window.json).
// These are what the same tokens would cost at list API prices — never what a subscription user pays.
// Tiered pricing (e.g. >200k-token prompts) and batch/priority discounts are ignored.

export const PRICE_LIST_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

export interface ModelPrice {
  input: number; // USD per token
  output: number;
  cache_read?: number;
  cache_write?: number;
}

export type PriceTable = Record<string, ModelPrice>;

/** Reduces the upstream file to the four per-token prices we use. */
export function compactPriceList(raw: Record<string, any>): PriceTable {
  const out: PriceTable = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!v || typeof v !== 'object' || typeof v.input_cost_per_token !== 'number' || typeof v.output_cost_per_token !== 'number') continue;
    out[k] = {
      input: v.input_cost_per_token,
      output: v.output_cost_per_token,
      ...(typeof v.cache_read_input_token_cost === 'number' ? { cache_read: v.cache_read_input_token_cost } : {}),
      ...(typeof v.cache_creation_input_token_cost === 'number' ? { cache_write: v.cache_creation_input_token_cost } : {}),
    };
  }
  return out;
}

const PREFIXES = ['', 'anthropic/', 'openai/', 'gemini/', 'xai/', 'deepseek/', 'mistral/'];

// Cursor's own models (and "auto", which doesn't say what served the request) have no public list price.
const CURSOR_UNPRICED = /^(?:auto|default|agent_review|composer(?:-.*)?|grok-bot-.*)$/;
// Effort and speed settings Cursor appends to a model's name; the list prices the model itself.
const CURSOR_VARIANT = /-(?:low|medium|high|xhigh|max|fast|thinking)$/;

/**
 * Ids to look up for a Cursor model, most specific first. Cursor names models its own way
 * (`cursor-grok-4.6-high-fast`, `claude-4.5-sonnet-thinking`), so the list price is found under the model's
 * own name: drop the `cursor-` prefix, put Claude's family before its version, then shed one effort/speed
 * suffix at a time. Trying the longer names first means a model that really is listed under a suffixed name
 * (say a cheaper `-fast` model) keeps its own price. The stored model id is never changed.
 */
export function cursorPriceIds(modelId: string): string[] {
  let id = modelId.trim().toLowerCase();
  if (CURSOR_UNPRICED.test(id)) return [];
  id = id.replace(/^cursor-/, '');
  const claude = /^claude-(\d+)(?:\.(\d+))?-(opus|sonnet|haiku|fable)(-.*)?$/.exec(id);
  if (claude) id = `claude-${claude[3]}-${claude[1]}${claude[2] ? `-${claude[2]}` : ''}${claude[4] ?? ''}`;
  if (id.startsWith('claude-')) id = id.replace(/(\d)\.(\d)/g, '$1-$2');
  const ids = [modelId, id];
  while (CURSOR_VARIANT.test(id)) ids.push((id = id.replace(CURSOR_VARIANT, '')));
  return [...new Set(ids)];
}

/** Exact model id first, then with/without a provider prefix. No fuzzy matching: unknown stays unknown. */
export function findPrice(table: PriceTable, modelId: string): ModelPrice | null {
  const bare = modelId.includes('/') ? modelId.slice(modelId.indexOf('/') + 1) : modelId;
  for (const id of [modelId, bare]) {
    for (const p of PREFIXES) {
      const hit = table[p + id];
      if (hit) return hit;
    }
  }
  return null;
}

export interface CostInput {
  /** Only Cursor rows get their model name translated for the lookup; every other source is matched as stored. */
  provider?: string;
  model_id: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
}

/** USD at list API prices, or null when the model has no known price or no token counts. */
export function estimateCost(table: PriceTable, r: CostInput): number | null {
  const ids = r.provider === 'cursor' ? cursorPriceIds(r.model_id) : [r.model_id];
  let p: ModelPrice | null = null;
  for (const id of ids) if ((p = findPrice(table, id))) break;
  if (!p || (r.input_tokens === null && r.output_tokens === null)) return null;
  return (
    (r.input_tokens ?? 0) * p.input +
    (r.output_tokens ?? 0) * p.output +
    (r.cache_read_tokens ?? 0) * (p.cache_read ?? p.input) +
    (r.cache_write_tokens ?? 0) * (p.cache_write ?? p.input)
  );
}
