import { useEffect, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { LogoMark, Wordmark } from '@/components/brand';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
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
  const scrolled = useScrolled();
  // Public profiles bring their own minimal top bar (logo + actions) and no footer.
  const seg = decodeURIComponent(pathname.slice(1));
  if (seg.startsWith('@') && !seg.slice(1).replace(/\/$/, '').includes('/')) return <Outlet />;
  return (
    <div className="flex min-h-svh flex-col">
      {/* Flat and full width at the top; once the page scrolls it eases into a floating pill. The header keeps one
          height and the pill moves with a transform, so nothing below it shifts. */}
      <header className="sticky top-0 z-20 h-16 px-3 sm:px-4">
        <div
          className={cn(
            'mx-auto flex w-full items-center justify-between rounded-[1.75rem] border transition-[max-width,height,padding,transform,background-color,border-color,box-shadow] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]',
            scrolled
              ? 'h-14 max-w-4xl translate-y-2.5 border-border bg-background/70 px-4 shadow-lg shadow-black/5 backdrop-blur-xl sm:px-5 dark:shadow-black/30'
              : 'h-16 max-w-6xl border-transparent bg-transparent px-2 sm:px-4',
          )}
        >
          <Wordmark to={user ? '/dashboard' : '/'} />
          {pathname === '/' && (
            <nav className="hidden items-center gap-8 text-sm text-muted-foreground font-medium md:flex">
              {[['#profile', 'Profile'], ['#features', 'Features'], ['#how', 'How it works'], ['#privacy', 'Privacy'], ['#faq', 'FAQ']].map(([href, label]) => (
                <a key={href} href={href} className="transition-colors hover:text-foreground">{label}</a>
              ))}
            </nav>
          )}
          <div className="flex items-center gap-2">
            <ThemeToggle />
            {!loading && (user ? (
              <Button asChild size="sm"><Link to="/dashboard">Dashboard</Link></Button>
            ) : (
              <Button asChild size="sm"><a href="/login">Sign in with GitHub</a></Button>
            ))}
          </div>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-5 py-8 sm:px-8">
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

/** True once the page has scrolled past the very top. */
function useScrolled(threshold = 8) {
  const [scrolled, setScrolled] = useState(() => window.scrollY > threshold);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > threshold);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [threshold]);
  return scrolled;
}
