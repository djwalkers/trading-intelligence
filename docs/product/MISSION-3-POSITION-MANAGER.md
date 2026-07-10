# Mission 3 — Position Manager v1

Date: 2026-07-08
Location: `Trading/platform/web`
Related: [`MISSION-2-PORTFOLIO-RISK-MANAGER.md`](./MISSION-2-PORTFOLIO-RISK-MANAGER.md),
[`MISSION-1.1-BOT-CANDIDATE-FALLBACK.md`](./MISSION-1.1-BOT-CANDIDATE-FALLBACK.md)

## What was built

The Bot Runner's old "no duplicate open trade" rule — a blunt reject-or-allow check — is replaced
with a Position Manager that understands existing positions and classifies every candidate as one
of four actions: **NEW_POSITION**, **ADD_TO_POSITION**, **HOLD_POSITION**, or **BLOCK_POSITION**. A
strong enough opportunity can now genuinely add to an existing paper position, but only when every
one of five strict rules passes. **Still no live trading, no broker API, no AI, no Hermes — paper
trading only.**

- **Position Manager** (`src/lib/bot/position-manager.ts`): `buildPositionContext(symbol, trades)`
  computes, per instrument, existing open trade count, exposure value and count by side, and
  minutes since the last trade (open or closed) in that instrument. `evaluatePosition(...)`
  classifies a candidate against that context.
- **Four-way classification**, evaluated in this order:
  1. **NEW_POSITION** — no existing open trade at all in this instrument.
  2. **BLOCK_POSITION** (hard conflict) — an existing open position on the *opposite* side already
     exists; a same-instrument, opposite-direction candidate is a direct conflict, never an add.
  3. **ADD_TO_POSITION** — an existing *same-side* open position, and all five add-to-position
     rules pass (side match is implicit from reaching this branch; confidence improved by at least
     5 points over the latest Bot trade on this instrument+side; agreement not weaker; resulting
     position value ≤ £750; at least 30 minutes since the last trade in this instrument).
  4. **HOLD_POSITION** (soft) or **BLOCK_POSITION** (hard) — an existing same-side position where
     one or more add-to-position rules failed. See "Design decision: splitting HOLD from BLOCK"
     below for exactly how these two are told apart.
- **Bot Runner integration**: the pipeline is now three tiers per candidate — individual risk
  checks (Mission 1/1.1, now four checks instead of five: the duplicate check is gone, replaced
  entirely by the Position Manager) → Position Manager classification → portfolio risk (Mission 2,
  unchanged). A candidate proceeds to the next tier only if the current one allows it; `HOLD_` or
  `BLOCK_POSITION` — like an individual or portfolio-risk failure — causes the bot to fall back to
  the next-ranked candidate.
- **Portfolio risk failure overrides the position action.** If the Position Manager tentatively
  returns `NEW_POSITION`/`ADD_TO_POSITION` but portfolio risk then fails, the *final* recorded
  action for that candidate is overridden to `BLOCK_POSITION` — satisfying the mission's own
  "portfolio risk fails" block condition without duplicating portfolio-risk logic inside
  `position-manager.ts`.
- **Decision trace** gained "Position evaluated" (existing position value, confidence comparison,
  agreement comparison, minutes since last trade) and "Position decision" (action + reason) steps
  per candidate.
- **Bot Decisions page** shows a "Position Manager" section per candidate (colour-coded by action),
  the existing/after-trade position values, the decision reason, and the five add-to-position
  checks — between the existing "Individual risk checks" and "Portfolio risk checks" sections.
- **Dashboard panel** and **Trade Journal** both surface the position action alongside the existing
  individual/portfolio status.
- **System Health** gained three new rows: Position Manager (Active), Max instrument position
  (£750), Add-to-position confidence improvement (+5), Minimum add interval (30 minutes).
- **Trade metadata**: Bot-sourced trades now also record `positionAction`, `existingPositionValue`,
  `positionValueAfterTrade`, and `positionDecisionReason`.

## Design decision: splitting HOLD_POSITION from BLOCK_POSITION

