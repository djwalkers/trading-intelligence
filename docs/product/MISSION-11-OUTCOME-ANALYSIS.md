# Mission 11 — Outcome Analysis v1

Date: 2026-07-10
Location: `Trading/platform/web`
Related: [`MISSION-7-DECISION-INTELLIGENCE.md`](./MISSION-7-DECISION-INTELLIGENCE.md),
[`MISSION-8-VPS-WORKER.md`](./MISSION-8-VPS-WORKER.md),
[`MISSION-10-SERVER-SCHEDULE-ACTIVATION.md`](./MISSION-10-SERVER-SCHEDULE-ACTIVATION.md)

## What this mission is, and isn't

Mission 7 gave every candidate a bot scan evaluates a permanent `DecisionRecord`, but every one of
them carries `outcome: "Pending"` forever — Mission 7 recorded evidence, it never judged it. This
mission closes that gap for the one case that's currently answerable: when an accepted decision's
linked paper trade closes, classify it as **Win**, **Loss**, or **Neutral** based on realised P/L,
and write that classification back onto the `decision_history` row. **Rejected decisions are still
never classified** — there's no trade to measure, and the mission's own instruction is explicit
that inferring an outcome for a rejected candidate is future work, not this mission's.

No new strategies, no Hermes/LLM integration, no broker integration, no UI redesign, no new
scheduling architecture, no VPS changes. The worker's trading logic is untouched; this mission adds
one more step to its existing poll cycle.

## 1. Outcome model

`src/lib/decision-intelligence/outcome-analysis.ts` — one shared constant,
`NEUTRAL_PNL_THRESHOLD_GBP = 0.01`, used by the single `classifyOutcome()` function every other
part of this mission calls through:

