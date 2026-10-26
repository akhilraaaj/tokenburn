import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowDown, ArrowRight, AtSign, BarChart3, CalendarDays, Check, CheckCircle2, ChevronDown, ChevronRight, CloudUpload, Coins, Flame, Globe, Laptop, Layers, Lock, RefreshCw, Terminal,
} from 'lucide-react';
import { GitHubMark, LogoMark } from '@/components/brand';
import { CopyCommand } from '@/components/copy-command';
import { Pills } from '@/components/pills';
import { UsageChart } from '@/components/usage-chart';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CONTRIBUTION_DAYS, contributionDays, type DailyRow, type DayTotal, type PublicProfile, type PublicRow } from '../../../../packages/shared/src/index.ts';
import { compact, fmt, plural, usd } from '@/lib/format.ts';
import { colorMap, daysFrom, rowTokens, type Metric, type Row } from '@/lib/series.ts';
import { cn } from '@/lib/utils';
import { AreaChart, perDay } from '@/components/profile-widgets';
import { useSession } from '@/session';
import { KpiCard, streakRuns } from './overview';
import { ProfileHeader, ProfileView } from './profile';

const INSTALL = 'npm install -g use-tokenburn && tokenburn setup';

const TOOLS = ['Claude Code', 'Codex CLI', 'Cursor', 'OpenCode', 'Gemini CLI', 'Grok CLI', 'Hermes Agent', 'OpenRouter'];

const STEPS = [
  { title: 'Install the CLI', body: 'One npm package. Works on macOS, Linux and Windows with Node 22.18+.', command: 'npm install -g use-tokenburn' },
  { title: 'Run setup', body: 'Sign in with GitHub, see what was found and exactly what will upload, then say yes.', command: 'tokenburn setup' },
  { title: 'Code as usual', body: 'It syncs every 30 minutes on its own. Check your numbers anytime, or share your profile.', command: 'tokenburn stats' },
];

/** Example model mix for the profile preview and the models tile. */
const MIX = [
  { name: 'Claude Opus 5.5', tool: 'Claude Code', share: 52, color: 'var(--series-1)' },
  { name: 'GPT-5 Codex', tool: 'Codex CLI', share: 28, color: 'var(--series-2)' },
  { name: 'Gemini 2.5 Pro', tool: 'Gemini CLI', share: 12, color: 'var(--series-3)' },
  { name: 'Other', tool: '', share: 8, color: 'var(--series-other)' },
];

/** The public-profile switches from Settings, same labels and order; they shape the preview like the server does. */
const SHOW_FIELDS = [
  ['show_github', 'GitHub account'],
  ['show_providers', 'Tools'],
  ['show_models', 'Models'],
  ['show_token_totals', 'Token totals'],
  ['show_daily_trend', 'Daily trend'],
  ['show_sessions', 'Session count'],
  ['show_streaks', 'Streaks & best day'],
  ['show_costs', 'Estimated cost'],
] as const;
type ShowKey = (typeof SHOW_FIELDS)[number][0];
type Shows = Record<ShowKey, boolean>;
const DEFAULT_SHOWS: Shows = {
  show_github: true, show_providers: true, show_models: true, show_token_totals: true,
  show_daily_trend: true, show_sessions: false, show_streaks: true, show_costs: false,
};

const FAQ = [
  { q: 'Are my prompts or code uploaded?', a: 'No. The CLI reads usage records on your machine and uploads daily totals per model, request counts and hashed session ids. Prompts, responses, code, file paths, project names and keys stay on your computer.' },
  { q: 'Is my profile public?', a: 'Not until you say so. Your profile is private by default; publish it from Settings or with tokenburn profile public, and pick exactly which fields it shows.' },
  { q: "What's on a public profile?", a: 'Only what you switch on: your tools, models, token totals, a daily chart, streaks, a contribution graph, session counts and estimated cost. Each one has its own switch, and the preview above uses the same ones.' },
  { q: 'How is cost estimated?', a: "The provider's billed amount where reported (OpenRouter), otherwise the tool's own estimate, otherwise public API list prices. It is not what a subscription costs, and it's always labeled as an estimate." },
  { q: 'Does something keep running in the background?', a: 'No. Your OS runs a quick sync every 30 minutes and nothing stays running in between.' },
  { q: 'Can I delete everything?', a: 'Yes. Deleting your account in Settings removes your profile and all uploaded usage. tokenburn forget clears the local data on each machine.' },
];

