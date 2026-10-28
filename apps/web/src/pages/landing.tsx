import { lazy, memo, Suspense, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  ArrowRight, AtSign, BarChart3, CalendarDays, Check, ChevronDown, ChevronRight, Coins, Flame, Globe, Laptop, Layers, Loader2, Lock, RefreshCw, Terminal
} from 'lucide-react';
import { GitHubMark, LogoMark, ToolMark, TOOL_MARKS } from '@/components/brand';
import { CopyCommand } from '@/components/copy-command';
import { TOOL_LOGOS, ToolLogoMark } from '@/components/tool-logos';
import { Pills } from '@/components/pills';
import { UsageChart } from '@/components/usage-chart';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CONTRIBUTION_DAYS, contributionDays, type DailyRow, type DayTotal, type PublicProfile, type PublicRow } from '../../../../packages/shared/src/index.ts';
import { compact, fmt, plural, usd } from '@/lib/format.ts';
import { colorMap, daysFrom, rowTokens, type Metric, type Row } from '@/lib/series.ts';
import { cn } from '@/lib/utils';
import { nowMs, useHost, useHydrated, useToday } from '@/lib/clock';
import { AreaChart, perDay } from '@/components/profile-widgets';
import { useSession } from '@/session';
import { checkUsernameNow, useUsernameCheck, type UsernameCheck } from '@/lib/username-check';
import { KpiCard, streakRuns } from '@/components/kpi-card';
import { ProfileHeader, ProfileView } from './profile';

const AccountDeletedDialog = lazy(() => import('@/components/account-deleted-dialog').then((m) => ({ default: m.AccountDeletedDialog })));

const INSTALL = 'npm install -g use-tokenburn && tokenburn setup';

const STEPS = [
  { title: 'Install the CLI', body: 'One small npm package for macOS, Linux and Windows (Node 22.18+).', command: 'npm install -g use-tokenburn' },
  {
    title: 'Run setup',
    body: 'Five guided steps: sign in with GitHub, see which tools were found, review exactly what uploads, then turn on auto sync.',
    command: 'tokenburn setup',
  },
  { title: 'Code as usual', body: 'It syncs every 30 minutes on its own. See your numbers in the terminal, and publish your profile when you like.', command: 'tokenburn stats' },
];

/** Example model mix for the profile preview and the models tile. */
const MIX = [
  { name: 'Claude Opus 5.5', tool: 'Claude Code', share: 52, color: 'var(--series-1)' },
  { name: 'GPT-6 Astra', tool: 'Codex CLI', share: 28, color: 'var(--series-2)' },
  { name: 'Gemini 3.8 Flash', tool: 'Gemini CLI', share: 12, color: 'var(--series-3)' },
  { name: 'Other', tool: '', share: 8, color: 'var(--series-other)' },
];

/** The public-profile switches from Settings, same labels and order; they shape the preview like the server does. */
const SHOW_FIELDS = [
  ['show_github', 'GitHub account'],
  ['show_providers', 'Tools'],
  ['show_models', 'Models'],
  ['show_token_totals', 'Token totals'],
  ['show_daily_trend', 'Daily trend'],
  ['show_streaks', 'Streaks & best day'],
  ['show_costs', 'Estimated cost'],
] as const;
type ShowKey = (typeof SHOW_FIELDS)[number][0];
type Shows = Record<ShowKey, boolean>;
const DEFAULT_SHOWS: Shows = {
  show_github: true, show_providers: true, show_models: true, show_token_totals: true,
  show_daily_trend: true, show_streaks: true, show_costs: false,
};

export const FAQ = [
  { q: 'Are my prompts or code uploaded?', a: 'No. The CLI reads usage records on your machine and uploads daily totals per model, request counts and hashed session ids. Prompts, responses, code, file paths, project names and keys stay on your computer.' },
  { q: 'Is my profile public?', a: 'Not until you say so. Your profile is private by default; publish it from Settings or with tokenburn profile public, and pick exactly which fields it shows.' },
  { q: "What's on a public profile?", a: 'Only what you switch on: your tools, models, token totals, a daily chart, streaks, a contribution graph and estimated cost. Each one has its own switch, and the preview above uses the same ones.' },
  { q: 'How is cost estimated?', a: "The provider's billed amount where reported (OpenRouter), otherwise the tool's own estimate, otherwise public API list prices. It is not what a subscription costs, and it's always labeled as an estimate." },
  { q: 'Does something keep running in the background?', a: 'No. Your OS runs a quick sync every 30 minutes and nothing stays running in between.' },
  { q: 'How do I sync right now?', a: 'Run tokenburn sync in your terminal. It collects usage on this machine and uploads it immediately. After setup, auto sync does the same every 30 minutes on its own.' },
  { q: 'How do I get help with the CLI?', a: 'Run tokenburn help or tokenburn --help for the full command list. Bare tokenburn prints the same thing: stats, sync, profile, service, and the rest.' },
  { q: 'Does Cursor work with tokenburn?', a: "Yes. Export a CSV from cursor.com/dashboard → Usage, then drop it in your Downloads folder. With auto-import on (in setup or tokenburn cursor auto-import on), every sync picks it up. Download a fresh export about once a month. You can also import one file with tokenburn import-cursor <file.csv>." },
  { q: 'Can I delete everything?', a: 'Yes. Deleting your account in Settings removes your profile and all uploaded usage. tokenburn forget clears the local data on each machine.' },
];

const ERRORS: Record<string, string> = {
  not_configured: 'GitHub sign-in is not configured on this server yet.',
  failed: 'Sign-in with GitHub failed or was cancelled. Please try again.',
  expired: 'That sign-in link expired. Please try again.',
  rate_limited: 'Too many sign-in attempts. Wait a minute and try again.',
};

/**
 * List prices (USD per million tokens) for the example models, from the same public price list the CLI uses
 * (LiteLLM, October 2026), so example costs are tokens × price exactly as the app computes them. Cache writes
 * fall back to the input price where none is listed, as in estimateCost().
 */