- **Win** — realised P/L `>` £0.01
- **Loss** — realised P/L `<` −£0.01
- **Neutral** — realised P/L within ±£0.01 inclusive (covers exactly-zero and near-zero closes)
- **Pending** — the trade is still open, has no linked trade, or the record isn't an accepted
  decision in the first place (default state, never explicitly set by this mission's code)

The threshold exists so a fractional-pence rounding artefact from price data never gets reported as
a "win" or "loss" — a real, if small, distinction from treating every non-zero number as decisive.

## 2. Outcome analysis service

`computeOutcomeUpdate(trade, record)` is the single pure function every other path in this mission
calls — the browser's automatic reconciliation and the worker's batch reconciliation both go
through it, so the two can never disagree about what a closed trade's outcome should be. It returns
`null` (no update) unless **all** of the following hold:

- `record.actionTaken === "Trade Opened"` (a Rejected record is never classified)
- `record.outcome === "Pending"` (a record already classified is never reclassified — this single
  guard is what makes the whole system idempotent, see "Data integrity" below)
- `record.createdTradeId === trade.id` (the trade passed in is genuinely the one this record opened)
- `trade.status === "Closed"` and it carries `realisedPnl`/`realisedPnlPercent`/`closedAt`

When it does produce an update, it also computes `holdingDurationMinutes` (opened timestamp to
`closedAt`, rounded to the nearest minute, floored at zero) and stamps `outcomeRecordedAt` with the
current time. `findReconcilableOutcomes(trades, records)` runs this over every record/trade pair in
one pass — the function both the browser effect and the worker call. `applyOutcomeUpdate(s)` folds
a batch of updates into an in-memory record array, used for optimistic local state before the
persisted write resolves.

## 3. Automatic update on trade close

`DecisionHistoryProvider` (`src/lib/state/decision-history-context.tsx`) already sits inside
`PaperTradesProvider` in `layout.tsx`'s provider tree, so it can call `usePaperTrades()` directly. A
new effect watches the `trades` array: whenever it changes (a trade opens or closes, anywhere in
the app), it runs `findReconcilableOutcomes()` against the current trade list and decision records.
If anything comes back, the local record state is updated optimistically (deferred into a microtask
via `Promise.resolve().then()` — the same pattern `bot-decision-log-context.tsx` already uses,
required because React's `set-state-in-effect` lint rule flags a synchronous `setState` call inside
an effect body) and the store's `updateOutcomes()` is called to persist it, with a `console.error`
on failure. **The trade-close action itself never fails or blocks on this** — `closeTrade()`
(`paper-trades-context.tsx`) is untouched; this effect only runs after it has already completed.

## 4. Worker reconciliation

`reconcileOutcomesForUser()` (`src/lib/decision-intelligence/reconcile-outcomes.ts`, server-only)
loads a user's trades and decision records via the service-role client and calls the same
`findReconcilableOutcomes()`. `reconcileAllUsers()` (`src/worker/reconcile-all-users.ts`) enumerates
every user known via `bot_schedules` (the only enumeration mechanism the worker has) and reconciles
each one, logging `outcomes_reconciled` when something changes and `reconcile_failed` (without
throwing) if one user's reconciliation errors — one user's failure never stops the rest. No second
permanent process was added: `src/worker/run-worker.ts`'s `pollOnce()` now calls
`reconcileAllUsers(client)` unconditionally at the end of every cycle, after schedule processing,
whether or not any schedule was due.

**Scope note**: a purely browser-only user (never configured a server schedule) is reconciled by
their own browser's effect instead — they're invisible to `reconcileAllUsers()`'s enumeration, since
`bot_schedules` is the only list of users the worker knows about. This mirrors the same scope
boundary the worker has always had for schedules themselves.

## 5. Database — migration 0017

`supabase/migrations/0017_decision_outcomes.sql` adds five nullable columns to `decision_history`:
`realised_pnl`, `realised_pnl_percent`, `holding_duration_minutes`, `closed_at`,
`outcome_recorded_at` — plus a partial unique index on `created_trade_id` (`where created_trade_id
is not null`) enforcing "one decision links to at most one trade" at the database level, not just in
application code. All-additive, all-nullable — no backfill, no default change, fully backward
compatible with every row Mission 7 already wrote.

**Confirmed NOT yet applied to the live Supabase project** — an explicit `select=realised_pnl`
against the live `decision_history` table returns `HTTP 42703` ("column does not exist"). As with
every migration since Mission 5, this environment has no direct Postgres/SQL execution access (no
`DATABASE_URL`/`SUPABASE_DB_PASSWORD`), only the service-role REST API — migrations can be written
and verified-as-not-yet-applied, never self-applied. **Action required**: run `0017_decision_outcomes.sql`
via the Supabase SQL Editor before this mission's outcome classification can write real values to
the live table.

## 6. Decision Intelligence page

`DecisionIntelligenceView.tsx` gained, without any redesign of the page's existing table/filter
layout:

- A new **Outcome** filter (`All`/`Pending`/`Win`/`Loss`/`Neutral`), positioned between Action and
  Confidence. Selecting anything but `All` implicitly restricts to `actionTaken === "Trade Opened"`
  rows — a Rejected record can never be surfaced by an outcome filter, by construction, not by a
  separate check that could drift out of sync.
- An `OutcomeBadge` component: a Rejected row always shows plain **"N/A"** text, never a `Pending`
  badge — the two states look and read differently on purpose, so a reader never mistakes "no
  outcome applies" for "an outcome is coming." An accepted row shows a coloured badge (Win = teal,
  Loss = red, Neutral = blue, Pending = grey).
- Three new table columns: **Realised P/L**, **Realised P/L %**, **Holding duration** (formatted as
  `45m` / `3h 15m` / `2d 4h`), each showing `—` when the field is `undefined` (open trades, rejected
  candidates, or anything not yet classified).
- A new **Outcome summary** panel (`OutcomeSummaryPanel.tsx`), inserted directly under the page's
  existing accepted/rejected counts — see below.

## 7. Outcome summary

