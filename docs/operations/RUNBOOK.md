# Operational Runbook

Location: `Trading/platform/web`
Introduced: Build 1.13.0 — see [`docs/product/BUILD-1.13.0.md`](../product/BUILD-1.13.0.md) and
[`docs/operations/DEPLOYMENT.md`](DEPLOYMENT.md) for related context.

General principle throughout this runbook: **never delete or clear persisted state as a first
response.** Every scenario below has a safer diagnostic step before any data-affecting action.

---

## Application will not start

**Symptoms**: `npm start` (or `pm2 start`) exits immediately, or the process is not listening on
its port.

**Likely causes**: a half-configured environment variable pair (see
[DEPLOYMENT.md](DEPLOYMENT.md#environment-configuration)); a build that hasn't been run yet; a port
already in use.

**Checks**:
1. Read the startup error text directly — the config layer throws a specific message naming the
   exact variable pair that's inconsistent (e.g. "NEXT_PUBLIC_SUPABASE_URL is set but
   NEXT_PUBLIC_SUPABASE_ANON_KEY is not").
2. Confirm `.next/` exists (i.e. `npm run build` has actually completed) — `npm start` with no
   build present fails distinctly.
3. `lsof -i :3000` (or your configured port) to check for a conflicting process.

**Safe corrective actions**: fix or unset the named environment variable to make the pair
consistent; run `npm run build` if missing; stop the conflicting process rather than force-killing
anything you don't recognise.

**Escalation**: if the error message doesn't clearly identify a config problem, capture the full
startup log before restarting anything.

**Data-loss considerations**: none — this is a pre-data-access failure.

---

## Build fails

**Symptoms**: `npm run build` exits non-zero.

**Likely causes**: a genuine TypeScript error; a lint-level React rule violation (this codebase
enforces React-Compiler-style rules, e.g. no impure calls during render); a dependency version
mismatch after a partial `npm install`.

**Checks**:
1. Read the build output in full — Next.js reports the exact file and line.
2. Run `npx tsc --noEmit` and `npm run lint` separately to isolate which stage is failing.
3. Confirm `npm install` completed cleanly (check for an `ERESOLVE` or similar error above the
   build output).

**Safe corrective actions**: fix the reported error at its source; re-run `npm install` if
dependencies look inconsistent. Do not skip type-checking or linting to force a build through.

**Escalation**: if the error is inside a dependency rather than this repo's own code, check
whether a recent `package.json` change is the cause before assuming an environment issue.

**Data-loss considerations**: none — a failed build never touches running processes or data.

---

## Health endpoint reports degraded

**Symptoms**: `GET /api/health` returns `"status": "degraded"`.

**Likely causes**: a half-configured environment variable pair was set *after* the process started
(the config layer validates once per process lifetime and caches the result) — this specific
`ConfigError` message is included in the response's `configurationIssue` field.

**Checks**:
1. Read the `configurationIssue` field in the health response directly.
2. Confirm the named variable pair in the running environment (`.env.local` or your process
   manager's env block) — a fix requires a **restart**, since config is validated once at startup,
   not re-read live.

**Safe corrective actions**: fix the named variable pair, then restart the process. Do not restart
speculatively without first reading `configurationIssue` — it tells you exactly what to fix.

**Escalation**: if `configurationIssue` is absent but status is still `"degraded"`, check
`docs/product/BUILD-1.13.0.md`'s health model section for what else could produce that status —
this would indicate the health model has grown a new check not yet reflected in this runbook.

**Data-loss considerations**: none.

---

## Automation stops running

**Symptoms**: no new entries in Bot Decisions / AI Decision History for longer than the configured
interval.

**Likely causes**: **Browser-based** scheduling — the browser tab was closed (this stops it by
design, not a bug). **Server-based** — the worker process has stopped, crashed, or was never
started.

**Checks**:
1. Settings page → check which scheduling system was expected to be running, and its displayed
   status.
2. For browser-based: is the browser/tab actually open? (This is expected behaviour, not a fault.)
3. For server-based: `pm2 status` (or however the worker is supervised) — is
   `trading-intelligence-worker` `online`? Check its logs for the most recent `poll_started` or
   `scan_failed` event.
4. Operations Centre → "Always-On Scanning" panel's "Last scan" timestamp — the clearest evidence
   of whether the worker has actually run recently, since the web app cannot directly detect the
   worker process.

**Safe corrective actions**: restart the worker process if it's not running (`pm2 restart
trading-intelligence-worker`); reopen the browser tab if browser-based scheduling was expected.

**Escalation**: if the worker is `online` per PM2 but its logs show repeated `poll_failed` or
`scan_failed` events, treat as a "Manual scan fails" scenario below — the underlying cause is
likely the same.

**Data-loss considerations**: none — no data is lost by automation simply not running; only new
decisions/scans are delayed.

---

## Manual scan fails

**Symptoms**: clicking "Run scan now" shows an error toast ("The scan couldn't complete. No trade
was placed.").

**Likely causes**: a transient failure inside the Strategy Engine, portfolio risk evaluation, or a
persistence write during the scan — the scan pipeline (`executeBotScan`) is now wrapped so any
failure is caught, logged, and surfaced as a toast rather than an uncaught error (Build 1.13.0).

**Checks**:
1. Check the browser console for the structured log entry (`component: "bot-scan-runner"`,
   includes a safe `errorCode` and `reason`).
2. Retry the scan once — many failures are transient (e.g. a momentary persistence hiccup).
3. Check Operations Centre for any degraded subsystem (Database, Market Data) that could explain it.

**Safe corrective actions**: retry via the same "Run scan now" button. No trade is ever left
partially created — a failed scan produces no trade and no orphaned decision record.

**Escalation**: if scans fail consistently (not just once), capture the logged `reason` field and
treat as a genuine bug report, not an operational hiccup.

**Data-loss considerations**: none — a failed scan opens no trade and writes no decision record.

---

## Persistence writes fail

**Symptoms**: a warning toast appears ("Your changes may not be saved right now...") or ("Your
database is unavailable — trades are being saved to this browser only until you reload.").

**Likely causes**: Supabase is unreachable (network, project paused, RLS misconfigured), or — far
rarer — the browser's own `localStorage` write failed (quota exceeded, storage disabled).

**Checks**:
1. The toast text itself distinguishes the two cases (Supabase fallback vs. a local-storage write
   failure) — read it first.
2. Check Operations Centre → Database panel for connection status.
3. Check browser console for the structured log entry (`errorCode: "PERSISTENCE_ERROR"`) with the
   specific reason.

**Safe corrective actions**: the in-memory state is always preserved regardless of whether the
write succeeded (this build's persistence-diagnostics fixes guarantee this) — the current session
is not broken, but **do not reload the page** until the underlying issue is fixed, or the
unsaved-to-storage state will be lost. Once Supabase connectivity (or local storage availability)
is restored, the next successful write resumes normal saving.

**Escalation**: if this persists across multiple sessions/reloads, treat as a genuine Supabase
outage or project configuration issue, not a one-off.

**Data-loss considerations**: **real** — anything written during the outage window that only made
it to the in-memory state (not actually persisted) will be lost on reload. This is exactly what the
warning toast is for; take it seriously rather than dismissing and reloading immediately.

---

## Browser shows stale data

**Symptoms**: prices, trades, or decisions don't reflect what you expect from another
session/device.

**Likely causes**: this app loads data once per page load, not via real-time sync (a disclosed,
long-standing limitation — see `sprints/sprint-001/SPRINT-001.md`, "What is intentionally not
included yet"); or you're looking at local-browser-only data (Bot Decisions log, browser-scheduling
state) that is never shared across devices by design.

**Checks**:
1. Reload the page — this is often simply "data as of last page load," not a bug.
2. Confirm whether the data in question is local-browser-only by design (Bot Decisions, browser
   scheduler state) versus account-scoped (paper trades, AI Decision History when Supabase is
   configured).

**Safe corrective actions**: reload. Do not clear browser storage as a first response — that
permanently discards local-only data (Bot Decisions history, browser scheduler preferences) that a
simple reload would not have lost.

**Escalation**: if account-scoped data (Supabase-backed) is stale even after reload and a fresh
sign-in, treat as a genuine sync/RLS bug.

**Data-loss considerations**: clearing storage as a "fix" for staleness is itself a data-loss risk —
avoid it.

---

## Worker is unavailable

**Symptoms**: `automation: "unknown"` in the health endpoint (always true — not itself a symptom of
a problem); Operations Centre's "Always-On Scanning" panel shows no recent "Last scan"; PM2 shows
the worker process not `online`.

**Likely causes**: the worker was never started; it crashed; its environment variables are
misconfigured (`SUPABASE_SERVICE_ROLE_KEY` / `NEXT_PUBLIC_SUPABASE_URL`).

**Checks**:
1. `pm2 status` (or your process manager) — is it running at all?
2. `pm2 logs trading-intelligence-worker` — look for the `scan_failed` event logged at startup if
   it exited immediately (this is how a missing service-role key surfaces).
3. Confirm the two required environment variables are present and paired correctly.

**Safe corrective actions**: fix the environment configuration, then `pm2 restart
trading-intelligence-worker` (or start it if it was never running).

**Escalation**: if it starts but immediately exits repeatedly (PM2's `max_restarts: 10` will
eventually give up), capture the exact log output before further changes.

**Data-loss considerations**: none — the worker being down only delays scans, it doesn't corrupt or
lose existing data.

---

## Repeated trade rejection

**Symptoms**: Bot Decisions / AI Decision History shows many consecutive "No Trade" outcomes.

**Likely causes**: this is very often **correct, working behaviour**, not a fault — the Portfolio
Risk Manager and Position Protection layers are designed to reject candidates that don't meet their
thresholds (max open positions, capital deployed, per-sector exposure, confidence/interval
requirements for adding to an existing position). Check the specific rejection reason before
assuming something is broken.

**Checks**:
1. Read the specific rejection reason shown for each candidate (Bot Decisions page shows full
   per-candidate risk-check detail).
2. Confirm current portfolio exposure against the documented limits (Operations Centre → AI Engine
   panel shows the exact configured thresholds).
3. If reasons look wrong (e.g. rejecting despite clearly being under every limit), that's a genuine
   bug, not expected behaviour.

**Safe corrective actions**: none needed if rejections are correctly reflecting configured risk
limits — this is the system working as designed. If genuinely wrong, this is a code-level bug
report, not an operational fix.

**Data-loss considerations**: none.

---

## Unexpected duplicate scans

**Symptoms**: two scans recorded with near-identical timestamps, or the same schedule apparently
processed twice.

**Likely causes**: an advisory-lock race between the worker and a browser-based scheduled scan
happening at nearly the same moment (Mission 6/8's locking mechanism is designed to prevent this,
but has not been verified under genuine concurrent load against real Postgres — a disclosed,
long-standing limitation).

**Checks**:
1. Compare the two scans' `scanId`s and trigger types (Manual/Scheduled) — confirm they're genuinely
   duplicate, not two legitimately different triggers close in time.
2. Check whether both the browser-based scheduler and server-based automation were enabled
   simultaneously for the same account — each is independent and unaware of the other, so both
   firing close together is possible today and not itself a bug, just two systems doing their own
   job.

**Safe corrective actions**: no destructive action needed — a duplicate scan does not duplicate
trades (the max-one-trade-per-scan rule still applies per scan). If it's actually the advisory lock
failing, capture full logs (both worker and browser) rather than guessing.

**Escalation**: report as a concurrency bug if the advisory lock itself appears to have failed (both
processes believed they held the lock) — this is exactly the untested-at-scale scenario the
project's own docs disclose.

**Data-loss considerations**: none directly — worst case is duplicate decision-log entries, not
duplicate trades.

---

## Hydration warning appears

**Symptoms**: React hydration mismatch warning in the browser console.

**Likely causes**: a genuine server/client render mismatch — this codebase has an established
pattern (defer state-setting into a microtask) specifically to avoid this class of bug for every
localStorage-backed context; a new hydration warning suggests either a new code path that doesn't
follow this pattern, or a browser extension modifying the DOM before React hydrates.

**Checks**:
1. Reproduce in a private/incognito window with no extensions — many hydration warnings are
   actually caused by browser extensions injecting content, not application code.
2. If it reproduces cleanly, note which component/page and check whether it reads from
   `localStorage`/`window` without the established deferred-microtask pattern (see
   `bot-decision-log-context.tsx` for the reference implementation).

**Safe corrective actions**: none purely operational — this is a code-level investigation. Reloading
does not fix a genuine hydration bug (it will recur).

**Escalation**: report as a bug with the exact component/page and browser.

**Data-loss considerations**: none.

---

## Local storage becomes corrupted

**Symptoms**: a page shows an empty/default state where data was previously present, with no other
error.

**Likely causes**: malformed JSON in one of the six localStorage keys documented in
[`docs/product/BUILD-1.13.0.md`](../product/BUILD-1.13.0.md#persistence-diagnostics) — every store's
read path already catches this and falls back to an empty/default state rather than crashing, by
design.

**Checks**:
1. Open browser DevTools → Application → Local Storage → confirm which key looks malformed (if you
   have the technical access to do so).
2. Check the browser console for a logged diagnostic event (Build 1.13.0 added logging to every
   previously-silent catch block).

**Safe corrective actions**: **do not manually clear localStorage as a first response** — the
existing fallback (empty/default state) is already the safe behaviour, and the underlying raw data
may still be recoverable/inspectable before being overwritten. If a fix is genuinely needed, editing
or removing only the single affected key (not all of localStorage) is safer than a blanket clear.

**Escalation**: if this recurs for the same user/browser repeatedly, investigate what's writing
malformed JSON in the first place (a genuine bug) rather than repeatedly working around the symptom.

**Data-loss considerations**: **real** — clearing a corrupted key permanently discards whatever
valid data might have been alongside the corruption. Prefer inspecting before clearing.

---

## Rollback is required

See [`docs/operations/DEPLOYMENT.md`](DEPLOYMENT.md#rollback-approach) for the full procedure.
Quick version: identify the last known-good commit, check it out, `npm install`, `npm run build`,
restart via PM2, verify via `/api/health` and a manual pass through the Dashboard.

**Data-loss considerations**: rolling back application code does not roll back database state — a
newer build's data written to Supabase remains after rolling back the code, which can cause a
schema mismatch if the newer build added a migration the older code doesn't expect. Check
`supabase/migrations/` before rolling back across a version boundary that added a migration.
