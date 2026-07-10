# Mission 6 — Server Architecture Preparation

Date: 2026-07-09
Location: `Trading/platform/web`
Related: [`MISSION-5-VERIFICATION-READINESS.md`](./MISSION-5-VERIFICATION-READINESS.md),
[`MISSION-4-SCHEDULED-BOT-SCANS.md`](./MISSION-4-SCHEDULED-BOT-SCANS.md),
[`MISSION-3-POSITION-MANAGER.md`](./MISSION-3-POSITION-MANAGER.md)

## What this mission is, and isn't

This mission prepares the platform's architecture for a future VPS/background-worker scheduling
mission (Mission 7) **without deploying a VPS or running a worker**. No new trading strategies, no
new UI features. Every file this mission adds is either:

1. A refactor of existing browser code to go through a shared abstraction (behaviour-preserving,
   verified manually — see below), or
2. New, dormant, server-only code and database tables that nothing in the running app calls yet.

The existing browser Bot Runner — manual scans, scheduled scans, the full individual/Position
Manager/portfolio risk pipeline — works exactly as it did before this mission. That was a hard
requirement, not a nice-to-have, and it's the thing most at risk from a refactor like this, so it
got the most direct verification (see "Browser compatibility verification" below).

## 1. Architecture review — what's browser-dependent today

Before changing anything, every file in the current bot execution path was re-read in full to
separate "already server-safe" from "genuinely browser-bound":

| Concern | File | Browser-dependent? |
|---|---|---|
| Core risk pipeline | `src/lib/bot/bot-runner.ts` (`runBotScan`) | **No.** Pure async function — takes `(instruments, trades, scanId, triggerType)` as plain parameters, calls only module-singleton business logic (Strategy Engine, Portfolio Risk Manager, Position Manager), and never touches persistence or any browser API. Confirmed by full re-read; needed zero changes. |
| Scan orchestration | `src/components/dashboard/BotRunnerPanel.tsx` (`runScan`) | **Yes**, but only in *what it calls after* `runBotScan()` returns — `addTrade`/`addDecision` from React contexts. This is the orchestration Mission 6 extracted into a shared wrapper (see below). |
| Auth/session access | `src/lib/persistence/supabase-paper-trade-store.ts` (`requireUserId`) | **Yes, fundamentally.** Derives the user id from `this.client.auth.getSession()` — a live browser session. A worker has no browser session to read, so it needs a different, explicit-`userId` code path (not a modification of this one — see below). |
| Scheduler timer | `BotRunnerPanel`'s `setInterval` tick handler | **Yes.** Only advances while the Dashboard tab is mounted (Mission 4's own disclosure). Unchanged this mission — browser scheduling is explicitly still browser-only. |
| Scheduler state | `src/lib/state/bot-scheduler-context.tsx` (`BotSchedulerProvider`) | **Yes**, entirely `localStorage`-backed. Unchanged this mission — a parallel Supabase-backed schedule table now exists (`bot_schedules`) for a future worker, but the browser continues to use its own local state exactly as before. |
| Decision logging | `src/lib/state/bot-decision-log-context.tsx` | **Yes**, entirely `localStorage`-backed, per-browser. A worker has no browser to log into, so a new server-side table (`bot_decisions`) exists for it — see below. |
| Idempotent scan IDs | `src/lib/bot/scan-id.ts` (`reserveScanId`) | **Yes**, and this is a real, currently undocumented gap: it's a purely local `localStorage` counter, unique per browser but **not** globally unique across a browser and a future worker acting on the same user. Documented here, not fixed this mission (see "Known gaps"). |

The headline finding: the hard part (the risk pipeline itself) was already done correctly in
Mission 1 — it never depended on the browser. The work this mission actually needed was building a
parallel, explicit-`userId` I/O path for a worker to plug into the same pipeline, and making sure
the browser and a future worker share one orchestration function rather than two copies that could
drift apart.

## 2. Shared execution abstraction

