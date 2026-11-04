import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { CalendarDays, Check, LayoutDashboard, Link2, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { CONTRIBUTION_DAYS, type PublicProfile } from '../../../../packages/shared/src/index.ts';
import { GitHubMark, Wordmark } from '@/components/brand';
import { ActivityCard, ContributionGraph, DailyBarsCard, ModelBreakdown, StreakCard, WeekdayChart } from '@/components/profile-widgets';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError } from '@/lib/api.ts';
import { dayLabel } from '@/lib/format.ts';
import { ProviderChip } from '@/components/tool-logos';
import { colorMap, rowTokens } from '@/lib/series.ts';
import { cn } from '@/lib/utils';
import { nowMs } from '@/lib/clock';
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
  const start = [addDays(firstDay, -3), addDays(new Date(nowMs()).toISOString().slice(0, 10), -29)].sort()[0];
  return start < since ? since : start;
}

/** Copies the profile link; the button confirms with "Link copied" for a moment. */
function ShareButton({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => navigator.clipboard.writeText(url).then(
    () => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    },
    () => toast.error('Could not copy the link'),
  );
  return (
    <Button size="sm" variant="outline" onClick={copy} aria-label="Copy profile link">
      {copied ? <Check /> : <Link2 />}<span className="max-sm:sr-only">{copied ? 'Copied' : 'Share'}</span>
    </Button>
  );
}

function ProfileActions({ username, preview }: { username: string; preview: boolean }) {
  const { user } = useSession();
  const own = !preview && user?.username === username;
  if (!own) return null;
  return (
    <div className="flex shrink-0 items-center gap-2 self-start">
      <ShareButton url={`${window.location.origin}/@${username}`} />
      <Button asChild size="sm" aria-label="Edit profile">
        <Link to="/dashboard/settings"><Pencil /><span className="max-sm:sr-only">Edit profile</span></Link>
      </Button>
    </div>
  );
}

/** Card shell with a title, subtitle and toolbar placeholder, like the profile widgets. */
function WidgetSkeleton({ children, toolbar = true }: { children: ReactNode; toolbar?: boolean }) {
  return (
    <Card>
      <CardContent className="grid gap-5">
        <div className="flex items-start justify-between gap-3">
          <div className="grid gap-2">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-24" />
          </div>
          {toolbar && <Skeleton className="h-8 w-32 rounded-lg" />}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

/** Loading state shaped like the profile: header, daily chart, activity, widget pair, contributions, models. */
function ProfileSkeleton() {
  return (
    <div className="mx-auto grid w-full max-w-3xl grid-cols-1 gap-6 px-4 pt-6 pb-12 sm:px-6" aria-busy="true" aria-label="Loading profile">
      <section className="flex items-start gap-4 pb-2 sm:gap-5">
        <Skeleton className="size-14 shrink-0 rounded-full sm:size-16" />
        <div className="grid min-w-0 flex-1 gap-2">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-3.5 w-48" />
          <div className="flex gap-2">
            <Skeleton className="h-5 w-20 rounded-full" />
            <Skeleton className="h-5 w-16 rounded-full" />
            <Skeleton className="h-5 w-24 rounded-full" />
          </div>
        </div>
        <Skeleton className="h-8 w-8 shrink-0 self-start rounded-md sm:w-20" />
      </section>
      <WidgetSkeleton>
        <div className="flex flex-wrap gap-3">{[28, 36, 24, 32].map((w, i) => <Skeleton key={i} className="h-3" style={{ width: `${w * 4}px` }} />)}</div>
        <div className="flex h-48 items-end gap-1">
          {Array.from({ length: 30 }, (_, i) => (
            <Skeleton key={i} className="flex-1 rounded-sm" style={{ height: `${25 + ((i * 37) % 70)}%` }} />
          ))}
        </div>
      </WidgetSkeleton>
      <WidgetSkeleton>
        <Skeleton className="h-8 w-44" />
        <Skeleton className="h-20 w-full" />
      </WidgetSkeleton>
      <div className="grid gap-6 md:grid-cols-2">
        <WidgetSkeleton toolbar={false}><Skeleton className="h-28 w-full" /></WidgetSkeleton>
        <WidgetSkeleton toolbar={false}><Skeleton className="h-28 w-full" /></WidgetSkeleton>
      </div>
      <WidgetSkeleton toolbar={false}><Skeleton className="h-28 w-full" /></WidgetSkeleton>
      <WidgetSkeleton>
        <div className="grid gap-3">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-5 w-full" />)}</div>
      </WidgetSkeleton>
    </div>
  );
}

function ProfileFrame({ handle, children }: { handle: string; children: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col">
      <ProfileHeader />
      <main className="flex-1">{children}</main>
    </div>
  );
}

/** Profiles get a bare top bar: the logo, plus Dashboard or sign-in. Share and Edit live in the profile header. */
export function ProfileHeader() {
  const { user, loading } = useSession();
  return (
    // A size container, so the actions can tighten when the header itself is narrow (the landing preview on a
    // small phone), not just when the viewport is.
    <header className="@container flex h-16 w-full items-center justify-between gap-3 px-4 sm:px-6">
      <Wordmark to={user ? '/dashboard' : '/'} />
      <div className="flex items-center gap-2">
        <ThemeToggle className="@max-[20rem]:hidden" />
        {!loading && (user ? (
          <Button asChild size="sm"><Link to="/dashboard">Dashboard</Link></Button>
        ) : (
          <>
            <Button asChild size="sm" variant="ghost" className="max-sm:hidden"><a href="/login">Sign in</a></Button>
            <Button asChild size="sm">
              <a href="/login"><span className="@max-[20rem]:hidden">Create your profile</span><span className="hidden @max-[20rem]:inline">Sign up</span></a>
            </Button>
          </>
        ))}
      </div>
    </header>
  );
}

export function Profile() {
  const { pathname } = useLocation();
  const handle = decodeURIComponent(pathname.slice(1)).replace(/^@/, '').replace(/\/$/, '').toLowerCase();
  return <ProfileFrame handle={handle}><ProfileBody handle={handle} /></ProfileFrame>;
}

/**
 * The profile the Worker embedded in this page's HTML (profileShell in apps/api), so the first render needs no
 * request. Only good for the page it came with: dropped once used, later profiles are fetched.
 */
let embedded: PublicProfile | null = (() => {
  try {
    return JSON.parse(document.getElementById('profile-data')?.textContent ?? 'null');
  } catch {
    return null;
  }
})();
const embeddedFor = (handle: string) => (embedded?.username === handle ? embedded : null);

function ProfileBody({ handle }: { handle: string }) {
  const { user } = useSession();
  const [profile, setProfile] = useState<PublicProfile | null>(() => embeddedFor(handle));
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    const first = embeddedFor(handle);
    embedded = null;
    setMissing(false);
    if (first) {
      setProfile(first);
      document.title = `@${first.username} · AI coding usage`;
      return;
    }
    setProfile((p) => (p?.username === handle ? p : null));
    api<PublicProfile>('GET', `/api/public/${encodeURIComponent(handle)}`)
      // Same title the server renders for this page (apps/api/src/index.ts, profileShell).
      .then((p) => { setProfile(p); document.title = `@${p.username} · AI coding usage`; })
      .catch((e: ApiError) => { if (e.status === 404) { setMissing(true); document.title = 'Not found · tokenburn'; } });
  }, [handle]);

  if (missing) {
    const own = user?.username === handle;
    return own ? (
      <div className="mx-auto grid max-w-md justify-items-center gap-3 px-4 py-24 text-center">
        <h1 className="text-2xl font-semibold">Your profile is private</h1>
        <p className="text-muted-foreground font-medium">Turn it on in Settings, and choose what it shows</p>
        <Button asChild variant="outline"><Link to="/dashboard/settings">Open settings</Link></Button>
      </div>
    ) : <NotFound message="This profile doesn't exist or is private." />;
  }
  if (!profile) return <ProfileSkeleton />;

  return (
    <div className="mx-auto grid w-full max-w-3xl grid-cols-1 gap-6 px-4 pt-6 pb-12 sm:px-6">
      <ProfileView profile={profile} />
    </div>
  );
}

