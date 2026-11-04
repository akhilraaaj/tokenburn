import { useEffect, useState, type ReactNode } from 'react';
import { Link, Outlet, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { GitHubMark, Wordmark } from '@/components/brand';
import { ThemeToggle } from '@/components/theme-toggle';
import { Button } from '@/components/ui/button';
import { useToday } from '@/lib/clock';
import { cn } from '@/lib/utils';
import { useSession } from '@/session';

const REPO_URL = 'https://github.com/akhilraaaj/tokenburn';

/** Smooth-scroll to a landing section without putting #id in the address bar. */
function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Brand link: always home. On `/` already, scroll to the top instead of a no-op navigation. */
function HomeWordmark({ className }: { className?: string }) {
  const { pathname } = useLocation();
  return (
    <Wordmark
      to="/"
      className={className}
      onClick={(e) => {
        if (pathname !== '/') return;
        e.preventDefault();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }}
    />
  );
}

/** Landing, public profiles and not-found: a quiet top bar, centered content, small footer. */
export function PublicLayout() {
  const { user, loading } = useSession();
  const { pathname } = useLocation();
  const navigationType = useNavigationType();
  // Block body on purpose: an effect must return nothing or a cleanup function. Some browser extensions make
  // window.scrollTo return a Promise, which React would later try to call as a cleanup and crash.
  useEffect(() => {
    // Once per page change: links start at the top, while a reload or back/forward (POP) keeps the browser's restored
    // position. navigationType is read, not a dependency, on purpose: same-page replaces (the landing page clearing
    // its scroll-to-section state) must not re-run this and jump back to the top.
    if (navigationType !== 'POP') window.scrollTo(0, 0);
    if (!pathname.startsWith('/@') && !pathname.startsWith('/%40')) {
      document.title = pathname === '/' ? 'tokenburn · AI coding usage, tracked locally' : pathname === '/welcome' ? 'Welcome · tokenburn' : 'Not found · tokenburn';
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
          <HomeWordmark />
          {pathname === '/' && (
            <nav className="hidden items-center gap-8 text-sm text-muted-foreground font-medium md:flex">
              {[['profile', 'Profile'], ['features', 'Features'], ['how', 'How it works'], ['privacy', 'Privacy'], ['faq', 'FAQ']].map(([id, label]) => (
                <button key={id} type="button" onClick={() => scrollToSection(id)} className="transition-colors hover:text-foreground">
                  {label}
                </button>
              ))}
            </nav>
          )}
          <div className="flex items-center gap-2">
            <Button asChild variant="ghost" size="icon-sm" className="hidden text-muted-foreground hover:text-foreground sm:inline-flex">
              <a href={REPO_URL} target="_blank" rel="noreferrer" aria-label="tokenburn on GitHub" title="Source on GitHub"><GitHubMark /></a>
            </Button>
            <ThemeToggle />
            {/* While the session loads, an invisible Sign in holds the space so the header doesn't shift when it lands. */}
            {user ? (
              <Button asChild size="sm"><Link to="/dashboard">Dashboard</Link></Button>
            ) : (
              <Button asChild size="sm" className={cn(loading && 'invisible')} aria-hidden={loading || undefined}><a href="/login" tabIndex={loading ? -1 : undefined}>Sign in with GitHub</a></Button>
            )}
          </div>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
      <SiteFooter signedIn={!!user} />
    </div>
  );
}

/** True once the page has scrolled past the very top. */
function useScrolled(threshold = 8) {
  // Starts false (as prerendered) and is corrected by the effect, so hydration matches even on a restored scroll.
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > threshold);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [threshold]);
  return scrolled;
}

const FOOTER_LINKS: { title: string; links: [string, string][] }[] = [
  { title: 'Product', links: [['profile', 'Profile'], ['features', 'Features'], ['how', 'How it works']] },
  { title: 'Trust', links: [['privacy', 'Privacy'], ['faq', 'FAQ']] },
];

/** Section jump that scrolls on `/` without a hash, or navigates home then scrolls when coming from another page. */
function SectionLink({ id, className, children }: { id: string; className?: string; children: ReactNode }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className={className}
      onClick={() => {
        if (pathname === '/') scrollToSection(id);
        else navigate('/', { state: { section: id } });
      }}
    >
      {children}
    </button>
  );
}

/**
 * Brand line and tagline, link columns, a bottom bar, and the wordmark set huge and faint along the bottom edge,
 * clipped by the footer like a watermark. Section links point at the landing page so they work from any page.
 */
function SiteFooter({ signedIn }: { signedIn: boolean }) {
  return (
    <footer className="relative overflow-hidden">
      <div className="mx-auto grid w-full max-w-6xl gap-10 px-5 pt-5 pb-10 sm:px-8 md:grid-cols-[1.3fr_2fr]">
        <div className="grid content-start gap-4">
          <HomeWordmark className="w-fit" />
          <p className="max-w-xs text-sm font-medium leading-relaxed text-muted-foreground">
            Every token you burn, in one place. Collected on your machine, shared only if you choose.
          </p>
          <span className="inline-flex w-fit items-center gap-2 rounded-full border px-2.5 py-1 text-xs text-muted-foreground font-medium">
            <span className="size-1.5 rounded-full bg-(--series-3)" />Local-first · Private by default
          </span>
        </div>
        <div className="grid grid-cols-2 gap-x-6 gap-y-8 sm:grid-cols-3">
          {FOOTER_LINKS.map((col) => (
            <nav key={col.title} aria-label={col.title} className="grid content-start gap-3 text-sm">
              <span className="text-xs font-semibold text-subtle">{col.title}</span>
              {col.links.map(([id, label]) => (
                <SectionLink key={id} id={id} className="w-fit text-left text-muted-foreground font-medium transition-colors hover:text-foreground">{label}</SectionLink>
              ))}
            </nav>
          ))}
          <nav aria-label="Get started" className="grid content-start gap-3 text-sm">
            <span className="text-xs font-semibold text-subtle">Get started</span>
            {signedIn ? (
              <Link to="/dashboard" className="w-fit text-muted-foreground font-medium transition-colors hover:text-foreground">Dashboard</Link>
            ) : (
              <a href="/login" className="w-fit text-muted-foreground font-medium transition-colors hover:text-foreground">Sign in</a>
            )}
            <SectionLink id="how" className="w-fit text-left text-muted-foreground font-medium transition-colors hover:text-foreground">Install the CLI</SectionLink>
            <a href={REPO_URL} target="_blank" rel="noreferrer" className="inline-flex w-fit items-center gap-1.5 text-muted-foreground font-medium transition-colors hover:text-foreground">
              <GitHubMark className="size-3.5" />GitHub
            </a>
          </nav>
        </div>
      </div>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-5 py-5 text-xs text-subtle font-medium sm:flex-row sm:items-center sm:justify-between sm:px-8">
        <span>
          © {useToday().slice(0, 4)} tokenburn ·{' '}
          <a href={REPO_URL} target="_blank" rel="noreferrer" className="transition-colors hover:text-foreground">Open source, MIT</a>
        </span>
        <span>Usage is collected locally · costs are API list-price estimates</span>
      </div>
      {/* Drawn with ::after so the decorative wordmark isn't page text (screen readers, contrast checks). */}
      <div aria-hidden className="pointer-events-none mb-[-0.24em] text-center text-[clamp(4rem,19vw,15rem)] leading-none font-semibold tracking-tighter text-foreground/[0.04] select-none after:content-['tokenburn']" />
    </footer>
  );
}
