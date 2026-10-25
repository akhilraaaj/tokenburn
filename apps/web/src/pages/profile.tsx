import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { CalendarDays, LayoutDashboard, Pencil, Share2 } from 'lucide-react';
import { toast } from 'sonner';
import type { PublicProfile } from '../../../../packages/shared/src/index.ts';
import { GitHubMark, Wordmark } from '@/components/brand';
import { ModelTable } from '@/components/model-table';
import { HighlightStats, Stat } from '@/components/stats';
import { UsageChart } from '@/components/usage-chart';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError } from '@/lib/api.ts';
import { dayLabel, fmt } from '@/lib/format.ts';
import { colorMap, METRIC_LABEL, providerLabel } from '@/lib/series.ts';
import { useSession } from '@/session';
import { NotFound } from './not-found';

const addDays = (day: string, n: number) => {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Where the chart starts: a few days before the first activity, but always at least 30 days, so a profile
 * that started tracking recently isn't mostly empty space.
 */
function chartStart(since: string, firstDay: string | null) {
  if (!firstDay) return since;
  const start = [addDays(firstDay, -3), addDays(new Date().toISOString().slice(0, 10), -29)].sort()[0];
  return start < since ? since : start;
}

async function share(url: string, title: string) {
  if (navigator.share) {
    await navigator.share({ url, title }).catch(() => {});
    return;
  }
  await navigator.clipboard.writeText(url).then(() => toast.success('Profile link copied'), () => toast.error('Could not copy the link'));
}

/** Profiles get a bare top bar: the logo, and actions that depend on who's looking. */
function ProfileFrame({ handle, children }: { handle: string; children: ReactNode }) {
  const { user, loading } = useSession();
  const own = !!user && user.username === handle;
  const url = `${window.location.origin}/@${handle}`;
  return (
    <div className="flex min-h-svh flex-col">
      <header className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between gap-3 px-4 sm:px-6">
        <Wordmark to={user ? '/dashboard' : '/'} />
        {!loading && (
          <div className="flex items-center gap-2">
            {user ? (
              <>
                <Button size="sm" variant="outline" onClick={() => share(url, `@${handle} on tokenburn`)}><Share2 />Share</Button>
                {own ? (
                  <Button asChild size="sm"><Link to="/dashboard/settings"><Pencil />Edit profile</Link></Button>
                ) : (
                  <Button asChild size="sm"><Link to="/dashboard"><LayoutDashboard />Dashboard</Link></Button>
                )}
              </>
            ) : (
              <>
                <Button asChild size="sm" variant="ghost"><a href="/login">Sign in</a></Button>
                <Button asChild size="sm"><a href="/login">Create your profile</a></Button>
              </>
            )}
          </div>
        )}
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}

export function Profile() {
  const { pathname } = useLocation();
  const handle = decodeURIComponent(pathname.slice(1)).replace(/^@/, '').replace(/\/$/, '').toLowerCase();
  return <ProfileFrame handle={handle}><ProfileBody handle={handle} /></ProfileFrame>;
}

function ProfileBody({ handle }: { handle: string }) {
  const { user } = useSession();
  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    setProfile(null);
    setMissing(false);
    api<PublicProfile>('GET', `/api/public/${encodeURIComponent(handle)}`)
      .then((p) => { setProfile(p); document.title = `@${p.username} · tokenburn`; })
      .catch((e: ApiError) => { if (e.status === 404) setMissing(true); });
  }, [handle]);

  const breakdown = profile?.breakdown ?? [];
  const colorOf = useMemo(() => colorMap(profile?.daily?.length ? profile.daily : breakdown), [profile]);

  if (missing) {
    const own = user?.username === handle;
    return own ? (
      <div className="mx-auto grid max-w-md justify-items-center gap-3 px-4 py-24 text-center">
        <h1 className="text-2xl font-semibold tracking-tight">Your profile is private</h1>
        <p className="text-muted-foreground">Turn it on in Settings, and choose what it shows.</p>
        <Button asChild variant="outline"><Link to="/dashboard/settings">Open settings</Link></Button>
      </div>
    ) : <NotFound message="This profile doesn't exist or is private." />;
  }
  if (!profile) {
    return (
      <div className="mx-auto grid w-full max-w-5xl gap-6 px-4 py-6 sm:px-6">
        <Skeleton className="h-36 rounded-xl" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  const providers = [...new Set(breakdown.map((b) => b.provider).filter(Boolean))] as string[];
  const h = profile.highlights ?? {};
  const metric = profile.shows.tokens ? 'output' : 'requests';
  const sessions = Object.entries(profile.sessions ?? {});
  const empty = !profile.daily && !breakdown.length && !sessions.length && !Object.keys(h).length;
  const name = profile.display_name || profile.username;
  const start = chartStart(profile.since, profile.first_day ?? null);

  return (
    <div className="mx-auto grid w-full max-w-5xl grid-cols-1 gap-6 px-4 pt-2 pb-12 sm:px-6">
      <Card>
        <CardContent className="flex flex-col gap-5 sm:flex-row sm:items-center">
          <Avatar className="size-20 rounded-2xl border">
            {profile.github && <AvatarImage src={profile.github.avatar_url} alt="" className="rounded-2xl" />}
            <AvatarFallback className="rounded-2xl text-2xl">{name.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="grid min-w-0 flex-1 gap-2">
            <div className="grid gap-0.5">
              <h1 className="truncate text-2xl font-semibold tracking-tight">{name}</h1>
              <p className="text-sm text-muted-foreground">@{profile.username}</p>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-muted-foreground">
              {profile.github && (
                <a href={`https://github.com/${profile.github.login}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 hover:text-foreground">
                  <GitHubMark className="size-3.5" />{profile.github.login}
                </a>
              )}
              {profile.first_day && (
                <span className="inline-flex items-center gap-1.5"><CalendarDays className="size-3.5" />Tracking since {dayLabel(profile.first_day)}</span>
              )}
            </div>
            {providers.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {providers.map((p) => <Badge key={p} variant="secondary" className="font-normal">{providerLabel(p)}</Badge>)}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <HighlightStats
        h={h}
        {...profile.shows}
        windowLabel="last 90 days"
        extra={sessions.map(([k, v]) => <Stat key={k} label={k === 'all' ? 'Sessions' : `${providerLabel(k)} sessions`} value={fmt(v)} hint="last 90 days" />)}
      />

      {profile.daily && !profile.first_day && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">No usage in the last 90 days yet.</CardContent>
        </Card>
      )}

      {profile.daily && profile.first_day && (
        <Card>
          <CardHeader>
            <CardTitle>{METRIC_LABEL[metric]} per day</CardTitle>
            <CardDescription>Since {dayLabel(start)} · UTC days</CardDescription>
          </CardHeader>
          <CardContent><UsageChart rows={profile.daily} since={start} metric={metric} colorOf={colorOf} /></CardContent>
        </Card>
      )}

      {breakdown.length > 0 && (
        <Card className="py-0">
          <CardContent className="px-0">
            <ModelTable rows={breakdown} colorOf={colorOf} tokens={profile.shows.tokens} costs={profile.shows.costs} />
          </CardContent>
        </Card>
      )}

      {empty && (
        <div className="grid justify-items-center gap-3 py-12 text-center">
          <p className="text-muted-foreground">This profile is public but doesn't share any usage details yet.</p>
          {user?.username === profile.username && (
            <Button asChild variant="outline" size="sm"><Link to="/dashboard/settings">Choose what to show</Link></Button>
          )}
        </div>
      )}

      <p className="text-xs text-subtle">
        Token counts come from each tool's own records and aren't comparable across tools in every detail.
        {profile.shows.costs && ' Costs are API list-price estimates unless billed by the provider; not what a subscription costs.'}
        {!user && <> <Link to="/" className="underline underline-offset-4">Track your own usage with tokenburn</Link></>}
      </p>
    </div>
  );
}
