import { useEffect } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { Wordmark } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { useSession } from '@/session';

/** Landing, public profiles and not-found: a quiet top bar, centered content, small footer. */
export function PublicLayout() {
  const { user, loading } = useSession();
  const { pathname } = useLocation();
  // Block body on purpose: an effect must return nothing or a cleanup function. Some browser extensions make
  // window.scrollTo return a Promise, which React would later try to call as a cleanup and crash.
  useEffect(() => {
    window.scrollTo(0, 0);
    if (!pathname.startsWith('/@') && !pathname.startsWith('/%40')) document.title = 'tokenburn';
  }, [pathname]);
  // Public profiles bring their own minimal top bar (logo + actions) and no footer.
  const seg = decodeURIComponent(pathname.slice(1));
  if (seg.startsWith('@') && !seg.slice(1).replace(/\/$/, '').includes('/')) return <Outlet />;
  return (
    <div className="flex min-h-svh flex-col">
      <header className="sticky top-0 z-20 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-4 sm:px-6">
          <Wordmark to={user ? '/dashboard' : '/'} />
          {!loading && (user ? (
            <Button asChild size="sm" variant="outline"><Link to="/dashboard">Dashboard</Link></Button>
          ) : (
            <Button asChild size="sm"><a href="/login">Sign in with GitHub</a></Button>
          ))}
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-2 px-4 py-6 text-xs text-subtle sm:px-6">
          <span>tokenburn · your AI coding usage, collected locally</span>
          <span>Token counts come from each tool's own records. Costs are estimates.</span>
        </div>
      </footer>
    </div>
  );
}
