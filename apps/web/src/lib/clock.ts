import { useLayoutEffect, useSyncExternalStore } from 'react';
import { SITE_HOST } from '@/lib/utils';

/**
 * Time and host for pages that are prerendered at build time and then hydrated (the landing page, see
 * scripts/prerender.mjs). Hydration needs the first render in the browser to match the build's HTML exactly, so
 * until it completes, "now" is the build's time and the host is the production one. Then the live values take
 * over and the few components that read them via the hooks below re-render once.
 */

const browser = typeof document !== 'undefined';
/** When the prerendered HTML was built (from <meta name="prerendered-at">); the current time while prerendering. */
const buildNow = browser ? Number(document.querySelector<HTMLMetaElement>('meta[name="prerendered-at"]')?.content) || Date.now() : Date.now();
let hydrating = browser && !!document.getElementById('root')?.hasChildNodes();

/**
 * Rendered once at the root of the app. Its layout effect runs in the commit that finishes hydration, before the
 * hooks below re-render with live values, so that re-render (and everything after) sees live time.
 */
export function HydrationMark() {
  useLayoutEffect(() => {
    hydrating = false;
  }, []);
  return null;
}

export const isHydrating = () => hydrating;

/** Milliseconds since the epoch: frozen at build time while hydrating, live otherwise. Use instead of Date.now() in render. */
export const nowMs = () => (hydrating ? buildNow : Date.now());

/** Today as a UTC day (YYYY-MM-DD), the same during hydration as at build time, today's date right after. */
export function useToday(): string {
  return useSyncExternalStore(noSubscribe, () => new Date(Date.now()).toISOString().slice(0, 10), () => new Date(buildNow).toISOString().slice(0, 10));
}

/** This page's host ("tokenburn.site", "localhost:5173"), the production host during prerender and hydration. */
export function useHost(): string {
  return useSyncExternalStore(noSubscribe, () => window.location.host, () => SITE_HOST);
}

/** False while prerendering and hydrating, true after: for client-only UI that the prerendered HTML can't contain. */
export function useHydrated(): boolean {
  return useSyncExternalStore(noSubscribe, () => true, () => false);
}

/** Never changes after hydration; the server snapshot is what makes these values hydration-safe. */
const noSubscribe = () => () => {};

export { buildNow as PRERENDERED_AT };
