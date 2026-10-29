# Architecture

The `tokenburn` terminal app collects and syncs. The web app (`apps/web`: Vite + React + Tailwind) has a
landing page, a private dashboard, settings and the public `/@username` profile. Everything deploys as one
Cloudflare Pages project: the API (`apps/api/src`) is bundled to `_worker.js` in the site build ("advanced
mode"), so it receives every request and serves the React app's files and talks to `/api/web/*` (cookie session) and `/api/public/*`. For `/@username` the
Worker injects the title and Open Graph tags into the HTML shell so shared links unfurl. Both the CLI and the
web sign in with the same GitHub OAuth app.

```
┌──────────────── user's machine ────────────────┐            ┌────────── Cloudflare ──────────┐
│ Claude Code · Codex · OpenCode · Gemini CLI    │            │ Worker (apps/api)              │
│ Grok CLI · Hermes        (local files/SQLite)  │──┐         │  /api/*   JSON (device token)  │
│ Cursor CSV exports in ~/Downloads              │  ├─ HTTPS ─► │  /@user   server-rendered HTML │
│ OpenRouter /activity (key stays local)         │  │ totals   │ D1: users, devices, profiles,  │
│        ↓                                       │  │ only     │     usage_daily, usage_sessions│
│ tokenburn (Node CLI, background service)    │──┘         │     account_daily              │
│   ~/.tokenburn/collector.db                 │            └────────────────────────────────┘
└────────────────────────────────────────────────┘                     ↑ GitHub device flow (login)
```

## Packages

| Path | What |
|---|---|
| `packages/shared` | Schema (`SOURCES` table: scope, capabilities, input semantics), Claude Code + Cursor parsers, daily aggregation |
| `packages/collector` | The `tokenburn` CLI. `src/sources/*` = one module per tool, registered in `sources/index.ts`. Bundled to `dist/cli.mjs` for npm |
| `apps/api` | Worker: CLI login (GitHub device flow), web sign-in, ingest, `/api/web/*` for the dashboard, `/api/public/*`, share-preview tags, static assets. D1 migrations |
| `apps/web` | Vite + React + Tailwind SPA: landing, dashboard, settings, profile. Charts are hand-built SVG components (no chart library) |

## Accounts and login

`tokenburn login` → `POST /api/login/start` → the **server** starts GitHub's device flow and returns
the user code → the user approves at github.com/login/device → the CLI polls `POST /api/login/poll` → the
server exchanges the code, reads the GitHub user id and login, **discards the GitHub token**, creates the
account (username defaults to the GitHub login) and returns a device token. That device token (hashed at
rest) is the only credential; there are no passwords or cookies. A local-only dev login exists when
`DEV_LOGIN=1` and the request is to localhost.

Dashboard sign-in uses GitHub's authorization-code flow (`/login` → github.com → `/auth/callback`, needs
`GITHUB_CLIENT_SECRET`) and an HttpOnly SameSite=Lax session cookie (hashed in `auth_sessions`). Cookie-authenticated
mutations (`/api/web/*` non-GET) require a same-origin `Origin` header. Until a machine has synced, `/dashboard` shows the CLI
get-started steps.

## Costs, streaks, best day

* Each daily bucket carries `cost_usd` (best known), `billed_cost_usd` and `unpriced_events`, computed by the
  collector: provider-billed cost (OpenRouter `usage`, Hermes `actual_cost_usd`) > tool estimate (OpenCode
  `cost`, Hermes `estimated_cost_usd`, grok-cli `cost_micros`) > API list-price estimate from LiteLLM's
  public price list (cached in `~/.tokenburn/prices.json`, refreshed daily; exact id or provider-prefix
  match only). Shown as "estimated", never as a bill.
* Total tokens = input + output + cache read + cache write. Best day = most total tokens. Streaks count
  consecutive UTC days with any request, across all tools and all history; the current streak survives
  until the end of today if yesterday was active. Shared logic: `packages/shared/src/activity.ts`.
* Costs and streaks are separate opt-in public-profile fields (`show_costs`, `show_streaks`).

## Sources

Each local source implements `LocalSource` (`roots`, `billing`, incremental `scan`). Two scopes:

* **device** (Claude Code, Codex, OpenCode, Gemini CLI, Grok CLI, Hermes): collected from this machine's files
  and uploaded as replace-by-key daily aggregates per device, plus salted-hash session summaries.
* **account** (Cursor CSV, OpenRouter): may arrive from several machines. Requests are deduped locally and
  uploaded as daily totals per user (`account_daily`, one row per day, tool and model). When machines disagree the
  server keeps the larger Cursor day (an export covers the whole account for its range, so the more complete one
  wins) and the latest OpenRouter day (the provider revises its daily totals).
