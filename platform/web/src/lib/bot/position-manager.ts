import type { AgreementLevel, PaperTrade, PaperTradeSide, PositionAction } from "@/lib/types";
import type { BotRiskCheck } from "./types";

// Hardcoded, disclosed, and deliberately simple — this is Mission 3's Position Manager v1, not a
// configurable risk engine. Adjusting any of these means editing this file, not a settings screen.
export const MIN_CONFIDENCE_IMPROVEMENT = 5;
export const MAX_POSITION_VALUE_GBP = 750;
export const MIN_ADD_INTERVAL_MINUTES = 30;

// Strongest to weakest, matching the order the Strategy Engine itself already describes them in
// (Build 1.3.0) — used only to compare "is the candidate's agreement at least as strong as the
// existing position's."
const AGREEMENT_RANK: Record<AgreementLevel, number> = {
  "Strong Agreement": 3,
  "Moderate Agreement": 2,
  "Mixed Signals": 1,
  Conflict: 0,
};

export interface PositionContext {
  instrumentSymbol: string;
  existingOpenTradeCount: number;
  valueBySide: Record<PaperTradeSide, number>;
  countBySide: Record<PaperTradeSide, number>;
  // Minutes since the most recent trade (open or closed) was placed for this instrument —
  // undefined only when there has never been a trade in this instrument at all. Deliberately not
  // scoped to "still open" trades: the 30-minute rule is a pacing limit on how often the bot acts
  // on an instrument, not a property of the position itself.
  minutesSinceLastOpenTrade?: number;
}

export interface PositionDecision {
  action: PositionAction;
  reason: string;
  // The five add-to-position checks — empty for NEW_POSITION (nothing to compare against) and
  // for the opposite-side conflict case (side mismatch is reported as its own, single check).
  checks: BotRiskCheck[];
  existingPositionValue: number;
  positionValueAfterTrade: number;
  latestBotConfidence?: number;
  latestBotAgreement?: AgreementLevel;
}

// The portfolio's current state for one instrument, before considering any new candidate —
// side-agnostic, since a candidate's side is only known at classification time.
export function buildPositionContext(instrumentSymbol: string, trades: PaperTrade[]): PositionContext {
  const instrumentTrades = trades.filter((trade) => trade.instrumentSymbol === instrumentSymbol);
  const openTrades = instrumentTrades.filter((trade) => trade.status === "Open");

  const valueBySide: Record<PaperTradeSide, number> = { BUY: 0, SELL: 0 };
  const countBySide: Record<PaperTradeSide, number> = { BUY: 0, SELL: 0 };

  for (const trade of openTrades) {
    const notional = trade.quantity * trade.entryPrice;
    valueBySide[trade.side] += notional;
    countBySide[trade.side] += 1;
  }

  let minutesSinceLastOpenTrade: number | undefined;
  if (instrumentTrades.length > 0) {
    const latestTimestamp = Math.max(
      ...instrumentTrades.map((trade) => new Date(trade.timestamp).getTime()),
    );
    minutesSinceLastOpenTrade = (Date.now() - latestTimestamp) / (1000 * 60);
  }

  return {
    instrumentSymbol,
    existingOpenTradeCount: openTrades.length,
    valueBySide,
    countBySide,
    minutesSinceLastOpenTrade,
  };
}

