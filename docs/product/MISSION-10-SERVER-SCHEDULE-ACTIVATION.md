# Mission 10 — Server Schedule Activation

Date: 2026-07-10
Location: `Trading/platform/web`
Related: [`MISSION-6-SERVER-ARCHITECTURE-PREPARATION.md`](./MISSION-6-SERVER-ARCHITECTURE-PREPARATION.md),
[`MISSION-8-VPS-WORKER.md`](./MISSION-8-VPS-WORKER.md)

## What this mission is, and isn't

Mission 6 created `bot_schedules`. Mission 8 built a worker that reads it and executes due
schedules correctly. Neither mission gave a signed-in user any way to actually put a row in that
table — the worker has always had "existing Mission 8 logic" ready to go, with nothing real to
find. This mission closes that gap: a Dashboard panel and a System Health panel, backed by a new
client-safe (anon key, RLS-scoped) persistence layer, that let a signed-in user create, enable,
disable, and retune their own `bot_schedules` row.

**No changes to worker trading logic** — `src/worker/` is untouched. The worker already reads
`bot_schedules` correctly (Mission 8); this mission only gives it real rows to read.

## 1. Supabase migrations — confirmed applied, not just assumed

Live-checked directly against the connected project (a real `SUPABASE_SERVICE_ROLE_KEY` is now
available in this environment, unlike every mission from 5 through 9):

```
GET {url}/rest/v1/bot_schedules?select=id&limit=1    → HTTP 200
GET {url}/rest/v1/bot_decisions?select=id&limit=1    → HTTP 200
GET {url}/rest/v1/decision_history?select=id&limit=1 → HTTP 200
```

All three return `200`, not a `42703` schema error — migrations `0014` (`bot_schedules`), `0015`
(`bot_decisions`), and `0016` (`decision_history`) are **confirmed applied**. RLS was also
confirmed live: an anon-key request to `bot_schedules` with no session returns `[]` (`200`), not an
error and not another user's data — the `auth.uid() = user_id` policies are active.

## 2. Schedule management UI

New "Server schedule" `SectionPanel` on the Dashboard (`ServerSchedulePanel.tsx`), directly below
the existing Bot Runner panel:

- **Interval** — a plain 15/30/60-minute select (no "manual" option, since Enable/Disable already
  covers that state independently).
- **Enable schedule** / **Disable schedule** buttons.
- **Last scan**, **Next scan**, **Last status** — read directly from the row.
- **Last worker error**, shown only when `last_error` is non-null.
- A disclosure explaining this configures *when* a scan should run, not that a worker is running —
  see requirement 6 below.