/**
 * The profile itself: header, highlights, daily trend and model table. The landing page renders it with example
 * data shaped by the same switches as Settings (`preview`), so both always look the same.
 */
export function ProfileView({ profile, preview = false }: { profile: PublicProfile; preview?: boolean }) {
  // Inside the landing page's preview the page already has its h1.
  const Heading = preview ? 'h2' : 'h1';
  const { user } = useSession();
  const breakdown = profile.breakdown ?? [];
  const colorOf = useMemo(() => colorMap(profile.daily?.length ? profile.daily : breakdown), [profile]);
  const providers = [...new Set(breakdown.map((b) => b.provider).filter(Boolean))] as string[];
  const h = profile.highlights ?? {};
  const metric = profile.shows.tokens ? 'output' : 'requests';
  const empty = !profile.daily && !breakdown.length && !Object.keys(h).length;
  const name = profile.display_name || profile.username;
  const start = chartStart(profile.since, profile.first_day ?? null);
  const hasTrend = !!profile.daily && !!profile.first_day;
  // A year of active days when the server sends it; otherwise the 90-day trend rows (older servers, cached JSON).
  const contributions = profile.contributions
    ? {
      since: new Date(nowMs() - (CONTRIBUTION_DAYS - 1) * 864e5).toISOString().slice(0, 10),
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
      <section className="flex items-start gap-4 pb-2 sm:gap-5">
        <Avatar className="size-14 shrink-0 rounded-full ring-1 ring-border ring-offset-2 ring-offset-background sm:size-16">
          {profile.github && <AvatarImage src={profile.github.avatar_url} alt="" className="rounded-full" />}
          <AvatarFallback className="rounded-full text-base">{name.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
        <div className="grid min-w-0 flex-1 gap-2">
          <div className="grid gap-1">
            <Heading className="truncate text-lg font-semibold leading-tight sm:text-xl">{name}</Heading>
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[13px] text-muted-foreground font-medium">
              <span>@{profile.username}</span>
              {profile.github && (
                <>
                  <span className="text-subtle" aria-hidden="true">·</span>
                  <a href={`https://github.com/${profile.github.login}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">
                    <GitHubMark className="size-3" />{profile.github.login}
                  </a>
                </>
              )}
            </div>
          </div>
          {(profile.first_day || providers.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-subtle">
              {profile.first_day && (
                <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-background border border-border/80 font-medium text-foreground/90 px-2">
                  <CalendarDays className="size-3.5" />Since {dayLabel(profile.first_day)}
                </span>
              )}
              {providers.map((p) => <ProviderChip key={p} provider={p} />)}
            </div>
          )}
        </div>
        <ProfileActions username={profile.username} preview={preview} />
      </section>

      {hasTrend && <DailyBarsCard rows={profile.daily!} since={start} metric={metric} colorOf={colorOf} />}

      <ActivityCard profile={profile} since={start} />

      {profile.daily && !profile.first_day && (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">No usage in the last 90 days yet</CardContent>
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
          <p className="text-muted-foreground font-medium">This profile is public but doesn't share any usage details yet</p>
          {!preview && user?.username === profile.username && (
            <Button asChild variant="outline" size="sm"><Link to="/dashboard/settings">Choose what to show</Link></Button>
          )}
        </div>
      )}
    </>
  );
}
