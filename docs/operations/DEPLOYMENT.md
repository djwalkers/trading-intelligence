# Deployment Guide

Location: `Trading/platform/web`
Introduced: Build 1.13.0 — see [`docs/product/BUILD-1.13.0.md`](../product/BUILD-1.13.0.md) for
the full build write-up this guide is part of.

This platform is two independent long-running processes: the Next.js **web app**, and the optional
**worker** (`src/worker/`, Mission 8) that runs scheduled scans independently of any browser. Both
can run without the other — the web app is fully functional standalone (local prototype mode, no
env vars at all); the worker only becomes relevant once always-on server-based scanning is wanted.

## Prerequisites

- Node.js 20.x (matches `@types/node`'s `^20.14.9` pin; no `engines` field is declared in
  `package.json`, but this is the version this codebase has been developed and tested against).
- npm (comes with Node).
- A Supabase project — **optional**. Without one, the app runs in local prototype mode: mock market
  data, browser-storage persistence, no authentication. See "Environment configuration" below.
- PM2 (`npm install -g pm2`) — **optional**, only needed if you want process supervision via
  `ecosystem.config.js` rather than running the processes directly.

## Supported runtime versions

Next.js 16.2.10, React 18.3.1. No Docker/container setup exists in this repo; deployment is a plain
Node process (or two, with the worker).

## Environment configuration

