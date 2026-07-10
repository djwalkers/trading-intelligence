# Mission 8 — VPS Background Worker

Date: 2026-07-09
Location: `Trading/platform/web`
Related: [`MISSION-6-SERVER-ARCHITECTURE-PREPARATION.md`](./MISSION-6-SERVER-ARCHITECTURE-PREPARATION.md),
[`MISSION-7-DECISION-INTELLIGENCE.md`](./MISSION-7-DECISION-INTELLIGENCE.md)

## What this mission is, and isn't

This mission builds the first real background execution service: a standalone Node process
(`npm run worker`) that wakes up, checks which users' bot schedules are due, runs a scan for each,
persists the result, and sleeps — entirely independent of any open browser tab. It runs on the
server architecture Mission 6 prepared and never used, and produces the same Decision Intelligence
records Mission 7 introduced.

**Roadmap lock, honoured exactly**: no new trading strategies, no Hermes, no learning logic, no UI
redesign, no broker integration, no Trading 212 integration, no outcome analysis. No workspace
restructuring. The existing browser Bot Runner is untouched — this mission adds a second caller of
the same pipeline, it does not modify the pipeline or the browser's use of it.

## 1. Worker application

New: `src/worker/` — four small files, each with one job:

- `run-worker.ts` — the entrypoint (`npm run worker`). An infinite wake/poll/sleep loop: fetch due
  schedules, process each one, sleep for `WORKER_POLL_INTERVAL_MS` (default 30s), repeat. Handles
  `SIGINT`/`SIGTERM` for a clean shutdown log line. Exits immediately, with a clear log message, if
  the service-role client can't be constructed (missing env vars) — it does not loop uselessly
  against a broken configuration.
- `fetch-due-schedules.ts` — one read: `bot_schedules` where `enabled = true` and `next_scan_at` is
  null or in the past.
- `process-schedule.ts` — one schedule, start to finish: claim the lock, run the scan, release the
  lock with the outcome. This is the only file that touches the risk pipeline, and it does so by
  calling `executeBotScan()`, never by reimplementing any part of it.
- `reserve-worker-scan-id.ts` — a worker-local scan id scheme (see "A gap this mission had to
  close," below).

No UI, no web server, no API route — this code is never imported by `src/app` or
`src/components`, only ever executed directly via `npm run worker`. Confirmed by the production
build: `next build` succeeds and `src/worker/` contributes nothing to any route's bundle (it isn't
reachable from any file the build graph actually traverses).

## 2. Shared execution — no duplicated risk logic

The worker calls exactly the same two functions the browser's `BotRunnerPanel` calls:

```
executeBotScan({ instruments, scanId, triggerType: "Scheduled", context })
```

where `context` comes from Mission 6's `createServerExecutionContext(client, userId)` instead of
the browser's `usePaperTrades()`/`useBotDecisionLog()`/`useDecisionHistory()`-backed context. The
pipeline inside `executeBotScan()` — Strategy Engine → Position Manager → Portfolio Risk → Decision
Intelligence → paper trade → trade events — is the one piece of code both callers share, unmodified
by this mission. `process-schedule.ts` contains zero risk logic of its own; it only orchestrates
locking and logging around the identical call the browser makes.

**A gap this mission had to close**: the browser's `reserveScanId()` (Mission 1.1) is a
`localStorage` counter that returns the fixed string `"SCAN-000001"` whenever `window` is
undefined — which is always, in a Node worker process. Mission 6 flagged this as a known,
unfixed gap; this mission needed an actual answer, since the worker cannot generate valid scan ids
without one. `reserveWorkerScanId()` is a worker-local, in-memory, per-process counter producing
ids like `WORKER-84213-000001` (pid + sequence) — infrastructure, not risk logic, and deliberately
not a cross-process-global sequence: the advisory lock (see "Concurrency" below) already guarantees
at most one scan ever runs for a given user at a time, so there is no scenario where two processes
race to produce a scan id for the same user's decision at the same moment.

## 3. Scheduler

