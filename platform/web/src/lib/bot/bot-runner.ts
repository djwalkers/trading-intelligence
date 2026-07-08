import type {
  Instrument,
  MarketDataStatus,
  MarketQuote,
  PaperTrade,
  PaperTradeSide,
  StrategyScore,
} from "@/lib/types";
import { getInstrumentBySymbol } from "@/lib/mock/instruments";
import { getStrategyEngine } from "@/lib/strategy-engine";
import { getMarketDataProvider } from "@/lib/market-data/get-market-data-provider";
import { isTradeableRecommendation, sideForRecommendation } from "@/lib/utils/paper-trade";
import type { BotCandidateEvaluation, BotDecision, BotRiskCheck, BotScanResult, BotTraceStep } from "./types";

// Hardcoded, disclosed, and deliberately simple — this is Mission 1/1.1, not a configurable risk
// engine. Adjusting any of these means editing this file, not a settings screen.
const MIN_CONFIDENCE = 75;
const MAX_NOTIONAL_GBP = 250;
const BOT_STRATEGY_LABEL = "Bot Runner";

function makeDecisionId(): string {
  return `bot-${Date.now()}`;
}

interface CandidateRiskResult {
  riskChecks: BotRiskCheck[];
  price: number;
  quantity: number;
  status: MarketDataStatus;
  quote: MarketQuote | undefined;
}

// Runs all five hardcoded risk checks for one candidate. Every check always runs and is always
// returned, whether it passed or not — the decision trace shows what would have needed to be
// true, not just the first failure.
async function evaluateCandidateRisk(
  candidate: StrategyScore,
  side: PaperTradeSide,
  openTrades: PaperTrade[],
  instrument: Instrument,
): Promise<CandidateRiskResult> {
  const riskChecks: BotRiskCheck[] = [];

  riskChecks.push({
    name: "Max one trade per scan",
    passed: true,
    detail: "Only one trade may be opened per scan; this check is informational.",
  });

  const confidencePassed = candidate.overallConfidence >= MIN_CONFIDENCE;
  riskChecks.push({
    name: "Minimum confidence",
    passed: confidencePassed,
    detail: `${candidate.overallConfidence}% confidence ${
      confidencePassed ? "meets" : "is below"
    } the ${MIN_CONFIDENCE}% minimum.`,
  });

  const agreementPassed = candidate.agreement !== "Conflict";
  riskChecks.push({
    name: "Agreement not Conflict",
    passed: agreementPassed,
    detail: `Agreement is ${candidate.agreement}.`,
  });

  const hasDuplicate = openTrades.some(
    (trade) =>
      trade.status === "Open" &&
      trade.instrumentSymbol === candidate.instrumentSymbol &&
      trade.side === side,
  );
  riskChecks.push({
    name: "No duplicate open trade",
    passed: !hasDuplicate,
    detail: hasDuplicate
      ? `An open ${side} trade already exists for ${candidate.instrumentSymbol}.`
      : `No existing open ${side} trade for ${candidate.instrumentSymbol}.`,
  });

  // Fetched regardless of the checks above, via the same MarketDataProvider every other trade
  // entry uses (Build 1.2.0) — the trace always shows the real price considered, even when the
  // candidate is rejected.
  const quotes = await getMarketDataProvider().getQuotes([candidate.instrumentSymbol]);
  const status = getMarketDataProvider().getStatus();
  const quote = quotes[0];
  const price = quote?.price ?? instrument.price;

  // Floor, not round — a hard cap risk check needs a size that never exceeds the limit, unlike
  // the ~£250 *target* sizing used elsewhere (quantityForEntryPrice), which rounds to the
  // nearest share and can land slightly over target for expensive instruments.
  const quantity = Math.floor(MAX_NOTIONAL_GBP / price);
  const notional = quantity * price;
  const notionalPassed = quantity >= 1 && notional <= MAX_NOTIONAL_GBP;
  riskChecks.push({
    name: "Max notional per trade",
    passed: notionalPassed,
    detail:
      quantity >= 1
        ? `${quantity} share(s) at ${price.toFixed(2)} = ${notional.toFixed(2)}, within the £${MAX_NOTIONAL_GBP} cap.`
        : `Price ${price.toFixed(2)} alone exceeds the £${MAX_NOTIONAL_GBP} cap — no valid position size.`,
  });

  return { riskChecks, price, quantity, status, quote };
}