* **Budgets** (D1 free plan: 100k rows written/day for the whole app): each account may write 20k rows per UTC day,
  storage ceilings are counted at most hourly, and the CLI uploads at most 2,000 rows per run, continuing on the
  next. Static files are served by Pages directly (`_routes.json`), not through the Worker.

Incremental strategies: JSONL byte offsets with partial-line handling (Claude Code, Codex, Gemini),
SQLite watermarks (Grok CLI `id`, OpenCode `time_updated`), snapshot deltas (Hermes running totals),
size+mtime for whole files (Cursor exports, legacy JSON, `.zst`). Other apps' databases are opened read-only
and only usage tables are queried.

## What leaves the machine

Daily per-model token totals, request counts, hashed session ids with first/last timestamps, Cursor and
OpenRouter rows (no emails, no costs). Never: prompts, responses, tool args, code, paths, project names,
hostnames, API keys.

## Display rules

Per-tool totals, never a blended grand total (input/output semantics differ; see `SOURCES[*].inputNote`).
"n/a" when a source can't report a metric. UTC days. No prices or cost estimates.

## Automatic sync

`tokenburn service install` (offered by `setup`) asks the OS to run `tokenburn sync --auto` every
30 minutes: a launchd agent with `StartInterval` on macOS (also at login); a systemd user timer on Linux, or a
crontab line (`# tokenburn-auto-sync`) where there's no systemd user session (WSL, containers); a Task
Scheduler task on Windows that starts a small VBScript so no console window flashes. On headless Linux servers
`loginctl enable-linger` keeps the user timer running after logout. Nothing stays resident between runs; each run takes about a second at low CPU/IO priority, logs one
line only when something changed or failed (`~/.tokenburn/sync.log`, self-trimming) and records the last
error for `tokenburn status`. `sync --auto` never prompts and does nothing until the user has approved
the first sync interactively. `tokenburn watch` remains available for real-time syncing in a terminal.

## Production hardening

* **Devices:** sign-out (`logout`/`forget`) and 180-day idle expiry *revoke* the token (`devices.revoked_at`)
  and keep the machine's history. Signing in again sends the old token, and the server resumes the same
  device, so history is never uploaded twice. Removing a machine in Settings / `devices remove` deletes its data.
* **Server-side deletes:** set `users.data_reset_at`; collectors that see a newer value re-upload full history once.
* **Collector:** one sync at a time (`sync.lock`, SQLite busy timeout). List-price estimates are frozen per
  event when first priced (`events.est_cost_usd`), so price-list updates never rewrite or re-upload history.
  Scheduled runs skip all work and network when nothing changed (a 6-hour check-in remains); a manual
  `sync` always contacts the server. `delete --provider` clears only that tool's parse state.
* **Limits:** rate limiting on sign-in (per IP) and ingest (per device): a fixed-window counter in D1 on
  Pages (no rate-limit binding there), or the Workers binding when deployed as a Worker; real-date validation
  (2020-01-01 to tomorrow); per-account caps (200k daily rows, 500k account events); event batches ≤ 500;
  health JSON ≤ 4 KB.
* **Privacy:** the public API is fixed at 90 days; best-day tokens and per-tool session counts are shown only
  when token totals / tools are public; local file paths in model ids are reduced to the file name before upload.
* **Web:** CSP, `frame-ancestors 'none'`, nosniff, referrer policy and HSTS (`apps/web/public/_headers` and
  the Worker); `__Host-` session cookie in production; OAuth state cookie cleared after use; sign-in errors as fixed codes.
* **Storage/cost:** `usage_daily` and `usage_sessions` are `WITHOUT ROWID`; device and account deletes remove
  child rows by their primary-key prefix (no table scans); daily cleanup (opportunistic from upload traffic on Pages, which has no cron) prunes expired sign-ins and sessions,
  90-day sync history and sessions older than two years; public profiles are edge-cached for 60 s; logs sampled at 10%.

### Known limits and next steps at scale

* At roughly 10k active users the Workers **Paid** plan ($5/month base) is needed; estimated total about
  $15/month at that size (requests + D1 writes). The free plan suits a beta of a few hundred users.
* D1's 10 GB per-database cap is the long-term ceiling. Next steps when approaching it: integer surrogate
  keys instead of UUID text, rolling Cursor events up into daily rows, and per-day session counts instead of
  per-session rows.
* Codex: two different sessions whose *first* responses have identical token counts and model are deduped
  as one (fork copies are indistinguishable otherwise). Rare outside scripted `codex exec` runs.
* Days are UTC everywhere (streaks shift for users far from UTC).
