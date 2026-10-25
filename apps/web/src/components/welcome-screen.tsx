import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Check, Loader2 } from 'lucide-react';
import { CopyCommand } from '@/components/copy-command';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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

  // Poll for the first sync while this screen is open; the dashboard replaces it as soon as data arrives.
  useEffect(() => {
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') reload();
    }, 5000);
    return () => clearInterval(t);
  }, [reload]);

  return (
    <div className="mx-auto grid w-full max-w-2xl grid-cols-1 gap-6 py-4 sm:py-8">
      <div className="grid gap-1">
        <h2 className="text-2xl font-semibold tracking-tight">Welcome to tokenburn{user ? `, ${user.github_login}` : ''}</h2>
        <p className="text-muted-foreground">Two quick steps and your AI coding usage shows up here.</p>
      </div>
      <ol className="grid grid-cols-1 gap-3">
        <Step n={1} done={!!saved} title="Claim your username" description="Your public profile lives at this address. You can change it later.">
          <UsernameForm origin={origin} saved={saved} onSaved={refresh} />
        </Step>
        <Step n={2} title="Connect your first machine" description="Usage lives on the computer where you code, so a small collector runs there (Node.js 22.18+).">
          <div className="grid grid-cols-1 gap-2">
            <p className="text-sm text-muted-foreground">Install the CLI</p>
            <CopyCommand command="npm install -g use-tokenburn" />
          </div>
          <div className="grid grid-cols-1 gap-2">
            <p className="text-sm text-muted-foreground">Run setup. It signs in with the same GitHub account, previews what it found and asks before uploading.</p>
            <CopyCommand command={origin.startsWith('http://localhost') ? `tokenburn setup --api ${origin}` : 'tokenburn setup'} />
          </div>
          <CursorNote />
          <p className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />Waiting for the first sync…
          </p>
        </Step>
        <Step n={3} optional title="Share your profile" description="Profiles are private by default. Choose what to show and publish it whenever you like.">
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
    <div className="grid gap-2 rounded-lg border bg-muted/40 p-4 text-sm">
      <p className="font-medium">Using Cursor?</p>
      <p className="text-muted-foreground">Cursor doesn't share usage with other apps, so tokenburn reads the CSV you download from Cursor.</p>
      <ol className="grid list-decimal gap-1 pl-5 text-muted-foreground marker:text-subtle">
        <li>Open <a href="https://cursor.com/dashboard?tab=usage" target="_blank" rel="noreferrer" className="text-foreground underline underline-offset-4">cursor.com → Dashboard → Usage</a> and click <span className="text-foreground">Export CSV</span>.</li>
        <li>Leave the file in your <span className="text-foreground">Downloads</span> folder. Don't move it; any file name works.</li>
        <li>Say yes to Cursor auto-import during setup. The next sync picks the file up.</li>
      </ol>
      <p className="text-xs text-subtle">Download a fresh export whenever you want newer numbers, at least once a month (files older than 45 days are skipped). Rows already imported are never counted twice.</p>
      <p className="text-xs text-subtle">Already set up? Turn it on with</p>
      <CopyCommand command="tokenburn cursor auto-import on" />
    </div>
  );
}

function Step({ n, title, description, done, optional, children }: {
  n: number; title: string; description: string; done?: boolean; optional?: boolean; children: ReactNode;
}) {
  return (
    <li className="min-w-0">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-3">
            <span className={cn('num flex size-6 shrink-0 items-center justify-center rounded-full border text-xs text-muted-foreground', done && 'border-primary bg-primary text-primary-foreground')}>
              {done ? <Check className="size-3.5" /> : n}
            </span>
            {title}
            {optional && <span className="text-xs font-normal text-subtle">Optional</span>}
          </CardTitle>
          <CardDescription className="pl-9">{description}</CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:pl-15">{children}</CardContent>
      </Card>
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
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="flex h-9 min-w-0 flex-1 items-center rounded-md border bg-background shadow-xs focus-within:ring-[3px] focus-within:ring-ring/50">
          <span className="shrink-0 pl-3 text-sm text-subtle">{host}/@</span>
          <Input
            aria-label="Username"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={30}
            autoComplete="off"
            spellCheck={false}
            className="h-full min-w-0 border-0 bg-transparent pl-0.5 shadow-none focus-visible:ring-0 dark:bg-transparent"
          />
        </div>
        <Button type="submit" disabled={busy || unchanged || check.state !== 'ok'}>{busy ? 'Saving…' : saved ? 'Change' : 'Claim'}</Button>
      </div>
      {hint && (
        <p className={cn('text-xs', error || check.state === 'bad' ? 'text-destructive' : check.state === 'ok' || unchanged ? 'text-foreground' : 'text-subtle')}>{hint}</p>
      )}
    </form>
  );
}