// Classifies a candidate against any existing position in the same instrument. Only decides based
// on side/confidence/agreement/value/time — it does NOT independently re-check portfolio risk
// (requirement 3's "Portfolio Risk Manager still passes after the add"). That's evaluated as its
// own, separate pipeline stage in runBotScan; if it fails there, the bot runner overrides a
// tentative NEW_POSITION/ADD_TO_POSITION result to BLOCK_POSITION, so the final recorded action
// still correctly reflects "blocked by portfolio risk" without this module needing to know
// anything about the Portfolio Risk Manager.
export function evaluatePosition(params: {
  context: PositionContext;
  trades: PaperTrade[];
  candidateSide: PaperTradeSide;
  candidateConfidence: number;
  candidateAgreement: AgreementLevel;
  candidateNotional: number;
}): PositionDecision {
  const { context, trades, candidateSide, candidateConfidence, candidateAgreement, candidateNotional } =
    params;
  const instrumentSymbol = context.instrumentSymbol;
  const oppositeSide: PaperTradeSide = candidateSide === "BUY" ? "SELL" : "BUY";
  const existingSameSideValue = context.valueBySide[candidateSide];
  const existingOppositeSideValue = context.valueBySide[oppositeSide];
  const positionValueAfterTrade = existingSameSideValue + candidateNotional;

  if (context.existingOpenTradeCount === 0) {
    return {
      action: "NEW_POSITION",
      reason: `No existing open position in ${instrumentSymbol} — this is a new position.`,
      checks: [],
      existingPositionValue: 0,
      positionValueAfterTrade: candidateNotional,
    };
  }

  if (existingOppositeSideValue > 0) {
    return {
      action: "BLOCK_POSITION",
      reason: `An open ${oppositeSide} position already exists in ${instrumentSymbol} — a ${candidateSide} candidate would conflict with it.`,
      checks: [
        {
          name: "Side matches existing position",
          passed: false,
          detail: `Existing position is ${oppositeSide}; candidate is ${candidateSide}.`,
        },
      ],
      existingPositionValue: existingSameSideValue,
      positionValueAfterTrade,
    };
  }

  // An existing same-side position (existingSameSideValue > 0, since existingOpenTradeCount > 0
  // and the opposite side is 0) — evaluate whether to add to it. Only the bot's own prior trades
  // on this instrument + side carry comparable confidence/agreement metadata (Signal-sourced
  // trades don't), so the comparison baseline is deliberately scoped to the latest Bot trade.
  const latestBotTrade = trades
    .filter(
      (trade) =>
        trade.status === "Open" &&
        trade.instrumentSymbol === instrumentSymbol &&
        trade.side === candidateSide &&
        trade.source === "Bot" &&
        trade.overallConfidence !== undefined,
    )
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];

  const latestBotConfidence = latestBotTrade?.overallConfidence;
  const latestBotAgreement = latestBotTrade?.strategyAgreement;

  const checks: BotRiskCheck[] = [];

  checks.push({
    name: "Side matches existing position",
    passed: true,
    detail: `Existing position is ${candidateSide}; candidate is also ${candidateSide}.`,
  });

  const confidencePassed =
    latestBotConfidence !== undefined && candidateConfidence >= latestBotConfidence + MIN_CONFIDENCE_IMPROVEMENT;
  checks.push({
    name: "Confidence improved enough",
    passed: confidencePassed,
    detail:
      latestBotConfidence === undefined
        ? "No prior Bot trade confidence recorded for this instrument to compare against."
        : `${candidateConfidence}% vs previous ${latestBotConfidence}% ${
            confidencePassed ? "meets" : "does not meet"
          } the +${MIN_CONFIDENCE_IMPROVEMENT}-point improvement bar.`,
  });

  const agreementPassed =
    latestBotAgreement !== undefined && AGREEMENT_RANK[candidateAgreement] >= AGREEMENT_RANK[latestBotAgreement];
  checks.push({
    name: "Agreement not weaker",
    passed: agreementPassed,
    detail:
      latestBotAgreement === undefined
        ? "No prior Bot trade agreement recorded for this instrument to compare against."
        : `Agreement ${candidateAgreement} vs previous ${latestBotAgreement} ${
            agreementPassed ? "is not weaker" : "has weakened"
          }.`,
  });

  const valuePassed = positionValueAfterTrade <= MAX_POSITION_VALUE_GBP;
  checks.push({
    name: "Position value within cap",
    passed: valuePassed,
    detail: `£${positionValueAfterTrade.toFixed(2)} position value after this trade ${
      valuePassed ? "is within" : "would exceed"
    } the £${MAX_POSITION_VALUE_GBP} cap.`,
  });

  const minutesSinceLastAdd = context.minutesSinceLastOpenTrade;
  const timePassed = minutesSinceLastAdd !== undefined && minutesSinceLastAdd >= MIN_ADD_INTERVAL_MINUTES;
  checks.push({
    name: "Minimum time since last add",
    passed: timePassed,
    detail:
      minutesSinceLastAdd === undefined
        ? "No prior trade timestamp recorded for this instrument."
        : `${minutesSinceLastAdd.toFixed(1)} minute(s) since the last trade ${
            timePassed ? "meets" : "is below"
          } the ${MIN_ADD_INTERVAL_MINUTES}-minute minimum.`,
  });

  const failedChecks = checks.filter((check) => !check.passed);

  if (failedChecks.length === 0) {
    return {
      action: "ADD_TO_POSITION",
      reason: `${instrumentSymbol}: confidence improved, agreement held, value and timing within limits — adding to the existing ${candidateSide} position.`,
      checks,
      existingPositionValue: existingSameSideValue,
      positionValueAfterTrade,
      latestBotConfidence,
      latestBotAgreement,
    };
  }

  const failedNames = failedChecks.map((check) => check.name).join(", ");

  // Hard-block reason (a structural limit) vs soft-hold reasons (not yet justified, but nothing is
  // actually wrong) — see docs/product/MISSION-3-POSITION-MANAGER.md for why these are split this
  // way rather than treating every unmet condition as a block.
  if (!valuePassed) {
    return {
      action: "BLOCK_POSITION",
      reason: `${instrumentSymbol}: position value cap would be exceeded — blocked, not just held. Unmet: ${failedNames}.`,
      checks,
      existingPositionValue: existingSameSideValue,
      positionValueAfterTrade,
      latestBotConfidence,
      latestBotAgreement,
    };
  }

  return {
    action: "HOLD_POSITION",
    reason: `${instrumentSymbol}: existing ${candidateSide} position held — not enough new evidence to add yet. Unmet: ${failedNames}.`,
    checks,
    existingPositionValue: existingSameSideValue,
    positionValueAfterTrade,
    latestBotConfidence,
    latestBotAgreement,
  };
}
