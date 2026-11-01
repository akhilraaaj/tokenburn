# tokenburn

Track how much you use AI coding tools, and share it on a public profile at
[tokenburn.site](https://tokenburn.site)/@username.

A small CLI reads usage from the tools on your machine (tokens, models, sessions) and uploads only
usage numbers, plus a machine name that only you can see. Prompts, code, file paths and API keys never
leave your computer, and you choose what your profile shows.

## Get started

```bash
npm install -g use-tokenburn
```

```bash
tokenburn setup
```

`setup` signs you in with GitHub, shows what it found and exactly what will be uploaded, and asks before
the first upload. It then turns on automatic sync: your OS runs `tokenburn sync --auto` every 30 minutes
at low priority, and nothing stays running in between.

```bash
tokenburn stats
```

```bash
tokenburn profile show models,tokens,trend
```

```bash
tokenburn profile public
```

Run `tokenburn help` for everything else (`status`, `dashboard`, `devices`, `delete`, `connect openrouter`, ...).

## Supported tools

| Tool | Source |
|---|---|
| Claude Code | local transcripts |
| Codex CLI | local session files |
| OpenCode | local database |
| Gemini CLI | local chat recordings |
| Grok CLI (community `grok-dev`) | local database |
| Hermes Agent | local state database |
| Cursor | usage CSV export, auto-imported from Downloads |
| OpenRouter | `/activity` API with your management key (stored only on your machine) |

## The website

* `/@username`: your public profile, showing only the fields you choose.
* `/dashboard`: your private dashboard with tokens, estimated cost, streaks, best day, and per-model
  and per-machine breakdowns. `/dashboard/settings` covers username, profile fields, machines and
  account deletion.

**Estimated cost** is the provider's billed amount where reported (OpenRouter), else the tool's own
estimate (OpenCode, Hermes, Grok CLI), else public API list prices from LiteLLM's price list. It is
**not** what a subscription costs. Models without a known price are left out of the total.

## Develop locally

Requires Node.js 22.18 or newer.

```bash
npm install
```

```bash
npm test
```

```bash
npm run typecheck
```

To sign in locally without a GitHub app, create `apps/api/.dev.vars` containing:

```
DEV_LOGIN=1
```

Then start the site and API on http://localhost:8787 (builds the React app, applies local D1
migrations and runs the Worker):

```bash
npm run dev:api
```

Open http://localhost:8787/login?dev=yourname to sign in. For hot reload while editing the frontend,
also run `npm run dev:web` and use the Vite URL it prints (it proxies API calls to :8787).

To sync this machine's real usage to your local server, sign the CLI in with the same dev account:

```bash
npm run collector -- login --dev yourname
```

```bash
npm run collector -- sync
```

```bash
npm run collector -- profile public
```

Then open http://localhost:8787/@yourname. End-to-end check (fixtures in an isolated HOME; needs the
dev server running):

```bash
node scripts/e2e.mjs
```

## Self-hosting (Cloudflare Pages)

The site, API and `/@username` share previews deploy as one Cloudflare Pages project.
`npm run build -w @tokenburn/api` builds the React app into `apps/web/dist` and bundles the API into
`apps/web/dist/_worker.js`. Run these from `apps/api`:

1. Log in: `npx wrangler login`
2. Create the database (once): `npx wrangler d1 create tokenburn`, then put its `database_id` in
   `apps/api/wrangler.jsonc`.
3. Create the Pages project (once): `npx wrangler pages project create tokenburn --production-branch main`
4. Create a GitHub OAuth app (github.com/settings/developers → New OAuth App) with homepage
   `https://<your-domain>` and callback `https://<your-domain>/auth/callback`, and tick **Enable Device
   Flow**. Put the Client ID in `apps/api/wrangler.jsonc` (`vars.GITHUB_CLIENT_ID`) and store the secret:
   `npx wrangler pages secret put GITHUB_CLIENT_SECRET --project-name tokenburn`
5. Deploy (applies D1 migrations, builds and uploads): `npm run deploy -w @tokenburn/api`
6. Point the CLI at your server with `TOKENBURN_API_URL=https://<your-domain>`, or change
   `DEFAULT_API_URL` in `packages/collector/src/config.ts` and build your own CLI with `npm run build:cli`.

Pages has no rate-limit bindings or cron triggers, so the API rate-limits in D1 and runs its daily
cleanup during uploads. Deployed as a plain Worker, the same code uses Workers rate-limit bindings if
configured. Design, scaling and hardening notes: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Known limitations

* Cursor has no local usage log, so you export a CSV (auto-import makes it one click). No session
  counts, and the model shows as `auto` when Cursor doesn't report which model served the request.
* Claude Code keeps transcripts for about 30 days by default, so older history can't be collected.
* Hermes and OpenRouter report totals rather than individual requests (per-session and per-day).
  OpenRouter covers the last 30 days. Grok CLI doesn't report cached tokens separately.
* Not supported: Grok Build (the official xAI CLI), whose on-disk format isn't documented.
* Days are in UTC.
* Automatic sync is tested on macOS. The Linux (systemd timer, or cron on WSL and containers) and
  Windows (Task Scheduler) setups are unit-tested but not yet verified on real machines.

## License

[MIT](LICENSE)
