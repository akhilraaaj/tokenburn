import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { CalendarDays, LayoutDashboard, MessagesSquare, Pencil, Share2 } from 'lucide-react';
import { toast } from 'sonner';
import { CONTRIBUTION_DAYS, type PublicProfile } from '../../../../packages/shared/src/index.ts';
import { GitHubMark, Wordmark } from '@/components/brand';
import { ActivityCard, ContributionGraph, DailyBarsCard, ModelBreakdown, StreakCard, WeekdayChart } from '@/components/profile-widgets';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError } from '@/lib/api.ts';
import { dayLabel, plural } from '@/lib/format.ts';
import { colorMap, providerLabel, rowTokens } from '@/lib/series.ts';
import { cn } from '@/lib/utils';
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

function ProfileFrame({ handle, children }: { handle: string; children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col">
      <ProfileHeader handle={handle} />
      <main className="flex-1">{children}</main>
    </div>
  );
}

/** Profiles get a bare top bar: the logo, and actions that depend on who's looking. */
export function ProfileHeader({ handle }: { handle: string }) {
  const { user, loading } = useSession();
  const own = !!user && user.username === handle;
  const url = `${window.location.origin}/@${handle}`;
  return (
    <header className="mx-auto flex h-16 w-full max-w-3xl items-center justify-between gap-3 px-4 sm:px-6">
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
      <div className="mx-auto grid w-full max-w-3xl gap-6 px-4 py-6 sm:px-6">
        <Skeleton className="h-36 rounded-xl" />
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-24 rounded-xl" />)}</div>
        <Skeleton className="h-72 rounded-xl" />
      </div>
    );
  }

  return (
    <div className="mx-auto grid w-full max-w-3xl grid-cols-1 gap-6 px-4 pt-2 pb-12 sm:px-6">
      <ProfileView profile={profile} />
      <p className="text-xs text-subtle">
        Token counts come from each tool's own records and aren't comparable across tools in every detail.
        {profile.shows.costs && ' Costs are API list-price estimates unless billed by the provider; not what a subscription costs.'}
        {!user && <> <Link to="/" className="underline underline-offset-4">Track your own usage with tokenburn</Link></>}
      </p>
    </div>
  );
}

/**
 * The profile itself: header, highlights, daily trend and model table. The landing page renders it with example
 * data shaped by the same switches as Settings (`preview`), so both always look the same.
 */
export function ProfileView({ profile, preview = false }: { profile: PublicProfile; preview?: boolean }) {
  const { user } = useSession();
  const breakdown = profile.breakdown ?? [];
  const colorOf = useMemo(() => colorMap(profile.daily?.length ? profile.daily : breakdown), [profile]);
  const providers = [...new Set(breakdown.map((b) => b.provider).filter(Boolean))] as string[];
  const h = profile.highlights ?? {};
  const metric = profile.shows.tokens ? 'output' : 'requests';
  const sessions = profile.sessions ?? {};
  const empty = !profile.daily && !breakdown.length && !Object.keys(sessions).length && !Object.keys(h).length;
  const name = profile.display_name || profile.username;
  const start = chartStart(profile.since, profile.first_day ?? null);
  const hasTrend = !!profile.daily && !!profile.first_day;
  // A year of active days when the server sends it; otherwise the 90-day trend rows (older servers, cached JSON).
  const contributions = profile.contributions
    ? {
      since: new Date(Date.now() - (CONTRIBUTION_DAYS - 1) * 864e5).toISOString().slice(0, 10),
      days: profile.contributions.map((d) => ({ day: d.day, value: profile.shows.tokens ? d.tokens ?? 0 : d.events })),
    }
    : hasTrend
      ? { since: profile.since, days: profile.daily!.map((r) => ({ day: r.day!, value: profile.shows.tokens ? rowTokens(r) : r.events })) }
      : null;
  // Streak beside the weekly rhythm, then the contribution grid.
  const widgets = [
    profile.shows.streaks && <StreakCard profile={profile} since={start} />,
    hasTrend && <WeekdayChart rows={profile.daily!} tokens={profile.shows.tokens} />,
    contributions && <ContributionGraph {...contributions} tokens={profile.shows.tokens} />,
  ].filter(Boolean);

  return (
    <>
      <Card className="gap-0 overflow-hidden py-0">
        <CardContent className="flex items-center gap-5 p-5 sm:p-6">
          <Avatar className="size-16 rounded-2xl border sm:size-20">
            {profile.github && <AvatarImage src={profile.github.avatar_url} alt="" className="rounded-2xl" />}
            <AvatarFallback className="rounded-2xl text-xl sm:text-2xl">{name.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="grid min-w-0 flex-1 gap-1.5">
            <div className="grid gap-0.5">
              <h1 className="truncate text-2xl font-semibold tracking-tight">{name}</h1>
              <p className="text-sm text-muted-foreground">@{profile.username}</p>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
              {profile.github && (
                <a href={`https://github.com/${profile.github.login}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 hover:text-foreground">
                  <GitHubMark className="size-3.5" />{profile.github.login}
                </a>
              )}
              {profile.first_day && (
                <span className="inline-flex items-center gap-1.5"><CalendarDays className="size-3.5" />Tracking since {dayLabel(profile.first_day)}</span>
              )}
              {sessions.all !== undefined && (
                <span className="inline-flex items-center gap-1.5"><MessagesSquare className="size-3.5" />{plural(sessions.all, 'session')} in 90 days</span>
              )}
            </div>
          </div>
        </CardContent>
        {providers.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t bg-surface-2/40 px-5 py-3 sm:px-6">
            <span className="mr-1 text-xs text-subtle">Builds with</span>
            {providers.map((p) => (
              <Badge key={p} variant="outline" className="gap-1.5 bg-card font-normal">
                {providerLabel(p)}
                {sessions[p] !== undefined && <span className="num text-subtle">· {plural(sessions[p], 'session')}</span>}
              </Badge>
            ))}
          </div>
        )}
      </Card>

      {hasTrend && <DailyBarsCard rows={profile.daily!} since={start} metric={metric} colorOf={colorOf} />}

      <ActivityCard profile={profile} since={start} />

      {profile.daily && !profile.first_day && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">No usage in the last 90 days yet.</CardContent>
        </Card>
      )}


      {widgets.length > 0 && (
        <div className="grid gap-6 md:grid-cols-2">
          {widgets.map((w, i) => (
            // An odd one out takes the full row instead of leaving a gap.
            <div key={i} className={cn('grid', widgets.length % 2 === 1 && i === widgets.length - 1 && 'md:col-span-2')}>{w}</div>
          ))}
        </div>
      )}

      {breakdown.length > 0 && (
        <ModelBreakdown
          rows={breakdown}
          daily={hasTrend ? profile.daily : undefined}
          since={start}
          colorOf={colorOf}
          tokens={profile.shows.tokens}
          costs={profile.shows.costs}
        />
      )}

      {empty && (
        <div className="grid justify-items-center gap-3 py-12 text-center">
          <p className="text-muted-foreground">This profile is public but doesn't share any usage details yet.</p>
          {!preview && user?.username === profile.username && (
            <Button asChild variant="outline" size="sm"><Link to="/dashboard/settings">Choose what to show</Link></Button>
          )}
        </div>
      )}
    </>
  );
}