New: `src/lib/bot/bot-execution-context.ts` — exports `BotExecutionContext` (an interface with
`loadTrades()`, `persistTrade()`, `persistDecision()`) and `executeBotScan()`, which calls
`context.loadTrades()`, runs the unchanged `runBotScan()`, then applies `persistTrade`/
`persistDecision` through the context. This is a client-safe module (no `server-only`, no
service-role imports) — it's the one piece both the browser and a future worker import.

`BotRunnerPanel.tsx`'s `runScan()` was refactored to build a `BotExecutionContext` from the existing
`usePaperTrades()`/`useBotDecisionLog()` hooks and call `executeBotScan()`, instead of calling
`runBotScan()` and then `addTrade`/`addDecision` directly. `loadTrades` reads the same `trades`
array `runBotScan()` used to receive as a direct closure-captured parameter — behaviourally
identical, not a new data path — and `persistTrade`/`persistDecision` wrap the exact same
`addTrade`/`addDecision` calls as before. This was verified live (see below): a manual scan and a
seeded scheduled scan both still open trades and log decisions with the same trace and metadata as
every prior mission.

A parallel implementation, `src/lib/bot/server-execution-context.ts` (marked `import "server-only"`
— see below), provides `createServerExecutionContext(client, userId)` returning a
`BotExecutionContext` backed by a service-role Supabase client and an explicit `userId`, for a
future worker to pass to the exact same `executeBotScan()`. Nothing in the running app calls this
yet.

**Important barrel-export detail**: `src/lib/bot/index.ts` exports `executeBotScan`/
`BotExecutionContext` (client-safe) but deliberately does **not** re-export
`server-execution-context.ts`. That file (and everything it imports) carries `import "server-only"`
— if the barrel re-exported it, any client component importing `@/lib/bot` (which is most of the
Dashboard) would transitively pull in server-only code and fail the build. Server-only modules are
only ever imported directly by their own path, never through the shared barrel.

## 3. Scheduler persistence design

Two new, dormant Supabase tables (migrations `0014` and `0015`), neither read nor written by the
browser app:

**`bot_schedules`** (one row per user, `unique(user_id)`): `user_id`, `enabled`, `interval_minutes`
(15/30/60, default 30), `next_scan_at`, `last_scan_at`, `last_status`
(`'Trade Opened' | 'No Trade' | 'Error'`), `last_error`, `locked_at`, `locked_by`, `created_at`,
`updated_at`. RLS: `auth.uid() = user_id` for select/insert/update (no delete policy — schedules
are disabled, not deleted). Deliberately simpler than the browser's local `SchedulerMode` enum
(`Manual`/`Every15`/`Every30`/`Every60`) — a disabled row (`enabled = false`) doesn't need a
meaningful interval, so there's no "manual" case to model, just a boolean gate plus an interval.

**`bot_decisions`** (append-only): `user_id`, `scan_id`, `trigger_type`, `action_taken`, `reason`,
`decision` (the **full** `BotDecision` object — candidates, trace, portfolio snapshot — as one
`jsonb` column), `created_paper_trade_id`, `created_at`. RLS: select/insert only, no update/delete —
same append-only pattern as `trade_events`. Storing the whole decision as `jsonb` rather than
modelling it relationally mirrors exactly what's already serialized to `localStorage` today, and
follows the precedent `paper_trades.portfolio_exposure_snapshot` already set in Mission 2 for
nested, decision-time data.

Both tables exist independently of the browser's local scheduler/decision-log state — this mission
does not migrate or replace either. A future Mission 7 UI could in principle merge local + server
history, but nothing reads `bot_decisions` or `bot_schedules` today.

## 4. Concurrency protection

**The race this guards against**: if a worker and the browser (or two future worker instances) ever
ran a scan for the same user at the same time, each would read the same snapshot of open trades,
each could independently pass Position Manager and portfolio risk checks, and both could open a
trade — silently exceeding the portfolio risk limits the whole pipeline exists to enforce. This is a
genuine time-of-check-to-time-of-use (TOCTOU) race, not a hypothetical.