Copy `.env.example` to `.env.local` and fill in only what you need — every variable is optional.
See `.env.example`'s own header for the full required/optional/server-only table, and
[`docs/product/BUILD-1.13.0.md`](../product/BUILD-1.13.0.md#environment-variables-added-or-changed)
for exactly how validation behaves. In short:

- **Nothing set** → fully valid, local prototype mode.
- **A pair fully set** (e.g. both `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`) →
  fully valid, that feature turns on.
- **Half a pair set** → the app (or worker) fails to start with a clear error naming exactly which
  variable is missing. This is deliberate — a half-configured deployment is always a mistake, never
  a valid "off" state.

Client-exposed (`NEXT_PUBLIC_`-prefixed) variables are safe to be public — they're either display
labels or intentionally public API keys (e.g. a Supabase anon key, which is meant to be used from
the browser and is protected by Row Level Security, not secrecy). Server-only variables
(`SUPABASE_SERVICE_ROLE_KEY`, `ALPHA_VANTAGE_API_KEY`) are enforced by the `server-only` package —
the production build itself fails if a client component ever imports a module that touches them,
even transitively.

## Build commands

```bash
cd platform/web
npm install
npm run build
```

`npm run build` runs `next build` (Turbopack), which also runs the full TypeScript check as part of
the build. Treat a failed build as a hard stop — do not deploy a build that failed.

## Start commands

```bash
npm start
```

Runs `next start`, serving the build produced by `npm run build`. Do **not** use `npm run dev` in
production — it's the unoptimised development server.

## Worker start command

Only needed if always-on server-based scanning is wanted (requires `SUPABASE_SERVICE_ROLE_KEY` and
`NEXT_PUBLIC_SUPABASE_URL` to be set — see `.env.example`):

```bash
npm run worker
```

This is a bare, long-running Node process (`src/worker/run-worker.ts`, run via `tsx`) — no build
step, no HTTP server of its own. It polls every `WORKER_POLL_INTERVAL_MS` (default 30s) for due
scan schedules. See `docs/product/MISSION-8-VPS-WORKER.md` for its full lifecycle.

## Health endpoint usage

`GET /api/health` — safe for repeated external polling (uptime checks, load balancer health probes,
PM2/systemd readiness checks). Returns `200` for healthy/degraded/unknown overall status, `503` only
when overall status is `"unavailable"`. Does no network calls, no database writes, and never
triggers a scan or trade — see
[`docs/product/BUILD-1.13.0.md`](../product/BUILD-1.13.0.md#health-model) for the exact response
shape and what each field means.

```bash
curl -s http://localhost:3000/api/health | jq
```

## Process supervision with PM2

`ecosystem.config.js` (repo root of `platform/web/`) defines both processes:

| Process name | What it runs | Depends on |
|---|---|---|
| `trading-intelligence-web` | `npm start` (i.e. `next start`) | A completed `npm run build` |
| `trading-intelligence-worker` | `npm run worker` | `SUPABASE_SERVICE_ROLE_KEY` + `NEXT_PUBLIC_SUPABASE_URL` configured |

```bash
# From platform/web/, after `npm run build`:
pm2 start ecosystem.config.js

# Status:
pm2 status

# Logs (also written to ./.pm2-logs/*.log per the ecosystem file):
pm2 logs trading-intelligence-web
pm2 logs trading-intelligence-worker

# Restart one process:
pm2 restart trading-intelligence-web

# Restart everything:
pm2 restart ecosystem.config.js

# Make PM2 restart these processes automatically after a server reboot:
pm2 save
pm2 startup   # follow the printed instructions for your OS/init system
```

Both processes are configured with `max_restarts: 10` and a 5-second `restart_delay` — if a process
keeps crash-looping past that, PM2 stops trying and marks it `errored`; check `pm2 logs` for why
before restarting manually.

## Restart procedure

1. Pull the new code.
2. `npm install` (if dependencies changed).
3. `npm run build`.
4. `pm2 restart trading-intelligence-web` (and `trading-intelligence-worker`, if the worker's code
   changed — a web-only change doesn't require restarting the worker, and vice versa).
5. `curl -s http://localhost:3000/api/health` to confirm the new build is serving and reports
   `"status": "healthy"`.

## Log inspection

Without PM2: both processes log to stdout/stderr directly — redirect to a file yourself, or run
under `systemd`/`screen`/`tmux` and use their own log mechanisms.

With PM2: `pm2 logs <name>` tails live; `./.pm2-logs/{web,worker}-{out,error}.log` (per
`ecosystem.config.js`) hold the persisted history. The worker's own log lines are single-line,
greppable, and follow the pattern `[worker] <ISO timestamp> <event_name> <JSON detail>` — see
`src/worker/logger.ts` for the full list of ~16 event names (e.g. `scan_executed`, `scan_failed`,
`lock_acquired`). The web app's structured logger (`src/lib/logger/logger.ts`) emits single-line
JSON in production (`NODE_ENV=production`, which PM2 sets by default per `ecosystem.config.js`).

## Common failures

See [`docs/operations/RUNBOOK.md`](RUNBOOK.md) for detailed symptom → cause → action steps. Quick
summary of the two most common:

- **App won't start**: almost always a half-configured environment variable pair (see
  "Environment configuration" above) — the startup error names exactly which variable is missing.
- **Worker won't start**: missing `SUPABASE_SERVICE_ROLE_KEY` or `NEXT_PUBLIC_SUPABASE_URL` — the
  worker logs `scan_failed` with a clear message and exits with a non-zero code rather than
  retry-looping uselessly.

## Rollback approach

There is no automated deployment pipeline in this repo (no CI/CD configured). Rollback is manual:

1. `git log` to find the last known-good commit.
2. Check out that commit (or revert the bad commit) on the deployment host.
3. `npm install` (in case dependencies changed between versions).
4. `npm run build`.
5. `pm2 restart ecosystem.config.js` (or your process manager's equivalent).
6. Confirm via `/api/health` and a manual pass through the Dashboard.

No database migration is reverted automatically — check `supabase/migrations/` for whether the
version you're rolling back to expects a migration that's already been applied; migrations in this
project are additive and have not required a rollback path to date.

## Persistence limitations

- Local-mode (no Supabase configured) persistence lives entirely in the browser's `localStorage` —
  it is **not** backed up anywhere and does not survive clearing browser data.
- Supabase-mode persistence has no automated backup/restore procedure documented in this repo;
  Supabase's own project-level backups (see your Supabase project dashboard) are the only safety
  net.
- The Alpha Vantage historical-candle disk cache (`.data/alpha-vantage-historical-cache.json`,
  worker-only) is fully regenerable — safe to delete if ever corrupted; the worker will simply
  re-fetch from Alpha Vantage on next use (subject to its own rate limits).

## Browser-only versus server-side automation behaviour

Do not confuse these two, and do not describe one as the other to users or in monitoring dashboards:

- **Browser-based scheduling** (Settings → "This browser"): only advances while a browser tab has
  the app open. Closing the browser pauses it. Not "always-on" despite the name of the feature it
  configures alongside.
- **Server-based / "Always-On Scanning"** (Settings → "Server (always-on)"): requires the worker
  process (`npm run worker`) to actually be running somewhere — enabling it in Settings only writes
  *when* a scan should run to the database; it does not start the worker itself. The web app has no
  way to directly detect whether the worker process is alive — `automation: "unknown"` in the health
  endpoint, and the Operations Centre's own disclosed "Not directly detectable" status, both reflect
  this honestly. The clearest evidence the worker is running is a recent "Last scan" timestamp.

## Production verification checklist

After any deploy or restart:

- [ ] `curl -s http://localhost:3000/api/health` returns `"status": "healthy"` (or a status you
      understand and expect) with the correct `version`.
- [ ] The Dashboard loads with no console errors (open it in a real browser, not just curl).
- [ ] If the worker is expected to be running: `pm2 status` shows it `online`, and its logs show a
      recent `poll_started`/`scan_executed`/`no_schedules_due` event within the last poll interval.
- [ ] If Supabase is configured: sign in and confirm a paper trade or scan writes and reads back
      correctly.
- [ ] No unexpected environment variable warnings in the startup logs.