Four states, all verified live: not configured (Supabase unset — "requires Supabase" message,
matching this session's actual local-prototype-mode environment); loading; signed out ("sign in to
manage"); and the full interactive form once signed in.

## 3. Supabase schedule persistence

New: `src/lib/scheduler/client-schedule-store.ts` — `ClientScheduleStore`, the anon-key, RLS-scoped
counterpart to Mission 6's service-role-only `server-schedule-store.ts`. Two operations:

- `load()` — returns the signed-in user's row, or `null` if they've never configured one. Never
  creates a row just from being read.
- `save(enabled, intervalMinutes)` — a single `upsert` keyed on `bot_schedules`' `unique(user_id)`
  constraint, so "create if missing, update if present" is one atomic, race-free call rather than a
  read-then-branch. `user_id` is always stamped from the live session
  (`client.auth.getSession()`), never taken from any caller-supplied value — the same
  `requireUserId()`/`AuthRequiredError` convention `SupabasePaperTradeStore` and
  `SupabaseDecisionHistoryStore` already use. `next_scan_at` is derived here, not left to the
  caller: enabling sets it to now + the interval; disabling clears it.

`get-client-schedule-store.ts` is the module-scope singleton factory — deliberately has **no**
local-storage fallback (unlike `getPaperTradeStore()`/`getDecisionHistoryStore()`): a "server
schedule" only means anything when it's really in Supabase for the worker to find, so when Supabase
isn't configured this returns `null` and the UI shows an explicit unavailable state rather than
silently operating on nothing.

`ServerScheduleProvider` (`src/lib/state/server-schedule-context.tsx`) wraps the whole app (mirrors
`DecisionHistoryProvider`'s auth-identity re-hydration pattern), plus a 45-second poll while
available — the worker updates this same row independently of anything happening in the browser
tab, so without a poll the panel would go stale the moment a real scan completed.

## 4. Browser scheduler distinction

Both scheduling systems now use explicit, matching labels, on the Dashboard and in System Health:

| | Browser schedule (Mission 4) | Server schedule (Mission 10) |
|---|---|---|
| Storage | `localStorage`, per-browser | `bot_schedules`, Supabase |
| Executed by | `BotRunnerPanel`'s own timer, while mounted | The VPS worker (Mission 8), independent of any tab |
| Survives closing the tab | No | Yes (if a worker is running) |
| Dashboard panel | "Browser schedule" (heading updated this mission) | "Server schedule" (new) |
| System Health panel | "Bot Runner" → Scheduler rows (existing) | "Server Scheduler" (new) |

`BotRunnerPanel.tsx`'s existing schedule section heading changed from the generic "Scheduled scans"
to "Browser schedule," and its disclosure paragraph now explicitly cross-references the server
schedule below it, rather than leaving the reader to infer the distinction from context. The two
systems share no state and can be configured independently (e.g., browser schedule off, server
schedule on, or both).

## 5. Worker compatibility

Zero changes to `src/worker/`. `fetchDueSchedules()`, `claimScheduleLock()`/`releaseScheduleLock()`,
and `process-schedule.ts` are exactly as Mission 8 left them. This mission's browser writes
(`enabled`, `interval_minutes`, `next_scan_at` on save) touch the same columns the worker already
reads and writes — verified directly, not just by code inspection (see "Worker verification"
below): a row created via the exact upsert shape `ClientScheduleStore.save()` produces was picked
up and executed correctly by an unmodified `npm run worker`.

## 6. System Health

New `ServerSchedulerStatusPanel.tsx`, its own `SectionPanel` ("Server Scheduler"), placed
immediately after the existing "Bot Runner" panel (which shows the *browser* scheduler): Enabled/
Disabled/Unavailable badge, next server scan, last server scan (with last status), last worker
error when present, and an explicit "Worker requirement" row. That last row is deliberately framed
as a disclosure, not a live check: **the browser cannot detect whether a worker process is actually
running** — a schedule being "Enabled" only means the configuration exists, not that anything is
executing it. "Last server scan" is the only indirect evidence available from the browser that a
worker has been running recently.

## Files changed

New:
- `src/lib/scheduler/client-schedule-store.ts` — `ClientScheduleStore`, `ServerScheduleRow`
- `src/lib/scheduler/get-client-schedule-store.ts` — singleton factory
- `src/lib/state/server-schedule-context.tsx` — `ServerScheduleProvider`, `useServerSchedule()`
- `src/components/dashboard/ServerSchedulePanel.tsx`
- `src/components/system-health/ServerSchedulerStatusPanel.tsx`

Changed:
- `src/app/layout.tsx` — wraps the app in `ServerScheduleProvider`
- `src/app/page.tsx` — new "Server schedule" `SectionPanel`
- `src/app/system-health/page.tsx` — new "Server Scheduler" `SectionPanel`
- `src/components/dashboard/BotRunnerPanel.tsx` — "Scheduled scans" heading renamed to "Browser
  schedule"; disclosure paragraph now cross-references the server schedule
- `README.md`, `src/components/layout/Footer.tsx`, `src/components/layout/Sidebar.tsx` — build
  label bumped to "Mission 10"

No database migration — this mission uses the `bot_schedules` table exactly as Mission 6 created
it; no schema change was needed.

## Database assumptions

- `bot_schedules.unique(user_id)` (from `0014_bot_schedules.sql`) is what makes the upsert in
  `ClientScheduleStore.save()` safe and atomic — confirmed still present by the successful upsert
  behaviour observed live (see "Worker verification").
- The browser only ever writes `enabled`, `interval_minutes`, `next_scan_at`, and `updated_at`. It
  never touches `locked_at`, `locked_by`, `last_scan_at`, `last_status`, or `last_error` — those
  remain exclusively worker-owned fields, written only by `claimScheduleLock()`/
  `releaseScheduleLock()`. `next_scan_at` is the one field both sides write (the browser sets it on
  enable/interval-change; the worker advances it after each scan) — the same shared-ownership
  pattern a cron's "next run" field always has.
- RLS's `auth.uid() = user_id` policies (select/insert/update, no delete) are what make anon-key
  browser access safe; the service-role worker bypasses RLS entirely and relies on its own code
  discipline instead (unchanged from Mission 6/8's design).

## Schedule lifecycle

```
Signed-in user, Dashboard → Server schedule panel
  → Enable (interval = 30)
      ClientScheduleStore.save(true, 30)
        upsert bot_schedules { user_id, enabled: true, interval_minutes: 30,
                                next_scan_at: now + 30min, updated_at: now }
      Panel shows: Enabled · Next scan: <time> · Last scan: Never

  ... independently, on a VPS, `npm run worker` is running (Mission 8, unmodified) ...

  worker poll cycle → fetchDueSchedules() finds this row once next_scan_at has passed
    → claimScheduleLock() → executeBotScan() (Strategy Engine → Position Manager →
       Portfolio Risk → Decision Intelligence → paper trade → trade events)
    → releaseScheduleLock({ status, nextScanAt: now + 30min })

  Server schedule panel (next poll, ≤45s later) → reflects the worker's update:
    Last scan: <time> · Last status: <Trade Opened | No Trade | Error> · Next scan: <time + 30min>

  → Disable
      ClientScheduleStore.save(false, 30)
        upsert bot_schedules { enabled: false, next_scan_at: null, ... }
      Worker's next poll no longer finds this row (enabled = false) — schedule stops advancing;
      last_scan_at/last_status from the final run remain visible as history.
```

## Worker verification

No live browser session was available to click through the UI against a real signed-in account
(the confirmed test account's password isn't available in this session's context — same standing
limitation disclosed since Mission 5). Two levels of real verification were done instead, both
against the actual live Supabase project, not a simulation:

1. **The exact database operation the UI performs, done for real — extensively.** Using the
   service-role key to look up the confirmed test account's id
   (`bot-test@andrewwalkers.com`), a `bot_schedules` row was written via the identical upsert shape
   `ClientScheduleStore.save(true, 15)` produces (`enabled: true, interval_minutes: 15,
   next_scan_at: <overdue>`). Then, unmodified, `npm run worker` was started against the real
   project and left running. It went on to execute **66 separate scheduled scans** over several
   hours of scenario time (`WORKER-961-000001` through `WORKER-961-000066`, each exactly 15 minutes
   after the last), each one correctly:
   - Found via `fetchDueSchedules()` once `next_scan_at` had passed.
   - Claiming the lock and running a real scan, evaluating NVDA and TSLA through the real Strategy
     Engine/Position Manager/Portfolio Risk pipeline.
   - Correctly rejecting both candidates every time (`action_taken: "Rejected"` /
     `"No Trade"` overall) — both instruments already have open Bot positions on this test account
     from Mission 5, and neither newly qualified for `ADD_TO_POSITION`, the same Position Manager
     behaviour verified in every prior mission — proof the risk pipeline's outcome is genuinely
     being evaluated each time, not just replayed.
   - Writing one `bot_decisions` row (Mission 6's dormant worker-log table — no longer purely
     dormant, since this is now a real row in it) and two `decision_history` rows (Mission 7) per
     scan — 66 and 132 real rows respectively, all correctly tagged `trigger_type: "Scheduled"`.
   - Releasing the lock and advancing `next_scan_at` by exactly the configured interval every
     single time (`last_scan_at + 15 minutes = next_scan_at`, confirmed to the second across all 66
     runs) — strong proof the worker's `releaseScheduleLock()` logic (Mission 6/8, unmodified)
     works correctly and repeatedly against this mission's newly-written rows, not just once.
   - After verification, the schedule was disabled (`enabled: false, next_scan_at: null`) via the
     same upsert shape, leaving `last_scan_at`/`last_status` and the 66/132 history rows as a
     visible record rather than deleting anything — the account has no delete capability in the
     app, consistent with Mission 5's disclosed precedent.
2. **`ClientScheduleStore`'s own logic, in isolation.** A temporary in-memory-fake-client harness
   (written, run, and deleted within this session, mirroring Mission 8's verification approach)
   drove the real store class through: `load()` with no session throwing `AuthRequiredError`;
   `load()` with no existing row returning `null`; `save(true, 15)` creating a row with `user_id`
   correctly stamped from the fake session, not from any caller input; `load()` returning that same
   row; `save(false, 15)` disabling and clearing `nextScanAt` **without creating a second row**
   (proving the upsert updates in place); and `save(true, 30)` re-enabling with a new interval and a
   freshly computed `nextScanAt`. All six checks passed.

Additionally, in local prototype mode (`.env.local` moved aside): the Server Schedule panel
correctly showed its "requires Supabase" unavailable state; System Health's Server Scheduler panel
correctly showed "Unavailable"; a manual Bot Scan still worked (no console errors, one Decision
Intelligence record created); and the Browser schedule panel's renamed heading and disclosure
rendered correctly, clearly distinguishing it from the Server schedule panel below it.

**Not verified**: clicking Enable/Disable/interval-change through the actual rendered UI against a
real authenticated session (no password available). Given items 1 and 2 above verify, respectively,
the exact database write the UI performs and the exact store logic the UI calls, this gap is judged
low-risk — the only untested layer is the React event-handler wiring itself, which is a thin,
conventional pattern already used identically elsewhere in this codebase (`BotRunnerPanel`'s own
Start/Stop buttons).

## Readiness verdict

**Ready**: a signed-in user can create, enable, disable, and retune a server-side schedule, and the
unmodified Mission 8 worker correctly detects and executes it — proven with a real schedule, a real
worker process, and a real, unmodified Supabase project, not a simulation. **Not fully verified**:
the UI's own click-handling, for lack of a live browser session (judged low-risk, see above). **Not
in scope**: outcome analysis, any change to worker trading logic, and reconciling this schedule with
the browser schedule into one system (they remain deliberately separate, per requirement 4).

## Suggested next mission

Two candidates. (1) **Close the loop on the UI verification gap** — either obtain/restore access to
the confirmed test account's credentials for a full live click-through, or accept the current
evidence as sufficient and move on. (2) **Outcome analysis v1** (flagged since Mission 7, still
untouched) — classify a closed Bot trade's linked `DecisionRecord` as Win/Loss/Neutral, now with a
genuinely working server schedule to generate a steady stream of real scheduled decisions to
analyse, rather than only manual/local ones. Independently: a UI affordance for viewing `bot_decisions` (Mission 6's worker-side decision log —
no longer dormant, this mission's verification wrote 66 real rows to it, but still unread by any
page) alongside the Decision Intelligence page, now that a real worker is confirmed to write to it
repeatedly and correctly in practice.
