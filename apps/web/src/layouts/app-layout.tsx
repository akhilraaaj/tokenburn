import { createContext, Suspense, useCallback, useContext, useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, Boxes, ChevronRight, ChevronsUpDown, Globe, LayoutDashboard, Laptop, LogOut, Settings } from 'lucide-react';
import type { DashboardData } from '../../../../packages/shared/src/index.ts';
import { LogoMark } from '@/components/brand';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger, useSidebar,
} from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError } from '@/lib/api.ts';
import { timeAgo } from '@/lib/format.ts';
import { signOut, useSession } from '@/session';

export type Range = '7' | '30' | '90' | '365';

interface DashboardState {
  data: DashboardData | null;
  error: string | null;
  days: Range;
  setDays: (d: Range) => void;
  reload: () => void;
}

const DashboardContext = createContext<DashboardState | null>(null);
export const useDashboard = () => useContext(DashboardContext)!;

const NAV = [
  { to: '/dashboard', label: 'Overview', icon: LayoutDashboard, end: true },
  { to: '/dashboard/models', label: 'Models', icon: Boxes },
  { to: '/dashboard/machines', label: 'Machines', icon: Laptop },
];

const TITLES: Record<string, string> = {
  '/dashboard': 'Overview', '/dashboard/models': 'Models', '/dashboard/machines': 'Machines', '/dashboard/settings': 'Settings',
};

/** On phones the sidebar is a slide-over sheet; close it after navigating. */
function CloseMobileSidebarOnNavigate() {
  const { setOpenMobile } = useSidebar();
  const { pathname } = useLocation();
  useEffect(() => {
    setOpenMobile(false);
  }, [pathname, setOpenMobile]);
  return null;
}

