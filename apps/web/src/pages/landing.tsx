import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ArrowRight, AtSign, BarChart3, Check, CheckCircle2, ChevronDown, Coins, Flame, Lock, Share2, Terminal,
} from 'lucide-react';
import { GitHubMark, LogoMark } from '@/components/brand';
import { CopyCommand } from '@/components/copy-command';
import { Stat, StatGrid } from '@/components/stats';
import { UsageChart } from '@/components/usage-chart';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CONTRIBUTION_DAYS, contributionDays, type DailyRow, type DayTotal, type PublicProfile, type PublicRow } from '../../../../packages/shared/src/index.ts';
import { compact } from '@/lib/format.ts';
import { colorMap, modelDisplayName, providerLabel, rowTokens, type Row } from '@/lib/series.ts';
import { cn } from '@/lib/utils';
import { useSession } from '@/session';
import { ProfileHeader, ProfileView } from './profile';

const INSTALL = 'npm install -g use-tokenburn && tokenburn setup';

const TOOLS = ['Claude Code', 'Codex CLI', 'Cursor', 'OpenCode', 'Gemini CLI', 'Grok CLI', 'Hermes Agent', 'OpenRouter'];

const STEPS = [
  { title: 'Install the CLI', body: 'Works on macOS, Linux and Windows with Node 22.18+.' },
  { title: 'Sign in with GitHub', body: 'Setup previews exactly what will be uploaded and asks first.' },
  { title: 'Code as usual', body: 'Usage syncs automatically every 30 minutes. Open the dashboard or share your profile.' },
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
  const since = new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10);
  const shape = [3, 5, 2, 8, 6, 9, 4, 0, 7, 11, 6, 8, 12, 5, 9, 14, 7, 10, 13, 8, 11];
  const rows: Row[] = [];
  shape.forEach((v, i) => {
    const day = new Date(Date.parse(since) + i * 864e5).toISOString().slice(0, 10);
    if (!v) return;
    rows.push({ day, provider: 'claude_code', model_id: 'claude-opus-5-5', events: v * 40, output_tokens: v * 52000 });
    rows.push({ day, provider: 'codex', model_id: 'gpt-5-codex', events: v * 12, output_tokens: Math.round(v * 21000 * (1 + (i % 3) / 3)) });
    if (i % 4 === 0) rows.push({ day, provider: 'cursor', model_id: 'auto', events: 6, output_tokens: 38000 });
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
          <div className="relative">
            <Card className="gap-0 overflow-hidden p-0 shadow-xl shadow-black/5">
              <div className="flex items-center gap-2 border-b bg-surface-2/50 px-4 py-2.5">
                <span className="size-2.5 rounded-full bg-border" />
                <span className="size-2.5 rounded-full bg-border" />
                <span className="size-2.5 rounded-full bg-border" />
                <span className="ml-3 truncate font-mono text-xs text-subtle">tokenburn · dashboard</span>
                <Badge variant="secondary" className="ml-auto font-normal">Example data</Badge>
              </div>
              <div className="grid gap-6 p-4 sm:p-6">
                <StatGrid className="md:grid-cols-4 lg:grid-cols-4">
                  <Stat label="Total tokens" value="1.4B" hint="last 21 days" />
                  <Stat label="Estimated cost" value="$412" hint="API list prices" />
                  <Stat label="Current streak" value="12 days" hint="consecutive days" />
                  <Stat label="Best day" value="Oct 19" hint="118M tokens" />
                </StatGrid>
                <Card>
                  <CardHeader><CardTitle className="text-sm font-medium">Output tokens per day</CardTitle></CardHeader>
                  <CardContent><UsageChart rows={example.rows} since={example.since} metric="output" colorOf={colorOf} /></CardContent>
                </Card>
              </div>
            </Card>
          </div>
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
            sub="Your GitHub has your commits. Your tokenburn profile has the rest: the models you lean on, how much you ship with them, and how long the streak has lasted."
          />
          <div className="grid gap-4">
            <ProfileControls shows={shows} onChange={(k, v) => setShows({ ...shows, [k]: v })} />
            <ProfilePreview profile={profile} />
          </div>
          <div className="grid items-center gap-6 rounded-xl border bg-card p-6 md:grid-cols-2 sm:p-8">
            <div className="grid content-start gap-3">
              <h3 className="text-xl font-semibold tracking-tight">Looks good wherever you share it</h3>
              <p className="text-sm text-muted-foreground">
                Drop your link in Slack, X or iMessage and it unfurls with your tools, top model, tokens and streak. Only what you
                chose to show.
              </p>
              <div className="flex flex-wrap gap-3 pt-1">
                <ProfileCta />
              </div>
            </div>
            <Unfurl profile={profile} />
          </div>
        </section>

        {/* Features */}
        <section id="features" className="grid scroll-mt-20 grid-cols-1 gap-10">
          <SectionHeading label="Features" icon={BarChart3} title="Everything you'd want to know, nothing you wouldn't share" sub="Built for developers who live in the terminal." />
          <div className="grid gap-4 md:grid-cols-6">
            <Tile className="md:col-span-4" icon={BarChart3} title="Every model, side by side" body="Input, output and cache tokens per model and per tool, with daily and weekly trends.">
              <div className="grid gap-3 pt-2">
                <div className="flex h-3 overflow-hidden rounded-full">
                  {MIX.map((m) => <div key={m.name} style={{ width: `${m.share}%`, background: m.color }} />)}
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {MIX.map((m) => (
                    <span key={m.name} className="inline-flex items-center gap-1.5">
                      <span className="swatch" style={{ background: m.color }} />{m.name}<span className="num text-subtle">{m.share}%</span>
                    </span>
                  ))}
                </div>
              </div>
            </Tile>
            <Tile className="md:col-span-2" icon={Flame} title="Streaks and best days" body="Current and longest streak across every tool, plus your busiest day.">
              <div className="flex items-end gap-1 pt-2">
                {[3, 5, 4, 7, 6, 8, 10, 9, 12, 14].map((h, i) => (
                  <div key={i} className="flex-1 rounded-sm" style={{ height: h * 4, background: i === 9 ? 'var(--series-2)' : 'color-mix(in oklab, var(--series-2) 35%, var(--tb-surface-2))' }} />
                ))}
              </div>
            </Tile>
            <Tile className="md:col-span-2" icon={Terminal} title="Collected on your machine" body="A small CLI reads your tools' own usage records. Nothing stays running in between syncs." />
            <Tile className="md:col-span-2" icon={Coins} title="Honest cost estimates" body="Billed amounts where providers report them, otherwise API list prices, always labeled." />
            <Tile className="md:col-span-2" icon={Share2} title="Made to be shared" body="Publish /@you with only the fields you choose. Links unfurl with a summary." />
          </div>
        </section>

        {/* How it works */}
        <section id="how" className="grid scroll-mt-20 grid-cols-1 gap-10">
          <SectionHeading label="How it works" icon={Terminal} title="Up and running in a minute" sub="Three steps, then it takes care of itself." />
          <div className="grid items-center gap-8 lg:grid-cols-2">
            <ol className="grid gap-3">
              {STEPS.map((s, i) => (
                <li key={s.title} className="group flex gap-4 rounded-xl border bg-card p-5 transition-colors hover:border-brand/40">
                  <span className="num flex size-8 flex-none items-center justify-center rounded-full border bg-surface-2 text-sm font-medium text-muted-foreground transition-colors group-hover:border-brand/40 group-hover:text-brand">
                    {i + 1}
                  </span>
                  <div className="grid gap-1">
                    <h3 className="font-medium">{s.title}</h3>
                    <p className="text-sm text-muted-foreground">{s.body}</p>
                  </div>
                </li>
              ))}
            </ol>
            <TerminalDemo handle={shown} />
          </div>
          <CopyCommand command={INSTALL} className="mx-auto w-full max-w-md" />
        </section>

        {/* Privacy */}
        <section id="privacy" className="grid scroll-mt-20 gap-8 overflow-hidden rounded-2xl border bg-card p-6 sm:p-10 md:grid-cols-2">
          <div className="grid content-start gap-3">
            <SectionLabel icon={Lock}>Privacy</SectionLabel>
            <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">What leaves your machine</h2>
            <p className="text-muted-foreground">
              Daily totals per model, request counts, hashed session ids and Cursor/OpenRouter rows. That's it. Setup shows you the
              exact upload and asks before the first one.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-1 lg:grid-cols-2">
            <div className="grid content-start gap-2.5 rounded-xl border bg-surface-2/40 p-4">
              <p className="text-xs font-medium tracking-wide text-subtle uppercase">Uploaded</p>
              {['Daily token totals', 'Model and tool names', 'Request counts', 'Hashed session ids'].map((x) => (
                <span key={x} className="flex items-center gap-2 text-sm"><Check className="size-3.5 text-brand" />{x}</span>
              ))}
            </div>
            <div className="grid content-start gap-2.5 rounded-xl border bg-surface-2/40 p-4">
              <p className="text-xs font-medium tracking-wide text-subtle uppercase">Never uploaded</p>
              {['Prompts and responses', 'Source code and file paths', 'Project and machine names', 'API keys and credentials'].map((x) => (
                <span key={x} className="flex items-center gap-2 text-sm text-muted-foreground"><Lock className="size-3.5 text-subtle" />{x}</span>
              ))}
            </div>
          </div>
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
        <section className="relative grid justify-items-center gap-5 overflow-hidden rounded-2xl border bg-card px-6 py-14 text-center sm:py-20">
          <LogoMark className="relative size-10" />
          <h2 className="relative max-w-2xl text-3xl font-semibold tracking-tight text-balance sm:text-5xl">
            Your <span className="text-brand">@{shown}</span> is waiting.
          </h2>
          <p className="relative max-w-md text-muted-foreground">Start tracking today. It takes a minute, and your code stays yours.</p>
          <div className="relative flex flex-wrap justify-center gap-3">
            <ProfileCta />
            <Button asChild size="lg" variant="outline"><a href="#how">How it works</a></Button>
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
    <Card className="gap-4">
      <CardHeader className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1">
        <CardTitle className="text-base">Choose what your profile shows</CardTitle>
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Lock className="size-3.5 text-subtle" />The same switches as Settings. Private until you publish.
        </p>
      </CardHeader>
      <CardContent className="grid gap-x-8 sm:grid-cols-2 lg:grid-cols-4">
        {SHOW_FIELDS.map(([k, label]) => (
          <label key={k} htmlFor={k} className="flex cursor-pointer items-center justify-between gap-4 border-t py-2.5 text-sm">
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
    <div className="overflow-hidden rounded-xl border bg-background shadow-sm">
      <div className="flex items-center gap-3 border-b bg-card px-4 py-2.5">
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
      <ProfileHeader handle={profile.username} />
      <div className="mx-auto grid w-full max-w-3xl grid-cols-1 gap-6 px-4 pt-2 pb-8 sm:px-6">
        <ProfileView profile={profile} preview />
        <p className="text-xs text-subtle">
          Token counts come from each tool's own records and aren't comparable across tools in every detail.
          {profile.shows.costs && ' Costs are API list-price estimates unless billed by the provider; not what a subscription costs.'}
        </p>
      </div>
    </div>
  );
}

/** A chat-style link preview with the same description the server puts in the profile's Open Graph tags. */
function Unfurl({ profile }: { profile: PublicProfile }) {
  const handle = profile.username;
  const providers = [...new Set((profile.breakdown ?? []).map((b) => b.provider).filter(Boolean))] as string[];
  const top = (profile.breakdown ?? []).filter((b) => b.model_id).sort((a, b) => b.events - a.events)[0];
  const h = profile.highlights ?? {};
  const description = [
    providers.length ? `Uses ${providers.map(providerLabel).join(', ')}` : 'AI coding usage',
    top?.model_id ? `most-used model: ${modelDisplayName(top.model_id)}` : '',
    h.totalTokens !== undefined ? `${compact(h.totalTokens)} tokens in 90 days` : '',
    h.currentStreak ? `${h.currentStreak}-day streak` : '',
  ].filter(Boolean).join(' · ');
  return (
    <div className="grid gap-2 rounded-xl border bg-background p-4">
      <div className="flex items-center gap-2 text-sm">
        <Avatar className="size-6 rounded-md"><AvatarFallback className="rounded-md text-[0.6rem]">{handle.slice(0, 2).toUpperCase()}</AvatarFallback></Avatar>
        <span className="font-medium">{handle}</span>
        <span className="text-xs text-subtle">just now</span>
      </div>
      <p className="text-sm">
        new streak record 🔥 <span className="text-brand">{window.location.host}/@{handle}</span>
      </p>
      <div className="grid gap-0.5 border-l-2 border-brand pl-3">
        <p className="flex items-center gap-1.5 text-xs text-subtle"><LogoMark className="size-3" />tokenburn</p>
        <p className="text-sm font-medium text-brand">@{handle} on tokenburn</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

function TerminalDemo({ handle }: { handle: string }) {
  const lines: [string, ReactNode][] = [
    ['cmd', <><span className="text-subtle">$</span> tokenburn setup</>],
    ['ok', <>Signed in with GitHub as <span className="text-foreground">@{handle}</span></>],
    ['dim', 'Found on this machine:'],
    ['dim', '  Claude Code   412 sessions'],
    ['dim', '  Codex CLI      96 sessions'],
    ['dim', '  Cursor        usage export'],
    ['ask', <>Upload daily totals per model? <span className="text-subtle">(prompts & code stay local)</span> <span className="text-foreground">Yes</span></>],
    ['ok', 'Auto-sync on, every 30 minutes'],
    ['link', <>{window.location.host}/@{handle}</>],
  ];
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-xl shadow-black/5">
      <div className="flex items-center gap-2 border-b bg-surface-2/50 px-4 py-2.5">
        <span className="size-2.5 rounded-full bg-border" />
        <span className="size-2.5 rounded-full bg-border" />
        <span className="size-2.5 rounded-full bg-border" />
        <span className="ml-3 font-mono text-xs text-subtle">~ zsh</span>
      </div>
      <pre className="grid gap-1 overflow-x-auto p-5 font-mono text-[0.8rem] leading-relaxed text-muted-foreground">
        {lines.map(([kind, text], i) => (
          <span key={i} className={cn(kind === 'cmd' && 'pb-1 text-foreground')}>
            {kind === 'ok' && <span className="text-brand">✓ </span>}
            {kind === 'ask' && <span style={{ color: 'var(--series-2)' }}>? </span>}
            {kind === 'link' && <span className="text-brand">→ </span>}
            {text}
          </span>
        ))}
        <span className="inline-block h-4 w-2 animate-pulse bg-foreground/70" />
      </pre>
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
