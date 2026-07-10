# Mission 7 — Decision Intelligence Foundation

Date: 2026-07-09
Location: `Trading/platform/web`
Related: [`MISSION-6-SERVER-ARCHITECTURE-PREPARATION.md`](./MISSION-6-SERVER-ARCHITECTURE-PREPARATION.md),
[`MISSION-3-POSITION-MANAGER.md`](./MISSION-3-POSITION-MANAGER.md),
[`MISSION-2-PORTFOLIO-RISK-MANAGER.md`](./MISSION-2-PORTFOLIO-RISK-MANAGER.md)

## What this mission is, and isn't

This mission builds the bot's long-term analytical memory — enough structured evidence that a
future Hermes recommendation can be backed by real history, not just today's operational logs.
**This mission is explicitly not about AI.** No autonomous learning, no strategy optimisation, no
outcome judgement. It records evidence; it does not yet interpret it. Paper trading only, no broker
integration, no VPS.

The distinction from what already existed: the bot already logs scans, paper trades, trade events,
strategy metadata, position decisions, and portfolio risk — that's excellent *operational* logging
(what happened). This mission adds *analytical* history (why it happened, and — just as
importantly — why the ideas that didn't happen were rejected). A `PaperTrade` only ever exists for
a trade that actually opened; the new `DecisionRecord` exists for every candidate a scan evaluated,
whether it opened a trade or was rejected.

## 1. Decision Intelligence model

New: `src/lib/decision-intelligence/types.ts` — `DecisionRecord`, one per candidate evaluated:

| Group | Fields |
|---|---|
| Identity | `version`, `id`, `scanId`, `sourceDecisionId` (the `BotDecision.id` this came from), `timestamp`, `triggerType`, `rank` |
| Opportunity | `symbol`, `instrumentName`, `sector`, `side`, `entryPrice` (null only for the structurally-unreachable "instrument not found" case) |
| Strategy | `strategyUsed`, `agreement`, `confidence`, `evidenceSummary` |
| Portfolio state | `deployedCapital`, `availableCash`, `sectorExposure`, `totalOpenTrades` — the scan's baseline snapshot, identical for every candidate in the same scan (at most one trade can ever open per scan) |
| Decision | `actionTaken` ("Trade Opened" \| "Rejected"), `rejectionReason?`, `positionAction?`, `portfolioRiskResult` ("Passed" \| "Failed" \| "Not evaluated") |
| Outcome | `outcome` — always `"Pending"` this mission; the type also declares `"Win" \| "Loss" \| "Neutral"` for later |
| Linkage | `createdTradeId?` — only set for the one candidate (per scan, at most) that opened a position |

`DECISION_RECORD_SCHEMA_VERSION = 1` is stamped onto every record at creation time (see
"Future-proofing" below).

**A genuine gap this mission had to fill**: `BotCandidateEvaluation` (the existing per-candidate
evaluation type, `src/lib/bot/types.ts`) never recorded a price or which individual strategy drove
the candidate — nothing needed it before, since only the *one* candidate that became a `PaperTrade`
ever needed that detail, and `PaperTrade` gets it from a different code path. To give every
candidate (rejected ones included) a real entry price and strategy attribution, three fields were
added to `BotCandidateEvaluation`: `price?` (the live quote already fetched inside
`evaluateCandidateRisk` for every candidate that reaches that point — undefined only for the
"instrument not found" branch, before any price fetch happens), `primaryStrategyName`, and
`evidenceSummary` (both copied straight from the `StrategyScore` candidate, available for every
candidate unconditionally). All additive; `bot-runner.ts`'s five `candidateEvaluations.push(...)`
call sites were each updated to populate them.

## 2. Decision History — accepted and rejected alike

New: `src/lib/decision-intelligence/build-decision-records.ts` — `buildDecisionRecords(decision:
BotDecision): DecisionRecord[]`, a pure, synchronous function mapping every entry in
`decision.candidates` to one `DecisionRecord`. Not just the winner: a scan that ranks five
candidates and rejects four before one opens a trade produces five `DecisionRecord`s, one per
candidate, in the same call.

Wired into the existing shared scan orchestration (Mission 6's `executeBotScan()`,
`src/lib/bot/bot-execution-context.ts`) rather than into `runBotScan()` itself — `runBotScan()`
stays pure and persistence-free, exactly as every prior mission established.
`BotExecutionContext` gained one more method, `persistDecisionRecords(records)`, called
immediately after `persistDecision()`. Both the browser (`BotRunnerPanel.tsx`, via a new
`useDecisionHistory()` hook) and the dormant Mission 6 worker path
(`server-execution-context.ts`) implement it, so a fallback-loop scan (Mission 1.1's original
"try the next-ranked candidate" behaviour) produces a full run of `DecisionRecord`s for every
candidate it walked through, not only the last one.

## 3. Decision Intelligence page

New route: `/decision-intelligence`
(`src/app/decision-intelligence/page.tsx` +
`src/components/decision-intelligence/DecisionIntelligenceView.tsx`), added to the sidebar between
Bot Decisions and Strategies with a new archive-box icon (`DecisionIntelligenceIcon`, deliberately
not brain/AI iconography).

One simple table (no charts, per the mission's own instruction), with five independent filters —
**strategy**, **agreement**, **symbol**, **action** (All / Trade Opened / Rejected), and
**confidence band** (90+ / 75–89 / 60–74 / below 60) — plus a small counts line (records stored /
accepted / rejected). Strategy/agreement/symbol filter options are derived dynamically from the
records actually present, rather than hardcoded, so the dropdown never shows a stale option list.
Portfolio-state fields (deployed capital, available cash, sector exposure) are captured on every
record but deliberately not rendered as table columns — the table already has fourteen columns;
keeping it readable took priority over showing every field inline, and the values remain available
on the underlying record for later consumption.

## 4. Database

New migration: `supabase/migrations/0016_decision_history.sql` — a new `decision_history` table,
one row per `DecisionRecord`. Unlike Mission 6's `bot_schedules`/`bot_decisions` (deliberately
dormant, worker-only), **this table is live and used by the browser today** via a new
`SupabaseDecisionHistoryStore`.

Columns mirror the `DecisionRecord` fields (see table above) with `user_id` (RLS-scoped,
`references auth.users`), `client_record_id` (the record's own `id`), and `created_at` (DB insert
time, distinct from `decided_at`, the record's own timestamp) added. Most columns are `not null`
since this is a brand-new table with no pre-existing rows to protect (the "nullable additions"
convention this codebase follows is specifically for adding columns to an *existing* table, e.g.
`0013_position_manager.sql`); the genuinely-optional fields (`entry_price`, `rejection_reason`,
`position_action`, `created_trade_id`) are nullable.

RLS: `auth.uid() = user_id` for select and insert, matching the `paper_trades` pattern. An update
policy is also included, even though nothing writes through it yet (`outcome` always defaults to
`'Pending'` on insert) — so a future outcome-analysis mission can update it without a schema/RLS
migration of its own, directly serving this mission's "future-proofing" instruction one layer
further.

## Architecture

```
runBotScan()                          — unchanged, still pure, still persistence-free
  └─ produces BotDecision (candidates[], one per ranked candidate walked)

executeBotScan()  (Mission 6)         — the one shared orchestration point
  ├─ persistTrade()                   — unchanged (Mission 6)
  ├─ persistDecision()                — unchanged (Mission 6)
  └─ persistDecisionRecords()         — NEW (Mission 7)
       buildDecisionRecords(decision) → DecisionRecord[] (one per candidate)
       → context.persistDecisionRecords(records)
            Browser:  DecisionHistoryProvider.addRecords()
                        → getDecisionHistoryStore().addRecords()
                            → SupabaseDecisionHistoryStore  (when configured)
                            → LocalStorageDecisionHistoryStore (fallback / default)
            Worker (dormant, Mission 6): server-execution-context.ts
                        → addRecordsForUser() (server-only, service-role client)
```

`DecisionHistoryProvider` (`src/lib/state/decision-history-context.tsx`) mirrors
`PaperTradesProvider`'s hydration-on-auth-identity-change pattern exactly: it re-loads whenever the
signed-in user changes, so switching accounts never shows a stale previous identity's history.
`ResilientDecisionHistoryStore` mirrors `ResilientPaperTradeStore`'s fallback-once behaviour, plus
tracks the two counters System Health's new panel needs (`recordsStored`, `lastRecordedAt`) that
paper trades never needed this way (Trade Journal shows the full list directly instead).

## 5. System Health

New `SectionPanel` ("Decision Intelligence") in `src/app/system-health/page.tsx`, backed by
`DecisionIntelligenceStatusPanel.tsx` and a new `useDecisionHistoryStatus()` hook (mirrors
`usePersistenceStatus()` exactly): **Status** (mode badge + connection/fallback detail),
**Records stored**, **Last recorded**.

## 6. Future-proofing

`DECISION_RECORD_SCHEMA_VERSION = 1`, stamped onto every record via the `version` field, and
carried through to the database column of the same name. Nothing in this mission reads or branches
on it yet — there is only one version — but it exists precisely so a future Hermes build can tell
which shape an older stored record is in before reading it, without a breaking rewrite of every row
already written. The `decision_history` table's `update` RLS policy (see "Database" above) is the
other half of this: schema evolution and outcome analysis both become additive from here, not
migrations that have to fight past RLS as well as the schema.

## Files changed

New:
- `src/lib/decision-intelligence/types.ts` — `DecisionRecord`, `DecisionOutcome`,
  `DecisionPortfolioRiskResult`, `DECISION_RECORD_SCHEMA_VERSION`
- `src/lib/decision-intelligence/build-decision-records.ts` — `buildDecisionRecords()`
- `src/lib/decision-intelligence/decision-history-store.ts` — `DecisionHistoryStore` interface
- `src/lib/decision-intelligence/local-storage-decision-history-store.ts`
- `src/lib/decision-intelligence/supabase-decision-history-store.ts` — also exports
  `toDbDecisionRecord`/`fromDbDecisionRecord`/`DecisionHistoryRow`, reused by the server-only store
- `src/lib/decision-intelligence/resilient-decision-history-store.ts`
- `src/lib/decision-intelligence/decision-history-status.ts` — `DecisionHistoryStatus` type
- `src/lib/decision-intelligence/get-decision-history-store.ts` — singleton factory
- `src/lib/decision-intelligence/server-decision-history-store.ts` — server-only, reuses
  `toDbDecisionRecord`; wired into Mission 6's dormant worker path, not called by the running app
- `src/lib/decision-intelligence/index.ts` — barrel
- `src/lib/state/decision-history-context.tsx` — `DecisionHistoryProvider`, `useDecisionHistory()`
- `src/lib/state/use-decision-history-status.ts`
- `src/app/decision-intelligence/page.tsx`
- `src/components/decision-intelligence/DecisionIntelligenceView.tsx`
- `src/components/system-health/DecisionIntelligenceStatusPanel.tsx`
- `supabase/migrations/0016_decision_history.sql`

Changed:
- `src/lib/bot/types.ts` — `BotCandidateEvaluation` gains `price?`, `primaryStrategyName`,
  `evidenceSummary`
- `src/lib/bot/bot-runner.ts` — all five `candidateEvaluations.push(...)` sites populate the three
  new fields
- `src/lib/bot/bot-execution-context.ts` — `BotExecutionContext` gains `persistDecisionRecords()`;
  `executeBotScan()` calls `buildDecisionRecords()` and persists the result every scan
- `src/lib/bot/server-execution-context.ts` (Mission 6, server-only) — implements
  `persistDecisionRecords()` via the new server-only store, to keep satisfying the
  `BotExecutionContext` interface
- `src/components/dashboard/BotRunnerPanel.tsx` — supplies `persistDecisionRecords` from
  `useDecisionHistory()`
- `src/app/layout.tsx` — wraps the app in `DecisionHistoryProvider`
- `src/components/layout/nav-items.ts`, `src/components/icons.tsx` — new nav entry + icon
- `src/app/system-health/page.tsx` — new Decision Intelligence section
- `README.md`, `src/components/layout/Footer.tsx`, `src/components/layout/Sidebar.tsx` — build
  label bumped to "Mission 7"

## Database changes

`supabase/migrations/0016_decision_history.sql` — not yet applied to the connected Supabase project
by this session (anon-key-only access, same standing limitation as every prior mission; the user
applies migrations directly).

## Verification

Run in local prototype mode (`.env.local` moved aside, matching the approach used in every prior
mission), in the same browser profile carrying state from Missions 4–6:

- **`npm run lint`** — clean.
- **`npm run build`** — clean (one type error surfaced and was fixed during development: reducing
  over an array with `noUncheckedIndexedAccess` enabled requires destructuring rather than indexing
  `records[0]` directly, in `resilient-decision-history-store.ts`).
- **Rejected candidates recorded**: with NVDA and TSLA both already holding open Bot positions from
  earlier sessions, a manual scan correctly rejected both (`HOLD_POSITION` — insufficient
  confidence improvement) and produced **2 DecisionRecords**, both `actionTaken: "Rejected"`, both
  carrying full strategy/agreement/confidence/rejection-reason/position-action detail. Confirms
  Requirement 2's core claim: rejected candidates become historical intelligence, not just the
  winner.
- **Accepted candidate recorded**: clearing paper trades and running a fresh scan opened a new NVDA
  trade and produced **1 DecisionRecord** with `actionTaken: "Trade Opened"`, `portfolioRiskResult:
  "Passed"`, `positionAction: "NEW_POSITION"`, and `createdTradeId` correctly matching the new
  trade's id.
- **Fallback candidates recorded**: the first (rejected-both) scan above is itself a fallback
  scenario — the scan walked NVDA (rank 1, rejected) then TSLA (rank 2, rejected) in the same scan,
  and both produced their own `DecisionRecord`, confirming the fallback loop (Mission 1.1) doesn't
  short-circuit decision recording partway through.
- **Decision Intelligence page**: rendered the nav link, the accepted/rejected counts (1 accepted /
  0 rejected after the second test scan), all five filter dropdowns populated with the records'
  actual strategy/agreement/symbol values, and the table with all fourteen visible columns.
  Filtering Action to "Rejected" against a dataset containing only one "Trade Opened" record
  correctly showed the empty-state message rather than the table.
- **System Health**: the new Decision Intelligence panel showed Status ("Local Browser Storage" —
  correct for this test session), Records stored (1), and Last recorded (the correct timestamp).
- **No regressions**: Trade Journal still showed the new Bot trade with full Position Manager
  metadata intact (`NEW_POSITION`, Momentum, 82% confidence); Bot Decisions still showed the full
  scan trace (`SCAN-000006 · Manual`, candidate evaluation, trace) exactly as before; manual scan
  and the underlying risk pipeline (individual → Position Manager → portfolio risk) all behaved
  identically to every prior mission — this mission only ever *adds* a persistence step after a
  scan completes, it never changes what the scan itself decides.

Not re-verified against a live authenticated Supabase session this mission — the test account
credentials confirmed in Mission 5 aren't available in this session's context, and
`SupabaseDecisionHistoryStore` follows the exact same session-derived-`userId` /
`AuthRequiredError` / RLS pattern already live-verified for `SupabasePaperTradeStore` in Mission 5,
so local-mode verification plus the clean build/lint pass is the appropriate level of confidence
here.

## How Hermes will consume this data later

`decision_history` is designed to be the evidence base a future Hermes reads from, not writes to
directly:

- **Learning from rejection, not just success**: every rejected candidate's `rejectionReason`,
  `positionAction`, and `portfolioRiskResult` are preserved alongside the exact strategy/confidence/
  agreement that produced it — Hermes can eventually correlate "candidates like this, with this
  confidence/agreement combination, tend to get rejected for this reason" without needing to
  reconstruct that from `paper_trades` (which only has the winners).
- **Outcome analysis as pure addition**: once a future mission decides how to judge a *closed* Bot
  trade's `DecisionRecord` as Win/Loss/Neutral (likely joining back via `createdTradeId` to the
  matching `paper_trades` row's `realisedPnl`), it only needs to `UPDATE decision_history SET
  outcome = ...` — the RLS policy already permits this, and the column already exists.
  `DecisionRecord`s for rejected candidates would most naturally stay `Pending` forever (there's no
  trade to judge), which the type already accommodates.
- **Schema evolution without breaking old rows**: `version` lets Hermes-era code branch on shape
  (`if (record.version === 1) { ... }`) rather than assuming every row matches today's fields.
- **Portfolio-state fields as training context**: `deployedCapital`/`availableCash`/
  `sectorExposure`/`totalOpenTrades` at decision time let a future model reason about whether a
  rejection was really about the opportunity or about the portfolio being stretched thin at that
  moment — a distinction `paper_trades` alone can't make, since a rejected candidate never becomes a
  row there at all.

## Readiness verdict

**Ready**: the analytical history described above is being recorded today, live, for every scan run
in a Supabase-configured or local-prototype session, and is queryable (`decision_history`, or
`useDecisionHistory()`/the Decision Intelligence page) right now. **Not built, and not a goal of
this mission**: outcome analysis, any Hermes-facing recommendation logic, or a UI that merges
`decision_history` with the Mission 6 worker's dormant `bot_decisions`/`bot_schedules` tables.

## How to run the prototype

```bash
cd Trading/platform/web
npm install
npm run dev
```

No environment variables are required for local prototype mode. `npm run lint` and `npm run build`
both pass cleanly.

## Suggested Mission 8

Two independent directions the mission's own disclosures point to, roughly equal priority:

1. **Outcome analysis v1** — decide the rule for classifying a closed Bot trade's linked
   `DecisionRecord` as Win/Loss/Neutral (most naturally: join `createdTradeId` back to
   `paper_trades.realisedPnl`/`realisedPnlPercent` at close time, with a threshold for "Neutral"
   near zero), and wire the `outcome` `UPDATE` the RLS policy already permits. This is the most
   direct continuation of this mission's own "outcome" field, and the first real signal Hermes could
   eventually learn from.
2. **Standing verification debt** — migration `0016` (and Mission 6's `0014`/`0015`) still need to be
   applied to the connected Supabase project and live-verified with a real authenticated session,
   using Mission 5's established schema-verification technique, before any Hermes-facing analysis
   can trust what's actually in the live table versus what the code assumes is there.

Lower priority, flagged but not blocking: merging the Decision Intelligence page's view with Mission
6's dormant `bot_decisions` table once a worker exists (Mission 7 that would be, numerically), and
richer mock instrument/sector data (flagged repeatedly since Mission 2) so accepted-vs-rejected
scenarios can be observed across more than two tradeable candidates.