const ERRORS: Record<string, string> = {
  not_configured: 'GitHub sign-in is not configured on this server yet.',
  failed: 'Sign-in with GitHub failed or was cancelled. Please try again.',
  expired: 'That sign-in link expired. Please try again.',
  rate_limited: 'Too many sign-in attempts. Wait a minute and try again.',
};

/** Illustrative data for the preview card (clearly labeled as an example on the page). */
function exampleRows(): { rows: Row[]; since: string } {
  const since = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
  const shape = [4, 6, 3, 0, 5, 7, 2, 3, 5, 2, 8, 6, 9, 4, 6, 7, 11, 6, 8, 12, 5, 9, 14, 7, 10, 13, 8, 11, 12, 9];
  const rows: Row[] = [];
  shape.forEach((v, i) => {
    const day = new Date(Date.parse(since) + i * 864e5).toISOString().slice(0, 10);
    if (!v) return;
    rows.push({ day, provider: 'claude_code', model_id: 'claude-opus-5-5', events: v * 40, output_tokens: v * 52000, cache_read_tokens: v * 2.1e6, cost_usd: v * 1.9 });
    rows.push({ day, provider: 'codex', model_id: 'gpt-5-codex', events: v * 12, output_tokens: Math.round(v * 21000 * (1 + (i % 3) / 3)), cache_read_tokens: v * 6e5, cost_usd: v * 0.6 });
    if (i % 4 === 0) rows.push({ day, provider: 'cursor', model_id: 'auto', events: 6, output_tokens: 38000, cache_read_tokens: 9e5, cost_usd: 0.4 });
  });
  return { rows, since };
}

const EXAMPLE_MODELS = [
  { provider: 'claude_code', usage_source: 'claude_code_jsonl', model_id: 'claude-opus-5-5', events: 38, out: 52000, price: 0.31 },
  { provider: 'codex', usage_source: 'codex_jsonl', model_id: 'gpt-5-codex', events: 14, out: 24000, price: 0.12 },
  { provider: 'gemini_cli', usage_source: 'gemini_cli_jsonl', model_id: 'gemini-2.5-pro', events: 6, out: 11000, price: 0.05 },
];

/**
 * An example public profile, built the way the server builds a real one: 90 days of daily rows, then only the
 * fields the switches allow (mirrors publicProfile() in apps/api).
 */
function exampleProfile(handle: string, f: Shows): PublicProfile {
  const today = Date.parse(new Date().toISOString().slice(0, 10));
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
        cache_write_tokens: output * 4, incomplete_events: 0, cost_usd: Math.round(events * m.price * 100) / 100, billed_cost_usd: null,
        unpriced_events: 0,
      });
    });
  }

  const shows = { tokens: f.show_token_totals, costs: f.show_costs, streaks: f.show_streaks };
  const out: PublicProfile = { username: handle, display_name: null, since, shows };
  if (f.show_daily_trend || f.show_streaks) out.first_day = daily[0].day;
  if (f.show_github) out.github = { login: handle, avatar_url: '' };
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
    out.contributions = contributionDays(history, shows.tokens);
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
  if (f.show_sessions) {
    const counts = { claude_code: 412, codex: 96, gemini_cli: 31 };
    out.sessions = f.show_providers ? counts : { all: Object.values(counts).reduce((a, b) => a + b, 0) };
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

const cleanHandle = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24);