function buildBotTrade(params: {
  candidate: StrategyScore;
  side: PaperTradeSide;
  price: number;
  quantity: number;
  status: MarketDataStatus;
  quote: MarketQuote | undefined;
  timestamp: string;
  decisionId: string;
  scanId: string;
  riskChecks: BotRiskCheck[];
}): PaperTrade {
  const { candidate, side, price, quantity, status, quote, timestamp, decisionId, scanId, riskChecks } =
    params;

  return {
    id: `trade-bot-${candidate.instrumentSymbol}-${Date.now()}`,
    instrumentSymbol: candidate.instrumentSymbol,
    instrumentName: candidate.instrumentName,
    side,
    quantity,
    entryPrice: price,
    timestamp,
    signalConfidence: candidate.overallConfidence,
    strategyName: BOT_STRATEGY_LABEL,
    status: "Open",
    reason: `Bot Runner opened this trade automatically: ${candidate.primaryStrategyName} led with the highest confidence (${candidate.overallConfidence}%), agreement was ${candidate.agreement}, and every risk check passed.`,
    source: "Bot",
    sourceBotDecisionId: decisionId,
    scanId,
    entryPriceSource: status.source,
    entryPriceProvider: status.provider,
    entryPriceTimestamp: quote?.lastUpdated ?? timestamp,
    primaryStrategy: candidate.primaryStrategyName,
    strategyAgreement: candidate.agreement,
    overallConfidence: candidate.overallConfidence,
    evidenceSummary: candidate.agreementExplanation,
    riskChecksSummary: riskChecks
      .map((check) => `${check.name}: ${check.passed ? "passed" : "failed"} (${check.detail})`)
      .join(" · "),
  };
}

