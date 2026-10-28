// Build step after `vite build` and the SSR build of src/entry-server.tsx: writes the landing page's HTML into
// dist/index.html, plus its structured data (JSON-LD), so crawlers and answer engines read the page without
// running JavaScript and the first paint doesn't wait for the bundle. The Worker strips both again for every
// other route that is served this same file (apps/api/src/index.ts, serveAsset).
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const ssrDir = `${root}dist-ssr`;
const { render, FAQ, PRERENDERED_AT } = await import(pathToFileURL(`${ssrDir}/entry-server.js`).href);

const SITE = 'https://tokenburn.pages.dev';
const DESCRIPTION =
  'Track AI coding usage across Claude Code, Cursor, Codex, Gemini CLI and more on your machine. A private dashboard for tokens, models, streaks and estimated cost, and an optional public profile. Your prompts and code never leave your computer.';

const jsonLd = {
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'WebSite', '@id': `${SITE}/#website`, url: `${SITE}/`, name: 'tokenburn', description: DESCRIPTION, inLanguage: 'en' },
    { '@type': 'Organization', '@id': `${SITE}/#org`, name: 'tokenburn', url: `${SITE}/`, logo: `${SITE}/icon-512.png` },
    {
      '@type': 'SoftwareApplication',
      '@id': `${SITE}/#app`,
      name: 'tokenburn',
      url: `${SITE}/`,
      description: DESCRIPTION,
      applicationCategory: 'DeveloperApplication',
      operatingSystem: 'macOS, Linux, Windows',
      softwareRequirements: 'Node.js 22.18 or later',
      installUrl: 'https://www.npmjs.com/package/use-tokenburn',
      offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
      publisher: { '@id': `${SITE}/#org` },
      image: `${SITE}/og.png`,
    },
    {
      '@type': 'FAQPage',
      '@id': `${SITE}/#faq`,
      mainEntity: FAQ.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
    },
  ],
};

const file = `${root}dist/index.html`;
const shell = await readFile(file, 'utf8');
if (!shell.includes('<div id="root"></div>')) throw new Error('prerender: <div id="root"></div> not found in dist/index.html');
const html = await render('/');
// `<` escaped so answer text can never close the script element.
const ld = `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>`;
// The headline is the largest paint and waits on Geist; without a preload the font is only found once the CSS is in.
const font = (await readdir(`${root}dist/assets`)).find((f) => /^geist-latin-wght-normal-.*\.woff2$/.test(f));
if (!font) throw new Error('prerender: Geist latin font not found in dist/assets');
const preload = `<link rel="preload" href="/assets/${font}" as="font" type="font/woff2" crossorigin>`;
// The time the page was rendered at, so the browser hydrates with the same dates (src/lib/clock.ts).
const stamp = `<meta name="prerendered-at" content="${PRERENDERED_AT}">`;
await writeFile(file, shell.replace('</head>', `${stamp}${preload}${ld}</head>`).replace('<div id="root"></div>', `<div id="root">${html}</div>`));
await rm(ssrDir, { recursive: true, force: true });
console.log(`prerender: / → dist/index.html (${(html.length / 1024).toFixed(1)} kB of markup)`);
