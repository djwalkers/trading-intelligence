# Mission 4 — Scheduled Bot Scans v1

Date: 2026-07-09
Location: `Trading/platform/web`
Related: [`MISSION-3-POSITION-MANAGER.md`](./MISSION-3-POSITION-MANAGER.md),
[`MISSION-2-PORTFOLIO-RISK-MANAGER.md`](./MISSION-2-PORTFOLIO-RISK-MANAGER.md)

## What was built

The Bot Runner can now run on a schedule — Every 15 / 30 / 60 minutes — instead of only when a
human clicks "Run Bot Scan," while keeping manual control and every existing safety rule intact.
**Still no live trading, no broker API, no AI, no Hermes — paper trading only.**

- **Scheduling modes**: Manual only (the default), Every 15 minutes, Every 30 minutes, Every 60
  minutes.
- **Dashboard controls**: a mode selector, Start schedule / Stop schedule buttons, and live Next
  scan time / Last scan time / schedule status (Stopped/Running) — all on the existing Bot Runner
  panel, alongside the unchanged "Run Bot Scan" manual button.
- **Every scheduled scan runs through the exact same three-tier pipeline** as a manual one —
  individual risk (Mission 1/1.1), the Position Manager (Mission 3), and portfolio risk
  (Mission 2) — with no shortcuts and no weakened rules. `runBotScan()` itself doesn't know or care
  whether it was triggered by a click or a timer.
- **Safety rules enforced**: never more than one trade per scan (unchanged, structural); the
  schedule stops itself if the user is signed out or their session expires; the schedule stops
  itself if persistence falls back away from Supabase.
- **Bot Decisions** now records a `triggerType` ("Manual" or "Scheduled") on every scan, shown on
  the Dashboard panel and the Bot Decisions page.
- **System Health** gained: Scheduler (Manual/Running/Stopped), Current interval, Last scheduled
  scan, Next scheduled scan — readable from any page, since the underlying schedule state is
  shared, not local to the Dashboard component.

## Architecture: this is browser-based scheduling, not a background worker

**Read this section before assuming the schedule "just runs."** There is no server, no cron job,
and no process running independently of the browser tab. The mechanism is:

1. `BotSchedulerProvider` (`src/lib/state/bot-scheduler-context.tsx`) holds the schedule's
   *state* — mode, status, next/last scan time, stop reason — in a React context, persisted to
   `localStorage` so it survives a page reload.
2. The Dashboard's `BotRunnerPanel` component owns the *ticking* — a `setInterval` that polls every
   10 seconds, checking "is it time yet?" against the shared state, and calls `runBotScan()` when it
   is.

**The consequence: the schedule only advances while the Dashboard tab is open.** Close the tab,
navigate to another page within the app, or close the browser, and the countdown simply stops
progressing — nothing crashes, but no scans run either. Reopen the Dashboard later and, if the
scheduled time has already passed, the very next poll (within 10 seconds) runs the "overdue" scan
immediately rather than silently skipping it — but if you were away for two scheduled intervals,
only that one catch-up scan runs, not two. This was directly observed during verification: seeding
an overdue `nextScanAt` and reloading the Dashboard caused a scan to fire within the first poll.

**System Health can still show the schedule's last-known state from any page** (mode, status,
last/next scan time) because that state lives in the shared context, not inside `BotRunnerPanel`
itself — but it cannot make the schedule advance from a page other than the Dashboard, since only
`BotRunnerPanel` runs the interval.

**What true 24/7 scheduling would need, and doesn't have yet:** a process that keeps running when
no browser tab is open at all — a VPS or a background worker (e.g., a scheduled serverless
function, a small always-on Node process, or a queue-driven job) that calls the same
`runBotScan()` logic independently of any user's browser session. This is explicitly a future
mission, not attempted here, per the instruction not to add server-side scheduling or a VPS yet.

## Design decisions

**Why the tick handler polls every 10 seconds rather than using a precise 15/30/60-minute
`setTimeout`:** a `setTimeout` scheduled for e.g. 15 minutes would need to be recreated correctly
across every mode change, page reload, or component remount, and a suspended/backgrounded browser
tab can throttle or delay timers unpredictably regardless of the approach. A short, cheap poll
against a stored target timestamp is simpler, self-correcting after any interruption (a reload
always re-checks "is `nextScanAt` in the past?"), and trivially handles the mode changing mid-wait.

**Why the schedule state lives in a shared `BotSchedulerProvider`, not local `BotRunnerPanel`
state:** System Health needs to display the current schedule status from a page where
`BotRunnerPanel` isn't mounted. A plain `useState` inside `BotRunnerPanel` would reset every time
the Dashboard unmounts, which would make "Stopped" the only status System Health could ever
honestly report from elsewhere — following the same shared-context pattern already established for
the bot decision log (Mission 1).

