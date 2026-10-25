import { useMemo } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, BarChart3, CheckCircle2, Coins, Flame, Lock, Share2, Terminal } from 'lucide-react';
import { CopyCommand } from '@/components/copy-command';
import { Stat, StatGrid } from '@/components/stats';
import { UsageChart } from '@/components/usage-chart';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { colorMap, type Row } from '@/lib/series.ts';
import { useSession } from '@/session';

const INSTALL = 'npm install -g use-tokenburn && tokenburn setup';

const TOOLS = ['Claude Code', 'Codex CLI', 'Cursor', 'OpenCode', 'Gemini CLI', 'Grok CLI', 'Hermes', 'OpenRouter'];

const FEATURES = [
  { icon: Terminal, title: 'Collected on your machine', body: "A small CLI reads your tools' own usage records and syncs daily totals every 30 minutes. Nothing stays running in between." },
  { icon: Lock, title: 'Private by default', body: 'Prompts, code, file paths and keys never leave your computer. Your profile stays private until you publish it.' },
  { icon: BarChart3, title: 'Every model, side by side', body: 'Input, output and cache tokens per model and per tool, with daily and weekly trends.' },
  { icon: Flame, title: 'Streaks and best days', body: 'Current and longest streak across every tool, plus your busiest day.' },
  { icon: Coins, title: 'Honest cost estimates', body: "Billed amounts where providers report them, otherwise API list prices, always labeled as estimates." },
  { icon: Share2, title: 'A profile worth sharing', body: 'Publish /@you with only the fields you choose. Links unfurl with a summary in Slack and X.' },
];

const STEPS = [
  { title: 'Install the CLI', body: 'Works on macOS, Linux and Windows with Node 22.18+.' },
  { title: 'Sign in with GitHub', body: 'Setup previews exactly what will be uploaded and asks first.' },
  { title: 'Code as usual', body: 'Usage syncs automatically. Open the dashboard or share your profile.' },
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

export function Landing() {
  const { user } = useSession();
  const [params] = useSearchParams();
  const error = ERRORS[params.get('error') ?? ''];
  const deleted = params.get('deleted') === '1';
  const navigate = useNavigate();
  const example = useMemo(exampleRows, []);
  const colorOf = useMemo(() => colorMap(example.rows), [example]);

  return (
    <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-24 px-4 pt-16 pb-24 sm:px-6 sm:pt-24">
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

      <section className="grid grid-cols-1 justify-items-center gap-6 text-center">
        <Badge variant="outline" className="gap-1.5 rounded-full px-3 py-1 font-normal text-muted-foreground">
          <span className="size-1.5 rounded-full bg-brand" /> Local-first · Private by default
        </Badge>
        <h1 className="max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-6xl">
          See where your AI coding tokens go.
        </h1>
        <p className="max-w-xl text-base text-pretty text-muted-foreground sm:text-lg">
          tokenburn tracks usage across Claude Code, Codex, Cursor and more, right from your machine. Models, tokens, streaks and
          estimated cost in one place, with a profile you can share.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          {user ? (
            <Button asChild size="lg"><Link to="/dashboard">Open dashboard <ArrowRight /></Link></Button>
          ) : (
            <Button asChild size="lg"><a href="/login">Sign in with GitHub <ArrowRight /></a></Button>
          )}
          <Button asChild size="lg" variant="outline"><a href="#how">How it works</a></Button>
        </div>
        <CopyCommand command={INSTALL} className="w-full max-w-md text-left" />
      </section>

      <section className="grid grid-cols-1 gap-3">
        <Card className="gap-6 p-2 sm:p-4">
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-sm font-medium">Output tokens per day</CardTitle>
            <Badge variant="secondary" className="font-normal">Example data</Badge>
          </CardHeader>
          <CardContent className="grid gap-6">
            <StatGrid className="md:grid-cols-4 xl:grid-cols-4">
              <Stat label="Total tokens" value="1.4B" hint="last 21 days" />
              <Stat label="Estimated cost" value="$412" hint="API list prices" />
              <Stat label="Current streak" value="12 days" hint="consecutive days" />
              <Stat label="Best day" value="Oct 19" hint="118M tokens" />
            </StatGrid>
            <UsageChart rows={example.rows} since={example.since} metric="output" colorOf={colorOf} />
          </CardContent>
        </Card>
        <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 pt-4 text-sm text-muted-foreground">
          <span className="text-subtle">Works with</span>
          {TOOLS.map((t) => <span key={t}>{t}</span>)}
        </div>
      </section>

      <section className="grid grid-cols-1 gap-10">
        <div className="grid gap-2 text-center">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Everything you'd want to know, nothing you wouldn't share</h2>
          <p className="text-muted-foreground">Built for developers who live in the terminal.</p>
        </div>
        <div className="grid gap-px overflow-hidden rounded-xl border bg-border sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div key={f.title} className="grid content-start gap-2 bg-card p-6">
              <f.icon className="size-5 text-brand" />
              <h3 className="font-medium">{f.title}</h3>
              <p className="text-sm text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="how" className="grid scroll-mt-20 grid-cols-1 gap-10">
        <div className="grid gap-2 text-center">
          <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Up and running in a minute</h2>
          <p className="text-muted-foreground">Three steps, then it takes care of itself.</p>
        </div>
        <ol className="grid gap-4 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title} className="grid content-start gap-2 rounded-xl border bg-card p-6">
              <span className="num text-sm font-medium text-subtle">0{i + 1}</span>
              <h3 className="font-medium">{s.title}</h3>
              <p className="text-sm text-muted-foreground">{s.body}</p>
            </li>
          ))}
        </ol>
        <CopyCommand command={INSTALL} className="mx-auto w-full max-w-md" />
      </section>

      <section className="grid gap-6 rounded-xl border bg-card p-6 sm:p-10 md:grid-cols-2">
        <div className="grid content-start gap-2">
          <h2 className="text-xl font-semibold tracking-tight">What leaves your machine</h2>
          <p className="text-sm text-muted-foreground">Daily totals per model, request counts, hashed session ids and Cursor/OpenRouter rows. That's it.</p>
        </div>
        <ul className="grid gap-2 text-sm">
          {['Prompts and responses', 'Source code and file paths', 'Project and machine names', 'API keys and credentials'].map((x) => (
            <li key={x} className="flex items-center gap-2 text-muted-foreground"><Lock className="size-3.5 text-subtle" /> {x} <span className="text-subtle">never uploaded</span></li>
          ))}
        </ul>
      </section>

      <section className="grid grid-cols-1 justify-items-center gap-4 text-center">
        <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">Start tracking today</h2>
        {user ? (
          <Button asChild size="lg"><Link to="/dashboard">Open dashboard <ArrowRight /></Link></Button>
        ) : (
          <Button asChild size="lg"><a href="/login">Sign in with GitHub <ArrowRight /></a></Button>
        )}
      </section>
    </div>
  );
}
