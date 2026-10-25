# tokenburn

A terminal app that collects your AI coding usage on your machine and publishes the parts you choose
to a public page at `/@username`. Prompts, code, file paths and API keys never leave your computer.

| Tool | How | Status |
|---|---|---|
| Claude Code | local transcripts, automatic | ✅ validated on real data |
| Cursor | usage CSV export (auto-imported from Downloads) | ✅ parser needs one real export to confirm headers |
| Codex CLI | local session files, automatic | ✅ from source; needs real-data check |
| OpenCode | local database, automatic | ✅ from source; needs real-data check |
| Gemini CLI | local chat recordings, automatic | ✅ from source; needs real-data check |
| Grok CLI (community `grok-dev`) | local database, automatic | ✅ from source; no cache split |
| Hermes Agent | local state database, automatic | ✅ from source; per-session totals |
| OpenRouter | `/activity` API with your management key (kept locally) | ✅ from docs; last 30 days |
| Grok Build (official xAI CLI) | — | ❌ format undocumented |

Design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Web

* `/` landing page · `/login` sign in with GitHub · `/dashboard` your private dashboard (shows the CLI
  get-started steps until a machine has synced) · `/settings` username, public-profile fields, machines,
  deletion · `/@username` public profile.
* Dashboard and `tokenburn stats` show total tokens, estimated cost, current/longest streak and best day.
  Estimated cost = the provider's billed amount where reported (OpenRouter), else the tool's own estimate
  (OpenCode, Hermes, grok-cli), else public API list prices from LiteLLM's price list. It is **not** what a
  subscription costs; models without a known price are left out and counted.

## For users (once deployed)

```bash
npm install -g tokenburn
```

```bash
tokenburn setup
```

`setup` signs you in with GitHub, shows what it found and what will be uploaded, asks before the first
upload, optionally turns on Cursor auto-import, and turns on automatic sync: the OS runs
`tokenburn sync --auto` every 30 minutes (nothing stays running in between). Then:

```bash
tokenburn stats
```

```bash
tokenburn profile show models,tokens,trend
```

```bash
tokenburn profile public
```

Run `tokenburn help` for everything else (`status`, `devices`, `delete`, `connect openrouter`, ...).

## Develop locally

```bash
npm install
```

```bash
npm test
```

```bash
npm run typecheck
```

Start everything on http://localhost:8787 (builds the React app, applies local D1 migrations, runs the
Worker). `apps/api/.dev.vars` sets `DEV_LOGIN=1`, so you can sign in without a GitHub app:

```bash
npm run dev:api
```

For hot reload while editing the frontend, also run `npm run dev:web` and use the Vite URL it prints
(it proxies API calls to :8787). Open `/login?dev=yourname` to sign in to the dashboard locally. In another terminal,
sign in the CLI with the same dev account and sync this machine's real usage to the local server:

```bash
npm run collector -- login --dev yourname
```

```bash
npm run collector -- sync
```

```bash
npm run collector -- profile public
```

Then open http://localhost:8787/@yourname. End-to-end check (fixtures, isolated HOME, needs the dev server):

```bash
node scripts/e2e.mjs
```

Build the npm bundle (`packages/collector/dist/cli.mjs`):

```bash
npm run build:cli
```

## Deploy

1. Create a GitHub OAuth App (github.com/settings/developers):
   * Homepage URL: your Worker URL. Authorization callback URL: `https://<your-worker>/auth/callback`.
   * Tick **Enable Device Flow** (used by the CLI).
   * Put its Client ID in `apps/api/wrangler.jsonc` → `vars.GITHUB_CLIENT_ID`, and store the client secret
     (used only for dashboard sign-in) as a Worker secret:
   ```bash
   npx wrangler secret put GITHUB_CLIENT_SECRET --config apps/api/wrangler.jsonc
   ```
2. Create the database and put its id in `apps/api/wrangler.jsonc`:
   ```bash
   npx wrangler d1 create tokenburn
   ```
3. Deploy:
   ```bash
   npm run deploy -w @tokenburn/api
   ```
4. Set `DEFAULT_API_URL` in `packages/collector/src/config.ts` to your Worker URL, then publish the CLI
   (the `tokenburn` npm name may be taken; rename in `packages/collector/package.json` if so):
   ```bash
   npm publish -w tokenburn
   ```

## Known limitations

* Cursor: you export manually (auto-import makes it one click); no session counts; `auto` model ids when
  Cursor doesn't report the serving model.
* Claude Code keeps transcripts ~30 days by default, so only retained history can be collected.
* Hermes and OpenRouter provide totals, not per-request rows (daily / per-session granularity).
* Days are UTC.
* Automatic sync: macOS (launchd, tested), Linux (systemd user timer, or a crontab line when systemd isn't
  available, e.g. WSL), Windows (Task Scheduler, hidden window). Linux and Windows schedulers are unit-tested
  but not yet run on a real Linux/Windows machine.
* Scale notes, hardening decisions and what to change past ~10k users: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