Deliberately a rollup, not a dashboard: no charts, no equity curve. Counts **accepted decisions**
only (Rejected candidates are excluded from every figure here, since this panel is about what
happened to trades that were actually placed): accepted total, closed outcomes, pending outcomes,
realised P/L (signed, summed), wins, losses, neutral, and a win rate computed as `Wins ÷ (Wins +
Losses)` — Neutral and Pending are excluded from that denominator on purpose, so a string of
still-open trades can't dilute the rate towards a falsely reassuring number. A fixed disclosure
line accompanies the numbers: *"This is a small paper-trading sample, not proof of strategy
profitability."*

## 8. Data integrity

- **One decision → at most one trade**: enforced at the database level by the new partial unique
  index on `created_trade_id` (migration 0017), in addition to `computeOutcomeUpdate()`'s own
  `record.createdTradeId === trade.id` check.
- **Idempotent by construction, not by a separate flag**: `computeOutcomeUpdate()`'s own `if
  (record.outcome !== "Pending") return null` guard means every re-run of reconciliation — the
  browser effect re-firing, the worker's next poll cycle, both running the same day — is a no-op for
  anything already classified. Verified directly: a repeated `findReconcilableOutcomes()` pass after
  applying the first batch of updates finds nothing left to do (pure-function test 8, below).
- **Closed trades cannot remain Pending after successful reconciliation** — any closed trade with a
  linked, still-Pending, accepted decision record is exactly what `findReconcilableOutcomes()`
  surfaces; the only way a closed trade's decision stays Pending is if reconciliation hasn't run yet
  for that user (browser effect not yet fired, or worker's user enumeration doesn't include them —
  see the worker scope note above) or if migration 0017 isn't applied yet (see below).
- **Open trades cannot be marked Win/Loss/Neutral** — `computeOutcomeUpdate()` requires
  `trade.status === "Closed"` before it produces anything; an open trade always returns `null`
  (pure-function test 5).
- **Rejected decisions never get misclassified** — `actionTaken !== "Trade Opened"` is checked
  first, before anything else, and short-circuits to `null` even when a plausible-looking trade
  exists (pure-function test 6).
- **Known legacy rows that cannot be linked**: any `decision_history` row from before migration
  0017 is applied has no way to receive an outcome update until the migration lands (the columns
  simply don't exist to write to yet) — not a data-loss risk, since `outcome` stays `"Pending"`
  exactly as it already was, but disclosed here as the reason "Pending" counts won't drop to zero
  the instant this mission's code ships.

## Tests performed

**Pure-function verification** (temporary harness, `scripts/verify-outcome-analysis.ts`, written,
run, and deleted within this session per its own header comment) — 11 scenarios, all passed:

1. A winning trade classifies as Win, with correct holding duration and realised P/L copy-through
2. A losing trade classifies as Loss
3. Near-zero P/L (£0.005, inside the ±£0.01 band) classifies as Neutral
4. Exactly-zero P/L classifies as Neutral
5. An open trade never gets classified — produces no update, stays Pending
6. A Rejected decision is never classified, even paired with a plausible closed-and-profitable trade
7. An already-classified (non-Pending) record is never reclassified, even when the trade's numbers
   would imply a different outcome — proves the idempotency guard, not just "usually correct"
8. `findReconcilableOutcomes` run twice in sequence (apply, then re-run) finds nothing left to do
   the second time
9. A decision with no `createdTradeId` (never opened a trade) is skipped safely, no crash
10. A legacy/orphaned `createdTradeId` with no matching trade is skipped safely, no crash
11. A trade/record pair with mismatched ids is correctly rejected

**Live verification against the real, connected Supabase project** (service-role key, present in
`.env.local` since Mission 8):

- Confirmed migration 0017 is **not yet applied** (`42703` on an explicit `realised_pnl` select).
- Tested `select=*` against the live (unmigrated) `decision_history` table and found it silently
  **omits** missing columns from the response rather than erroring — this differs from naming a
  missing column explicitly, which does error. This is what exposed a real bug: the original
  `fromDbDecisionRecord()` used `row.realised_pnl === null ? undefined : toNumber(...)`, which does
  not catch `undefined` (an absent key), so it would have fallen through to `toNumber(undefined)` =
  `NaN` the moment this code ran against the live project, before the migration lands. **Fixed** by
  switching to loose `== null` equality (catches both `null` and `undefined`) for both `realised_pnl`
  and `realised_pnl_percent` in `supabase-decision-history-store.ts`.
- Re-ran `npm run lint` / `npm run build` / `npx tsc --noEmit` after the fix — all clean.
- Started the real worker (`npm run worker`) briefly against the live project: one full
  `poll_started` → `no_schedules_due` → reconciliation cycle completed with no errors logged, clean
  `worker_finished` shutdown on SIGTERM.
- Verified RLS remains fully effective via direct anon-key `curl` calls: an unauthenticated read of
  `decision_history` returns `[]` (not an error, not leaked data); an unauthenticated `PATCH` on a
  known row returns `[]` (zero rows affected — the `UPDATE` policy's `USING` clause still blocks it).
- Verified the Mission 10 `bot_schedules` test row is byte-for-byte unchanged from where Mission 10
  left it (`enabled: false`, same `last_scan_at`/`last_status`/`updated_at`) — server schedules are
  unaffected by this mission.

**Local prototype mode** (`.env.local` moved aside, dev server started fresh): server-rendered
`/decision-intelligence` returned `HTTP 200` with no server-side errors. The rendered HTML confirms,
without any records present: the new **Outcome summary** panel renders correctly with all-zero
counts and a `—` win rate; the new **Outcome** filter `<select>` renders with exactly the five
expected options (All/Pending/Win/Loss/Neutral); the existing empty-state message ("No decision
records yet...") still renders correctly, meaning the new table columns don't break the
zero-records case.

**Not verified this mission**: an interactive browser click-through (running a live Bot Scan,
closing a winning/losing/near-zero trade through the UI, and watching the Outcome badge, new P/L/
duration columns, and summary panel update live). Neither of this session's two browser-automation
mechanisms was available — the sandboxed dev-server preview tool returned "no such tool available,"
and the Claude-in-Chrome extension reported "not connected" on repeated attempts. What was verified
instead, and is judged to substantially cover the same ground: the 11-scenario pure-function suite
covers every classification and idempotency rule the UI depends on; the SSR/HTML checks above
confirm the new components render correctly with real (if empty) application state, not mock data;
and the automatic-reconciliation *effect* wiring (`decision-history-context.tsx`) is a thin,
conventional `useEffect` following the same pattern already exercised in this codebase (the
hydration effect it sits beside). The one thing genuinely untested is the live rendering of a
non-empty Win/Loss/Neutral badge and the summary panel's non-zero arithmetic in an actual browser —
low risk, since both are pure presentational reads of the same `DecisionRecord` fields the
pure-function suite already exercises directly.

**No new Supabase rows were created for this mission's testing** — all live checks were read-only
except one RLS-verification `PATCH` attempt via the anon key (correctly affected zero rows) and the
worker's own reconciliation pass (found nothing to update, since existing `decision_history` rows
are either Rejected or blocked by the not-yet-applied migration).

## Files changed

New:
- `src/lib/decision-intelligence/outcome-analysis.ts` — `NEUTRAL_PNL_THRESHOLD_GBP`,
  `computeOutcomeUpdate`, `findReconcilableOutcomes`, `applyOutcomeUpdate`, `applyOutcomeUpdates`
- `src/lib/decision-intelligence/reconcile-outcomes.ts` (server-only) — `reconcileOutcomesForUser`
- `src/worker/reconcile-all-users.ts` (server-only) — `reconcileAllUsers`
- `src/components/decision-intelligence/OutcomeSummaryPanel.tsx`
- `supabase/migrations/0017_decision_outcomes.sql`

Changed:
- `src/lib/decision-intelligence/types.ts` — `DecisionRecord` gained 5 optional fields
- `src/lib/decision-intelligence/decision-history-store.ts` — interface gained `updateOutcomes()`
- `src/lib/decision-intelligence/local-storage-decision-history-store.ts`,
  `supabase-decision-history-store.ts`, `resilient-decision-history-store.ts`,
  `server-decision-history-store.ts` — `updateOutcomes()` implementations; the Supabase store's
  `fromDbDecisionRecord()` fixed to use loose `== null` checks (see "Tests performed" above)
- `src/lib/decision-intelligence/index.ts` — barrel export additions
- `src/lib/state/decision-history-context.tsx` — automatic reconciliation effect
- `src/worker/logger.ts` — `outcomes_reconciled`/`reconcile_failed` log event types
- `src/worker/run-worker.ts` — `pollOnce()` calls `reconcileAllUsers()` every cycle
- `src/components/decision-intelligence/DecisionIntelligenceView.tsx` — Outcome filter, `OutcomeBadge`,
  3 new columns, `OutcomeSummaryPanel` wired in, updated `InfoNote` copy
- `src/components/layout/Footer.tsx`, `src/components/layout/Sidebar.tsx`,
  `src/app/system-health/page.tsx` — build label bumped to "Mission 11"

## Migration created

`supabase/migrations/0017_decision_outcomes.sql` — see "Database" above. **Not yet applied to the
live project; must be run manually via the Supabase SQL Editor.**

## Outcome rules

| Realised P/L | Outcome |
|---|---|
| `> £0.01` | Win |
| `< -£0.01` | Loss |
| `-£0.01` to `£0.01` inclusive | Neutral |
| Trade still open, no linked trade, or not an accepted decision | Pending (never explicitly set — the default) |

Rejected decisions are never classified under any circumstance — they show `"N/A"` in the UI, not a
`Pending` badge.

## Reconciliation architecture

```
                    findReconcilableOutcomes(trades, records)
                          (outcome-analysis.ts — the one shared function)
                         /                                          \
        Browser: DecisionHistoryProvider                    Worker: reconcileAllUsers()
        effect watches usePaperTrades().trades               (run-worker.ts pollOnce(),
        → runs on every trade-list change                     every cycle, for every user
        → optimistic local update (deferred                   known via bot_schedules)
          via microtask) + store.updateOutcomes()             → reconcileOutcomesForUser()
                                                                 per user, errors isolated