/** Signed-in app: collapsible sidebar + inset content. Loads dashboard data once and shares it with the pages. */
export function AppLayout() {
  const { user, loading, refresh } = useSession();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [params, setParams] = useSearchParams();
  const days = (['7', '30', '90', '365'].includes(params.get('days') ?? '') ? params.get('days') : '30') as Range;
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!user) return;
    setError(null);
    api<DashboardData>('GET', `/api/web/dashboard?days=${days}`).then(setData).catch((e: ApiError) => setError(e.message));
  }, [user, days, nonce]);

  // Block body: see PublicLayout.
  useEffect(() => {
    window.scrollTo(0, 0);
    document.title = `${TITLES[pathname] ?? 'Dashboard'} · tokenburn`;
  }, [pathname]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const setDays = useCallback((d: Range) => setParams((p) => { p.set('days', d); return p; }, { replace: true }), [setParams]);

  if (loading) return <div className="p-6"><Skeleton className="h-8 w-48" /></div>;
  if (!user) return <Navigate to="/" replace />;

  const keep = (to: string) => (days !== '30' ? `${to}?days=${days}` : to);
  const initials = (user.username ?? user.github_login).slice(0, 2).toUpperCase();

  // Freshest sync across machines, for the status in the top bar.
  const lastSync = data?.devices.map((d) => d.last_sync_at).filter(Boolean).sort().at(-1) ?? null;
  const stale = !lastSync || Date.now() - Date.parse(lastSync) > 2 * 864e5;

  return (
    <DashboardContext.Provider value={{ data, error, days, setDays, reload }}>
      <SidebarProvider>
        <CloseMobileSidebarOnNavigate />
        <Sidebar collapsible="icon" variant="inset">
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild size="lg" className="hover:bg-transparent active:bg-transparent">
                  <Link to="/dashboard">
                    <div className="flex size-8 items-center justify-center rounded-lg border bg-background shadow-xs"><LogoMark className="size-4" /></div>
                    <div className="grid leading-tight group-data-[collapsible=icon]:hidden">
                      <span className="font-semibold tracking-tight">tokenburn</span>
                      <span className="text-xs text-subtle">Dashboard</span>
                    </div>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarHeader>
          <SidebarContent className="gap-1 pt-2">
            <SidebarGroup>
              <SidebarGroupLabel>Usage</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu className="gap-0.5">
                  {NAV.map((n) => (
                    <SidebarMenuItem key={n.to}>
                      <NavLink to={keep(n.to)} end={n.end}>
                        {({ isActive }) => (
                          <SidebarMenuButton isActive={isActive} tooltip={n.label} className="h-9 data-[active=true]:shadow-xs">
                            <n.icon />
                            <span>{n.label}</span>
                          </SidebarMenuButton>
                        )}
                      </NavLink>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            <SidebarGroup>
              <SidebarGroupLabel>Account</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu className="gap-0.5">
                  <SidebarMenuItem>
                    <NavLink to="/dashboard/settings">
                      {({ isActive }) => (
                        <SidebarMenuButton isActive={isActive} tooltip="Settings" className="h-9 data-[active=true]:shadow-xs">
                          <Settings /><span>Settings</span>
                        </SidebarMenuButton>
                      )}
                    </NavLink>
                  </SidebarMenuItem>
                  {/* Collapsed to icons, the profile card below is hidden; this keeps the profile one click away. */}
                  {user.username && (
                    <SidebarMenuItem className="hidden group-data-[collapsible=icon]:block">
                      <SidebarMenuButton asChild tooltip="Public profile">
                        <Link to={`/@${user.username}`}><Globe /><span>Public profile</span></Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
            <ProfileStatus username={user.username} isPublic={data?.profile_public ?? null} />
          </SidebarContent>
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
                      <Avatar className="size-8 rounded-lg border">
                        {/* The public avatar; it only exists while the profile is public and shows GitHub, else initials. */}
                        {user.username && <AvatarImage src={`/api/avatar/${user.username}`} alt="" className="rounded-lg" />}
                        <AvatarFallback className="rounded-lg text-xs">{initials}</AvatarFallback>
                      </Avatar>
                      <div className="grid flex-1 text-left text-sm leading-tight">
                        <span className="truncate font-medium">{user.username ? `@${user.username}` : user.github_login}</span>
                        <span className="truncate text-xs text-subtle">GitHub · {user.github_login}</span>
                      </div>
                      <ChevronsUpDown className="ml-auto size-4 text-subtle" />
                    </SidebarMenuButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="top" align="start" className="min-w-56">
                    <DropdownMenuLabel className="font-normal text-muted-foreground">Signed in as {user.github_login}</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {user.username && <DropdownMenuItem asChild><Link to={`/@${user.username}`}><Globe />Public profile</Link></DropdownMenuItem>}
                    <DropdownMenuItem asChild><Link to="/dashboard/settings"><Settings />Settings</Link></DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onSelect={async () => { await signOut(refresh); navigate('/'); }}><LogOut />Sign out</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
        </Sidebar>
        <SidebarInset>
          <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 rounded-t-xl border-b bg-background/80 px-4 backdrop-blur sm:px-6">
            <SidebarTrigger className="-ml-1.5" />
            <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
              <Link to="/dashboard" className="hidden text-muted-foreground hover:text-foreground sm:inline">Dashboard</Link>
              <ChevronRight className="hidden size-3.5 text-subtle sm:block" />
              <h1 className="truncate font-medium">{TITLES[pathname] ?? 'Dashboard'}</h1>
            </nav>
            {data && data.devices.length > 0 && (
              <span className="ml-auto inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs text-muted-foreground" title={lastSync ?? ''}>
                <span className="size-1.5 rounded-full" style={{ background: stale ? 'var(--series-4)' : 'var(--series-3)' }} />
                {lastSync ? `Synced ${timeAgo(lastSync)}` : 'Not synced yet'}
              </span>
            )}
          </header>
          <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-6 p-4 sm:p-6 lg:p-8">
            <Suspense fallback={<Skeleton className="h-72 rounded-xl" />}>
              <Outlet />
            </Suspense>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </DashboardContext.Provider>
  );
}

/** Public-profile status in the sidebar: where it lives, whether it's live, and the next useful action. */
function ProfileStatus({ username, isPublic }: { username: string | null; isPublic: boolean | null }) {
  if (isPublic === null) return null;
  const live = isPublic && !!username;
  const color = live ? 'var(--series-3)' : 'var(--series-other)';
  const action = live ? { to: `/@${username}`, label: 'View profile' } : { to: '/dashboard/settings', label: username ? 'Make it public' : 'Pick a username' };
  return (
    <div className="mx-2 mt-auto mb-1 overflow-hidden rounded-xl border bg-background shadow-xs group-data-[collapsible=icon]:hidden">
      <div className="flex items-center gap-2.5 p-3">
        <span className="flex size-8 flex-none items-center justify-center rounded-lg" style={{ background: `color-mix(in oklab, ${color} 16%, transparent)`, color }}>
          <Globe className="size-4" />
        </span>
        <div className="grid min-w-0 flex-1 leading-tight">
          <span className="text-xs font-medium">Public profile</span>
          <span className="truncate font-mono text-[0.7rem] text-subtle">{username ? `/@${username}` : 'No username yet'}</span>
        </div>
        <span
          className="inline-flex flex-none items-center gap-1 rounded-full px-1.5 py-0.5 text-[0.65rem] font-medium"
          style={{ background: `color-mix(in oklab, ${color} 14%, transparent)`, color: live ? color : 'var(--tb-text-2)' }}
        >
          <span className="size-1.5 rounded-full" style={{ background: color }} />
          {live ? 'Live' : 'Private'}
        </span>
      </div>
      <Link
        to={action.to}
        className="flex items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
      >
        {action.label}
        <ArrowUpRight className="size-3.5" />
      </Link>
    </div>
  );
}
