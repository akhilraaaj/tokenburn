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

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function withMeta(res: Response, opts: { title: string; description?: string; url?: string; noindex?: boolean }): Response {
  const tags = [
    opts.description ? `<meta name="description" content="${attr(opts.description)}">` : '',
    `<meta property="og:title" content="${attr(opts.title)}">`,
    opts.description ? `<meta property="og:description" content="${attr(opts.description)}">` : '',
    opts.url ? `<meta property="og:url" content="${attr(opts.url)}"><meta property="og:type" content="profile">` : '',
    '<meta name="twitter:card" content="summary">',
    opts.noindex ? '<meta name="robots" content="noindex">' : '',
  ].join('');
  return new HTMLRewriter()
    .on('title', { element: (el) => void el.setInnerContent(opts.title) })
    .on('head', { element: (el) => void el.append(tags, { html: true }) })
    .transform(res);
}