// One scan: rank every tradeable opportunity the Strategy Engine finds, then walk down the ranked
// list — evaluating risk checks for each candidate in turn (Mission 1.1) — until one passes every
// check and a single paper trade is opened, or every candidate has been rejected. The loop breaks
// the instant a candidate passes, so "max one trade per scan" is still satisfied structurally, not
// by a counter. Pure aside from one live price fetch per candidate evaluated — never touches
// persistence itself; the caller adds the trade and logs the decision.
export async function runBotScan(
  instruments: Instrument[],
  openTrades: PaperTrade[],
  scanId: string,
): Promise<BotScanResult> {
  const startedAt = performance.now();
  const decisionId = makeDecisionId();
  const timestamp = new Date().toISOString();
  const instrumentsScanned = instruments.map((instrument) => instrument.symbol);
  const trace: BotTraceStep[] = [];

  trace.push({
    step: "Scan started",
    detail: `${scanId} started, scanning ${instruments.length} instrument(s).`,
  });
  trace.push({
    step: "Instruments scanned",
    detail: instrumentsScanned.length > 0 ? instrumentsScanned.join(", ") : "None",
  });

  const scores = getStrategyEngine().evaluateAll(instruments);

  // A "valid opportunity" has a clear directional call the app already considers tradeable —
  // this excludes Hold and Avoid before risk checks ever run, the same bar a human applies via
  // the Paper Trade button elsewhere in the app.
  const rankedCandidates = scores
    .filter(
      (score) => score.overallSignal !== "HOLD" && isTradeableRecommendation(score.overallRecommendation),
    )
    .sort((a, b) => b.overallConfidence - a.overallConfidence);

  if (rankedCandidates.length === 0) {
    trace.push({
      step: "Candidates ranked",
      detail: "No tradeable candidates — every instrument evaluated to Hold or Avoid.",
    });
    trace.push({
      step: "Scan completed",
      detail: "No trade opened — no tradeable candidates this scan.",
    });

    return {
      decision: {
        id: decisionId,
        scanId,
        timestamp,
        instrumentsScanned,
        candidates: [],
        selectedInstrument: null,
        selectedInstrumentName: null,
        actionTaken: "No Trade",
        reason: "No tradeable opportunities this scan — every instrument evaluated to Hold or Avoid.",
        trace,
        tradeCreated: false,
        executionTimeMs: performance.now() - startedAt,
      },
      trade: null,
    };
  }

  trace.push({
    step: "Candidates ranked",
    detail: `${rankedCandidates.length} candidate(s) ranked by confidence: ${rankedCandidates
      .map((candidate) => `${candidate.instrumentSymbol} (${candidate.overallConfidence}%)`)
      .join(", ")}.`,
  });

  const candidateEvaluations: BotCandidateEvaluation[] = [];
  let openedTrade: PaperTrade | null = null;
  let selected: StrategyScore | null = null;

  for (const candidate of rankedCandidates) {
    const rank = candidateEvaluations.length + 1;
    const side = sideForRecommendation(candidate.overallRecommendation);

    trace.push({
      step: "Candidate evaluated",
      detail: `#${rank} ${candidate.instrumentSymbol} — ${candidate.overallConfidence}% confidence, ${candidate.agreement}.`,
    });

    const instrument = getInstrumentBySymbol(candidate.instrumentSymbol);

    if (!instrument) {
      // Structurally unreachable — every score comes from evaluating this same instruments list —
      // but handled explicitly rather than asserted, consistent with strict null-checking
      // elsewhere in this codebase.
      const rejectionReason = `Could not find instrument data for ${candidate.instrumentSymbol}.`;
      candidateEvaluations.push({
        rank,
        instrumentSymbol: candidate.instrumentSymbol,
        instrumentName: candidate.instrumentName,
        side,
        confidence: candidate.overallConfidence,
        agreement: candidate.agreement,
        riskChecks: [],
        outcome: "Rejected",
        rejectionReason,
      });
      trace.push({ step: "Candidate rejected", detail: `${candidate.instrumentSymbol}: ${rejectionReason}` });
      continue;
    }

    const { riskChecks, price, quantity, status, quote } = await evaluateCandidateRisk(
      candidate,
      side,
      openTrades,
      instrument,
    );
    const failedChecks = riskChecks.filter((check) => !check.passed);

    trace.push({
      step: "Risk checks evaluated",
      detail: `${candidate.instrumentSymbol}: ${riskChecks.length - failedChecks.length}/${riskChecks.length} risk checks passed.`,
    });

    if (failedChecks.length === 0) {
      selected = candidate;
      openedTrade = buildBotTrade({
        candidate,
        side,
        price,
        quantity,
        status,
        quote,
        timestamp,
        decisionId,
        scanId,
        riskChecks,
      });
      candidateEvaluations.push({
        rank,
        instrumentSymbol: candidate.instrumentSymbol,
        instrumentName: candidate.instrumentName,
        side,
        confidence: candidate.overallConfidence,
        agreement: candidate.agreement,
        riskChecks,
        outcome: "Trade Opened",
      });
      trace.push({
        step: "Trade opened",
        detail: `Opened a ${side} trade for ${candidate.instrumentSymbol}.`,
      });
      break;
    }

    const rejectionReason = `Failed: ${failedChecks.map((check) => check.name).join(", ")}.`;
    candidateEvaluations.push({
      rank,
      instrumentSymbol: candidate.instrumentSymbol,
      instrumentName: candidate.instrumentName,
      side,
      confidence: candidate.overallConfidence,
      agreement: candidate.agreement,
      riskChecks,
      outcome: "Rejected",
      rejectionReason,
    });
    trace.push({ step: "Candidate rejected", detail: `${candidate.instrumentSymbol}: ${rejectionReason}` });
  }

  const executionTimeMs = performance.now() - startedAt;

  if (openedTrade && selected) {
    const rejectedCount = candidateEvaluations.length - 1;
    trace.push({
      step: "Scan completed",
      detail: `Trade opened for ${selected.instrumentSymbol} after evaluating ${candidateEvaluations.length} candidate(s) (${rejectedCount} rejected first).`,
    });

    return {
      decision: {
        id: decisionId,
        scanId,
        timestamp,
        instrumentsScanned,
        candidates: candidateEvaluations,
        selectedInstrument: selected.instrumentSymbol,
        selectedInstrumentName: selected.instrumentName,
        actionTaken: "Trade Opened",
        reason:
          rejectedCount > 0
            ? `Opened a ${openedTrade.side} trade for ${selected.instrumentSymbol} after ${rejectedCount} higher-ranked candidate(s) failed risk checks.`
            : `Opened a ${openedTrade.side} trade for ${selected.instrumentSymbol}: highest-ranked opportunity at ${selected.overallConfidence}% confidence (${selected.agreement}), all risk checks passed.`,
        trace,
        tradeCreated: true,
        createdTradeId: openedTrade.id,
        executionTimeMs,
      },
      trade: openedTrade,
    };
  }

  trace.push({
    step: "Scan completed",
    detail: `No trade opened — all ${candidateEvaluations.length} candidate(s) failed risk checks.`,
  });

  return {
    decision: {
      id: decisionId,
      scanId,
      timestamp,
      instrumentsScanned,
      candidates: candidateEvaluations,
      selectedInstrument: null,
      selectedInstrumentName: null,
      actionTaken: "No Trade",
      reason: `All ${candidateEvaluations.length} candidate(s) failed risk checks — no trade opened this scan.`,
      trace,
      tradeCreated: false,
      executionTimeMs,
    },
    trade: null,
  };
}
