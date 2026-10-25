import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import type { WebUser } from '../../../../packages/shared/src/index.ts';
import { api } from '../lib/api.ts';

interface Session { user: WebUser | null; loading: boolean; refresh: () => Promise<void> }
const SessionContext = createContext<Session>({ user: null, loading: true, refresh: async () => {} });
export const useSession = () => useContext(SessionContext);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<WebUser | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = async () => {
    const r = await api<{ user: WebUser | null }>('GET', '/api/web/session').catch(() => ({ user: null }));
    setUser(r.user);
    setLoading(false);
  };
  useEffect(() => { void refresh(); }, []);
  return <SessionContext.Provider value={{ user, loading, refresh }}>{children}</SessionContext.Provider>;
}

const navCls = ({ isActive }: { isActive: boolean }) => `no-underline text-[0.92rem] ${isActive ? 'text-primary font-semibold' : 'text-secondary'}`;

export function Layout() {
  const { user, refresh } = useSession();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
    const titles: Record<string, string> = { '/dashboard': 'Dashboard', '/settings': 'Settings' };
    // Profile pages set their own title once loaded.
    if (!pathname.startsWith('/@') && !pathname.startsWith('/%40')) document.title = titles[pathname] ? `${titles[pathname]} · tokenburn` : 'tokenburn';
  }, [pathname]);

  const signOut = async () => {
    await api('POST', '/api/web/logout');
    await refresh();
    navigate('/');
  };

  return (
    <>
      <header className="flex items-center justify-between gap-3 flex-wrap px-6 max-sm:px-4 py-3 border-b border-line bg-surface-1">
        <Link to={user ? '/dashboard' : '/'} className="font-semibold text-primary no-underline">tokenburn</Link>
        <nav className="flex gap-4 items-center flex-wrap">
          {user ? (
            <>
              <NavLink to="/dashboard" className={navCls}>Dashboard</NavLink>
              <NavLink to="/settings" className={navCls}>Settings</NavLink>
              {user.username && <NavLink to={`/@${user.username}`} className={navCls}>Profile</NavLink>}
              <button type="button" onClick={signOut} className="text-secondary text-[0.92rem]">Sign out</button>
            </>
          ) : (
            <a href="/login" className="btn btn-primary">Sign in with GitHub</a>
          )}
        </nav>
      </header>
      <main className="max-w-[1080px] mx-auto px-6 max-sm:px-4 py-7 max-sm:py-5 grid gap-5">
        <Outlet />
      </main>
    </>
  );
}
