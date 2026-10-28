// Share previews for the single-page app: the Worker serves index.html for /@username with the
// profile's title and Open Graph tags filled in, so links unfurl in Slack/X/iMessage without client JS.
import { modelDisplayName } from '../../../packages/shared/src/models.ts';
import { PROVIDER_LABELS } from '../../../packages/shared/src/schema.ts';
import type { PublicProfile } from '../../../packages/shared/src/web.ts';

function compact(n: number) {
  const f = (v: number, s: string) => (v >= 10 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, '')) + s;
  if (n >= 1e9) return f(n / 1e9, 'B');
  if (n >= 1e6) return f(n / 1e6, 'M');
  if (n >= 1e3) return f(n / 1e3, 'K');
  return String(n);
}

export function profileDescription(p: PublicProfile): string {
  const providers = [...new Set((p.breakdown ?? []).map((b) => b.provider).filter(Boolean))] as string[];
  const top = (p.breakdown ?? []).filter((b) => b.model_id).sort((a, b) => b.events - a.events)[0];
  const h = p.highlights ?? {};
  return [
    providers.length ? `Uses ${providers.map((x) => PROVIDER_LABELS[x as keyof typeof PROVIDER_LABELS] ?? x).join(', ')}` : 'AI coding usage',
    top?.model_id ? `most-used model: ${modelDisplayName(top.model_id)}` : '',
    h.totalTokens !== undefined ? `${compact(h.totalTokens)} tokens in 90 days` : '',
    h.currentStreak ? `${h.currentStreak}-day streak` : '',
  ].filter(Boolean).join(' · ');
}

/** JSON for inside a <script> element: `<` escaped so no value can close it. */
const json = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

const text = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** The production site; canonical URLs point here from every deployment (keep in sync with apps/web/index.html). */
export const SITE_URL = 'https://tokenburn.pages.dev';

export interface PageMeta {
  title: string;
  description?: string;
  /** Absolute canonical URL; also the og:url. */
  canonical?: string;
  ogType?: 'website' | 'profile';
  noindex?: boolean;
  jsonLd?: object;
  /**
   * index.html carries the prerendered landing page and its structured data; every other route served from it
   * drops both, so no other URL repeats the landing copy.
   */
  keepPrerender?: boolean;
  /** HTML for #root in place of the prerendered landing page (ignored with keepPrerender). */
  root?: string;
  /** Data for the app, embedded as <script type="application/json" id=…> (not executed, so the CSP allows it). */
  data?: { id: string; value: unknown };
}

/**
 * Rewrites the head of index.html for one route: the template's description, canonical, Open Graph, Twitter and
 * JSON-LD tags are replaced (not added to; crawlers and unfurlers read the first of each), and the title is set.
 */
export function withMeta(res: Response, m: PageMeta): Response {
  const description = m.description ?? 'AI coding usage across Claude Code, Cursor, Codex, Gemini CLI and more, tracked on your machine.';
  const image = `${SITE_URL}/og.png`;
  const tags = [
    `<meta name="description" content="${attr(description)}">`,
    m.canonical ? `<link rel="canonical" href="${attr(m.canonical)}"><meta property="og:url" content="${attr(m.canonical)}">` : '',
    '<meta property="og:site_name" content="tokenburn">',
    `<meta property="og:title" content="${attr(m.title)}">`,
    `<meta property="og:description" content="${attr(description)}">`,
    `<meta property="og:type" content="${m.ogType ?? 'website'}">`,
    `<meta property="og:image" content="${image}"><meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">`,
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${attr(m.title)}">`,
    `<meta name="twitter:description" content="${attr(description)}">`,
    `<meta name="twitter:image" content="${image}">`,
    m.noindex ? '<meta name="robots" content="noindex">' : '',
    // `<` escaped so no value can close the script element.
    m.jsonLd ? `<script type="application/ld+json">${json(m.jsonLd)}</script>` : '',
    m.data ? `<script type="application/json" id="${attr(m.data.id)}">${json(m.data.value)}</script>` : '',
  ].join('');
  const remove = { element: (el: Element) => void el.remove() };
  const headers = new Headers(res.headers);
  headers.delete('content-length'); // the body changes length
  let rw = new HTMLRewriter()
    .on('meta[name="description"], meta[property^="og:"], meta[name^="twitter:"], meta[name="robots"], link[rel="canonical"]', remove)
    .on('title', { element: (el) => void el.setInnerContent(m.title) })
    .on('head', { element: (el) => void el.append(tags, { html: true }) });
  if (!m.keepPrerender) {
    rw = rw.on('script[type="application/ld+json"]', remove).on('#root', { element: (el) => void el.setInnerContent(m.root ?? '', { html: true }) });
  }
  return rw.transform(new Response(res.body, { status: res.status, statusText: res.statusText, headers }));
}

