import { createContext, Suspense, useCallback, useContext, useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, Boxes, ChevronRight, ChevronsUpDown, Globe, LayoutDashboard, Laptop, LogOut, Settings } from 'lucide-react';
import type { DashboardData } from '../../../../packages/shared/src/index.ts';
import { ThemeToggle } from '@/components/theme-toggle';
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

// Default (not null) so Vite HMR / brief unmounts don't crash on `const { reload } = useDashboard()`.
const DashboardContext = createContext<DashboardState>({
  data: null,
  error: null,
  days: '30',
  setDays: () => {},
  reload: () => {},
});

/** Shared dashboard data for routes under AppLayout. */
export const useDashboard = () => useContext(DashboardContext);

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
  // Provider must wrap every return (including loading / redirect). Early returns without it make
  // child routes briefly call useDashboard() on null and crash: "Cannot destructure property 'reload'".
  const dashboard: DashboardState = { data, error, days, setDays, reload };

  if (loading) {
    return (
      <DashboardContext.Provider value={dashboard}>
        <div className="p-6"><Skeleton className="h-8 w-48" /></div>
      </DashboardContext.Provider>
    );
  }
  if (!user) {
    return (
      <DashboardContext.Provider value={dashboard}>
        <Navigate to="/" replace />
      </DashboardContext.Provider>
    );
  }

  const keep = (to: string) => (days !== '30' ? `${to}?days=${days}` : to);
  const initials = (user.username ?? user.github_login).slice(0, 2).toUpperCase();

  // Freshest sync across machines, for the status in the top bar.
  const lastSync = data?.devices.map((d) => d.last_sync_at).filter(Boolean).sort().at(-1) ?? null;
  const stale = !lastSync || Date.now() - Date.parse(lastSync) > 2 * 864e5;

  return (
    <DashboardContext.Provider value={dashboard}>
      <SidebarProvider>
        <CloseMobileSidebarOnNavigate />
        <Sidebar collapsible="icon" variant="inset">
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild size="lg" className="hover:bg-transparent active:bg-transparent">
                  <Link to="/dashboard">
                    <div className="flex size-8 items-center justify-center rounded-md border bg-background shadow-xs"><LogoMark className="size-4" /></div>
                    <div className="grid leading-tight group-data-[collapsible=icon]:hidden gap-0.5">
                      <span className="font-semibold">tokenburn</span>
                      <span className="text-xs text-subtle font-medium">Dashboard</span>
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
                <SidebarMenu className="gap-1">
                  {NAV.map((n) => (
                    <SidebarMenuItem key={n.to}>
                      <NavLink to={keep(n.to)} end={n.end}>
                        {({ isActive }) => (
                          <SidebarMenuButton isActive={isActive} tooltip={n.label} className="h-9 data-[active=true]:shadow-xs">
                            <n.icon />
                            <span className="font-medium tracking-normal">{n.label}</span>
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
                <SidebarMenu className="gap-1">
                  <SidebarMenuItem>
                    <NavLink to="/dashboard/settings">
                      {({ isActive }) => (
                        <SidebarMenuButton isActive={isActive} tooltip="Settings" className="h-9 data-[active=true]:shadow-xs">
                          <Settings /><span className="font-medium tracking-normal">Settings</span>
                        </SidebarMenuButton>
                      )}
                    </NavLink>
                  </SidebarMenuItem>
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
                      <Avatar className="size-8 rounded-full border">
                        {/* The public avatar; it only exists while the profile is public and shows GitHub, else initials. */}
                        {user.username && <AvatarImage src={`/api/avatar/${user.username}`} alt="" className="rounded-full" />}
                        <AvatarFallback className="rounded-full text-xs">{initials}</AvatarFallback>
                      </Avatar>
                      <div className="grid flex-1 text-left text-sm gap-0.5">
                        <span className="truncate font-semibold">{user.username ? `@${user.username}` : user.github_login}</span>
                        <span className="truncate text-xs text-subtle font-medium">GitHub · {user.github_login}</span>
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
              <Link to="/dashboard" className="hidden font-medium text-muted-foreground hover:text-foreground sm:inline">Dashboard</Link>
              <ChevronRight className="hidden size-3.5 text-subtle sm:block" />
              <span className="truncate font-semibold">{TITLES[pathname] ?? 'Dashboard'}</span>
            </nav>
            <div className="ml-auto flex items-center gap-2">
              {data && data.devices.length > 0 && (
                <span className="inline-flex items-center gap-2 rounded-full border px-2.5 py-1 text-xs text-muted-foreground font-medium" title={lastSync ?? ''}>
                  <span className="size-1.5 rounded-full" style={{ background: stale ? 'var(--series-4)' : 'var(--series-3)' }} />
                  {lastSync ? `Synced ${timeAgo(lastSync)}` : 'Not synced yet'}
                </span>
              )}
              <ThemeToggle />
            </div>
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

/** Profile live/private status — same chip language as the header sync pill; hidden when the sidebar is collapsed. */
function ProfileStatus({ username, isPublic }: { username: string | null; isPublic: boolean | null }) {
  if (isPublic === null) return null;
  const live = isPublic && !!username;
  const href = live ? `/@${username}` : '/dashboard/settings';
  const tip = live ? `Public · @${username}` : username ? 'Private profile' : 'Choose a username';

  return (
    <SidebarGroup className="mt-auto px-2 pb-1 group-data-[collapsible=icon]:hidden">
      <SidebarGroupContent>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              tooltip={tip}
              className="h-8 rounded-md border border-sidebar-border bg-sidebar-accent px-2.5 text-xs text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active=true]:bg-sidebar-accent"
            >
              <Link to={href}>
                <span className="size-1.5 flex-none rounded-full" style={{ background: live ? 'var(--series-3)' : 'var(--series-other)' }} />
                <span className="truncate font-medium text-sidebar-foreground max-w-30">{username ? `@${username}` : 'Your profile'}</span>
                <span className="ml-auto flex items-center gap-1 text-[0.7rem] text-sidebar-foreground/55">
                  {live ? 'Live' : username ? 'Private' : 'Setup'}
                  {live && <ArrowUpRight className="size-3" />}
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}
