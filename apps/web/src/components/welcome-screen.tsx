import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Check, ChevronDown, Loader2 } from 'lucide-react';
import { ToolMark } from '@/components/brand';
import { CopyCommand } from '@/components/copy-command';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useDashboard } from '@/layouts/app-layout';
import { api, ApiError } from '@/lib/api.ts';
import { cn } from '@/lib/utils';
import { useSession } from '@/session';

type Availability = { state: 'idle' | 'checking' | 'ok' | 'bad'; reason?: string };

/** Shown on the dashboard until the first machine syncs: claim a username, connect a machine, optionally publish. */
export function WelcomeScreen({ origin }: { origin: string }) {
  const { user, refresh } = useSession();
  const { reload } = useDashboard();
  const saved = user?.username ?? null;
  // Step 1 is done once a username is saved; the first sync (step 2) replaces this whole screen.
  const current = saved ? 2 : 1;

  // Poll for the first sync while this screen is open; the dashboard replaces it as soon as data arrives.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') reload();
    }, 5000);
    return () => clearInterval(t);
  }, [reload]);

  return (
    <div className="mx-auto grid w-full max-w-2xl grid-cols-1 gap-10 py-4 sm:py-10">
      <header className="grid justify-items-start gap-4">
        <span className="inline-flex items-center gap-2 rounded-full border bg-card py-1 pr-3 pl-1 text-xs text-muted-foreground font-medium">
          <span className="rounded-full bg-[color-mix(in_oklab,var(--series-2)_12%,transparent)] px-2 py-0.5 font-medium text-[color-mix(in_oklab,var(--series-2)_72%,var(--foreground))]">
            Step {current} of 3
          </span>
          Getting started
        </span>
        <div className="grid gap-2">
          <h2 className="text-2xl font-semibold tracking-tight text-balance sm:text-3xl">
            Welcome to tokenburn{user ? <>, <span className="text-(--series-2)">{user.github_login}</span></> : ''}
          </h2>
          <p className="max-w-lg text-muted-foreground font-medium">Two quick steps and every token you burn shows up right here.</p>
        </div>
        <div className="flex w-full max-w-xs gap-1.5" aria-hidden>
          {[1, 2, 3].map((n) => (
            <span key={n} className={cn('h-1 flex-1 rounded-full transition-colors duration-500', n < current ? 'bg-(--series-2)' : n === current ? 'bg-[color-mix(in_oklab,var(--series-2)_45%,transparent)]' : 'bg-border')} />
          ))}
        </div>
      </header>

      <ol className="grid grid-cols-1">
        <Step n={1} state={saved ? 'done' : 'active'} title="Claim your username" description="Your public profile lives at this address. You can change it later.">
          <UsernameForm origin={origin} saved={saved} onSaved={refresh} />
        </Step>
        <Step n={2} state={saved ? 'active' : 'next'} title="Connect your first machine" description="Usage lives on the computer where you code, so a small collector runs there (Node.js 22.18+).">
          <div className="grid grid-cols-1 gap-2">
            <p className="text-sm text-muted-foreground font-medium">Install the CLI</p>
            <CopyCommand command="npm install -g use-tokenburn" />
          </div>
          <div className="grid grid-cols-1 gap-2">
            <p className="text-sm text-muted-foreground font-medium">Run setup. It signs in with the same GitHub account, previews what it found and asks before uploading.</p>
            <CopyCommand command={origin.startsWith('http://localhost') ? `tokenburn setup --api ${origin}` : 'tokenburn setup'} />
          </div>
          <p className="flex items-center gap-2.5 rounded-xl border border-dashed px-3.5 py-2.5 text-sm text-muted-foreground font-medium">
            <span className="relative flex size-2">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-(--series-3) opacity-60" />
              <span className="relative inline-flex size-2 rounded-full bg-(--series-3)" />
            </span>
            Listening for your first sync. This page updates on its own.
          </p>
          <CursorNote />
        </Step>
        <Step n={3} state="next" optional last title="Share your profile" description="Profiles are private by default. Choose what to show and publish it whenever you like.">
          <div>
            <Button asChild variant="outline" size="sm"><Link to="/dashboard/settings">Profile settings</Link></Button>
          </div>
        </Step>
      </ol>
    </div>
  );
}

/** Cursor has no usage API: the collector imports the CSV you export, straight from your Downloads folder. */
function CursorNote() {
  return (
    <details className="group rounded-xl border bg-muted/30 text-sm [&_summary::-webkit-details-marker]:hidden">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 font-medium">
        <span className="flex items-center gap-2.5">
          <ToolMark tool="cursor" className="size-4" />Using Cursor?
        </span>
        <ChevronDown className="size-4 text-subtle transition-transform group-open:rotate-180" />
      </summary>
      <div className="grid gap-2 border-t px-4 pt-3 pb-4 font-medium leading-relaxed">
        <p className="text-muted-foreground">Cursor doesn't share usage with other apps, so tokenburn reads the CSV you download from Cursor.</p>
        <ol className="grid list-decimal gap-1 pl-5 text-muted-foreground marker:text-subtle">
          <li>Open <a href="https://cursor.com/dashboard?tab=usage" target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-4">cursor.com → Dashboard → Usage</a> and click <span className="text-foreground">Export CSV</span>.</li>
          <li>Leave the file in your <span className="text-foreground">Downloads</span> folder. Don't move it; any file name works.</li>
          <li>Say yes to Cursor auto-import during setup. The next sync picks the file up.</li>
        </ol>
        <p className="text-xs text-subtle leading-5">Download a fresh export whenever you want newer numbers, at least once a month (files older than 45 days are skipped). Rows already imported are never counted twice.</p>
        <p className="text-xs text-subtle">Already set up? Turn it on with</p>
        <CopyCommand command="tokenburn cursor auto-import on" />
      </div>
    </details>
  );
}

