import { createContext, Suspense, useCallback, useContext, useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Boxes, ChevronsUpDown, ExternalLink, LayoutDashboard, Laptop, LogOut, Settings } from 'lucide-react';
import type { DashboardData } from '../../../../packages/shared/src/index.ts';
import { LogoMark } from '@/components/brand';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Separator } from '@/components/ui/separator';
import {
  Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset,
  SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarRail, SidebarTrigger, useSidebar,
} from '@/components/ui/sidebar';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError } from '@/lib/api.ts';
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

  return (
    <DashboardContext.Provider value={{ data, error, days, setDays, reload }}>
      <SidebarProvider>
        <CloseMobileSidebarOnNavigate />
        <Sidebar collapsible="icon" variant="inset">
          <SidebarHeader>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild size="lg">
                  <Link to="/dashboard">
                    <div className="flex size-8 items-center justify-center rounded-lg border bg-background"><LogoMark className="size-4" /></div>
                    <span className="font-semibold tracking-tight">tokenburn</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupLabel>Usage</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {NAV.map((n) => (
                    <SidebarMenuItem key={n.to}>
                      <NavLink to={keep(n.to)} end={n.end}>
                        {({ isActive }) => (
                          <SidebarMenuButton isActive={isActive} tooltip={n.label}>
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
                <SidebarMenu>
                  <SidebarMenuItem>
                    <NavLink to="/dashboard/settings">
                      {({ isActive }) => (
                        <SidebarMenuButton isActive={isActive} tooltip="Settings"><Settings /><span>Settings</span></SidebarMenuButton>
                      )}
                    </NavLink>
                  </SidebarMenuItem>
                  {user.username && (
                    <SidebarMenuItem>
                      <SidebarMenuButton asChild tooltip="Public profile">
                        <Link to={`/@${user.username}`}><ExternalLink /><span>Public profile</span></Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          <SidebarFooter>
            <SidebarMenu>
              <SidebarMenuItem>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
                      <Avatar className="size-8 rounded-lg">
                        {/* The public avatar; it only exists while the profile is public and shows GitHub, else initials. */}
                        {user.username && <AvatarImage src={`/api/avatar/${user.username}`} alt="" className="rounded-lg" />}
                        <AvatarFallback className="rounded-lg text-xs">{initials}</AvatarFallback>
                      </Avatar>
                      <div className="grid flex-1 text-left text-sm leading-tight">
                        <span className="truncate font-medium">{user.username ? `@${user.username}` : user.github_login}</span>
                        <span className="truncate text-xs text-subtle">GitHub · {user.github_login}</span>
                      </div>
                      <ChevronsUpDown className="ml-auto size-4" />
                    </SidebarMenuButton>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent side="top" align="start" className="min-w-56">
                    <DropdownMenuLabel className="font-normal text-muted-foreground">Signed in as {user.github_login}</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem asChild><Link to="/dashboard/settings"><Settings />Settings</Link></DropdownMenuItem>
                    <DropdownMenuItem onSelect={async () => { await signOut(refresh); navigate('/'); }}><LogOut />Sign out</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarFooter>
          <SidebarRail />
        </Sidebar>
        <SidebarInset>
          <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
            <SidebarTrigger className="-ml-1" />
            <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
            <h1 className="text-sm font-medium">{TITLES[pathname] ?? 'Dashboard'}</h1>
          </header>
          <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-6 p-4 sm:p-6">
            <Suspense fallback={<Skeleton className="h-72 rounded-xl" />}>
              <Outlet />
            </Suspense>
          </div>
        </SidebarInset>
      </SidebarProvider>
    </DashboardContext.Provider>
  );
}
