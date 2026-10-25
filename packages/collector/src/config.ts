import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { BillingMode, Provider } from '../../shared/src/index.ts';
import { stateDir } from './paths.ts';

/** Where `setup`/`login` connect unless --api or TOKENBURN_API_URL says otherwise. Set this when you deploy. */
export const DEFAULT_API_URL = 'https://tokenburn.akhilraaaj7.workers.dev/';

export interface Config {
  api_url: string;
  device_token: string | null;
  device_id: string | null;
  /** Token from before `logout`, sent on the next login so this machine resumes its device (no double counting). */
  previous_token: string | null;
  /** Salt for hashing session ids before upload. Never leaves this machine. */
  session_salt: string;
  extra_dirs: Partial<Record<Provider, string[]>>;
  billing_overrides: Partial<Record<Provider, BillingMode>>;
  first_sync_approved: boolean;
  cursor_auto_import: boolean;
  downloads_dir: string | null;
  /** OpenRouter management key. Stays in this file (mode 0600); only used to call openrouter.ai directly. */
  openrouter_key: string | null;
}

const file = () => path.join(stateDir(), 'config.json');

export function loadConfig(): Config {
  let raw: Partial<Config> & { claude_dirs?: string[]; billing_override?: BillingMode | null } = {};
  try {
    raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {}
  const cfg: Config = {
    api_url: process.env.TOKENBURN_API_URL || raw.api_url || DEFAULT_API_URL,
    device_token: raw.device_token ?? null,
    device_id: raw.device_id ?? null,
    previous_token: raw.previous_token ?? null,
    session_salt: raw.session_salt || crypto.randomBytes(32).toString('hex'),
    extra_dirs: raw.extra_dirs ?? (raw.claude_dirs?.length ? { claude_code: raw.claude_dirs } : {}),
    billing_overrides: raw.billing_overrides ?? (raw.billing_override ? { claude_code: raw.billing_override } : {}),
    first_sync_approved: raw.first_sync_approved ?? false,
    cursor_auto_import: raw.cursor_auto_import ?? false,
    downloads_dir: raw.downloads_dir ?? null,
    openrouter_key: process.env.OPENROUTER_MANAGEMENT_KEY || raw.openrouter_key || null,
  };
  if (!raw.session_salt) saveConfig(cfg);
  return cfg;
}

export function saveConfig(cfg: Config) {
  fs.mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
  const { openrouter_key, ...rest } = cfg;
  // Don't persist a key that only came from the environment.
  const persistedKey = process.env.OPENROUTER_MANAGEMENT_KEY && openrouter_key === process.env.OPENROUTER_MANAGEMENT_KEY ? null : openrouter_key;
  fs.writeFileSync(file(), JSON.stringify({ ...rest, openrouter_key: persistedKey }, null, 2), { mode: 0o600 });
  fs.chmodSync(file(), 0o600);
}