/** schema.org ProfilePage for a public profile, so search and answer engines know whose page it is. */
export function profileJsonLd(p: PublicProfile, url: string, description: string): object {
  const name = p.display_name || `@${p.username}`;
  return {
    '@context': 'https://schema.org',
    '@type': 'ProfilePage',
    url,
    name: `${name} · AI coding usage`,
    description,
    isPartOf: { '@type': 'WebSite', name: 'tokenburn', url: `${SITE_URL}/` },
    mainEntity: {
      '@type': 'Person',
      name,
      alternateName: `@${p.username}`,
      identifier: p.username,
      url,
      ...(p.github ? { sameAs: [`https://github.com/${p.github.login}`], image: `${SITE_URL}${p.github.avatar_url}` } : {}),
    },
  };
}

/**
 * The profile's public numbers as plain HTML, for crawlers and answer engines that read pages without running
 * JavaScript. It holds only what the JSON the app renders from holds (the owner's chosen fields) and is replaced by
 * the app as soon as it starts, so it's visually hidden rather than shown and then swapped out.
 */
export function profileSummaryHtml(p: PublicProfile): string {
  const name = p.display_name || `@${p.username}`;
  const h = p.highlights ?? {};
  const providers = [...new Set((p.breakdown ?? []).map((b) => b.provider).filter(Boolean))] as string[];
  const models = new Map<string, number>();
  for (const b of p.breakdown ?? []) if (b.model_id) models.set(b.model_id, (models.get(b.model_id) ?? 0) + b.events);
  const topModels = [...models.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([id]) => modelDisplayName(id));
  const n = (v: number) => v.toLocaleString('en-US');
  const facts: [string, string | null | undefined][] = [
    ['Tools', providers.length ? providers.map((x) => PROVIDER_LABELS[x as keyof typeof PROVIDER_LABELS] ?? x).join(', ') : null],
    ['Most-used models', topModels.length ? topModels.join(', ') : null],
    ['Tokens in the last 90 days', h.totalTokens !== undefined ? `${n(h.totalTokens)} (${compact(h.totalTokens)})` : null],
    ['Estimated cost in the last 90 days (API list prices)', typeof h.costUsd === 'number' ? `$${h.costUsd.toFixed(2)}` : null],
    ['Current streak', h.currentStreak !== undefined ? `${n(h.currentStreak)} days` : null],
    ['Longest streak', h.longestStreak !== undefined ? `${n(h.longestStreak)} days` : null],
    ['Active days', h.activeDays !== undefined ? n(h.activeDays) : null],
    ['Best day', h.bestDay ? `${h.bestDay.day}${h.bestDay.tokens !== undefined ? ` (${n(h.bestDay.tokens)} tokens)` : ''}` : null],
    ['Tracking since', p.first_day ?? null],
    ['Coding sessions in the last 90 days', p.sessions ? n(Object.values(p.sessions).reduce((a, b) => a + b, 0)) : null],
    ['GitHub', p.github ? p.github.login : null],
  ];
  const rows = facts.filter(([, v]) => v).map(([k, v]) => `<dt>${text(k)}</dt><dd>${text(v!)}</dd>`).join('');
  return '<article style="position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap">'
    + `<h1>${text(name)} · AI coding usage</h1>`
    + `<p>${text(profileDescription(p))}</p>`
    + (rows ? `<dl>${rows}</dl>` : '')
    + '<p>Public profile on <a href="/">tokenburn</a>, which tracks AI coding usage (tokens, models, streaks) on the developer\'s own machine. Figures are daily totals in UTC; costs are estimates.</p>'
    + '</article>';
}