The mission text lists six "Block rules" (§4) that are, verbatim, the negation of the six
add-to-position preconditions from §3 — it never separately specifies what triggers
`HOLD_POSITION`, even though §2 lists it as one of four possible classifications. Reading §4
literally would make `HOLD_POSITION` unreachable, which felt like a gap worth filling deliberately
rather than leaving dead code behind.

This implementation splits the six conditions by severity:

- **Hard blocks → `BLOCK_POSITION`**: an opposite-side conflict, the position value cap (£750)
  being exceeded, and portfolio risk failing. These are structural — no amount of "waiting" fixes
  them; a value cap doesn't become less exceeded five minutes from now.
- **Soft holds → `HOLD_POSITION`**: confidence not yet improved enough, agreement having weakened,
  and not enough time since the last trade. These are comparative and time-based — nothing is
  *wrong*, there just isn't a strong enough new signal yet. A `HOLD_POSITION` reads as "the existing
  position is fine as-is," not "this candidate did something wrong."

Both classifications have the identical operational effect in `runBotScan` — no trade opens for
that candidate, and the bot falls back to the next-ranked one — so this split is purely about
making the decision log honest and readable, not a functional distinction. It is a disclosed
interpretation filling a real gap in the mission spec, not a deviation from anything the spec
actually stated.

## Architecture overview

```
runBotScan(instruments, trades, scanId)
  for each ranked candidate:
    evaluateCandidateRisk(...)              — 4 individual checks (duplicate check removed)
    if any fail → reject, continue

    buildPositionContext(symbol, trades)    — existing exposure for this instrument
    evaluatePosition({ context, trades, candidateSide, candidateConfidence,
                       candidateAgreement, candidateNotional })
    if HOLD_POSITION or BLOCK_POSITION → reject, continue

    evaluatePortfolioRisk(...)              — 6 portfolio checks (Mission 2, unchanged)
    if fails → override action to BLOCK_POSITION, reject, continue

    if both tiers pass → buildBotTrade(...), break
```

**Why the Position Manager doesn't independently re-check portfolio risk:** the mission's own
add-to-position rule #6 ("Portfolio Risk Manager still passes after the add") is naturally satisfied
by evaluating portfolio risk as its own pipeline stage immediately after — duplicating that logic
inside `position-manager.ts` would mean two places could disagree about what "portfolio risk passing"
means. The override-on-failure approach keeps `position-manager.ts` focused purely on
position-specific concerns (side, confidence, agreement, value, time) and lets `bot-runner.ts`
remain the one place that knows the full pipeline order.

**Why the confidence/agreement baseline is scoped to the latest *Bot* trade on the instrument +
side, not any trade:** only Bot-sourced trades reliably carry `overallConfidence` /
`strategyAgreement` from the same Strategy Engine the candidate itself was scored against — a
Signal-sourced trade's `signalConfidence` comes from a different, older mock system entirely
(Build 0.1.0/0.2.0) and isn't a comparable number. If no prior Bot trade exists for the instrument
+ side (e.g. the existing position came from a manual Signal or Market Intelligence trade), the
comparison can't be made — the confidence and agreement checks both fail with an explicit "no prior
Bot trade recorded to compare against" detail, which correctly routes to `HOLD_POSITION` rather than
silently allowing an unverifiable add.

**Why "time since last trade" looks at *any* trade in the instrument (open or closed), not just
open ones:** the 30-minute rule is a pacing limit on how often the bot acts on an instrument at all,
not a property specific to the currently-open position. Scoping it to only-open trades would let the
bot close a position and immediately reopen one in the same instrument with no cooldown, which
misses the intent of a rate limit.

## Position Manager rules implemented

