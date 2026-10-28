// Build-time only (scripts/prerender.mjs): renders the landing page to static HTML for crawlers, answer engines
// and a fast first paint; main.tsx hydrates it. Never shipped to the browser.
import { StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from 'react-router-dom';
import { Toaster } from '@/components/ui/sonner';
import { HydrationMark, PRERENDERED_AT } from '@/lib/clock';
import { FAQ } from '@/pages/landing';
import { routes } from '@/routes';
import { SessionProvider } from '@/session';

export { FAQ, PRERENDERED_AT };

/** Must render the same tree as main.tsx, or hydration won't match. */
export async function render(path: string): Promise<string> {
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`https://prerender.invalid${path}`));
  if (context instanceof Response) throw new Error(`prerender ${path}: unexpected redirect`);
  const router = createStaticRouter(handler.dataRoutes, context);
  return renderToString(
    <StrictMode>
      <SessionProvider>
        {/* hydrate={false}: no inline hydration script, which the CSP (script-src 'self') would block anyway. */}
        <StaticRouterProvider router={router} context={context} hydrate={false} />
        <Toaster position="bottom-right" />
        <HydrationMark />
      </SessionProvider>
    </StrictMode>,
  );
}