`fetchDueSchedules()` reads `bot_schedules` for rows where `enabled = true` and `next_scan_at` is
either `null` (a schedule that's never been run) or already in the past, ordered oldest-due-first so
a worker that fell behind catches up on the most overdue users first. For each due schedule,
`processSchedule()`:

1. Claims the row's lock (see "Concurrency").
2. Runs one scan via `executeBotScan()`.
3. Releases the lock, writing `last_scan_at` (now), `last_status` (`"Trade Opened"` / `"No Trade"` /
   `"Error"`), `last_error` (the failure message, or `null`), and `next_scan_at` (now +
   `interval_minutes`) — respecting whatever interval that user's schedule row specifies (15/30/60
   minutes, per Mission 6's `bot_schedules` schema), exactly as instructed.

## 4. Concurrency

Implements — for the first time actually *calls* — Mission 6's advisory lock
(`claimScheduleLock`/`releaseScheduleLock`, `src/lib/scheduler/server-schedule-store.ts`), unchanged
from how it was designed:

- **Only one scan per user at a time**: `claimScheduleLock` is a single conditional `UPDATE`
  (`locked_at`/`locked_by` set only if currently null or older than five minutes) — Postgres
  serialises concurrent attempts on the same row, so at most one caller's `UPDATE` can ever succeed.
- **Skip safely, log why**: if `claimScheduleLock` returns `null`, `processSchedule()` logs
  `lock_skipped` with a human-readable reason and returns immediately — it does not retry, queue, or
  block waiting for the lock.
- **Release on completion**: both the success path and the `catch` block call
  `releaseScheduleLock()` — a failing scan still releases its lock (with `status: "Error"` and the
  failure message recorded), so a single bad scan can never leave a user's schedule stuck locked
  forever.
- **Recover automatically after timeout**: unchanged from Mission 6 — a lock older than five minutes
  is treated as abandoned and becomes claimable again, so a worker that crashed mid-scan doesn't
  permanently block that user's schedule.

**Verified** (see "Verification" below) with an in-memory harness proving: a second concurrent claim
attempt while the first is held is correctly rejected; the lock is released with the correct status
both on success and on a simulated failure.

## 5. Authentication

The worker uses `getServiceRoleClient()` (Mission 6) — the service role key, read from
`SUPABASE_SERVICE_ROLE_KEY`, never `NEXT_PUBLIC_`-prefixed, never read by the browser bundle (the
file is marked `import "server-only"`, which fails the Next.js build if a client component ever
pulls it in). The worker never invents or accepts a `user_id` from anywhere other than the
`bot_schedules` row it's currently processing — `createServerExecutionContext(client, userId)` binds
one `userId` per schedule for the lifetime of that scan, and every write inside it
(`addTradeForUser`, `persistServerDecision`, `addRecordsForUser`) takes that `userId` as a required,
explicit parameter, never optional, never inferred from anything else. There is no anonymous write
path anywhere in this code, and no bypass of `executeBotScan()`'s business rules — the worker cannot
open a trade or record a decision except by calling it.

## 6. Logging

`src/worker/logger.ts` — one function, `log(event, details?)`, printing a single line per call:
timestamp, event name, optional JSON detail blob. Every lifecycle moment the mission asked for is
logged: `worker_started`, `schedule_found`, `lock_acquired` (or `lock_skipped`, with why),
`scan_executed`, `trade_opened` (only when one did), `decision_records_stored`, `lock_released`,
`worker_finished` — plus `poll_started`/`no_schedules_due`/`scan_failed`/`poll_failed` for the
quieter and failure cases. No logging framework, no log levels, no structured-logging library — a
single `console.log` per event, greppable in plain stdout (a redirected file, `pm2 logs`,
`journalctl`), per the mission's explicit "simple structured logging only."

## 7. Local development

`npm run worker` runs the worker standalone via `tsx`. Two things had to be solved to make this
work at all, both discovered by actually trying to run it (Mission 6 built this code but never
executed it):

- **`import "server-only"` throws outside Next.js's bundler.** The `server-only` package's
  "safe in Server Components" behaviour depends on Next.js's build system resolving its
  `react-server` conditional export instead of the default (which unconditionally throws) — a
  webpack/turbopack-specific mechanism, not something plain Node/`tsx` does on its own. Running the
  worker without a fix crashes immediately on the first server-only import. Fixed by setting
  `NODE_OPTIONS=--conditions=react-server` in the `worker` script, which makes Node's own module
  resolution pick the same no-op export Next.js does — confirmed working, not just assumed (see
  "Verification").
- **`.env.local` isn't loaded automatically outside Next.js.** Next's `next dev`/`next build`
  auto-load it; a plain `tsx` script does not. Fixed with `tsx --env-file-if-exists=.env.local`
  (Node's native `--env-file` flag, available since Node 20.6), so `npm run worker` picks up the
  same local config the web app uses, while still starting cleanly (just with a warning) if the
  file doesn't exist — matching this app's "no environment variables required" default posture.

Both fixes live entirely in the `worker` script in `package.json`:

```
"worker": "NODE_OPTIONS=--conditions=react-server tsx --env-file-if-exists=.env.local src/worker/run-worker.ts"
```

Run the web app and the worker at once in two terminals:

```bash
npm run dev      # terminal 1 — the browser app, unchanged
npm run worker   # terminal 2 — the background worker
```

Neither binds a port or depends on the other; they only share the same Supabase project (through
different keys — anon for the browser, service role for the worker).

## Files changed

New:
- `src/worker/run-worker.ts` — entrypoint, poll loop, graceful shutdown
- `src/worker/fetch-due-schedules.ts` — reads due `bot_schedules` rows
- `src/worker/process-schedule.ts` — claim → scan → release, per schedule
- `src/worker/reserve-worker-scan-id.ts` — worker-local scan id generator
- `src/worker/logger.ts` — structured lifecycle logging

Changed:
- `package.json` — new `worker` script; `tsx` added as a dev dependency
- `.env.example` — documents `WORKER_POLL_INTERVAL_MS` (optional) and expands the existing
  `SUPABASE_SERVICE_ROLE_KEY` comment to describe its now-real use by the worker
- `README.md`, `src/components/layout/Footer.tsx`, `src/components/layout/Sidebar.tsx`,
  `src/app/system-health/page.tsx` — build label bumped to "Mission 8"

No changes to any browser-reachable file — `src/app/`, `src/components/`, and every file Mission 6
already built (`bot-execution-context.ts`, `server-execution-context.ts`,
`server-schedule-store.ts`, etc.) are used exactly as they were, unmodified.

## Database changes

None. This mission reads and writes to tables Mission 6 (`bot_schedules`) and Mission 7
(`decision_history`, `paper_trades`, `trade_events`) already created. No new migration.

## Worker lifecycle

```
npm run worker
  → worker_started
  → loop:
      poll_started
      fetch bot_schedules where enabled = true and next_scan_at <= now (or null)
      → no rows: no_schedules_due
      → for each due row:
          schedule_found
          claimScheduleLock()
            → null: lock_skipped (another process holds it) — move to the next row
            → row:  lock_acquired
                     executeBotScan() — Strategy Engine → Position Manager → Portfolio Risk →
                                        Decision Intelligence → paper trade → trade events
                     scan_executed
                     trade_opened            (only if one did)
                     decision_records_stored
                     releaseScheduleLock({ status, nextScanAt })   [success path]
                       — or, on a thrown error —
                     scan_failed
                     releaseScheduleLock({ status: "Error", error, nextScanAt })
                     lock_released (either path)
      sleep WORKER_POLL_INTERVAL_MS (default 30_000ms)
  → (SIGINT/SIGTERM) worker_finished, exit 0
```

## Deployment overview

Not deployed this mission (that's explicitly future work — see "What remains" below), but the
shape a Linux VPS deployment would take:

1. Clone the repo, `npm install` in `platform/web`.
2. Set real environment variables (not a `.env.local` file) directly in the process's environment:
   `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, optionally `WORKER_POLL_INTERVAL_MS`.
3. Run `npm run worker` under a process supervisor (systemd, pm2, or equivalent) so it restarts on
   crash and starts on boot. The supervisor must launch the `npm run worker` script itself (or
   replicate its exact `NODE_OPTIONS`/`--env-file-if-exists` flags) — invoking `node
   src/worker/run-worker.ts` directly, without `NODE_OPTIONS=--conditions=react-server`, will crash
   on the first server-only import, per "Local development" above.
4. Redirect stdout to a log file or let the supervisor capture it — the structured log lines are
   designed to be readable directly from there.
5. The web app (`npm run build && npm run start`, or wherever it's hosted) and the worker are
   independent deployables — neither needs to be co-located, restarted together, or aware of each
   other beyond sharing one Supabase project.

## Environment variables

| Variable | Required for | Notes |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Worker + browser | Not secret; same value for both |
| `SUPABASE_SERVICE_ROLE_KEY` | Worker only | Never read by the browser; bypasses RLS — see "Service-role safety" in the Mission 6 doc |
| `WORKER_POLL_INTERVAL_MS` | Worker only, optional | Defaults to `30000`. How often the worker checks for due schedules — not the per-user scan interval, which is `bot_schedules.interval_minutes` |

## Service role requirements

Unchanged from Mission 6's design, now actually exercised: the service role key bypasses Row Level
Security entirely, so every safety property depends on the worker's own code, not the database.
This mission's code honours all of them: `createServerExecutionContext` requires an explicit
`userId` (never optional, never inferred); every persistence call inside it
(`addTradeForUser`/`persistServerDecision`/`addRecordsForUser`) takes that same `userId` and stamps
it on every row it writes; the worker only ever discovers a `userId` by reading `bot_schedules`,
never from any external or user-supplied input; and the worker only ever executes the shared
`executeBotScan()` pipeline, never a parallel or abbreviated version of it.

## Failure handling

- **Per-scan failure** (an error thrown anywhere inside `executeBotScan()` or the persistence calls
  around it): caught in `processSchedule()`, logged as `scan_failed` with the error message, and the
  lock is still released with `status: "Error"` and `last_error` set to that message —
  `next_scan_at` still advances by the normal interval, so a schedule that fails once retries on its
  regular cadence rather than being retried in a tight loop or left stuck.
- **Per-poll failure** (e.g. the initial `fetchDueSchedules` read itself fails): caught in the main
  loop, logged as `poll_failed`, and the worker sleeps and tries again next cycle rather than
  crashing the whole process over one bad poll.
- **Missing configuration** (no service role client can be constructed): logged clearly and the
  process exits with a non-zero code immediately — it does not loop forever failing to connect.
- **Lock contention**: not a failure at all — `lock_skipped` is the expected, safe outcome when
  another process (a second worker instance, or in principle the browser if it's ever wired to use
  the same lock) is already handling that user.

## Verification

`npm run lint` and `npm run build` both pass cleanly. `next build` confirms `src/worker/` is not
reachable from any route's bundle graph — no accidental client exposure of anything worker-related.

**No real Supabase project with a service role key was available in this environment** — the same
standing limitation disclosed in every mission since Mission 5. Two levels of verification were
still possible and both were done:

1. **The worker's actual failure/startup path, for real**: running `npm run worker` with only the
   anon key configured (this session's real `.env.local`) correctly logged `worker_started`, then
   `scan_failed` with a clear "service role key not set" message, and exited — proving the
   `NODE_OPTIONS=--conditions=react-server` and `--env-file-if-exists` fixes actually work (the
   process did not crash on `import "server-only"`, and it did read `.env.local`), and that the
   missing-configuration failure path behaves as documented above.
2. **The worker's core logic, against an in-memory fake Supabase client**: a temporary local
   harness (written, run, and deleted within this session — not part of the shipped code) drove the
   real `fetchDueSchedules`, `claimScheduleLock`/`releaseScheduleLock`, `processSchedule`, and
   `executeBotScan` functions against a duck-typed fake query builder seeded with one overdue
   schedule. Confirmed: (a) the due schedule was found; (b) a second concurrent lock claim for the
   same user, attempted while the first was still held, was correctly rejected (`null`) — direct
   proof of "only one scan may execute for one user at a time"; (c) a full `processSchedule()` run
   executed the real Strategy Engine/Position Manager/Portfolio Risk pipeline, opened a real NVDA
   trade, stored one Decision Intelligence record, and released the lock with `last_status: "Trade
   Opened"` and a correctly-advanced `next_scan_at`; (d) a simulated persistence failure inside the
   scan was still followed by a released lock and `last_status: "Error"` with the failure message
   recorded — the lock is never left stuck.
3. **Browser Bot Runner, unaffected**: in local prototype mode, a manual scan after this mission's
   changes still opened an NVDA trade with full risk-check/Position Manager/portfolio-risk metadata
   and correctly recorded exactly one Decision Intelligence record — identical behaviour to every
   prior mission's verification, confirming this mission added a second caller of the shared
   pipeline without touching the first.
4. **Web app + worker running simultaneously**: started the Next.js dev server and `npm run worker`
   at the same time in this session with no port conflicts, no interference, and no errors in
   either process's logs — satisfying the "developer should be able to run web app + worker
   simultaneously" requirement directly, not just by inspection.

**Not verified**: live concurrency between a real worker process and the real browser (or two real
worker processes) against an actual Postgres row, and live application of migrations `0014`–`0016`
against the connected project (both still blocked on the same missing service-role-key/CLI-access
limitation disclosed since Mission 5). The in-memory harness proves the *code's* locking logic is
correct; it does not prove Postgres's own row-level UPDATE serialisation behaves identically under
real concurrent load, though that behaviour is a well-established, standard Postgres guarantee this
design relies on rather than reimplements.

## Deployment readiness

**Ready to deploy against a real Supabase project**, once migrations `0014`–`0016` are applied and a
service role key is available — the code path has been verified as far as this environment allows
(startup, configuration failure, and full logic-level simulation), and requires no further code
changes to point at a live project; only environment variables change. **Not ready**: nothing in
this mission has been run against a real Postgres instance or a real VPS, so the live behaviour of
lock serialisation under genuine concurrent load, and the actual schema/RLS interaction, remain
unverified in the way Mission 5's live test account verified the browser's own writes.

## What remains before deploying onto a Linux VPS

- Apply migrations `0014` (`bot_schedules`), `0015` (`bot_decisions`, not used by this worker but
  part of the same migration set), and `0016` (`decision_history`) to the connected Supabase
  project, and confirm them using Mission 5's schema-verification technique.
- Obtain and securely store a real `SUPABASE_SERVICE_ROLE_KEY` for the VPS environment (a secrets
  manager or the hosting provider's environment-variable store — never a committed file).
- Choose and configure a process supervisor (systemd unit, pm2 ecosystem file, or a Docker
  container with a restart policy) that launches `npm run worker` (or exactly replicates its
  `NODE_OPTIONS`/`--env-file-if-exists` flags) and restarts it on crash.
- Decide how `bot_schedules` rows actually get created — nothing in the app today writes to this
  table; a user enabling worker-based scheduling needs some UI or admin path to insert/update their
  own row (explicitly out of scope for this mission's "no UI redesign" instruction, but a real gap
  before this is usable end-to-end).
- Live-verify actual concurrent execution: run two worker processes (or a worker and a
  browser-triggered scan) against the same user at the same time on a real project, and confirm the
  lock behaves as the in-memory simulation predicts under genuine Postgres concurrency.
- Decide on log shipping/monitoring for a real deployment (this mission's logging is
  stdout-only, deliberately simple, with no alerting).

## How to run the prototype

```bash
cd Trading/platform/web
npm install
npm run dev      # the browser app
npm run worker   # the background worker, in a second terminal
```

No environment variables are required for local prototype mode. `SUPABASE_SERVICE_ROLE_KEY` is
required only if you want the worker to actually reach a configured Supabase project; without it,
the worker starts, logs a clear configuration error, and exits. `npm run lint` and `npm run build`
both pass cleanly.

## Suggested next mission

Two candidates, both flagged above as genuine gaps this mission surfaced but didn't resolve, since
resolving them wasn't this mission's job: (1) a minimal path for `bot_schedules` rows to actually
get created and enabled — without one, the worker has nothing to ever find, however correctly it's
built; and (2) the standing verification debt, now three migrations deep (`0014`–`0016`), still
blocking any live concurrency or RLS verification against a real project. Independently, outcome
analysis (Win/Loss/Neutral on `decision_history`, flagged since Mission 7) remains unstarted and is
explicitly excluded from this mission's scope.