| Rule | Enforced as |
|------|-------------|
| Candidate side matches existing open side | Reaching the "same-side" branch at all (an opposite-side match is caught earlier as a hard `BLOCK_POSITION`) |
| Confidence at least 5 points higher than the latest existing Bot confidence | `candidateConfidence >= latestBotConfidence + 5` |
| Agreement not weaker than the existing agreement | `AGREEMENT_RANK[candidate] >= AGREEMENT_RANK[existing]` (Strong Agreement > Moderate Agreement > Mixed Signals > Conflict) |
| Total position value after add ≤ £750 | `existingSameSideValue + candidateNotional <= 750` |
| At least 30 minutes since the last open trade for that instrument | `minutesSinceLastTrade >= 30` |
| Portfolio Risk Manager still passes after the add | Evaluated as a separate pipeline stage; failure overrides the action to `BLOCK_POSITION` |

None of Mission 1/1.1's four remaining individual risk rules (max one trade per scan, minimum 75%
confidence, no Conflict agreement, £250 max notional) or Mission 2's six portfolio rules were
weakened, removed, or made conditional.

## Files changed

New:
- `src/lib/types/position-manager.ts` — `PositionAction` (barrel-exported)
- `src/lib/bot/position-manager.ts` — `buildPositionContext()`, `evaluatePosition()`, the three
  hardcoded limit constants
- `supabase/migrations/0013_position_manager.sql`

Changed:
- `src/lib/types/paper-trade.ts` — four new optional fields: `positionAction`,
  `existingPositionValue`, `positionValueAfterTrade`, `positionDecisionReason`
- `src/lib/types/index.ts` — barrel-exports `position-manager.ts`
- `src/lib/bot/types.ts` — `BotCandidateEvaluation` gains `positionEvaluated`/`positionAction`/
  `positionChecks`/`existingPositionValue`/`positionValueAfterTrade`/`positionDecisionReason`
- `src/lib/bot/bot-runner.ts` — the duplicate check removed from `evaluateCandidateRisk`; a new
  Position Manager tier inserted between individual and portfolio risk checks
- `src/lib/bot/index.ts` — barrel exports the new module and types
- `src/lib/persistence/supabase-paper-trade-store.ts` — maps the four new columns both ways
- `src/lib/state/bot-decision-log-context.tsx` — storage key bumped to `v4`
- `src/components/dashboard/BotRunnerPanel.tsx` — shows position action alongside individual/
  portfolio status
- `src/components/bot/BotDecisionsView.tsx` — new "Position Manager" section per candidate
- `src/components/system-health/BotRunnerStatusPanel.tsx` — three new Position Manager rows
- `src/components/trading/TradeJournalEntry.tsx` — shows position action, value before/after, and
  decision reason when present
- `src/components/layout/Sidebar.tsx`, `Footer.tsx`, `src/app/system-health/page.tsx` — build
  label bumped to "Mission 3"

## Database changes

**`0013_position_manager.sql`** — adds four nullable columns to `paper_trades`: `position_action`
(text, checked against the four action values), `existing_position_value` (numeric),
`position_value_after_trade` (numeric), and `position_decision_reason` (text). All purely
informational, never read by any P/L calculation — every trade placed before this migration is
unaffected. Columns are added *before* the check constraint that references them — migration 0012
had this backwards (constraint before column), which fails in Postgres with "column does not exist"
(the user hit this directly when applying 0012); fixed there, and this migration follows the
correct order from the start.

## Manual Supabase steps required

Run `0013_position_manager.sql` in the SQL Editor (same anon-key-only limitation as every schema
change in this project). Migrations `0008`–`0012` remain unapplied from prior builds/missions — the
verification debt is now seven migrations deep.

## Test scenarios verified

**Verified in local prototype mode**, using deliberately seeded `localStorage` states (this mock
dataset only ever produces two tradeable candidates — NVDA at 82% and TSLA at 78%, both BUY — so
precise scenarios require seeding rather than relying on naturally-occurring confidence changes,
since the Strategy Engine's output for a given instrument snapshot is deterministic and never
drifts between scans):

1. **New position can still be opened** — clean state, one scan: NVDA correctly classified
   `NEW_POSITION` and opened.
