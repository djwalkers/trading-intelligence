# Mission 1.1 — Bot Candidate Fallback and Scan Trace

Date: 2026-07-08
Location: `Trading/platform/web`
Related: [`MISSION-1-FIRST-AUTONOMOUS-PAPER-TRADE.md`](./MISSION-1-FIRST-AUTONOMOUS-PAPER-TRADE.md),
[`BUILD-1.3.0.md`](./BUILD-1.3.0.md)

## What was built

The Bot Runner now behaves like a proper decision engine rather than a single-shot check. Where
Mission 1's bot stopped the moment its top-ranked candidate failed a risk check, Mission 1.1's bot
walks the full ranked candidate list — evaluating each one's risk checks in turn — until either one
opens a trade or every candidate has been exhausted. Every scan also gets a readable, sequential
scan ID and a full step-by-step trace, both surfaced on the Dashboard, the Bot Decisions page, and
System Health. **Still no live trading, no broker API, no AI, no Hermes — paper trading only.**

- **Candidate fallback**: `runBotScan` ranks every tradeable opportunity by confidence (unchanged
  from Mission 1), then loops through the ranked list. If a candidate fails any risk check, the loop
  moves to the next-ranked candidate instead of ending the scan. The loop breaks the instant a
  candidate passes every check — so at most one trade is still ever opened per scan — or continues
  to the end of the list, producing "No Trade" only when every candidate has failed.
- **Scan ID**: every scan gets a readable, sequential ID (`SCAN-000001`, `SCAN-000002`, …) via
  `reserveScanId()`, a small `localStorage`-backed counter. Bot-sourced trades now store this
  `scanId` alongside the existing `sourceBotDecisionId`.
- **Decision trace**: each `BotDecision` now carries an ordered `trace` of step/detail pairs — scan
  started, instruments scanned, candidates ranked, each candidate evaluated, its risk checks
  evaluated, rejected (with reason) or opened, and scan completed — plus a per-candidate
  `BotCandidateEvaluation` list (rank, instrument, side, confidence, agreement, full risk checks,
  outcome, rejection reason) and a measured `executionTimeMs`.
- **Bot Decisions page** now shows, per scan: the scan ID, candidates evaluated / rejected counts,
  execution time, the executed candidate (if any), every rejected candidate with its full risk
  check breakdown and rejection reason, and a collapsible "Full scan trace" with every step.
- **Dashboard Bot Runner panel** now shows the scan ID, candidates evaluated, rejected count,
  execution time, and — per candidate — Executed/Rejected with the rejection reason inline.
- **System Health's Bot Runner panel** gained the last scan's ID and a "Last scan candidates" row
  (evaluated vs. rejected).

## Architecture overview

```
runBotScan(instruments, openTrades, scanId)
  1. getStrategyEngine().evaluateAll(instruments)          — unchanged from Mission 1
  2. rank tradeable candidates by confidence                — unchanged from Mission 1
  3. for each candidate, in ranked order:
       evaluateCandidateRisk(candidate, side, openTrades, instrument)  — same 5 checks as before
       if all pass → buildBotTrade(...), record "Trade Opened", break the loop
       if any fail → record "Rejected" with a reason, continue to the next candidate
  4. if no candidate ever passed → "No Trade", reason names how many candidates were tried
  → returns { decision: BotDecision, trade: PaperTrade | null }, exactly one BotDecision per scan
```

**Why the loop, not recursion or a second function:** the fallback is a straightforward `for...of`
over the already-ranked candidate array with a `break` on success — no new control-flow
abstraction was needed. `evaluateCandidateRisk` (the five risk checks) and `buildBotTrade` (trade
construction) were extracted from Mission 1's single inline block into named helpers specifically
so the loop body stays readable; the checks themselves are byte-for-byte the same five rules.