**Why not a database uniqueness constraint on open trades** (the naive fix): Mission 3's
`ADD_TO_POSITION` feature deliberately allows multiple same-side open positions in the same
instrument under the right conditions (confidence improved, enough time elapsed, value under the
cap). A DB-level "no duplicate open trade" constraint would silently break that legitimate feature.
The actual business rule — whether a new trade is allowed given existing positions — is correctly
and only enforceable by the Position Manager's nuanced logic, not a blunt constraint.

**The actual fix**: a per-user advisory lock, implemented in
`src/lib/scheduler/server-schedule-store.ts` as a conditional `UPDATE` against
`bot_schedules.locked_at`/`locked_by`:

```sql
update bot_schedules
set locked_at = now(), locked_by = $worker_id
where user_id = $1
  and (locked_at is null or locked_at < now() - interval '5 minutes')
returning *
```

Zero rows returned means another process currently holds a live lock — the caller skips this scan
cycle rather than proceeding. Because this is a single conditional `UPDATE`, not a read-then-write,
two concurrent callers can't both "see" the row as claimable and both proceed: Postgres serialises
the two `UPDATE`s and only one can match the `WHERE` clause first. A lock older than five minutes is
treated as abandoned (a worker that died mid-scan can't block the schedule forever) and becomes
reclaimable. `releaseScheduleLock` is scoped to `locked_by = workerId`, so a worker can never release
a lock it doesn't actually hold — important if its own lock already expired and something else
claimed it in the meantime.

This is implemented and ready to use, but **not called by anything yet** — no worker exists to call
it. It's exercised only by type-checking and the build, not live (there's no second process to race
against in this environment).

**Known gap, documented rather than fixed this mission**: `reserveScanId()`
(`src/lib/bot/scan-id.ts`) is a `localStorage` counter, unique per browser only. A worker acting on
the same user as an open browser tab could reserve a colliding `SCAN-NNNNNN` id. Fixing this
properly needs a server-side id source (a Postgres sequence, or switching to a UUID-based scheme)
— flagged here for Mission 7, not addressed now, since nothing calls the server-side path yet and
inventing a fix without a worker to validate it against would be speculative.

## 5. Service-role safety

The service role key bypasses Row Level Security entirely — that is what it's for, and it's also
exactly why a worker using it is not automatically protected the way the browser is by the
`auth.uid() = user_id` policies. All safety has to come from disciplined application code:

- **Never expose the key to the browser.** `SUPABASE_SERVICE_ROLE_KEY` is deliberately not
  `NEXT_PUBLIC_`-prefixed (see `.env.example`) — Next.js only inlines `NEXT_PUBLIC_`-prefixed vars
  into the client bundle, so this one is server-only by naming convention alone. On top of that,
  every file that reads it (`src/lib/supabase/service-role-client.ts`) starts with
  `import "server-only"` — the official Next.js package that makes "don't import this into a client
  component" a **build-time error**, not just a code-review convention, if any client component ever
  pulls it in, even transitively through another import.
- **The worker must enforce ownership in code.** Every server-side read/write function
  (`loadTradesForUser`, `addTradeForUser`, `persistServerDecision`, `claimScheduleLock`) takes
  `userId` as an explicit, required parameter — there is no version of any of these functions that
  operates without one, and none of them derive it from anything the caller doesn't explicitly pass
  in.
- **Worker writes must always include `user_id`.** `addTradeForUser` stamps `user_id: userId` on
  every insert, the same way `SupabasePaperTradeStore.addTrade` stamps it from the session today —
  the only difference is where the id comes from (an explicit parameter vs. a derived session).
- **The worker must not bypass business rules.** A future worker must call `executeBotScan()` — the
  same shared wrapper the browser uses — never `runBotScan()` plus its own ad hoc persistence. This
  is enforced by convention/code-review today (there's no technical barrier stopping someone writing
  a worker that ignores this), which is a real limitation to flag honestly, not something this
  mission's file structure alone can guarantee.