```

Both paths call the identical pure function, so "classified the instant you close a trade" (browser)
and "classified on the next worker poll" (worker, for users whose browser tab isn't open) can never
produce a different answer for the same trade.

## Data integrity findings

See "Data integrity" above. Summary: one decision → one trade is enforced at the database level
(partial unique index); idempotency is structural, not flag-based; open trades and Rejected records
are both provably unreachable by the classification path; the only currently-unlinkable rows are
pre-migration-0017 legacy rows, which correctly remain Pending rather than being incorrectly
guessed at.

## Build/lint/typecheck result

`npm run lint`, `npm run build`, and `npx tsc --noEmit -p tsconfig.json` all completed with zero
errors and zero warnings, after the `fromDbDecisionRecord()` fix described above.

## Readiness verdict

**Ready, with one manual step outstanding**: the outcome classification logic, its automatic
browser trigger, and its worker-side reconciliation are all built, tested at the pure-function
level, and confirmed not to disturb any existing system (schedules, RLS, worker startup, manual Bot
Scan). **Migration 0017 must be applied to the live Supabase project via the SQL Editor before any
real Win/Loss/Neutral value can be written there** — until then, the code runs safely (guarded by
the `== null` fix) but every reconciliation pass finds nothing to persist. **Not verified**: a live,
interactive browser click-through, for lack of an available browser-automation tool this session
(judged low-risk — see "Tests performed" for what was verified instead, and why it's judged to cover
the same ground).

## Suggested next mission

With migration 0017 applied, the natural next step is to actually observe the full loop end-to-end
against the live project: run a real scheduled or manual scan, let a trade close, and confirm a real
Win/Loss/Neutral lands in `decision_history` — the one proof this mission couldn't complete without
the migration being live. Independently, two longer-standing candidates remain open: a live
concurrency test against real Postgres (two workers or a worker + browser racing the same user's
schedule, flagged since Mission 10), and wiring the Dashboard/Market Intelligence/Watchlist display
pages to Mission 9's historical-data path (currently only the Bot Runner uses it).
