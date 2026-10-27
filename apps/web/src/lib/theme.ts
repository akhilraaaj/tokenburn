import { useSyncExternalStore } from 'react';

/** Theme state lives on <html class="dark">, set before first paint by public/theme.js; this hook reads and flips it. */
export type Theme = 'light' | 'dark';

const KEY = 'tokenburn-theme';
const root = () => document.documentElement;
const current = (): Theme => (root().classList.contains('dark') ? 'dark' : 'light');

function subscribe(onChange: () => void) {
  const mo = new MutationObserver(onChange);
  mo.observe(root(), { attributes: true, attributeFilter: ['class'] });
  return () => mo.disconnect();
}

export function setTheme(theme: Theme) {
  // Dark is the default, so only a light choice needs saving.
  try {
    if (theme === 'dark') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, theme);
  } catch { /* storage blocked: the choice lasts for this page only */ }
  // Switch in one frame: without this, every transition-colors element would fade on its own. The toggle keeps its
  // own icon animation.
  const style = document.createElement('style');
  style.textContent = ':not([data-theme-toggle], [data-theme-toggle] *){transition:none!important}';
  document.head.appendChild(style);
  root().classList.toggle('dark', theme === 'dark');
  void getComputedStyle(document.body).opacity;
  requestAnimationFrame(() => style.remove());
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, current, () => 'dark' as Theme);
  return { theme, setTheme, toggle: () => setTheme(theme === 'dark' ? 'light' : 'dark') };
}