**Why the interval callback reads from a ref, not directly from React state:** the interval is set
up once, for the component's lifetime (an empty dependency array), so it can't close over
fresh values from a later render. Every value it needs — scheduler state, auth state, persistence
status, the scan-running function — is captured in a `useRef` that's kept current via a plain
effect (`useEffect(() => { ref.current = {...} })`, which runs after every render). This avoids
tearing the interval down and recreating it on every render, which would risk a missed or doubled
tick right at a poll boundary.

**Why "signed out" and "persistence failure" are treated as two separate safety checks, not one:**
they have different scopes and different signal sources. "Signed out" is checked against
`useAuth()`'s live session state directly — the primary defence is actually structural: `AuthGate`
already redirects a signed-out user away from every page (including the Dashboard) when Supabase is
configured, so a user without a session can't even reach the scheduler UI to start it in the first
place. The scheduler's own check is a narrower safety net for the case a session *expires* while a
schedule is already running and the tab stays open. "Persistence failure" is checked against
`usePersistenceStatus()`'s `fallbackReason` — set once, the first time `ResilientPaperTradeStore`
falls back from Supabase to local storage (Build 0.9.0) — so a schedule stops rather than silently
keep writing paper trades to a different store than the user configured.

**Why `recordScan` updates `lastScanAt`/`nextScanAt` for every scan, but System Health's "Last
scheduled scan" filters to `triggerType === "Scheduled"` specifically:** the Dashboard's own "Last
scan" label is intentionally generic (any trigger) since it's right next to the manual button and
the schedule controls together — a manual click naturally counts as "the last time a scan ran."
System Health's row is explicitly named "Last scheduled scan," so it reads the decision log
filtered to scheduled-triggered decisions only, avoiding a misleading report if the most recent
scan happened to be a manual one.

## Safety rules confirmed

| Rule | How it's enforced |
|------|--------------------|
| Respects all existing individual, Position Manager, and portfolio risk rules | `runScan()` calls the same `runBotScan()` regardless of trigger type — no separate scheduled code path exists |
| Never more than one trade per scan | Unchanged, structural — the candidate loop `break`s the instant one passes (Mission 1.1) |
| Does not run while signed out | Structurally: `AuthGate` blocks the whole Dashboard when Supabase is configured and there's no session. Additionally: the tick handler checks `useAuth()` before every scheduled run and stops the schedule if signed out |
| Stops automatically if persistence fails | The tick handler checks `usePersistenceStatus().fallbackReason` before every scheduled run and stops the schedule if Supabase has fallen back to local storage |

## Files changed

New:
- `src/lib/state/bot-scheduler-context.tsx` — `BotSchedulerProvider`, `useBotScheduler()`,
  `SchedulerMode`, `SchedulerStatus`, `SCHEDULE_INTERVAL_MINUTES`

Changed:
- `src/lib/bot/types.ts` — new `ScanTriggerType` ("Manual" | "Scheduled"); `BotDecision` gains
  `triggerType`
- `src/lib/bot/bot-runner.ts` — `runBotScan()` takes a `triggerType` parameter, threaded into
  every returned `BotDecision`
- `src/lib/bot/index.ts` — barrel-exports `ScanTriggerType`
- `src/app/layout.tsx` — wraps the app in `BotSchedulerProvider`
- `src/components/dashboard/BotRunnerPanel.tsx` — scheduling mode selector, Start/Stop buttons,
  next/last scan time, schedule status, the ref-based tick handler and its safety checks
- `src/components/bot/BotDecisionsView.tsx` — shows trigger type per scan
- `src/components/system-health/BotRunnerStatusPanel.tsx` — four new Scheduler rows
- `src/lib/state/bot-decision-log-context.tsx` — storage key bumped to `v5`
- `src/components/layout/Sidebar.tsx`, `Footer.tsx`, `src/app/system-health/page.tsx` — build
  label bumped to "Mission 4"

No database migration this mission — per the explicit instruction, scheduler state stays
local-only (`localStorage`, via `BotSchedulerProvider`) rather than being added to Supabase or any
new server-side store.

## Test scenarios verified

**Verified in local prototype mode:**

- **Manual scan still works** — clicking "Run Bot Scan" opened a trade exactly as in every prior
  mission, correctly logged with `triggerType: "Manual"`.