2. **ADD_TO_POSITION when rules pass** — seeded a prior Bot BUY trade on NVDA at 70% confidence,
   60 minutes old. NVDA's real 82% (≥ 70+5) with matching agreement, £277.30 after-trade value
   (≤ £750), and 60 minutes elapsed (≥ 30) all passed — correctly classified `ADD_TO_POSITION` and
   opened.
3. **Blocked (held) when confidence hasn't improved enough** — seeded a prior Bot BUY trade on
   NVDA at 80% confidence (82 − 80 = 2 < 5). NVDA correctly classified `HOLD_POSITION` ("Unmet:
   Confidence improved enough"), and **the bot correctly fell back to TSLA**, which opened as
   `NEW_POSITION`.
4. **Opposite-side trade blocked** — seeded an existing open SELL position on NVDA. The BUY
   candidate correctly classified `BLOCK_POSITION` ("An open SELL position already exists... a BUY
   candidate would conflict with it"), with fallback to TSLA opening successfully.
5. **Max £750 position cap works** — seeded a prior Bot BUY trade on NVDA, 5 shares at $138.65
   (£693.25 existing); adding the candidate's own £138.65 would total £831.90 > £750. Correctly
   classified `BLOCK_POSITION` ("Unmet: Position value within cap") — a hard block, not a hold, per
   this mission's severity split — with fallback to TSLA opening successfully.
6. **Minimum add interval works** — seeded a prior Bot BUY trade on NVDA, 10 minutes old (< 30).
   Confidence and value conditions both passed, but time did not — correctly classified
   `HOLD_POSITION` ("Unmet: Minimum time since last add"), with fallback to TSLA opening
   successfully.
7. **Bot falls back to the next candidate when the Position Manager blocks one** — directly
   confirmed in scenarios 3, 4, 5, and 6 above; TSLA opened successfully as the fallback in every
   case.
8. The Bot Decisions page correctly showed, for scenario 6: the individual checks (now four, no
   duplicate check), a "Position Manager — HOLD_POSITION" section with the existing/after-trade
   values (£138.65 → £277.30) and all five position checks (four passed, "Minimum time since last
   add" failed with "10.1 minute(s)... is below the 30-minute minimum"), and correctly noted
   "Portfolio risk not evaluated — the Position Manager did not allow a new or added position" for
   NVDA.
9. System Health correctly showed the three new rows: Position Manager (Active), Max instrument
   position (£750), Add-to-position confidence improvement (+5), Minimum add interval (30 minutes).
10. Trade Journal correctly showed `Position: NEW_POSITION`, `£0.00 → £242.23`, and the decision
    reason on the TSLA trade.
11. Existing Signal-sourced and Market-Intelligence-sourced trades were both placed successfully in
    the same session with no regressions.
12. `npm run lint` and `npm run build` both pass cleanly.
13. Restoring `.env.local` and reloading in Supabase-configured mode still correctly gates behind
    sign-in with no console errors — no regression from this mission's changes.

**Not verified against a real authenticated Supabase session:** migration `0013` has not been
applied to the live project, and (per the limitation disclosed in every prior build/mission) no
confirmable test account was available in this environment, so a Bot-sourced trade's position
metadata persisting to Supabase end-to-end was not exercised.

## How to run the prototype

```bash
cd Trading/platform/web
npm install
npm run dev
```

No environment variables are required. `npm run lint` and `npm run build` both pass cleanly.

## Suggested next mission

The verification debt is now seven migrations deep (`0008`–`0013`, plus confirming a real test
account) — still the standing top priority independent of any new mission. Beyond that: a richer
mock instrument/sector universe (Mission 2 already flagged this) would also let position-manager
scenarios be exercised through real, repeated scans rather than seeded state, since today's
deterministic 2-candidate universe never produces a naturally-occurring confidence change between
scans; scheduled/interval-based bot triggering now that manual triggering, candidate fallback,
portfolio risk, and position management are all proven; or reconciling `quantityForEntryPrice`'s
~£250 *target* sizing (used by Signal/Market-Intelligence trades) with the Bot Runner's stricter
floor-based sizing, since the two now interact more visibly through shared position values.
