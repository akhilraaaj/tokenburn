// Shapes exchanged between the Worker's JSON endpoints and the web app.

export interface DailyRow {
  provider: string;
  usage_source: string;
  model_id: string;
  day: string;
  billing_mode: string;
  measurement_type: string;
  events: number;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  incomplete_events: number;
  cost_usd: number | null;
  billed_cost_usd: number | null;
  unpriced_events: number;
}

export interface Highlights {
  totalTokens: number;
  costUsd: number | null;
  billedUsd: number | null;
  unpricedEvents: number;
  events: number;
  bestDay: { day: string; tokens: number } | null;
  currentStreak: number;
  longestStreak: number;
  activeDays: number;
}

/** A row on the public profile: only the fields the owner enabled are present. */
export type PublicRow = Partial<DailyRow> & { events: number };

export interface PublicProfile {
  username: string;
  display_name: string | null;
  since: string;
  daily?: PublicRow[];
  breakdown?: PublicRow[];
  /** Per tool when tools are public, otherwise a single `all` total. */
  sessions?: Record<string, number>;
  /** bestDay.tokens is omitted unless token totals are public. */
  highlights?: Omit<Partial<Highlights>, 'bestDay'> & { bestDay?: { day: string; tokens?: number } | null };
  shows: { tokens: boolean; costs: boolean; streaks: boolean };
}

export interface WebUser {
  github_login: string;
  username: string | null;
}

export interface WebDevice {
  id: string;
  name: string;
  created_at: string;
  last_sync_at: string | null;
  collector_version: string | null;
  health: { sources?: Record<string, unknown> } | null;
}

export interface DashboardData {
  origin: string;
  since: string;
  days: number;
  has_data: boolean;
  rows: DailyRow[];
  sessions: Record<string, number>;
  highlights: Highlights;
  devices: WebDevice[];
  profile_public: boolean;
}

export const PROFILE_FLAGS = ['is_public', 'show_providers', 'show_models', 'show_token_totals', 'show_daily_trend', 'show_sessions', 'show_streaks', 'show_costs'] as const;
export type ProfileFlag = (typeof PROFILE_FLAGS)[number];
export type ProfileSettings = Record<ProfileFlag, number | boolean> & { display_name: string | null };

export const rowTokens = (r: Pick<Partial<DailyRow>, 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_write_tokens'>) =>
  (r.input_tokens ?? 0) + (r.output_tokens ?? 0) + (r.cache_read_tokens ?? 0) + (r.cache_write_tokens ?? 0);