export function Landing() {
  const { user } = useSession();
  const [params] = useSearchParams();
  const error = ERRORS[params.get('error') ?? ''];
  const deleted = params.get('deleted') === '1';
  const navigate = useNavigate();
  const example = useMemo(exampleRows, []);
  const colorOf = useMemo(() => colorMap(example.rows), [example]);
  const [handle, setHandle] = useState('');
  const shown = user?.username ?? (handle || 'you');
  const [shows, setShows] = useState(DEFAULT_SHOWS);
  const [step, setStep] = useState(0);
  const profile = useMemo(() => exampleProfile(shown, shows), [shown, shows]);

  return (
    <div className="relative overflow-x-clip">

      <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-28 px-4 pt-16 pb-24 sm:px-6 sm:pt-24">
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        <Dialog open={deleted} onOpenChange={(open) => { if (!open) navigate('/', { replace: true }); }}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <div className="mb-1 flex size-10 items-center justify-center rounded-full border"><CheckCircle2 className="size-5 text-brand" /></div>
              <DialogTitle>Your account was deleted</DialogTitle>
              <DialogDescription>Your profile and all uploaded usage are gone from the server.</DialogDescription>
            </DialogHeader>
            <ul className="grid gap-3 text-sm text-muted-foreground">
              <li>If you sign in with GitHub again, you'll be asked before a new, empty account is created.</li>
              <li>To remove tokenburn from GitHub entirely, revoke it in GitHub → Settings → Applications → Authorized OAuth Apps.</li>
              <li>Machines you connected keep their local data. Run this on each to remove it:</li>
            </ul>
            <CopyCommand command="tokenburn forget" />
            <DialogFooter>
              <DialogClose asChild><Button>Done</Button></DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Hero */}
        <section className="grid grid-cols-1 justify-items-center gap-7 text-center animate-in fade-in slide-in-from-bottom-3 duration-700">
          <Badge variant="outline" className="gap-1.5 rounded-full px-3 py-1 font-normal text-muted-foreground">
            <span className="relative flex size-1.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand opacity-60" />
              <span className="relative inline-flex size-1.5 rounded-full bg-brand" />
            </span>
            Local-first · Private by default
          </Badge>
          <h1 className="max-w-4xl text-4xl font-semibold tracking-tighter text-balance sm:text-6xl md:text-7xl">
            Every token you burn, in one place.
          </h1>
          <p className="max-w-2xl text-base text-pretty text-muted-foreground sm:text-lg">
            tokenburn tracks your AI coding across Claude Code, Codex, Cursor and more, right from your machine. Get a private
            dashboard of models, tokens, streaks and cost, and a public <span className="font-medium text-foreground">@profile</span> that
            shows how you build with AI.
          </p>
          <HandleClaim handle={handle} onChange={setHandle} />
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-sm text-subtle">
            <span className="inline-flex items-center gap-1.5"><Check className="size-3.5 text-brand" />8 tools supported</span>
            <span className="inline-flex items-center gap-1.5"><Check className="size-3.5 text-brand" />Setup in a minute</span>
            <span className="inline-flex items-center gap-1.5"><Check className="size-3.5 text-brand" />Your code never leaves</span>
          </div>
        </section>

        {/* Product preview + tools */}
        <section className="grid grid-cols-1 gap-8 animate-in fade-in slide-in-from-bottom-6 duration-1000">
          <HeroDashboard rows={example.rows} since={example.since} colorOf={colorOf} handle={shown} />
          <div className="grid gap-4">
            <p className="text-center text-xs font-medium tracking-widest text-subtle uppercase">Works with the tools you already use</p>
            <div className="marquee overflow-hidden">
              <div className="marquee-track flex w-max gap-3">
                {[...TOOLS, ...TOOLS].map((t, i) => (
                  <span key={i} aria-hidden={i >= TOOLS.length} className="inline-flex items-center gap-2 rounded-full border bg-card px-4 py-1.5 text-sm whitespace-nowrap text-muted-foreground">
                    <span className="swatch rounded-full" style={{ background: `var(--series-${(i % TOOLS.length) % 7 + 1})` }} />{t}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Profile */}
        <section id="profile" className="grid scroll-mt-20 grid-cols-1 gap-10">
          <SectionHeading
            label="Your profile"
            icon={AtSign}
            title="One link that shows how you build with AI"
            sub="Your GitHub has your commits. Your tokenburn profile has the rest: the models you lean on, how much you ship with them, and how long the streak has lasted. Flip a switch and watch it change."
          />
          <div className="grid items-start gap-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
            <div className="grid gap-4">
              <ProfileControls shows={shows} onChange={(k, v) => setShows({ ...shows, [k]: v })} />
              <div className="hidden lg:grid"><ProfileCta /></div>
            </div>
            <ProfilePreview profile={profile} />
          </div>
          <div className="grid lg:hidden"><ProfileCta /></div>
        </section>

        {/* Features */}
        <section id="features" className="grid scroll-mt-20 grid-cols-1 gap-10">
          <SectionHeading
            label="Features"
            icon={BarChart3}
            title="Everything you'd want to know, nothing you wouldn't share"
            sub="One place for every AI coding tool, built for developers who live in the terminal."
          />
          <div className="grid gap-4 md:grid-cols-6">
            <Tile className="md:col-span-4" icon={BarChart3} title="Activity at a glance" body="Tokens, requests and cost per day, by model, with your best day called out.">
              <div className="grid gap-2">
                <div className="flex gap-1 text-[0.7rem]">
                  {['Tokens', 'Requests', 'Cost'].map((l, i) => (
                    <span key={l} className={cn('rounded-md px-2 py-0.5', i === 0 ? 'bg-surface-2 text-foreground' : 'text-subtle')}>{l}</span>
                  ))}
                </div>
                <AreaChart height={92} points={FEATURE_TREND} color="var(--series-2)" format={(v) => `${compact(v)} tokens`} xLabels={['30 days ago', 'Today']} />
              </div>
            </Tile>
            <Tile className="md:col-span-2" icon={Flame} title="Streaks that count" body="Any tool on any day keeps it alive. Current, longest and every run in between.">
              <AreaChart height={92} points={FEATURE_STREAK} color="var(--series-4)" format={(v) => (v ? `Day ${v} of a streak` : 'No usage')} xLabels={['30 days ago', 'Today']} />
            </Tile>
            <Tile className="md:col-span-3" icon={CalendarDays} title="A year of contributions" body="A GitHub-style grid across every tool, sized to fit any screen.">
              <MiniContributions />
            </Tile>
            <Tile className="md:col-span-3" icon={Layers} title="Every model, side by side" body="Rank by tokens, requests or cost, and open any model for its own trend.">
              <div className="grid gap-2.5">
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
            <Tile className="md:col-span-2" icon={Terminal} title="Collected on your machine" body="A small CLI reads each tool's own usage records. Your code and prompts never leave." />
            <Tile className="md:col-span-2" icon={RefreshCw} title="Syncs on its own" body="Your OS runs a quick sync every 30 minutes. Nothing stays running in between." />
            <Tile className="md:col-span-2" icon={Coins} title="Honest cost estimates" body="Billed amounts where providers report them, otherwise API list prices, always labeled." />
          </div>
        </section>

        {/* How it works */}
        <section id="how" className="grid scroll-mt-20 grid-cols-1 gap-10">
          <SectionHeading label="How it works" icon={Terminal} title="Up and running in a minute" sub="Three steps, then it takes care of itself. Pick a step to see it in the terminal." />
          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
            <ol className="relative grid gap-2">
              {/* The rail connecting the step numbers fills in up to the selected step. */}
              <span aria-hidden className="absolute top-9 bottom-9 left-[2.2rem] w-px bg-border" />
              <span
                aria-hidden
                className="absolute top-9 left-[2.2rem] w-px bg-brand transition-[height] duration-300"
                style={{ height: `calc((100% - 4.5rem) * ${step / (STEPS.length - 1)})` }}
              />
              {STEPS.map((st, i) => (
                <li key={st.title}>
                  <button
                    type="button"
                    onClick={() => setStep(i)}
                    aria-pressed={step === i}
                    className={cn(
                      'relative flex w-full gap-4 rounded-xl border p-5 text-left transition-colors',
                      step === i ? 'border-border bg-card shadow-sm' : 'border-transparent hover:bg-card/50',
                    )}
                  >
                    <span
                      className={cn(
                        'num z-[1] flex size-8 flex-none items-center justify-center rounded-full border text-sm font-medium transition-colors',
                        step === i ? 'border-brand bg-brand text-primary-foreground'
                          : i < step ? 'border-brand/50 bg-background text-brand' : 'bg-background text-muted-foreground',
                      )}
                    >
                      {i + 1}
                    </span>
                    <span className="grid min-w-0 gap-1.5">
                      <span className={cn('font-medium', step !== i && 'text-muted-foreground')}>{st.title}</span>
                      <span className="text-sm text-muted-foreground">{st.body}</span>
                      <code className={cn('w-fit truncate rounded-md px-2 py-0.5 font-mono text-xs', step === i ? 'bg-brand/10 text-brand' : 'bg-surface-2 text-subtle')}>$ {st.command}</code>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
            <TerminalDemo handle={shown} step={step} />
          </div>
        </section>

        {/* Privacy */}
        <section id="privacy" className="grid scroll-mt-20 grid-cols-1 gap-10">
          <SectionHeading
            label="Privacy"
            icon={Lock}
            title="Your code stays on your machine"
            sub="tokenburn only ever sees totals. Here's where your data goes, step by step."
          />
          <div className="grid gap-3 md:grid-cols-[1fr_auto_1fr_auto_1fr] md:items-stretch">
            <FlowCard
              icon={Laptop} color="var(--series-other)" step="1 · On your machine" title="Stays local" local
              body="Read by the CLI, never uploaded."
              items={['Prompts and responses', 'Source code and file paths', 'Project and machine names', 'API keys and credentials']}
            />
            <FlowArrow />
            <FlowCard
              icon={CloudUpload} color="var(--series-1)" step="2 · Synced" title="Only totals"
              body="Numbers, nothing you wrote."
              items={['Tokens per model, per day', 'Request counts', 'Hashed session ids', 'Cursor and OpenRouter rows']}
            />
            <FlowArrow />
            <FlowCard
              icon={Globe} color="var(--series-3)" step="3 · On your profile" title="Only what you allow"
              body="Private until you publish."
              items={['Each field has its own switch', 'Preview it before going public', 'Turn it off anytime', 'Delete everything in Settings']}
            />
          </div>
          <p className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-sm text-muted-foreground">
            <Lock className="size-3.5 text-subtle" />
            Setup shows the exact upload and asks before the first one.
          </p>
        </section>

        {/* FAQ */}
        <section id="faq" className="grid scroll-mt-20 grid-cols-1 gap-10">
          <SectionHeading title="Questions, answered" />
          <div className="mx-auto grid w-full max-w-3xl divide-y rounded-xl border bg-card">
            {FAQ.map((f) => (
              <details key={f.q} className="group px-5 py-4 [&_summary::-webkit-details-marker]:hidden">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium">
                  {f.q}
                  <ChevronDown className="size-4 flex-none text-subtle transition-transform group-open:rotate-180" />
                </summary>
                <p className="pt-2 text-sm text-pretty text-muted-foreground">{f.a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* Final CTA */}
        <section className="grid justify-items-center gap-4 rounded-2xl border bg-card px-6 py-14 text-center sm:py-16">
          <LogoMark className="size-8" />
          <h2 className="max-w-2xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Your <span className="text-brand">@{shown}</span> is waiting.
          </h2>
          <p className="max-w-md text-muted-foreground">It takes a minute, and your code stays yours.</p>
          <div className="flex flex-wrap justify-center gap-3 pt-2">
            <ProfileCta />
          </div>
        </section>
      </div>
    </div>
  );
}

/** Primary call to action, depending on whether someone is signed in and has a username yet. */
function ProfileCta() {
  const { user } = useSession();
  if (!user) return <Button asChild size="lg"><a href="/login"><GitHubMark />Claim your profile <ArrowRight /></a></Button>;
  if (user.username) return <Button asChild size="lg"><Link to={`/@${user.username}`}>View your profile <ArrowRight /></Link></Button>;
  return <Button asChild size="lg"><Link to="/dashboard">Open dashboard <ArrowRight /></Link></Button>;
}

/** "yourhost/@handle" field: typing previews the handle across the page; claiming goes through sign-in. */
function HandleClaim({ handle, onChange }: { handle: string; onChange: (h: string) => void }) {
  const { user } = useSession();
  if (user) {
    return (
      <div className="grid w-full max-w-md grid-cols-1 justify-items-center gap-4">
        <div className="flex flex-wrap justify-center gap-3">
          <Button asChild size="lg"><Link to="/dashboard">Open dashboard <ArrowRight /></Link></Button>
          {user.username && <Button asChild size="lg" variant="outline"><Link to={`/@${user.username}`}>View your profile</Link></Button>}
        </div>
        <CopyCommand command={INSTALL} className="w-full text-left" />
      </div>
    );
  }
  return (
    <div className="grid w-full max-w-lg grid-cols-1 gap-3">
      <form
        action="/login"
        className="flex items-center gap-1 rounded-xl border bg-card p-1.5 shadow-lg shadow-black/5 transition-shadow focus-within:ring-[3px] focus-within:ring-ring/30"
      >
        <label htmlFor="handle" className="flex min-w-0 flex-1 items-center pl-3 font-mono text-sm">
          <span className="flex-none text-subtle"><span className="hidden sm:inline">{window.location.host}/</span>@</span>
          <input
            id="handle"
            value={handle}
            onChange={(e) => onChange(cleanHandle(e.target.value))}
            placeholder="yourname"
            autoComplete="off"
            spellCheck={false}
            className="w-full min-w-16 bg-transparent py-1.5 text-foreground outline-none placeholder:text-subtle/70"
          />
        </label>
        <Button type="submit" size="lg" className="flex-none">Claim <ArrowRight /></Button>
      </form>
      <CopyCommand command={INSTALL} className="w-full text-left" />
    </div>
  );
}

function ProfileControls({ shows, onChange }: { shows: Shows; onChange: (k: ShowKey, v: boolean) => void }) {
  return (
    <Card className="gap-3">
      <CardHeader className="gap-1">
        <CardTitle className="text-sm">What your profile shows</CardTitle>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Lock className="size-3 text-subtle" />Same switches as Settings. Private until you publish.
        </p>
      </CardHeader>
      <CardContent className="grid gap-x-6 sm:grid-cols-2 lg:grid-cols-1">
        {SHOW_FIELDS.map(([k, label]) => (
          <label key={k} htmlFor={k} className="flex cursor-pointer items-center justify-between gap-4 border-t py-2 text-sm">
            {label}
            <Switch id={k} size="sm" checked={shows[k]} onCheckedChange={(v) => onChange(k, v)} />
          </label>
        ))}
      </CardContent>
    </Card>
  );
}

/** The real profile page (top bar, ProfileView, footnote) inside a browser frame, fed example data. */
function ProfilePreview({ profile }: { profile: PublicProfile }) {
  return (
    <div className="flex max-h-[860px] flex-col overflow-hidden rounded-xl border bg-background shadow-sm max-lg:max-h-[680px]">
      <div className="flex flex-none items-center gap-3 border-b bg-card px-4 py-2.5">
        <div className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-border" />
          <span className="size-2.5 rounded-full bg-border" />
          <span className="size-2.5 rounded-full bg-border" />
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md border bg-surface-2/60 px-2.5 py-1 font-mono text-xs text-muted-foreground">
          <Lock className="size-3 flex-none text-subtle" />
          <span className="truncate">{window.location.host}/<span className="text-foreground">@{profile.username}</span></span>
        </div>
        <Badge variant="secondary" className="font-normal">Example data</Badge>
      </div>
      {/* The page scrolls inside the frame, like a real browser window. */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <ProfileHeader handle={profile.username} />
        <div className="mx-auto grid w-full max-w-3xl grid-cols-1 gap-6 px-4 pt-2 pb-8 sm:px-6">
          <ProfileView profile={profile} preview />
          <p className="text-xs text-subtle">
            Token counts come from each tool's own records and aren't comparable across tools in every detail.
            {profile.shows.costs && ' Costs are API list-price estimates unless billed by the provider; not what a subscription costs.'}
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * The dashboard's Overview as it really looks (top bar, stat cards, daily chart), built from the same components
 * and fed example data, so the hero always matches the app.
 */
function HeroDashboard({ rows, since, colorOf, handle }: { rows: Row[]; since: string; colorOf: (k: string) => number; handle: string }) {
  const [range, setRange] = useState<'7' | '30'>('30');
  const [metric, setMetric] = useState<Metric>('output');
  const from = range === '7' ? new Date(Date.now() - 6 * 864e5).toISOString().slice(0, 10) : since;
  const shown = rows.filter((r) => r.day! >= from);
  const total = (f: (r: Row) => number) => shown.reduce((a, r) => a + f(r), 0);
  const runs = streakRuns(rows, since);
  const current = runs[runs.length - 1].value;
  return (
    <div className="overflow-hidden rounded-xl border bg-background shadow-xl shadow-black/5">
      <div className="flex items-center gap-2 border-b bg-card px-4 py-2.5">
        <span className="size-2.5 rounded-full bg-border" />
        <span className="size-2.5 rounded-full bg-border" />
        <span className="size-2.5 rounded-full bg-border" />
        <span className="ml-3 truncate font-mono text-xs text-subtle">{window.location.host}/dashboard</span>
        <Badge variant="secondary" className="ml-auto font-normal">Example data</Badge>
      </div>
      <div className="flex text-left">
        {/* Content */}
        <div className="min-w-0 flex-1 bg-background">
          <div className="flex h-12 items-center gap-2 border-b px-4 text-sm">
            <span className="hidden text-muted-foreground sm:inline">Dashboard</span>
            <ChevronRight className="hidden size-3.5 text-subtle sm:block" />
            <span className="font-medium">Overview</span>
            <span className="ml-auto inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs text-muted-foreground">
              <span className="size-1.5 rounded-full" style={{ background: 'var(--series-3)' }} />Synced 4 min ago
            </span>
          </div>
          <div className="grid gap-4 p-4 sm:p-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="grid gap-0.5">
                <span className="text-xl font-semibold tracking-tight">Overview</span>
                <span className="text-xs text-muted-foreground">Your AI coding usage · last {range} days · UTC</span>
              </div>
              <Pills label="Range" items={[['7', '7 days'], ['30', '30 days']]} value={range} onChange={setRange} />
            </div>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <KpiCard label="Total tokens" value={compact(total(rowTokens))} hint="Across 3 tools" points={perDay(shown, from, rowTokens)} color="var(--series-2)" format={(v) => `${fmt(v)} tokens`} />
              <KpiCard label="Estimated cost" value={usd(total((r) => r.cost_usd ?? 0))} hint="API list prices, not a bill" points={perDay(shown, from, (r) => r.cost_usd ?? 0)} color="var(--series-3)" format={usd} />
              <KpiCard label="Requests" value={compact(total((r) => r.events))} hint="412 sessions" points={perDay(shown, from, (r) => r.events)} color="var(--series-1)" format={(v) => `${fmt(v)} requests`} />
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
}

function TerminalDemo({ handle, step }: { handle: string; step: number }) {
  const scripts: [string, ReactNode][][] = [
    [
      ['cmd', <><span className="text-subtle">$</span> npm install -g use-tokenburn</>],
      ['dim', 'added 1 package in 3s'],
      ['ok', <>Installed. Next: <span className="text-foreground">tokenburn setup</span></>],
    ],
    [
      ['cmd', <><span className="text-subtle">$</span> tokenburn setup</>],
      ['ok', <>Signed in with GitHub as <span className="text-foreground">@{handle}</span></>],
      ['dim', 'Found on this machine:'],
      ['dim', '  Claude Code   412 sessions'],
      ['dim', '  Codex CLI      96 sessions'],
      ['dim', '  Cursor        usage export'],
      ['ask', <>Upload daily totals per model? <span className="text-subtle">(prompts & code stay local)</span> <span className="text-foreground">Yes</span></>],
      ['ok', 'Auto-sync on, every 30 minutes'],
    ],
    [
      ['cmd', <><span className="text-subtle">$</span> tokenburn stats</>],
      ['dim', 'Last 30 days'],
      ['dim', '  Tokens        412M      Est. cost   $186'],
      ['dim', '  Streak        12 days   Best day    Oct 19'],
      ['ok', 'Synced 4 minutes ago'],
      ['link', <>{window.location.host}/@{handle}</>],
    ],
  ];
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-sm">
      <div className="flex items-center gap-2 border-b bg-surface-2/50 px-4 py-2.5">
        <span className="size-2.5 rounded-full bg-border" />
        <span className="size-2.5 rounded-full bg-border" />
        <span className="size-2.5 rounded-full bg-border" />
        <span className="ml-3 font-mono text-xs text-subtle">~ zsh</span>
        <span className="ml-auto text-xs text-subtle">Step {step + 1} of {scripts.length}</span>
      </div>
      <pre key={step} className="grid min-h-72 content-start gap-1 overflow-x-auto p-5 font-mono text-[0.8rem] leading-relaxed text-muted-foreground animate-in fade-in duration-300">
        {scripts[step].map(([kind, text], i) => (
          <span key={i} className={cn(kind === 'cmd' && 'pb-1 font-medium text-foreground', kind === 'link' && 'text-brand')}>
            {kind === 'ok' && <span style={{ color: 'var(--series-3)' }}>✓ </span>}
            {kind === 'ask' && <span style={{ color: 'var(--series-4)' }}>? </span>}
            {kind === 'link' && '→ '}
            {text}
          </span>
        ))}
        <span className="inline-block h-4 w-2 animate-pulse bg-foreground/70" />
      </pre>
    </div>
  );
}

/** One stage of the data flow in the privacy section, tinted with its stage color. */
function FlowCard({ icon: Icon, color, step, title, body, items, local = false }: {
  icon: typeof Lock;
  color: string;
  step: string;
  title: string;
  body: string;
  items: string[];
  local?: boolean;
}) {
  return (
    <div className="grid content-start gap-4 rounded-xl border bg-card p-5">
      <div className="grid gap-3">
        <span
          className="flex size-10 items-center justify-center rounded-xl"
          style={{ background: `color-mix(in oklab, ${color} 16%, transparent)`, color }}
        >
          <Icon className="size-5" />
        </span>
        <div className="grid gap-0.5">
          <span className="text-xs text-subtle">{step}</span>
          <span className="text-lg font-semibold tracking-tight">{title}</span>
          <span className="text-sm text-muted-foreground">{body}</span>
        </div>
      </div>
      <ul className="grid gap-2 border-t pt-4 text-sm">
        {items.map((x) => (
          <li key={x} className={cn('flex items-center gap-2', local && 'text-muted-foreground')}>
            {local ? <Lock className="size-3.5 flex-none text-subtle" /> : <Check className="size-3.5 flex-none" style={{ color }} />}
            {x}
          </li>
        ))}
      </ul>
    </div>
  );
}

function FlowArrow() {
  return (
    <div aria-hidden className="flex items-center justify-center text-subtle">
      <ArrowRight className="hidden size-4 md:block" />
      <ArrowDown className="size-4 md:hidden" />
    </div>
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
    <div className="grid justify-items-center gap-3 text-center">
      {label && icon && <SectionLabel icon={icon}>{label}</SectionLabel>}
      <h2 className="max-w-2xl text-3xl font-semibold tracking-tight text-balance sm:text-4xl">{title}</h2>
      {sub && <p className="max-w-2xl text-pretty text-muted-foreground">{sub}</p>}
    </div>
  );
}

function Tile({ icon: Icon, title, body, className, children }: { icon: typeof Lock; title: string; body: string; className?: string; children?: ReactNode }) {
  return (
    <div className={cn('group grid content-between gap-4 rounded-xl border bg-card p-6 transition-all hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-lg hover:shadow-black/5', className)}>
      <div className="grid gap-2">
        <span className="flex size-9 items-center justify-center rounded-lg border bg-surface-2/60 transition-colors group-hover:border-brand/40">
          <Icon className="size-4.5 text-brand" />
        </span>
        <h3 className="font-medium">{title}</h3>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
      {children}
    </div>
  );
}