**Why scan IDs live in their own module (`src/lib/bot/scan-id.ts`), not the decision log context:**
`reserveScanId()` is a plain synchronous function — read `localStorage`, increment, write, return a
formatted string — called imperatively from a click handler, never during render or inside an
effect body. Folding it into `BotDecisionLogProvider`'s React state would have meant a `useRef` plus
an async hydration effect to work around React's setState-in-effect and purity rules, for no benefit
over just reading and writing localStorage directly at call time. Keeping it a plain function in
`src/lib/bot/` avoids that complexity entirely and keeps the decision log context focused on what it
already does — storing decisions.

**Why the trace is a flat list of `{ step, detail }` pairs, not a typed enum of step kinds:** the
mission asked for a "clear step-by-step trace," which a human reads top-to-bottom on the Bot
Decisions page — there's no code anywhere that branches on which step a trace entry represents.
Introducing a step-kind enum and matching UI logic for each kind would be structure the log doesn't
need; a plain ordered list, rendered in order, is the whole feature.

**Why the decision log's storage key was bumped from `v1` to `v2`:** `BotDecision`'s shape changed
enough (flat `riskChecks` → `candidates[]` + `trace[]` + `scanId`) that old Mission 1 entries in
`localStorage` are a different, incompatible shape. Rather than write migration code for a
local-browser-only prototype log, the storage key changed so old entries are simply left behind —
consistent with how this log was already documented as "a prototype decision log, not an audit
trail."

## Risk behaviour confirmation

**All five risk rules are unchanged and still enforced exactly as in Mission 1** — this mission
only changed *how many candidates get a chance to pass them*, never *what the rules require*:

| # | Rule | Status |
|---|------|--------|
| 1 | Max one new paper trade per scan | Unchanged — still structural: the loop `break`s the instant one candidate passes |
| 2 | No duplicate open trade, same instrument + side | Unchanged — now correctly causes fallback to the next candidate instead of ending the scan |
| 3 | Minimum confidence 75% | Unchanged |
| 4 | Block trades where agreement is Conflict | Unchanged |
| 5 | Max notional per trade £250 | Unchanged — same hard floor-based sizing from Mission 1 |

No rule was weakened, removed, or made conditional. If every ranked candidate fails, the scan
still opens zero trades — the fallback only gives *more* candidates a chance to clear the *same*
bar, never a lower one.

## Files changed

New:
- `src/lib/bot/scan-id.ts` — `reserveScanId()`
- `supabase/migrations/0011_bot_scan_id.sql`

Changed:
- `src/lib/bot/types.ts` — `BotCandidateEvaluation`, `BotTraceStep` added; `BotDecision` gains
  `scanId`, `candidates`, `trace`, `executionTimeMs`; the old flat `riskChecks` field is replaced
  by per-candidate `riskChecks`
- `src/lib/bot/bot-runner.ts` — `runBotScan` takes a `scanId` parameter and loops over ranked
  candidates instead of only ever considering the first; risk checks and trade construction
  extracted into `evaluateCandidateRisk`/`buildBotTrade` helpers
- `src/lib/bot/index.ts` — barrel exports the new types and `reserveScanId`
- `src/lib/types/paper-trade.ts` — new optional `scanId` field
- `src/lib/persistence/supabase-paper-trade-store.ts` — maps `scan_id` both ways
- `src/lib/state/bot-decision-log-context.tsx` — storage key bumped to `v2`
- `src/components/dashboard/BotRunnerPanel.tsx` — shows scan ID, candidates evaluated/rejected,
  execution time, and a per-candidate Executed/Rejected list
- `src/components/bot/BotDecisionsView.tsx` — shows scan ID, full candidate evaluation (risk
  checks per candidate), and a collapsible full scan trace
- `src/components/system-health/BotRunnerStatusPanel.tsx` — shows the last scan's ID and a
  candidates evaluated/rejected row
- `src/components/trading/TradeJournalEntry.tsx` — shows `Scan: SCAN-000004` when a trade has one

## Database changes

