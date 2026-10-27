import { useEffect } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { LogoMark, Wordmark } from '@/components/brand';
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
    if (!pathname.startsWith('/@') && !pathname.startsWith('/%40')) {
      document.title = pathname === '/' ? 'tokenburn · AI coding usage, tracked locally' : 'tokenburn';
    }
  }, [pathname]);
  // Public profiles bring their own minimal top bar (logo + actions) and no footer.
  const seg = decodeURIComponent(pathname.slice(1));
  if (seg.startsWith('@') && !seg.slice(1).replace(/\/$/, '').includes('/')) return <Outlet />;
  return (
    <div className="flex min-h-svh flex-col">
      <header className="sticky top-0 z-20 border-b bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between px-4 sm:px-6">
          <Wordmark to={user ? '/dashboard' : '/'} />
          {pathname === '/' && (
            <nav className="hidden items-center gap-6 text-sm text-muted-foreground md:flex">
              {[['#profile', 'Profile'], ['#features', 'Features'], ['#how', 'How it works'], ['#privacy', 'Privacy'], ['#faq', 'FAQ']].map(([href, label]) => (
                <a key={href} href={href} className="transition-colors hover:text-foreground">{label}</a>
              ))}
            </nav>
          )}
          {!loading && (user ? (
            <Button asChild size="sm"><Link to="/dashboard">Dashboard</Link></Button>
          ) : (
            <Button asChild size="sm"><a href="/login">Sign in with GitHub</a></Button>
          ))}
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4 px-4 py-5 sm:px-6">
          <Link to={user ? '/dashboard' : '/'} className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
            <LogoMark className="size-4" />
            tokenburn
          </Link>
          <span className="text-xs text-subtle font-medium">Collected locally · costs are estimates</span>
        </div>
      </footer>
    </div>
  );
}