- **Default is Manual only** — on a clean load, mode was "Manual only", status "Stopped", and
  "Start schedule" was correctly disabled (there's nothing to start with no interval selected).
- **Scheduled scan starts** — selecting "Every 15 minutes" and clicking "Start schedule" correctly
  set status to "Running", "Current interval: 15 minutes", and a "Next scan" time exactly 15
  minutes ahead.
- **Scheduled scans create Bot Decisions and can open paper trades** — seeding an overdue
  `nextScanAt` and reloading (to simulate time passing without waiting 15 real minutes) caused the
  poll to fire within 10 seconds: a second scan ran, correctly logged as `SCAN-000002 · Scheduled`,
  and opened a TSLA trade.
- **Risk rules still block trades correctly on a scheduled scan** — in that same scheduled scan,
  NVDA (already an open position from the earlier manual scan) was correctly rejected by the
  Position Manager as `HOLD_POSITION` ("not enough new evidence to add yet"), and the bot correctly
  fell back to TSLA — proving the Position Manager (and, by the same code path, portfolio risk) is
  fully active for scheduled runs, not bypassed.
- **Scheduled scan stops** — clicking "Stop schedule" correctly set status to "Stopped" and cleared
  the next-scan time.
- **System Health correctly reflects schedule state** — Scheduler: Stopped, Current interval: 15
  minutes, Last scheduled scan: `SCAN-000002` (correctly filtered to the scheduled-triggered
  decision, distinct from the earlier manual one), Next scheduled scan: — (correctly empty while
  stopped).
- **Signed-out users cannot run scheduled scans** — verified structurally: with Supabase
  configured, reloading the app while signed out correctly redirected to `/sign-in` before the
  Dashboard (and therefore the scheduler UI) ever rendered, with no console errors. The additional
  in-tick auth check (for a session that expires mid-session while a schedule is already running)
  could not be exercised live, for the same reason disclosed in every prior build/mission: no
  confirmable Supabase test account was available in this environment.
- Existing Signal-sourced and Market-Intelligence-sourced trades were both placed successfully in
  the same session with no regressions — all four trades (2 Bot, 1 Signal, 1 Market Intelligence)
  coexisted correctly in Trade Journal.
- `npm run lint` and `npm run build` both pass cleanly (one lint error was found and fixed during
  development: mutating a `useRef`'s `.current` directly during render is flagged by this
  project's React Compiler-style lint rules — fixed by moving the assignment into a plain
  `useEffect` with no dependency array, which runs after every render).
- Restoring `.env.local` and reloading in Supabase-configured mode still correctly gates behind
  sign-in with no console errors — no regression from this mission's changes.

**Not verified against a real authenticated Supabase session:** as with every prior mission, no
confirmable test account was available, so the persistence-failure auto-stop and the
session-expiry auto-stop could not be exercised against a live, authenticated session — only their
code paths and the structural `AuthGate` protection were confirmed.

## What is needed for VPS scheduling

This mission deliberately stops short of real 24/7 scheduling. To get there, a later mission would
need:

- **A long-running process independent of any browser tab** — a small VPS-hosted Node service, a
  serverless scheduled function (e.g. a cron-triggered edge function), or a queue worker — that can
  call the same `runBotScan()` logic (or an equivalent server-side port of it) on its own clock.
- **Server-side credentials to write trades** — today the app only ever uses the Supabase anon key
  from the browser, authenticated as the signed-in user. A background worker acting "on behalf of"
  a user needs its own auth story (a service role key scoped carefully, or a per-user API
  token/refresh token flow) — this is a real security design decision, not just a wiring change.
  Anon-key-from-a-server would either be unable to write (blocked by the same RLS policies that
  protect users today) or would need those policies loosened, which shouldn't be done casually.
  This is why we haven't proposed one automatically.
- **A persisted, server-visible schedule configuration** — today's `localStorage`-only schedule
  state is invisible to any process outside the browser; a VPS-based scheduler would need this
  moved into Supabase (a new table, or reusing an existing one) so the server-side worker and the
  browser UI agree on what's configured.
- **Idempotency and failure handling for unattended runs** — a scan that fails partway (e.g., a
  transient market data or persistence error) currently just surfaces to a human watching the
  Dashboard; a background worker needs retry/backoff and alerting instead of a human noticing.

None of this exists yet, by design — Mission 4 proves the scheduling *logic and safety rules*
work correctly; a VPS/background-worker mission would replace *where* the ticking happens, not
change the risk/position/portfolio logic itself.

## How to run the prototype

```bash
cd Trading/platform/web
npm install
npm run dev
```

No environment variables are required. `npm run lint` and `npm run build` both pass cleanly.

## Suggested next mission

VPS/background-worker scheduling (see above) is the obvious next step this mission's own
disclosure points to, but the verification debt — now seven migrations deep (`0008`–`0013`) plus
confirming a real test account — remains the standing top priority independent of any new mission,
since it's needed before any server-side worker could write trades as a real user in the first
place. Beyond that: a richer mock instrument/sector universe (flagged by both Mission 2 and Mission
3) would let scheduled-scan scenarios be observed over several real ticks rather than simulated via
seeded state.