const DEMO_PRICES = {
  'claude-opus-5-5': { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
  'gpt-6-astra': { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
  'gemini-3.8-flash': { input: 0.75, output: 3.75, cache_read: 0.075, cache_write: 0.75 },
} as const;

type DemoTokens = { input?: number; output?: number; cache_read?: number; cache_write?: number };
const demoCost = (model: keyof typeof DEMO_PRICES, t: DemoTokens) => {
  const p = DEMO_PRICES[model];
  return ((t.input ?? 0) * p.input + (t.output ?? 0) * p.output + (t.cache_read ?? 0) * p.cache_read + (t.cache_write ?? 0) * p.cache_write) / 1e6;
};

/** Illustrative data for the preview card (clearly labeled as an example on the page). */
function exampleRows(today: string): { rows: Row[]; since: string } {
  const since = new Date(Date.parse(today) - 29 * 864e5).toISOString().slice(0, 10);
  const shape = [4, 6, 3, 0, 5, 7, 2, 3, 5, 2, 8, 6, 9, 4, 6, 7, 11, 6, 8, 12, 5, 9, 14, 7, 10, 13, 8, 11, 12, 9];
  const rows: Row[] = [];
  shape.forEach((v, i) => {
    const day = new Date(Date.parse(since) + i * 864e5).toISOString().slice(0, 10);
    if (!v) return;
    const opus = { output: v * 52000, cache_read: v * 2.1e6 };
    const astra = { output: Math.round(v * 21000 * (1 + (i % 3) / 3)), cache_read: v * 6e5 };
    const flash = { output: 38000, cache_read: 9e5 };
    rows.push({ day, provider: 'claude_code', model_id: 'claude-opus-5-5', events: v * 40, output_tokens: opus.output, cache_read_tokens: opus.cache_read, cost_usd: demoCost('claude-opus-5-5', opus) });
    rows.push({ day, provider: 'codex', model_id: 'gpt-6-astra', events: v * 12, output_tokens: astra.output, cache_read_tokens: astra.cache_read, cost_usd: demoCost('gpt-6-astra', astra) });
    if (i % 4 === 0) rows.push({ day, provider: 'gemini_cli', model_id: 'gemini-3.8-flash', events: 6, output_tokens: flash.output, cache_read_tokens: flash.cache_read, cost_usd: demoCost('gemini-3.8-flash', flash) });
  });
  return { rows, since };
}

const EXAMPLE_MODELS = [
  { provider: 'claude_code', usage_source: 'claude_code_jsonl', model_id: 'claude-opus-5-5', events: 38, out: 52000 },
  { provider: 'codex', usage_source: 'codex_jsonl', model_id: 'gpt-6-astra', events: 14, out: 24000 },
  { provider: 'gemini_cli', usage_source: 'gemini_cli_jsonl', model_id: 'gemini-3.8-flash', events: 6, out: 11000 },
] as const;

/**
 * An example public profile, built the way the server builds a real one: 90 days of daily rows, then only the
 * fields the switches allow (mirrors publicProfile() in apps/api).
 */
function exampleProfile(handle: string, f: Shows, day: string, avatarUrl = ''): PublicProfile {
  const today = Date.parse(day);
  const dayOf = (back: number) => new Date(today - back * 864e5).toISOString().slice(0, 10);
  const since = dayOf(89);
  const daily: DailyRow[] = [];
  for (let back = 64; back >= 0; back--) {
    const r = Math.abs(Math.sin(back * 12.9898) * 43758.5453) % 1;
    if (back > 34 && r < 0.18) continue; // a few gaps early on, then an unbroken 35-day streak
    const v = (0.35 + r) * (1.4 - back / 110) * (new Date(today - back * 864e5).getUTCDay() % 6 === 0 ? 0.5 : 1);
    EXAMPLE_MODELS.forEach((m, i) => {
      if (i === 2 && back % 3) return;
      const events = Math.max(1, Math.round(m.events * v));
      const output = Math.round(m.out * events * 0.12);
      daily.push({
        day: dayOf(back), provider: m.provider, usage_source: m.usage_source, model_id: m.model_id, billing_mode: 'subscription',
        measurement_type: 'measured', events, input_tokens: output * 3, output_tokens: output, cache_read_tokens: output * 40,
        cache_write_tokens: output * 4, incomplete_events: 0, billed_cost_usd: null,
        cost_usd: Math.round(demoCost(m.model_id, { input: output * 3, output, cache_read: output * 40, cache_write: output * 4 }) * 100) / 100,
        unpriced_events: 0,
      });
    });
  }

  const shows = { tokens: f.show_token_totals, costs: f.show_costs, streaks: f.show_streaks };
  const out: PublicProfile = { username: handle, display_name: null, since, shows };
  if (f.show_daily_trend || f.show_streaks) out.first_day = daily[0].day;
  if (f.show_github) out.github = { login: handle, avatar_url: avatarUrl };
  const pick = (r: DailyRow) => ({
    ...(f.show_providers ? { provider: r.provider, usage_source: r.usage_source } : {}),
    ...(f.show_models ? { model_id: r.model_id } : {}),
    ...(shows.tokens ? { input_tokens: r.input_tokens, output_tokens: r.output_tokens, cache_read_tokens: r.cache_read_tokens, cache_write_tokens: r.cache_write_tokens } : {}),
    ...(shows.costs ? { cost_usd: r.cost_usd, unpriced_events: r.unpriced_events } : {}),
  });
  if (f.show_daily_trend) {
    out.daily = daily.map((r) => ({ day: r.day, events: r.events, ...pick(r) }));
    // A year of history for the contribution graph: the 90-day rows plus lighter, patchier months before them.
    const history: DayTotal[] = daily.map((r) => ({ day: r.day, events: r.events, tokens: rowTokens(r) }));
    for (let back = 65; back < CONTRIBUTION_DAYS; back++) {
      const r = Math.abs(Math.sin(back * 7.233) * 9631.71) % 1;
      if (r < 0.45 || new Date(today - back * 864e5).getUTCDay() % 6 === 0 && r < 0.8) continue;
      const events = Math.round(10 + r * 50 * (1 - back / 600));
      history.push({ day: dayOf(back), events, tokens: events * 160000 });
    }
    out.contributions = contributionDays(history, shows.tokens, day);
  }
  if (f.show_models || f.show_providers || shows.tokens || shows.costs) {
    const groups = new Map<string, PublicRow>();
    for (const r of daily) {
      const k = [f.show_providers ? r.provider : '', f.show_models ? r.model_id : ''].join('\u0001');
      const base: Record<string, unknown> = pick(r);
      const g: any = groups.get(k) ?? { ...Object.fromEntries(Object.entries(base).map(([key, v]) => [key, typeof v === 'number' ? null : v])), events: 0 };
      g.events += r.events;
      for (const [key, v] of Object.entries(base)) if (typeof v === 'number') g[key] = (g[key] ?? 0) + v;
      groups.set(k, g);
    }
    out.breakdown = [...groups.values()];
  }
  if (shows.tokens || shows.costs || shows.streaks) {
    const perDay = new Map<string, number>();
    for (const r of daily) perDay.set(r.day, (perDay.get(r.day) ?? 0) + rowTokens(r));
    const best = [...perDay.entries()].sort((a, b) => b[1] - a[1])[0];
    // Streak lengths, day by day up to today (rows are generated oldest first).
    const run: number[] = [];
    for (let back = 89, n = 0; back >= 0; back--) run.push(n = perDay.has(dayOf(back)) ? n + 1 : 0);
    out.highlights = {
      ...(shows.tokens ? { totalTokens: [...perDay.values()].reduce((a, b) => a + b, 0) } : {}),
      ...(shows.costs ? { costUsd: daily.reduce((a, r) => a + (r.cost_usd ?? 0), 0), billedUsd: null } : {}),
      ...(shows.streaks ? {
        currentStreak: run[run.length - 1], longestStreak: Math.max(...run), activeDays: perDay.size,
        bestDay: shows.tokens ? { day: best[0], tokens: best[1] } : { day: best[0] },
      } : {}),
    };
  }
  return out;
}

/** Example series for the feature tiles. */
const FEATURE_TREND = [42, 55, 38, 61, 70, 48, 30, 66, 80, 74, 58, 92, 85, 60, 44, 78, 96, 88, 70, 64, 110, 98, 76, 58, 90, 120, 104, 86, 95, 112]
  .map((v, i) => ({ label: `Day ${i + 1}`, value: v * 1e6 }));
const FEATURE_STREAK = [1, 2, 3, 0, 1, 2, 3, 4, 5, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  .map((v, i) => ({ label: `Day ${i + 1}`, value: v }));

/** A static, illustrative contribution grid for the feature tile. */
function MiniContributions() {
  const weeks = 24;
  const cells = Array.from({ length: weeks * 7 }, (_, i) => {
    const r = Math.abs(Math.sin(i * 3.917) * 2731.3) % 1;
    const ramp = 0.35 + 0.65 * (Math.floor(i / 7) / weeks);
    return Math.min(4, Math.floor(r * 5 * ramp + (i % 7 >= 5 ? -0.6 : 0.4)));
  });
  return (
    <div className="grid grid-flow-col grid-rows-7 gap-[3px]" style={{ gridTemplateColumns: `repeat(${weeks}, minmax(0, 1fr))` }}>
      {cells.map((l, i) => (
        <div
          key={i}
          className="aspect-square rounded-[2px]"
          style={{ background: l <= 0 ? 'var(--tb-surface-2)' : `color-mix(in oklab, var(--tb-brand) ${[0, 28, 50, 75, 100][l]}%, var(--tb-surface-1))` }}
        />
      ))}
    </div>
  );
}

// Same characters and length the server accepts for usernames (USERNAME_RE in apps/api/src/auth.ts).
const cleanHandle = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30);

/**
 * A GitHub-style identicon for the signed-out demo profile: a mirrored 5×5 pixel pattern in one brand color,
 * derived from the handle, so typing a name gives the example its own avatar. Built as a data: SVG because the
 * page's CSP only allows same-origin and data: images.
 */
function identicon(seed: string): string {
  let h = 2166136261; // FNV-1a
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const colors = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#6250d6'];
  const color = colors[h % colors.length];
  let cells = '';
  for (let i = 0; i < 15; i++) {
    if (!((h >>> (i + 3)) & 1)) continue;
    const x = Math.floor(i / 5), y = i % 5;
    cells += `<rect x='${x}' y='${y}' width='1' height='1'/>`;
    if (x < 2) cells += `<rect x='${4 - x}' y='${y}' width='1' height='1'/>`;
  }
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='-0.6 -0.6 6.2 6.2' shape-rendering='crispEdges'><rect x='-0.6' y='-0.6' width='6.2' height='6.2' fill='#f0efec'/><g fill='${color}'>${cells}</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function Landing() {
  const { user } = useSession();
  const [params] = useSearchParams();
  const { state } = useLocation() as { state: { section?: string } | null };
  const deleted = params.get('deleted') === '1';
  const navigate = useNavigate();
  // Example data is dated relative to today; useToday keeps it identical to the prerendered HTML while hydrating.
  const today = useToday();
  const hydrated = useHydrated(); // the ?deleted dialog is client-only; the prerendered page has none
  const example = useMemo(() => exampleRows(today), [today]);
  const colorOf = useMemo(() => colorMap(example.rows), [example]);
  const [handle, setHandle] = useState('');
  // The demos follow the typed handle at low priority, so typing stays instant while they re-render behind it.
  const deferredHandle = useDeferredValue(handle);
  const shown = user?.username ?? (deferredHandle || 'yourname');
  const [shows, setShows] = useState(DEFAULT_SHOWS);
  // Signed in, the example profile wears the visitor's own GitHub avatar (their numbers stay examples); signed out,
  // an identicon made from the handle they're typing.
  const avatarUrl = useMemo(() => (user ? '/api/web/avatar' : identicon(shown)), [user, shown]);
  const profile = useMemo(() => exampleProfile(shown, shows, today, avatarUrl), [shown, shows, today, avatarUrl]);

  // Sign-in failures land here as ?error=… — toast once, then drop the param so refresh doesn't re-fire.
  const errorToasted = useRef(false);
  useEffect(() => {
    const code = params.get('error');
    if (!code || errorToasted.current) return;
    errorToasted.current = true;
    const message = ERRORS[code];
    if (message) toast.error(message);
    const next = new URLSearchParams(params);
    next.delete('error');
    const qs = next.toString();
    navigate(qs ? `/?${qs}` : '/', { replace: true });
  }, [params, navigate]);

  // Footer/header section jumps avoid #hashes in the URL; scroll here, then clear router state.
  // Also strip a leftover hash if someone arrived with /#faq.
  useEffect(() => {
    if (window.location.hash) {
      const id = window.location.hash.slice(1);
      history.replaceState(null, '', window.location.pathname + window.location.search);
      requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      return;
    }
    const id = state?.section;
    if (!id) return;
    const t = window.setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      navigate('.', { replace: true, state: null });
    }, 50);
    return () => window.clearTimeout(t);
  }, [state?.section, navigate]);

  return (
    <div className="relative overflow-x-clip">

      <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-20 px-5 pt-16 pb-24 sm:gap-24 sm:px-8 sm:pt-20 lg:gap-28 lg:pt-24">
        {deleted && hydrated && (
          <Suspense fallback={null}>
            <AccountDeletedDialog onClose={() => navigate('/', { replace: true })} />
          </Suspense>
        )}

        {/* Hero + product preview, kept close so the dashboard shows on the first screen */}
        <div className="grid grid-cols-1 gap-10 sm:gap-12">
          {/* Slides in but never starts transparent: the h1 is the largest paint, and fading it in delays LCP. */}
          <section className="grid grid-cols-1 justify-items-center gap-6 text-center motion-safe:animate-in motion-safe:slide-in-from-bottom-3 motion-safe:duration-700">
            <span className="inline-flex items-center gap-2.5 rounded-full border bg-card py-1 pr-3.5 pl-1 text-xs text-muted-foreground shadow-xs font-medium">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[color-mix(in_oklab,var(--series-2)_12%,transparent)] px-2 py-0.5 font-medium text-[color-mix(in_oklab,var(--series-2)_72%,var(--foreground))]">
                <span className="relative flex size-1.5">
                  <span className="absolute inline-flex size-full rounded-full bg-[var(--series-2)] opacity-60 motion-safe:animate-ping" />
                  <span className="relative inline-flex size-1.5 rounded-full bg-[var(--series-2)]" />
                </span>
                Local-first
              </span>
              Private by default
            </span>
            <h1 className="max-w-3xl text-3xl leading-[1.35] font-semibold tracking-normal text-balance sm:text-5xl sm:leading-[1.2] sm:tracking-tight lg:text-[3.5rem]">
              <ToolHeadline />
            </h1>
            <p className="max-w-xl text-sm sm:text-base leading-relaxed font-medium text-pretty text-muted-foreground">
              See how you really build with AI. Every model, token and streak across your tools, on one dashboard and
              one <span className="font-medium text-foreground">@profile</span> worth sharing.
            </p>
            <div className="grid w-full justify-items-center pt-1"><HandleClaim handle={handle} onChange={setHandle} /></div>
          </section>

          {/* Product preview + tools */}
          <section className="grid grid-cols-1 gap-16 animate-in fade-in slide-in-from-bottom-6 sm:gap-20 duration-1000">
            <HeroDashboard rows={example.rows} since={example.since} colorOf={colorOf} labeled={!!user} />
            <div className="grid gap-6">
              <p className="text-center text-xs font-medium tracking-widest text-subtle uppercase">Works with the tools you already use</p>
              <div className="marquee overflow-hidden">
                <div className="marquee-track flex w-max items-center py-2">
                  {[...TOOL_LOGOS, ...TOOL_LOGOS].map((t, i) => (
                    <span key={i} aria-hidden={i >= TOOL_LOGOS.length} className="flex flex-none items-center px-6 text-muted-foreground/80 transition-colors hover:text-foreground sm:px-8">
                      <ToolLogoMark logo={t} className="[--logo-h:1.25rem] sm:[--logo-h:1.5rem]" />
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </section>
        </div>

        {/* Profile */}
        <section id="profile" className="grid scroll-mt-24 grid-cols-1 gap-10 sm:gap-12">
          <SectionHeading
            label="Your profile"
            icon={AtSign}
            title="Show the work behind the commits"
            sub="A shareable page for the models you run, the tokens you burn, and the streaks you keep. Flip a switch, preview live, then publish."
          />
          <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[18rem_minmax(0,1fr)] lg:gap-8">
            {/* On desktop the switches stay pinned below the site header while the full-height preview scrolls by. */}
            <div className="grid gap-6 lg:sticky lg:top-20">
              <ProfileControls shows={shows} onChange={(k, v) => setShows({ ...shows, [k]: v })} />
              <div className="hidden lg:grid"><ProfileCta /></div>
            </div>
            <ProfilePreview profile={profile} labeled={!!user} />
          </div>
          <div className="grid lg:hidden"><ProfileCta /></div>
        </section>

        <FeaturesSection />

        {/* How it works */}
        <section id="how" className="grid scroll-mt-24 grid-cols-1 gap-10 sm:gap-12">
          <SectionHeading label="How it works" icon={Terminal} title="Less setup than a coffee" sub="Install, set up, then code as usual. Pick a step to watch it run in the terminal." />
          <HowItWorks handle={shown} />
        </section>

        {/* Privacy */}
        <section id="privacy" className="grid scroll-mt-24 grid-cols-1 gap-10 sm:gap-12">
          <SectionHeading
            label="Privacy"
            icon={Lock}
            title="Your code stays on your machine"
            sub="tokenburn only ever sees totals. Here's where your data goes, step by step."
          />
          {/* Three lists in the app's card style: what stays local, what syncs, what a profile can show. */}
          <div className="grid gap-5 md:grid-cols-3 lg:gap-6">
            <PrivacyList icon={Laptop} title="Never leaves your machine" local items={NEVER_UPLOADED} />
            <PrivacyList icon={RefreshCw} title="Synced: only totals" items={SYNCED} />
            <PrivacyList icon={Globe} title="On your profile: your call" items={PROFILE_CONTROLS} />
          </div>
          <p className="flex items-center justify-center gap-2 text-center text-xs text-muted-foreground font-medium">
            <Lock className="size-3.5 flex-none text-subtle" />
            Setup shows the exact upload and asks before the first one.
          </p>
        </section>

        {/* FAQ */}
        <section id="faq" className="grid scroll-mt-24 grid-cols-1 gap-10 sm:gap-12">
          <SectionHeading title="Questions, answered" />
          <div className="mx-auto grid w-full max-w-3xl divide-y rounded-2xl border bg-card">
            {FAQ.map((f) => (
              <details key={f.q} className="group px-6 py-5 sm:px-7 [&_summary::-webkit-details-marker]:hidden">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
                  {f.q}
                  <ChevronDown className="size-4 flex-none text-subtle transition-transform group-open:rotate-180" />
                </summary>
                <p className="pt-3 pr-8 text-sm leading-relaxed font-medium text-pretty text-muted-foreground">{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* Final CTA: the hero's claim field and install command again, under the tools they bring together. */}
        <section className="relative isolate grid justify-items-center gap-7 overflow-hidden rounded-3xl border bg-card px-4 py-14 text-center sm:px-6 sm:py-16">
          {/* Faint grid lines along the top edge, fading out before the copy. */}
          <svg aria-hidden className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-56 w-full text-border opacity-60 [mask-image:linear-gradient(to_bottom,black,transparent)]">
            <defs>
              <pattern id="cta-grid" width="28" height="28" patternUnits="userSpaceOnUse" x="50%">
                <path d="M28 0H0V28" fill="none" stroke="currentColor" strokeWidth="1" />
              </pattern>
            </defs>
            <rect width="100%" height="100%" fill="url(#cta-grid)" />
          </svg>
          <ToolStack />
          <div className="grid justify-items-center gap-3">
            <h2 className="max-w-2xl text-[1.625rem] leading-[1.3] font-semibold tracking-normal text-balance sm:text-4xl sm:leading-tight sm:tracking-tight">
              You've burned millions of tokens.
              <span className="block text-muted-foreground">Got anything to show for it?</span>
            </h2>
            <p className="max-w-xl sm:text-base text-sm font-medium text-pretty text-muted-foreground my-1 leading-relaxed">
              Claim your handle and turn every session in Claude Code, Codex, Cursor and Gemini into streaks, stats and a
              profile worth sharing.
            </p>
          </div>
          <HandleClaim id="handle-cta" handle={handle} onChange={setHandle} />
        </section>
      </div>
    </div>
  );
}

/** Each tool's mark on its own brand tile, shared by the headline and the marquee. */
const TOOL_TILES: Record<keyof typeof TOOL_MARKS, string> = {
  claude: 'bg-[#d97757] text-white',
  codex: 'border bg-white text-black',
  cursor: 'bg-black text-white dark:border dark:border-white/15',
  gemini: 'bg-[#3186ff] text-white',
  grok: 'bg-black text-white dark:border dark:border-white/15',
  opencode: 'border bg-white text-black',
  openrouter: 'bg-[#6467f2] text-white',
  hermes: 'border bg-white text-black',
};
const HEADLINE_TOOLS = Object.keys(TOOL_TILES) as (keyof typeof TOOL_MARKS)[];
/** How long each headline slot holds a tool; different on purpose, so the slots drift instead of swapping in step. */
const SLOT_HOLD_MS = [2900, 3700, 4500];

/** The headline copy with its icon slots. Each slot keeps its own clock and moves to the next tool not on screen. */
function ToolHeadline() {
  const [shown, setShown] = useState([0, 1, 2]);
  useEffect(() => {
    if (prefersReducedMotion()) return;
    let timers: ReturnType<typeof setInterval>[] = [];
    const start = () => {
      timers = SLOT_HOLD_MS.map((ms, slot) => setInterval(() => setShown((prev) => {
        let next = prev[slot];
        do next = (next + 1) % HEADLINE_TOOLS.length; while (prev.includes(next));
        return prev.map((v, i) => (i === slot ? next : v));
      }), ms));
    };
    const stop = () => timers.forEach(clearInterval);
    // Background tabs skip transitions, so swaps there would land as jumps on return; pause while hidden.
    const onVisibility = () => (document.hidden ? stop() : (stop(), start()));
    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, []);
  // Each icon sticks to the word before it and "in one … place." stays whole, so narrow screens break lines after an
  // icon, never before one or around a lone word.
  return (
    <>
      Every <span className="whitespace-nowrap">token <HeadlineIcon active={shown[0]} /></span>{' '}
      you <span className="whitespace-nowrap">burn, <HeadlineIcon active={shown[1]} /></span>{' '}
      <span className="whitespace-nowrap">in one <HeadlineIcon active={shown[2]} /> place</span>
    </>
  );
}

/**
 * Swap timing, a flip in two strictly separate halves: the old tile folds away to edge-on, and only then does the
 * next one unfold into place. Nothing overlaps.
 */
const TILE_OUT = 'transform 280ms cubic-bezier(0.5, 0, 0.75, 0), opacity 280ms cubic-bezier(0.5, 0, 0.75, 0)';
const TILE_IN = 'transform 420ms cubic-bezier(0.25, 1, 0.5, 1) 280ms, opacity 420ms cubic-bezier(0.25, 1, 0.5, 1) 280ms';

/**
 * An app-icon tile set inline with the headline text, sized to the font. Every tool's tile stays mounted and only
 * transform and opacity change (both GPU-composited).
 */
function HeadlineIcon({ active }: { active: number }) {
  return (
    <span aria-hidden className="relative inline-block size-[0.82em] translate-y-[-0.06em] align-middle [perspective:12em] sm:size-[0.92em]">
      {HEADLINE_TOOLS.map((tool, i) => (
        <span
          key={tool}
          className={cn(
            'absolute inset-0 flex items-center justify-center rounded-[0.24em] shadow-md shadow-black/10 will-change-[opacity,transform] motion-reduce:!transition-none',
            TOOL_TILES[tool],
            i === active ? 'opacity-100' : 'opacity-0',
          )}
          style={{ transform: i === active ? 'rotateX(0deg)' : 'rotateX(90deg)', transition: i === active ? TILE_IN : TILE_OUT }}
        >
          <ToolMark tool={tool} className="size-[0.56em]" />
        </span>
      ))}
    </span>
  );
}

/** Every tool's tile in an overlapping stack. The tiles spread out on hover. */
function ToolStack() {
  return (
    <div aria-hidden className="group flex">
      {HEADLINE_TOOLS.map((tool, i) => (
        <span
          key={tool}
          className={cn(
            'flex size-8 items-center justify-center rounded-lg shadow-md shadow-black/10 ring-[3px] ring-card transition-[margin] duration-300 sm:size-9',
            TOOL_TILES[tool],
            i > 0 && '-ml-1.5 group-hover:ml-1.5',
          )}
        >
          <ToolMark tool={tool} className="size-4 sm:size-4.5" />
        </span>
      ))}
    </div>
  );
}

/** The features bento. It depends on nothing typed on the page, so it's memoized out of the handle re-renders. */
const FeaturesSection = memo(function FeaturesSection() {
  return (
  <section id="features" className="grid scroll-mt-24 grid-cols-1 gap-10 sm:gap-12">
    <SectionHeading
      label="Features"
      icon={BarChart3}
      title="Everything you'd want to know, nothing you wouldn't share"
      sub="One place for every AI coding tool, built for developers who live in the terminal."
    />
    <div className="grid gap-5 md:grid-cols-6 lg:gap-6">
      <Tile className="md:col-span-4" icon={BarChart3} label="Activity" accent="var(--series-2)" title="Watch the tokens fly" body="Tokens, requests and cost stacked by day and by model, so you see what actually moved. Your biggest day gets its own spotlight.">
        <div className="grid gap-3">
          <div className="flex gap-1 text-[0.7rem]">
            {['Tokens', 'Requests', 'Cost'].map((l, i) => (
              <span key={l} className={cn('rounded-md px-2 py-0.5', i === 0 ? 'bg-surface-2 text-foreground' : 'text-subtle')}>{l}</span>
            ))}
          </div>
          <AreaChart height={92} points={FEATURE_TREND} color="var(--series-2)" format={(v) => `${compact(v)} tokens`} xLabels={['30 days ago', 'Today']} />
        </div>
      </Tile>
      <Tile className="md:col-span-2" icon={Flame} label="Streaks" accent="var(--series-4)" title="Don't break the chain" body="Any tool, any day keeps it alive. Then go chase your longest run.">
        <AreaChart height={92} points={FEATURE_STREAK} color="var(--series-4)" format={(v) => (v ? `Day ${v} of a streak` : 'No usage')} xLabels={['30 days ago', 'Today']} />
      </Tile>
      <Tile className="md:col-span-3" icon={CalendarDays} label="Heatmap" accent="var(--tb-brand)" title="Your year, square by square" body="A GitHub-style heatmap of every day you built with AI, across every tool you use, all year long.">
        <MiniContributions />
      </Tile>
      <Tile className="md:col-span-3" icon={Layers} label="Models" accent="var(--series-7)" title="Know your heavy lifters" body="See which models actually do the work. Rank by tokens, requests or cost, then dive into any one.">
        <div className="grid gap-3.5">
          {MIX.slice(0, 3).map((m) => (
            <div key={m.name} className="grid gap-1">
              <div className="flex items-center justify-between text-xs">
                <span className="inline-flex items-center gap-1.5"><span className="swatch" style={{ background: m.color }} />{m.name}</span>
                <span className="num text-subtle">{m.share}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full rounded-full" style={{ width: `${m.share}%`, background: m.color }} />
              </div>
            </div>
          ))}
        </div>
      </Tile>
      <Tile className="md:col-span-2" icon={Terminal} label="Local-first" accent="var(--series-3)" title="Your code stays home" body="A tiny CLI reads usage logs right on your machine. Prompts and code never leave it.">
        <MiniCollect />
      </Tile>
      <Tile className="md:col-span-2" icon={RefreshCw} label="Auto sync" accent="var(--series-1)" title="Set it and forget it" body="A quick sync every 30 minutes, run by your OS. Nothing humming in the background.">
        <MiniSyncs />
      </Tile>
      <Tile className="md:col-span-2" icon={Coins} label="Costs" accent="var(--series-5)" title="No mystery math" body="Billed where providers report it, list price where they don't. Always labeled.">
        <MiniCosts />
      </Tile>
    </div>
  </section>
  );
});

/** Primary call to action, depending on whether someone is signed in and has a username yet. */
function ProfileCta() {
  const { user } = useSession();
  if (!user) return <Button asChild size="lg"><a href="/login"><GitHubMark />Claim your profile <ArrowRight /></a></Button>;
  if (user.username) return <Button asChild size="lg"><Link to={`/@${user.username}`}>View your profile <ArrowRight /></Link></Button>;
  return <Button asChild size="lg"><Link to="/dashboard">Open dashboard <ArrowRight /></Link></Button>;
}

/** "yourhost/@handle" field: typing previews the handle across the page; claiming goes through sign-in. */
function HandleClaim({ id = 'handle', handle, onChange }: { id?: string; handle: string; onChange: (h: string) => void }) {
  const { user } = useSession();
  const host = useHost();
  if (user) {
    return (
      <div className="grid w-full max-w-xl grid-cols-1 gap-4">
        {/* Same shape as the claim field below, with the signed-in actions in place of the input. */}
        <div className="flex overflow-hidden rounded-xl border bg-card shadow-xs">
          <span className="flex shrink-0 items-center border-r bg-surface-2 px-3 font-mono text-sm text-muted-foreground">
            <span className="hidden sm:inline font-medium">{host}/</span>@
          </span>
          {user.username ? (
            <Link to={`/@${user.username}`} className="flex min-w-0 flex-1 items-center truncate px-3 py-2.5 text-left font-mono text-sm text-foreground hover:text-brand">
              {user.username}
            </Link>
          ) : (
            <span className="flex min-w-0 flex-1 items-center truncate px-3 py-2.5 text-left font-mono text-sm text-subtle">no handle yet</span>
          )}
          <div className="flex items-center gap-1.5 p-1.5">
            {user.username && <Button asChild size="sm" variant="ghost" className="h-8 px-3 max-sm:hidden"><Link to={`/@${user.username}`}>Profile</Link></Button>}
            <Button asChild size="sm" className="h-8 px-3"><Link to="/dashboard">Dashboard <ArrowRight /></Link></Button>
          </div>
        </div>
        <OrDivider />
        <CopyCommand command={INSTALL} className="w-full py-2 text-left" />
      </div>
    );
  }
  return <ClaimForm id={id} handle={handle} onChange={onChange} />;
}

/**
 * The signed-out claim field. Availability is checked as you type (debounced and cached, see username-check.ts).
 * Claim checks right away if the answer isn't in yet, then goes to sign-in only when the name is free (or when the
 * check can't answer, since sign-up re-checks anyway); a new account starts with the claimed name.
 */
function ClaimForm({ id, handle, onChange }: { id: string; handle: string; onChange: (h: string) => void }) {
  const live = useUsernameCheck(handle);
  // The answer to the last Claim click, shown until the name changes.
  const [submitted, setSubmitted] = useState<{ name: string; check: UsernameCheck } | null>(null);
  const [claiming, setClaiming] = useState(false);
  // Coming back from GitHub with Back restores this page as it was left, mid-claim; let the button work again.
  useEffect(() => {
    const reset = (e: PageTransitionEvent) => e.persisted && setClaiming(false);
    window.addEventListener('pageshow', reset);
    return () => window.removeEventListener('pageshow', reset);
  }, []);
  const check = submitted?.name === handle ? submitted.check : live;
  const claim = async (e: React.FormEvent) => {
    e.preventDefault();
    if (claiming) return;
    if (!handle) return window.location.assign('/login'); // nothing typed: plain sign-in
    setClaiming(true);
    const r = live.state === 'ok' ? live : await checkUsernameNow(handle);
    if (r.state === 'bad') {
      setSubmitted({ name: handle, check: r });
      setClaiming(false);
      return;
    }
    window.location.assign(`/login?handle=${encodeURIComponent(handle)}`);
  };
  const host = useHost();
  return (
    <div className="grid w-full max-w-xl grid-cols-1 gap-4">
      <form
        action="/login"
        onSubmit={claim}
        className={cn(
          'flex overflow-hidden rounded-xl border bg-card shadow-xs transition-colors focus-within:ring-1',
          check.state === 'bad' ? 'border-destructive/60 focus-within:ring-destructive/30' : 'focus-within:border-ring focus-within:ring-ring/40',
        )}
      >
        <label htmlFor={id} className="flex min-w-0 flex-1 items-stretch">
          <span className="flex shrink-0 items-center border-r bg-surface-2 px-3 font-mono text-sm text-muted-foreground">
            <span className="hidden sm:inline font-medium">{host}/</span>@
          </span>
          <input
            id={id}
            name="handle"
            value={handle}
            onChange={(e) => onChange(cleanHandle(e.target.value))}
            placeholder="yourname"
            autoComplete="off"
            spellCheck={false}
            maxLength={30}
            aria-invalid={check.state === 'bad'}
            aria-label="Username to claim"
            className="min-w-0 flex-1 bg-transparent px-3 py-2.5 font-mono text-sm text-foreground outline-none placeholder:text-subtle"
          />
          <span className="flex w-6 items-center justify-center text-subtle" aria-hidden>
            {check.state === 'checking' && !claiming && <Loader2 className="size-3.5 animate-spin" />}
            {check.state === 'ok' && <Check className="size-3.5 text-[var(--series-3)]" />}
          </span>
        </label>
        <div className="flex items-center p-1.5">
          <Button type="submit" size="sm" className="h-8 px-3 font-semibold" disabled={check.state === 'bad' || claiming}>
            {claiming ? <><Loader2 className="animate-spin" />Checking</> : <>Claim <ArrowRight /></>}
          </Button>
        </div>
      </form>
      <OrDivider />
      <CopyCommand command={INSTALL} className="w-full py-2 text-left" />
    </div>
  );
}

/** A hairline with a small label, between the claim field and the install command. */
function OrDivider() {
  return (
    <div aria-hidden className="flex items-center gap-3 font-mono text-[0.7rem] text-subtle font-medium">
      <span className="h-px flex-1 bg-border" />
      or install the CLI
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function ProfileControls({ shows, onChange }: { shows: Shows; onChange: (k: ShowKey, v: boolean) => void }) {
  return (
    <Card className="gap-3">
      <CardHeader className="gap-1.5">
        <CardTitle className="text-sm">What your profile shows</CardTitle>
        <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Lock className="size-3 text-subtle" />Same switches as Settings. Private until you publish.
        </p>
      </CardHeader>
      {/* Below lg the same switches are compact chips, so the card stays short above the preview. */}
      <CardContent className="flex flex-wrap gap-2 lg:hidden">
        {SHOW_FIELDS.map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="switch"
            aria-checked={shows[k]}
            onClick={() => onChange(k, !shows[k])}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors',
              shows[k] ? 'border-brand/40 bg-brand/10 text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Check className={cn('size-3.5 transition-opacity', shows[k] ? 'text-brand' : 'opacity-0 -ml-5')} />
            {label}
          </button>
        ))}
      </CardContent>
      <CardContent className="grid max-lg:hidden">
        {SHOW_FIELDS.map(([k, label]) => (
          <label key={k} htmlFor={k} className="flex cursor-pointer items-center justify-between gap-4 border-t py-2 text-sm font-medium">
            {label}
            <Switch id={k} size="sm" checked={shows[k]} onCheckedChange={(v) => onChange(k, v)} />
          </label>
        ))}
      </CardContent>
    </Card>
  );
}

/** macOS window controls (close, minimize, zoom) for the browser and terminal frames. */
function WindowDots() {
  return (
    <span aria-hidden className="flex flex-none gap-1.5">
      <span className="size-2.5 rounded-full bg-[#ff5f57]" />
      <span className="size-2.5 rounded-full bg-[#febc2e]" />
      <span className="size-2.5 rounded-full bg-[#28c840]" />
    </span>
  );
}

/**
 * The real profile page (top bar, ProfileView, footnote) inside a browser frame, fed example data. It shows at full
 * height with no scroll of its own, so the page scroll never gets trapped inside it.
 */
/**
 * The real profile page inside a browser frame, fed example data. It never scrolls on its own (that would trap the
 * page scroll); below lg it opens capped, with a button to show the rest.
 */
/**
 * Marks a demo as made-up numbers. Shown only to signed-in visitors: their own handle and avatar appear in the
 * demos, so without it the example stats could pass for theirs.
 */
function ExampleBadge() {
  return <Badge variant="secondary" className="flex-none font-normal">Example data</Badge>;
}

function ProfilePreview({ profile, labeled }: { profile: PublicProfile; labeled: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const host = useHost();
  return (
    <div className="relative flex flex-col overflow-clip rounded-xl border bg-background shadow-sm">
      <div className="flex flex-none items-center gap-3 border-b bg-card px-4 py-2.5">
        <WindowDots />
        <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border bg-surface-2/60 px-2.5 py-1 font-mono text-xs text-muted-foreground">
          <Lock className="size-3 flex-none text-subtle" />
          <span className="truncate">{host}/<span className="text-foreground">@{profile.username}</span></span>
        </div>
        {labeled && <ExampleBadge />}
      </div>
      <div className={cn(!expanded && 'max-lg:max-h-[44rem]')}>
        <ProfileHeader />
        <div className="mx-auto grid w-full max-w-3xl grid-cols-1 gap-6 px-4 pt-2 pb-8 sm:px-6">
          <ProfileView profile={profile} preview />
        </div>
      </div>
      {!expanded && (
        <div className="absolute inset-x-0 bottom-0 flex h-36 items-end justify-center bg-linear-to-t from-background from-30% to-transparent pb-5 lg:hidden">
          <Button size="sm" variant="outline" onClick={() => setExpanded(true)}>
            Show full profile <ChevronDown />
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * The dashboard's Overview as it really looks (top bar, stat cards, daily chart), built from the same components
 * and fed example data, so the hero always matches the app.
 */
const HeroDashboard = memo(function HeroDashboard({ rows, since, colorOf, labeled }: { rows: Row[]; since: string; colorOf: (k: string) => number; labeled: boolean }) {
  const [range, setRange] = useState<'7' | '30'>('30');
  const [metric, setMetric] = useState<Metric>('output');
  const host = useHost();
  const from = range === '7' ? new Date(nowMs() - 6 * 864e5).toISOString().slice(0, 10) : since;
  const shown = rows.filter((r) => r.day! >= from);
  const total = (f: (r: Row) => number) => shown.reduce((a, r) => a + f(r), 0);
  const runs = streakRuns(rows, since);
  const current = runs[runs.length - 1].value;
  return (
    <div className="overflow-hidden rounded-xl border bg-background shadow-xl shadow-black/5">
      <div className="flex items-center gap-2 border-b bg-card px-4 py-2.5">
        <WindowDots />
        <span className="ml-3 truncate font-mono text-xs text-subtle">{host}/dashboard</span>
        {labeled && <span className="ml-auto"><ExampleBadge /></span>}
      </div>
      <div className="flex text-left">
        {/* Content */}
        <div className="min-w-0 flex-1 bg-background">
          <div className="flex h-12 items-center gap-2 border-b px-4 text-sm">
            <span className="hidden text-muted-foreground sm:inline font-medium">Dashboard</span>
            <ChevronRight className="hidden size-3.5 text-subtle sm:block" />
            <span className="font-semibold">Overview</span>
            <span className="ml-auto inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs text-muted-foreground font-medium">
              <span className="size-1.5 rounded-full" style={{ background: 'var(--series-3)' }} />Synced 4 min ago
            </span>
          </div>
          <div className="grid gap-4 p-4 sm:p-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="grid gap-0.5">
                <span className="text-xl font-semibold">Overview</span>
                <span className="text-xs text-muted-foreground font-medium">Your AI coding usage · last {range} days · UTC</span>
              </div>
              <Pills label="Range" items={[['7', '7 days'], ['30', '30 days']]} value={range} onChange={setRange} />
            </div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <KpiCard label="Total tokens" value={compact(total(rowTokens))} hint="Across 3 tools" points={perDay(shown, from, rowTokens)} color="var(--series-2)" format={(v) => `${fmt(v)} tokens`} />
              <KpiCard label="Estimated cost" value={usd(total((r) => r.cost_usd ?? 0))} hint="API list prices, not a bill" points={perDay(shown, from, (r) => r.cost_usd ?? 0)} color="var(--series-3)" format={usd} />
              <KpiCard label="Requests" value={compact(total((r) => r.events))} hint="Across all tools" points={perDay(shown, from, (r) => r.events)} color="var(--series-1)" format={(v) => `${fmt(v)} requests`} />
              <KpiCard label="Current streak" value={plural(current, 'day')} hint={`Longest ${plural(Math.max(...runs.map((p) => p.value)), 'day')}`} points={runs.filter((p, i) => daysFrom(since)[i] >= from)} color="var(--series-4)" format={(v) => (v ? `Day ${v} of a streak` : 'No usage')} />
            </div>
            <Card>
              <CardHeader className="flex flex-wrap items-start justify-between gap-3">
                <div className="grid gap-1">
                  <CardTitle className="text-sm">{metric === 'output' ? 'Output tokens' : 'Requests'} per day</CardTitle>
                  <span className="text-xs text-muted-foreground">Stacked by model</span>
                </div>
                <Pills<Metric> label="Metric" items={[['output', 'Output'], ['requests', 'Requests']]} value={metric} onChange={setMetric} />
              </CardHeader>
              <CardContent><UsageChart rows={shown} since={from} metric={metric} colorOf={colorOf} height={200} /></CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
});

/**
 * The setup steps as a vertical stepper beside the terminal demo. Finished steps get a check, and the line below
 * the current step fills as its terminal output types out.
 */
function HowItWorks({ handle }: { handle: string }) {
  const [step, setStep] = useState(0);
  // The current step's run: how long it plays, when it started, and a key that restarts the rail fill on every run.
  const [run, setRun] = useState({ ms: 0, start: 0, key: 0, step: -1 });
  return (
    <div className="grid items-stretch gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)] lg:gap-12">
      {/* Rail stepper: reached steps are solid with a soft halo, and the rail fills toward the next step as the
          terminal plays the current one. */}
      <ol className="grid content-center">
        {STEPS.map((st, i) => {
          const state = i < step ? 'done' : i === step ? 'active' : 'next';
          const last = i === STEPS.length - 1;
          return (
            <li key={st.title}>
              <button
                type="button"
                onClick={() => setStep(i)}
                aria-current={state === 'active' ? 'step' : undefined}
                className="group grid w-full grid-cols-[auto_minmax(0,1fr)] gap-x-5 text-left"
              >
                <span className="flex flex-col items-center">
                  <span
                    className={cn(
                      'num relative z-1 flex size-9 flex-none items-center justify-center rounded-full text-sm font-medium transition-[background-color,border-color,color,box-shadow] duration-300 ease-out',
                      state === 'next'
                        ? 'border-2 bg-background text-subtle group-hover:border-foreground/30 group-hover:text-foreground'
                        : 'bg-(--series-2) text-white ring-[6px] ring-[color-mix(in_oklab,var(--series-2)_16%,transparent)] dark:ring-[color-mix(in_oklab,var(--series-2)_26%,transparent)]',
                    )}
                  >
                    {i + 1}
                  </span>
                  {!last && (
                    <span className="relative w-0.5 flex-1 overflow-hidden bg-border">
                      {/* The fill grows with a GPU transform over the step's whole run, ending as the next step lights. */}
                      {state === 'done' && <span className="absolute inset-0 bg-[var(--series-2)]" />}
                      {state === 'active' && run.step === i && run.ms > 0 && (
                        <span
                          key={run.key}
                          className="rail-fill absolute inset-0 bg-[var(--series-2)]"
                          // A negative delay pins the fill to the run's start, so a late render can't put it behind.
                          style={{ animationDuration: `${run.ms}ms`, animationDelay: `${Math.min(0, run.start - performance.now())}ms` }}
                        />
                      )}
                    </span>
                  )}
                </span>
                <span className={cn('grid min-w-0 content-start gap-2 pt-1.5', !last && 'pb-10')}>
                  <span className={cn('font-medium transition-colors duration-300', state === 'next' && 'text-muted-foreground group-hover:text-foreground')}>{st.title}</span>
                  <span className="text-sm leading-relaxed font-medium text-muted-foreground">{st.body}</span>
                  <code
                    className={cn(
                      'flex w-fit max-w-full items-center gap-2 truncate rounded-lg px-2.5 py-1 font-mono font-medium text-xs transition-colors duration-300',
                      state === 'active' ? 'bg-[var(--term-bg)] text-[var(--term-text)]' : 'bg-surface-2 text-subtle',
                    )}
                  >
                    <span className={cn('transition-colors duration-300', state === 'active' && 'text-[var(--term-green)]')}>➜</span>{st.command}
                  </code>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <TerminalDemo
        handle={handle}
        step={step}
        onPlay={(ms, start) => setRun((r) => ({ ms, start, key: r.key + 1, step }))}
        onAdvance={() => setStep((n) => (n + 1) % STEPS.length)}
      />
    </div>
  );
}

type TermLine = { cmd: string } | { out: ReactNode; gap?: boolean };

// Colors of the real CLI (packages/collector/src/ui.ts).
const T = {
  dim: (s: ReactNode) => <span className="text-[var(--term-dim)]">{s}</span>,
  blue: (s: ReactNode) => <span className="text-[var(--term-blue)]">{s}</span>,
  orange: (s: ReactNode) => <span className="text-[var(--term-orange)]">{s}</span>,
  green: (s: ReactNode) => <span className="text-[var(--term-green)]">{s}</span>,
  cyan: (s: ReactNode) => <span className="text-[var(--term-cyan)]">{s}</span>,
  bold: (s: ReactNode) => <span className="font-semibold text-[var(--term-text)]">{s}</span>,
  link: (s: ReactNode) => <span className="text-[var(--term-blue)] underline underline-offset-2">{s}</span>,
};
const ok = (s: ReactNode) => <>{T.green('✔')} {s}</>;
const ask = (q: ReactNode, hint: string, answer: string) => <>{T.blue('?')} {T.bold(q)} {T.dim(hint)} {answer}</>;
const logo = <>{T.blue('▃▅')}{T.orange('█')} {T.bold('tokenburn')}</>;
const stepTitle = (n: number, title: string) => <>{T.bold(T.blue(`${n}/5`))}  {T.bold(title)}</>;

/** A rounded panel like the CLI's boxes; drawn with CSS so it lines up at any width. */
function TermBox({ title, tone = 'var(--term-line)', children }: { title: ReactNode; tone?: string; children: ReactNode }) {
  return (
    <span className="relative my-1.5 grid gap-0.5 rounded-lg border px-3 pt-3 pb-2" style={{ borderColor: tone }}>
      <span className="absolute -top-2.5 left-2 bg-[var(--term-bg)] px-1.5">{title}</span>
      {children}
    </span>
  );
}

function terminalScripts(handle: string, host: string): TermLine[][] {
  return [
    [
      { cmd: 'npm install -g use-tokenburn' },
      { out: T.dim('added 1 package in 2s') },
      { cmd: 'tokenburn' },
      { out: <>{logo} {T.dim('0.3.1')}</> },
      { out: T.dim('Your AI coding usage across tools. Collected on this machine, shared only if you choose.') },
      { out: <>{T.bold('New here?')} One command does everything:</>, gap: true },
      { out: <>  {T.dim('tokenburn')} {T.cyan('setup')}    {T.dim('Sign in, find your tools, first upload, auto sync')}</> },
    ],
    [
      { cmd: 'tokenburn setup' },
      { out: <>{logo} {T.dim('setup')}</> },
      { out: T.dim('Five quick steps. Nothing is uploaded until you approve it.') },
      { out: stepTitle(1, 'Sign in with GitHub'), gap: true },
      {
        out: (
          <TermBox title={T.bold('Sign in with GitHub')}>
            <span>{T.dim('1.')} Open      {T.link('github.com/login/device')}</span>
            <span>{T.dim('2.')} Enter     {T.bold(T.orange('WDJB-MJHT'))}</span>
          </TermBox>
        ),
      },
      { out: ok(<>Signed in as {T.bold(handle)}</>) },
      { out: stepTitle(2, 'Find your AI coding tools'), gap: true },
      { out: <>  {ok(<>Claude Code  {T.dim('412 files · 18,204 new requests')}</>)}</> },
      { out: <>  {ok(<>Codex CLI    {T.dim('96 files · 3,118 new requests')}</>)}</> },
      { out: stepTitle(3, 'Cursor (optional)'), gap: true },
      { out: ask('Do you use Cursor? Turn on auto-import?', '(y/N)', 'y') },
      { out: ok('Cursor auto-import on') },
      { out: stepTitle(4, 'Review and upload'), gap: true },
      {
        out: (
          <TermBox title={T.bold('What gets uploaded')}>
            <span>{T.green('✔')} Uploaded   {T.dim('daily totals per model, hashed session ids')}</span>
            <span><span className="text-[var(--term-red)]">✖</span> Never      {T.dim('prompts, code, file paths, project names')}</span>
          </TermBox>
        ),
      },
      { out: ask('Upload this to your account?', '(y/N)', 'y') },
      { out: ok('Synced 64 daily totals') },
      { out: stepTitle(5, 'Automatic sync'), gap: true },
      { out: ask('Turn on automatic sync?', '(Y/n)', '') },
      { out: ok('Automatic sync on: every 30 minutes') },
      {
        out: (
          <TermBox title={T.green(T.bold("✔ You're all set"))} tone="var(--term-green)">
            <span>{T.dim('Profile')}     {T.link(`${host}/@${handle}`)} {T.dim('(private)')}</span>
            <span>{T.dim('Auto sync')}   on, every 30 min</span>
          </TermBox>
        ),
        gap: true,
      },
    ],
    [
      { cmd: 'tokenburn stats' },
      { out: <>{T.bold('Your usage · last 30 days')} {T.dim('(UTC, this machine)')}</> },
      { out: <>  {T.bold('597M')} total tokens</> },
      { out: <>  {T.bold('$735')} estimated cost {T.dim('(API list prices, not your bill)')}</> },
      { out: <>  Best day Oct 19 · current streak {T.bold('12 days')} · longest 21 days</> },
      { out: <>{T.orange('■')} {T.bold('Claude Code')}  {T.dim('local transcripts')}</>, gap: true },
      { out: <>  {T.blue('▂▃▅▇▆▃▅█▇▅▃▆▇█▅▆')}  {T.dim('output/day')}</> },
      { cmd: 'tokenburn profile public' },
      { out: ok('Your profile is now public') },
      { out: <>  {T.dim('Profile')}     {T.link(`${host}/@${handle}`)}</> },
      { out: <>  {T.dim('Visibility')}  {T.green('● Public')}</> },
    ],
  ];
}

const prefersReducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * The real CLI output for each step, typed out once the terminal scrolls into view: commands character by
 * character, output line by line. Reduced-motion users get the finished screen.
 */
/** Typing speed (ms per tick) and how long a finished step stays on screen before the next one starts. */
const TICK_MS = 28;
const HOLD_MS = 1800;
/** How long the old step's output takes to fade out before the next step starts typing. */
const SWAP_MS = 240;

function TerminalDemo({ handle, step, onPlay, onAdvance }: {
  handle: string;
  step: number;
  /** Called when a step starts playing: how long it lasts (typing plus hold; 0 when it won't auto-advance) and when. */
  onPlay: (ms: number, start: number) => void;
  onAdvance: () => void;
}) {
  const host = useHost();
  const lines = useMemo(() => terminalScripts(handle, host), [handle, host]);
  // The step on screen trails the selected one by a short fade: the old output eases out, then the new one types.
  const [shown, setShown] = useState(step);
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    if (step === shown) return;
    if (prefersReducedMotion()) {
      setShown(step);
      return;
    }
    setLeaving(true);
    const id = setTimeout(() => {
      setShown(step);
      setLeaving(false);
    }, SWAP_MS);
    return () => clearTimeout(id);
  }, [step, shown]);
  const script = lines[shown];
  // Timeline: a command costs one tick per character plus a pause; an output line costs a few ticks.
  const timeline = useMemo(() => {
    let t = 0;
    return script.map((l) => {
      const start = t;
      t += 'cmd' in l ? l.cmd.length + 12 : 4;
      return start;
    });
  }, [script]);
  const total = timeline.length ? timeline[timeline.length - 1] + 4 : 0;
  const wrap = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  // Whether earlier lines have moved out of view at the top, which turns on the top-edge fade.
  const [clipped, setClipped] = useState(false);
  const [tick, setTick] = useState(0);
  const [run, setRun] = useState(0);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    // Plays only while on screen: offscreen, the typing timer and step cycle stop instead of running forever.
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { threshold: 0.3 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // One clock drives the typing, the stepper's rail and the advance: ticks are read from elapsed time (not counted),
  // so a throttled timer can't make the terminal drift from the rail.
  const play = useRef(onPlay);
  play.current = onPlay;
  const advance = useRef(onAdvance);
  advance.current = onAdvance;
  useEffect(() => {
    if (!visible || leaving) return;
    if (prefersReducedMotion()) {
      setTick(total);
      play.current(0, performance.now());
      return;
    }
    const duration = total * TICK_MS + HOLD_MS;
    const start = performance.now();
    setTick(0);
    play.current(duration, start);
    const id = setInterval(() => setTick(Math.min(total, Math.floor((performance.now() - start) / TICK_MS))), TICK_MS);
    const next = setTimeout(() => advance.current(), duration);
    return () => {
      clearInterval(id);
      clearTimeout(next);
    };
  }, [visible, shown, leaving, total, run]);

  // Follow the output as it grows, like a terminal does, gliding rather than jumping. The body clips instead of
  // scrolling (no scrollbar, and the page scroll never gets caught here), but it can still be moved from code.
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    setClipped(el.scrollHeight > el.clientHeight + 1);
    if (el.scrollHeight - el.clientHeight - el.scrollTop > 1) {
      el.scrollTo({ top: el.scrollHeight, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    }
  }, [tick, shown]);

  const done = tick >= total;

  return (
    <div ref={wrap} className="overflow-hidden rounded-xl border border-[var(--term-line)] bg-[var(--term-bg)] text-[var(--term-text)] shadow-lg">
      <div className="flex items-center gap-2 border-b border-[var(--term-line)] bg-[var(--term-bar)] px-4 py-2.5">
        <WindowDots />
        <span className="ml-3 font-mono text-xs text-[var(--term-dim)]">~ zsh</span>
        <button
          type="button"
          onClick={() => setRun((r) => r + 1)}
          className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium text-[var(--term-dim)] transition-colors hover:text-[var(--term-text)]"
          aria-label="Replay"
        >
          <RefreshCw className="size-3" />Replay
        </button>
      </div>
      <div
        ref={body}
        className={cn(
          'h-80 overflow-hidden p-4 font-mono text-[0.78rem] leading-relaxed sm:h-[26rem] sm:p-5',
          clipped && '[mask-image:linear-gradient(to_bottom,transparent,black_3rem)]',
        )}
        role="region"
        aria-label={`Terminal showing ${STEPS[shown].command}`}
      >
        {/* Outer layer fades the old step out; the inner one, remounted per step, settles the new one in. */}
        <div
          className={cn('transition-[opacity,transform] ease-out', leaving && '-translate-y-1.5 opacity-0')}
          style={{ transitionDuration: `${SWAP_MS}ms` }}
        >
          <div key={`${shown}-${run}`} className="term-in grid content-start gap-0.5">
            {script.map((l, i) => {
              if (tick < timeline[i]) return null;
              if ('cmd' in l) {
                const typed = l.cmd.slice(0, tick - timeline[i]);
                const typing = typed.length < l.cmd.length;
                return (
                  <span key={i} className={cn('term-line whitespace-pre-wrap', i > 0 && 'mt-3')}>
                    <span className="text-[var(--term-green)]">➜</span> <span className="text-[var(--term-cyan)]">~</span> {typed}
                    {typing && <Caret />}
                  </span>
                );
              }
              return <span key={i} className={cn('term-line whitespace-pre-wrap', l.gap && 'mt-2.5')}>{l.out}</span>;
            })}
            {done && (
              <span className="mt-3">
                <span className="text-[var(--term-green)]">➜</span> <span className="text-[var(--term-cyan)]">~</span> <Caret />
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

const Caret = () => <span className="inline-block h-3.5 w-[7px] translate-y-0.5 bg-[var(--term-text)]/80 motion-safe:animate-pulse" />;

const NEVER_UPLOADED = ['Prompts and responses', 'Source code and file paths', 'Project and machine names', 'API keys and credentials'];
const SYNCED = ['Tokens per model, per day', 'Request counts', 'Hashed session ids', 'Cursor and OpenRouter rows'];
const PROFILE_CONTROLS = ['Private until you publish', 'A switch for every field', 'Preview before going public', 'Delete everything in Settings'];

/** A titled list in the app's card style, one row per item. */
function PrivacyList({ icon: Icon, title, items, local = false }: { icon: typeof Lock; title: string; items: string[]; local?: boolean }) {
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm"><Icon className="size-4 text-subtle" />{title}</CardTitle>
      </CardHeader>
      <CardContent className="grid">
        {items.map((x) => (
          <span key={x} className={cn('flex items-center justify-between gap-4 border-t py-2.5 text-sm font-medium', local && 'text-muted-foreground')}>
            {x}
            {local ? <Lock className="size-3.5 flex-none text-subtle" /> : <Check className="size-3.5 flex-none text-brand" />}
          </span>
        ))}
      </CardContent>
    </Card>
  );
}

function SectionLabel({ icon: Icon, children }: { icon: typeof Lock; children: ReactNode }) {
  return (
    <span className="inline-flex w-fit items-center gap-1.5 rounded-full border bg-card px-2.5 py-1 text-xs font-medium text-muted-foreground">
      <Icon className="size-3.5 text-brand" />{children}
    </span>
  );
}

function SectionHeading({ label, icon, title, sub }: { label?: string; icon?: typeof Lock; title: string; sub?: string }) {
  return (
    // Phones get looser leading and near-normal tracking; the tight display setting only kicks in from sm, where the
    // type is big enough to carry it.
    <div className="grid justify-items-center gap-4 text-center">
      {label && icon && <SectionLabel icon={icon}>{label}</SectionLabel>}
      <h2 className="max-w-2xl px-2 text-2xl leading-[1.3] font-semibold tracking-[-0.01em] text-balance sm:px-0 sm:text-4xl sm:tracking-tight">{title}</h2>
      {sub && <p className="max-w-2xl text-sm sm:text-base font-medium leading-relaxed text-pretty text-muted-foreground">{sub}</p>}
    </div>
  );
}

/**
 * A bento card; hovering only adds a small, soft shadow. A dark shadow disappears on a dark page, so dark mode pairs a
 * deeper shadow with a faint light edge that reads as the card lifting.
 */
function Tile({ icon: Icon, label, accent, title, body, className, children }: {
  icon: typeof Lock;
  /** Short eyebrow above the title, led by the icon in the card's accent color. */
  label: string;
  accent: string;
  title: string;
  body: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn(
        'grid content-between gap-6 rounded-2xl border bg-card p-6 transition-shadow duration-300 sm:p-8 hover:shadow-[0_6px_16px_-4px_rgb(0_0_0/0.08)] dark:hover:shadow-[0_0_0_1px_rgb(255_255_255/0.07),0_10px_28px_-8px_rgb(0_0_0/0.75)]',
        className,
      )}
    >
      <div className="grid gap-2.5">
        <span className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Icon className="size-4" style={{ color: accent }} />
          {label}
        </span>
        <h3 className="pt-1 text-xl font-semibold tracking-tight">{title}</h3>
        <p className="text-sm leading-relaxed text-muted-foreground font-medium">{body}</p>
      </div>
      {children}
    </div>
  );
}

/** "Your code stays home": one line of the CLI scanning locally. */
function MiniCollect() {
  return (
    <code className="flex w-fit max-w-full items-center gap-2 truncate rounded-lg bg-[var(--term-bg)] px-3 py-1.5 font-mono text-xs text-[var(--term-text)]">
      <span className="text-[var(--term-green)]">➜</span>tokenburn sync
      <span className="text-[var(--term-dim)]">·</span>
      <span className="text-[var(--term-green)]">✔ 3 tools found</span>
    </code>
  );
}

/** "Set it and forget it": the last few half-hourly runs as dots on a line, the latest one live. */
function MiniSyncs() {
  return (
    <div className="flex items-center gap-3">
      <div className="relative flex flex-1 items-center justify-between">
        <span aria-hidden className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border" />
        {[0, 1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={cn('relative size-2 rounded-full ring-4 ring-card', i === 4 ? 'bg-[var(--series-3)]' : 'bg-[color-mix(in_oklab,var(--series-3)_45%,var(--tb-surface-2))]')}
          />
        ))}
      </div>
      <span className="font-mono text-xs text-subtle">every 30 min</span>
    </div>
  );
}

/** "No mystery math": the three sources an amount can come from, each labeled. */
function MiniCosts() {
  const sources = [['Billed', 'var(--series-3)'], ['Tool estimate', 'var(--series-2)'], ['List price', 'var(--series-1)']];
  return (
    <div className="flex flex-wrap gap-1.5">
      {sources.map(([label, color]) => (
        <span key={label} className="rounded-full px-2 py-0.5 text-xs font-medium" style={{ color: `color-mix(in oklab, ${color} 72%, var(--foreground))`, background: `color-mix(in oklab, ${color} 12%, transparent)` }}>
          {label}
        </span>
      ))}
    </div>
  );
}