- **A worker should derive which users to scan from `bot_schedules` rows** (`enabled = true`, due by
  `next_scan_at`), not from any external or user-supplied input, once one exists.

## 6. Browser compatibility

The existing browser Bot Runner needed to keep working exactly as before — manual scans and browser
scheduled scans. Verified manually in local prototype mode (`.env.local` moved aside, matching the
approach used in every prior mission):

- **Manual scan**: clicked "Run Bot Scan" on a clean load. Open trades went from 0 → 1; Bot Decisions
  logged `SCAN-000003 · Manual`, `Trade Opened`, full candidate evaluation and trace, correctly
  routed through the new `executeBotScan()` wrapper.
- **Scheduled scan**: set mode to "Every 15 minutes," clicked "Start schedule" (through the real UI,
  not simulated), then seeded `nextScanAt` in `localStorage` to one minute in the past and reloaded
  (the same seeded-overdue-time technique Mission 4 used to verify this originally, since waiting 15
  real minutes isn't practical). The next 10-second poll fired within seconds: `lastScanAt` and
  `nextScanAt` both advanced, and Bot Decisions logged `SCAN-000004 · Scheduled`, `Trade Opened`,
  with the same full trace and metadata as the manual scan.
- Both scans opened real trades and logged full decisions identically to pre-refactor behaviour —
  the `executeBotScan()` refactor is behaviour-preserving, not just type-checking clean.
- Reset the scheduler to Manual/Stopped and restored `.env.local` afterwards; confirmed it still
  gates behind sign-in with no console errors (no regression from this mission's changes).

Not re-verified against a live authenticated Supabase session this mission — the test account
credentials confirmed in Mission 5 (`bot-test@andrewwalkers.com`) aren't available in this session's
context, and this mission's changes don't touch `SupabasePaperTradeStore`, `AuthGate`, or RLS at all
(only additive, unused server-only modules and two new dormant tables), so local-mode verification
plus the build/lint pass is the appropriate level of confidence here.

## Files changed

New (client-safe, used by the browser today):
- `src/lib/bot/bot-execution-context.ts` — `BotExecutionContext`, `executeBotScan()`

New (server-only, `import "server-only"`, not called by the running app):
- `src/lib/supabase/service-role-client.ts` — `getServiceRoleClient()`
- `src/lib/persistence/server-paper-trade-store.ts` — `loadTradesForUser()`, `addTradeForUser()`
- `src/lib/scheduler/server-bot-decision-store.ts` — `persistServerDecision()`
- `src/lib/scheduler/server-schedule-store.ts` — `claimScheduleLock()`, `releaseScheduleLock()`,
  `ScheduleRow`
- `src/lib/bot/server-execution-context.ts` — `createServerExecutionContext()`

New migrations:
- `supabase/migrations/0014_bot_schedules.sql`
- `supabase/migrations/0015_bot_decisions.sql`

Changed:
- `src/lib/persistence/supabase-paper-trade-store.ts` — exported `PaperTradeRow`,
  `TradeIntelligenceRow`, `toDbTrade`, `fromDbTrade` (previously module-private) so the server store
  can reuse the exact same row mapping instead of risking drift with a second hand-written copy
- `src/lib/bot/index.ts` — barrel-exports `executeBotScan`/`BotExecutionContext` (client-safe only —
  server-only modules deliberately not re-exported here)
- `src/components/dashboard/BotRunnerPanel.tsx` — `runScan()` now calls `executeBotScan()` with a
  browser-backed context instead of calling `runBotScan()` and persisting directly
- `.env.example` — documents the new, optional, server-only `SUPABASE_SERVICE_ROLE_KEY`
- `README.md`, `src/components/layout/Footer.tsx`, `src/components/layout/Sidebar.tsx` — build label
  bumped to "Mission 6"; new "Server architecture preparation" section in `README.md`

## Database changes applied

Two new migrations added (`0014_bot_schedules.sql`, `0015_bot_decisions.sql`) — not yet applied to
the connected Supabase project by this session (anon-key-only access, same standing limitation as
every prior mission; the user applies migrations directly). Neither table is required for the
existing app to keep working — both are additive and dormant.

## Build/lint result

`npm run lint` and `npm run build` both pass cleanly. The production build's success is itself a
partial proof of the `server-only` guard working correctly in the intended direction: none of the
new server-only modules are reachable from the client bundle graph (if one were accidentally
imported from a client component, the build would fail with a `server-only` error rather than
silently succeeding).

No local test suite exists to run (confirmed already in Mission 5 — `package.json` has no `test`
script).

## Known gaps and risks (carried forward honestly, not fixed this mission)

1. **`reserveScanId()` is not globally unique** across a browser and a future worker acting on the
   same user — see "Concurrency protection" above. Needs a server-side id source before a worker
   goes live.
2. **Nothing technically prevents a future worker from bypassing `executeBotScan()`** and writing
   trades directly through `server-paper-trade-store.ts` — the safety is a code convention, not an
   enforced boundary. Worth a code-review checklist item for Mission 7, not solvable by file
   structure alone.
3. **The concurrency lock is unexercised against a real second process** — implemented and
   type-checked, but there's no live worker to race against in this environment, so the exact
   Postgres-level serialisation behaviour under real concurrent load hasn't been observed, only
   reasoned about from the conditional-`UPDATE` semantics.
4. **`bot_schedules`/`bot_decisions` RLS protects a future browser-direct-access path, not the
   worker** — a service-role client bypasses RLS entirely regardless of these policies; they exist
   in case the browser is ever given direct read access to its own schedule/decision rows, not as a
   defence against the worker itself.
5. **Migrations 0014/0015 have not been applied to the connected Supabase project** — same
   anon-key-only limitation disclosed in every prior mission.

## What remains for Mission 7

- Actually deploy a worker (VPS, scheduled serverless function, or queue-driven job) that calls
  `createServerExecutionContext()` + `executeBotScan()`, wrapped with
  `claimScheduleLock()`/`releaseScheduleLock()`.
- Apply migrations `0014` and `0015` to the connected Supabase project (or confirm they're applied,
  using the same schema-verification technique from Mission 5).
- Solve the scan-id uniqueness gap (a DB sequence or UUID-based scheme) before both a worker and a
  browser can safely reserve scan ids for the same user.
- Decide how the worker discovers which users/schedules to act on (poll `bot_schedules` where
  `enabled = true` and `next_scan_at` is due) and how it updates `next_scan_at` after each run
  (`releaseScheduleLock`'s `nextScanAt` parameter is ready for this).
- Decide whether the browser's local scheduler and the server-side `bot_schedules` row should ever
  be reconciled/merged into one source of truth, or remain deliberately separate (browser = quick
  local toggle, server = the "real" always-on schedule) — an open product decision, not an
  architecture question.
- Extend the Bot Decisions UI to optionally show worker-triggered decisions from `bot_decisions`
  alongside the local browser log, if that's desired.

## Readiness verdict

**Ready** for a future worker to be built against: the shared execution wrapper, server-only
persistence, dormant schema, and concurrency-lock primitive are all in place, type-checked, and
build clean. **Not ready, and not a goal of this mission**: no worker is deployed, the concurrency
lock is unexercised against real concurrency, and the scan-id uniqueness gap remains open. The
existing browser Bot Runner is **confirmed unaffected** — manual and scheduled scans both verified
working identically through the new shared wrapper.

## How to run the prototype

```bash
cd Trading/platform/web
npm install
npm run dev
```

No environment variables are required for local prototype mode. `SUPABASE_SERVICE_ROLE_KEY` is
optional and only relevant to a future worker — the app runs identically with or without it set.
`npm run lint` and `npm run build` both pass cleanly.

## Suggested next mission

Mission 7: build and deploy the actual background worker described in "What remains for Mission 7"
above. The verification debt flagged in Mission 5 (confirming migrations 0008–0015 are applied
against the live project) remains a prerequisite, now extended to cover `0014`/`0015` specifically,
since a worker can't write real rows to tables that don't exist yet on the connected project.
