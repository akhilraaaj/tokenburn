// Local cache of the public model price list used for API-equivalent cost estimates.
// Only the price list is downloaded; nothing about the user is sent.
import fs from 'node:fs';
import path from 'node:path';
import { compactPriceList, PRICE_LIST_URL, type PriceTable } from '../../shared/src/index.ts';
import { stateDir } from './paths.ts';

const file = () => path.join(stateDir(), 'prices.json');
const MAX_AGE_MS = 24 * 3600e3;

interface Cached {
  fetched_at: string;
  table: PriceTable;
}

function readCache(): Cached | null {
  try {
    return JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {
    return null;
  }
}

/** Cached table, refreshed at most daily. Falls back to the stale cache, then to {} (no estimates), on failure. */
export async function loadPrices(opts: { network: boolean } = { network: true }): Promise<PriceTable> {
  if (process.env.TOKENBURN_NO_PRICES === '1') return {};
  const cached = readCache();
  if (cached && (!opts.network || Date.now() - Date.parse(cached.fetched_at) < MAX_AGE_MS)) return cached.table;
  if (!opts.network) return {};
  try {
    const res = await fetch(PRICE_LIST_URL, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(String(res.status));
    const table = compactPriceList(await res.json());
    if (Object.keys(table).length < 100) throw new Error('price list looks incomplete');
    fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file(), JSON.stringify({ fetched_at: new Date().toISOString(), table } satisfies Cached));
    return table;
  } catch {
    return cached?.table ?? {};
  }
}

export const pricesFetchedAt = () => readCache()?.fetched_at ?? null;
