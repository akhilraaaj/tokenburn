import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import './index.css';
import { Toaster } from '@/components/ui/sonner';
import { HydrationMark, isHydrating } from '@/lib/clock';
import { routes } from '@/routes';
import { SessionProvider } from '@/session';

const router = createBrowserRouter(routes);

/** The whole app. entry-server.tsx renders the same tree (with a static router) for the prerendered landing page. */
const app = (
  <StrictMode>
    <SessionProvider>
      <RouterProvider router={router} />
      <Toaster position="bottom-right" />
      <HydrationMark />
    </SessionProvider>
  </StrictMode>
);

const root = document.getElementById('root')!;
// The landing page arrives prerendered (scripts/prerender.mjs): React adopts that DOM instead of repainting it, so
// the first paint is the final one. Every other route gets an empty root from the Worker and renders from scratch.
if (isHydrating()) {
  hydrateRoot(root, app, {
    // A mismatch isn't fatal (React re-renders that part), but it means something in the landing page reads the
    // clock or the host without lib/clock.ts.
    onRecoverableError: (error) => console.warn('Hydration fell back to client rendering:', error),
  });
} else {
  createRoot(root).render(app);
}