**`0011_bot_scan_id.sql`** — adds one nullable column, `scan_id` (text), to `paper_trades`. Purely
informational, never read by any P/L calculation; every trade placed before this migration is
unaffected. The full candidate-by-candidate trace is still not persisted to Supabase at all — only
this one scan-level identifier travels with the resulting trade row, exactly like
`sourceBotDecisionId` and `riskChecksSummary` before it.

## Manual Supabase steps required

Run `0011_bot_scan_id.sql` in the SQL Editor (same anon-key-only limitation as every schema change
in this project). Migrations `0008`, `0009`, and `0010` remain unapplied from prior builds/missions
— this mission does not change that; the verification debt is now five migrations deep.

## Verification results

**Verified in local prototype mode**, using a deliberately constructed scenario: three consecutive
scans against the same 5-instrument watchlist, where NVDA (82% confidence) and TSLA (78%
confidence) are the only two tradeable candidates this mock data ever produces.

- **Scan 1** (`SCAN-000001`): no open trades yet — NVDA (the top candidate) passed every risk
  check immediately and opened a trade. 1 candidate evaluated, 0 rejected.
- **Scan 2** (`SCAN-000002`): NVDA now has an open BUY position — the "No duplicate open trade"
  check correctly failed for NVDA, and **the bot correctly fell back to TSLA**, which passed every
  check and opened a trade. 2 candidates evaluated, 1 rejected — this is the exact fallback
  behaviour the mission asked to verify.
- **Scan 3** (`SCAN-000003`): both NVDA and TSLA now have open positions — both failed the
  duplicate check, no candidates remained, and the bot correctly opened **no trade**, reporting
  "All 2 candidate(s) failed risk checks — no trade opened this scan." 2 candidates evaluated, 2
  rejected.
- Across all three scans, **at most one trade was opened per scan** — confirmed both by the
  Dashboard panel and by the Paper Portfolio's trade count after each scan.
- The Bot Decisions page correctly listed all three scans (most recent first) with full
  candidate-by-candidate risk check detail, correct rejection reasons, and an expandable full trace
  showing every step (scan started → instruments scanned → candidates ranked → each candidate
  evaluated/rejected → scan completed) matching the actual sequence of events exactly.
- System Health's Bot Runner panel correctly showed the latest scan's ID (`SCAN-000003`), its
  outcome, and "2 evaluated · 2 rejected".
- Trade Journal correctly showed `Scan: SCAN-000002` on the TSLA trade (the one opened via
  fallback) alongside its existing Strategy Engine metadata and risk checks summary.
- Existing Signal-sourced and Market-Intelligence-sourced trades were both placed successfully in
  the same session — all four trades (2 Bot, 1 Signal, 1 Market Intelligence) coexisted correctly
  in Trade Journal and Paper Portfolio with no regressions.
- `npm run lint` and `npm run build` both pass cleanly.
- Restoring `.env.local` and reloading in Supabase-configured mode still correctly gates behind
  sign-in with no console errors — no regression from this mission's changes.

**Not verified against a real authenticated Supabase session:** migration `0011` has not been
applied to the live project, and (per the limitation disclosed in every prior build/mission) no
confirmable test account was available in this environment, so a Bot-sourced trade's `scan_id`
persisting to Supabase end-to-end was not exercised.

## How to run the prototype

```bash
cd Trading/platform/web
npm install
npm run dev
```

No environment variables are required. `npm run lint` and `npm run build` both pass cleanly.

## Suggested next mission

The verification debt is now five migrations deep (`0008`–`0011`, plus confirming a real test
account) — still the standing top priority independent of any new mission. Beyond that, natural
next steps this mission's design surfaces: portfolio-level exposure limits across all open bot
trades (today's £250 cap is still per-trade only, not aggregate); scheduled or interval-based
triggering now that manual triggering and candidate fallback are both proven; or persisting the
full candidate trace to Supabase (today only the scan-level `scan_id` travels with the trade — the
trace itself stays local-browser-only, which may be worth revisiting once the app has a real
per-user audit requirement).