/** One step on the rail: done steps show a check, the active one an orange halo; content sits in a soft card. */
function Step({ n, title, description, state, optional, last, children }: {
  n: number; title: string; description: string; state: 'done' | 'active' | 'next'; optional?: boolean; last?: boolean; children: ReactNode;
}) {
  return (
    <li className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-4 sm:gap-x-5">
      <span className="flex flex-col items-center">
        <span
          className={cn(
            'num z-[1] flex size-8 flex-none items-center justify-center rounded-full text-sm font-medium transition-colors duration-300',
            state === 'done' && 'bg-[var(--series-2)] text-[#1c0c04]',
            state === 'active' && 'bg-[var(--series-2)] text-[#1c0c04] ring-[6px] ring-[color-mix(in_oklab,var(--series-2)_16%,transparent)] dark:ring-[color-mix(in_oklab,var(--series-2)_26%,transparent)]',
            state === 'next' && 'border-2 bg-background text-subtle',
          )}
        >
          {state === 'done' ? <Check className="size-4" /> : n}
        </span>
        {!last && <span className={cn('w-0.5 flex-1', state === 'done' ? 'bg-[var(--series-2)]' : 'bg-border')} />}
      </span>
      <div className={cn('grid min-w-0 content-start gap-4', !last && 'pb-10')}>
        <div className="grid gap-1 pt-1">
          <h3 className={cn('flex flex-wrap items-center gap-2 font-semibold', state === 'next' && 'text-muted-foreground')}>
            {title}
            {optional && <span className="rounded-full border px-2 py-px text-[0.7rem] font-medium text-subtle">Optional</span>}
          </h3>
          <p className="text-sm text-muted-foreground font-medium">{description}</p>
        </div>
        <div className={cn('grid grid-cols-1 gap-4', state === 'active' && 'rounded-2xl border bg-card p-4 shadow-xs sm:p-5')}>{children}</div>
      </div>
    </li>
  );
}

function UsernameForm({ origin, saved, onSaved }: { origin: string; saved: string | null; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(saved ?? '');
  const [check, setCheck] = useState<Availability>({ state: 'idle' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = name.trim().toLowerCase();
  const unchanged = value === saved;

  // Debounced availability check; your own saved name counts as available.
  useEffect(() => {
    if (!value || unchanged) {
      setCheck({ state: 'idle' });
      return;
    }
    setCheck({ state: 'checking' });
    let live = true;
    const t = setTimeout(() => {
      api<{ available: boolean; reason?: string }>('GET', `/api/web/username-available?name=${encodeURIComponent(value)}`)
        .then((r) => live && setCheck(r.available ? { state: 'ok' } : { state: 'bad', reason: r.reason }))
        .catch(() => live && setCheck({ state: 'idle' }));
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [value, unchanged]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (unchanged || check.state !== 'ok') return;
    setBusy(true);
    setError(null);
    try {
      await api('PUT', '/api/web/username', { username: value });
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save the username');
    } finally {
      setBusy(false);
    }
  };

  const host = origin.replace(/^https?:\/\//, '');
  const hint = error ?? (check.state === 'bad' ? check.reason : check.state === 'ok' ? 'Available' : check.state === 'checking' ? 'Checking…' : unchanged && saved ? `Saved · ${host}/@${saved}` : null);

  return (
    <form onSubmit={save} className="grid grid-cols-1 gap-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="flex h-9 min-w-0 flex-1 overflow-hidden rounded-lg border bg-background shadow-xs transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring/40">
          <span className="flex h-full shrink-0 items-center border-r bg-surface-2 px-3 font-mono text-sm text-muted-foreground">
            <span className="hidden sm:inline">{host}/</span>@
          </span>
          <Input
            aria-label="Username"
            value={name}
            onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30))}
            maxLength={30}
            autoComplete="off"
            spellCheck={false}
            placeholder="yourname"
            className="h-full min-w-0 rounded-none border-0 bg-transparent px-2.5 font-mono shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
          />
          <span className="flex items-center pr-2.5 text-subtle">
            {check.state === 'checking' && <Loader2 className="size-3.5 animate-spin" />}
            {check.state === 'ok' && <Check className="size-3.5" style={{ color: 'var(--series-3)' }} />}
          </span>
        </div>
        <Button type="submit" disabled={busy || unchanged || check.state !== 'ok'}>{busy ? 'Saving…' : saved ? 'Change' : 'Claim'}</Button>
      </div>
      {hint && (
        <p className={cn('text-xs font-medium mt-1', error || check.state === 'bad' ? 'text-destructive' : check.state === 'ok' || unchanged ? 'text-foreground' : 'text-subtle')}>{hint}</p>
      )}
    </form>
  );
}
