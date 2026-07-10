import type {
  Instrument,
  MarketDataStatus,
  MarketQuote,
  PaperTrade,
  PaperTradeSide,
  PortfolioExposureSnapshot,
  PositionAction,
  StrategyScore,
} from "@/lib/types";
import { getInstrumentBySymbol } from "@/lib/mock/instruments";
import { getStrategyEngine } from "@/lib/strategy-engine";
import { getMarketDataProvider } from "@/lib/market-data/get-market-data-provider";
import type { HistoricalMarketDataProvider } from "@/lib/market-data/historical-market-data-provider";
import { isTradeableRecommendation, sideForRecommendation } from "@/lib/utils/paper-trade";
import { buildExposureSnapshot, evaluatePortfolioRisk } from "./portfolio-risk";
import { buildPositionContext, evaluatePosition } from "./position-manager";
import type {
  BotCandidateEvaluation,
  BotDecision,
  BotRiskCheck,
  BotScanResult,
  BotTraceStep,
  ScanTriggerType,
} from "./types";

// Hardcoded, disclosed, and deliberately simple — this is Mission 1/1.1/2/3/4, not a configurable
// risk engine. Adjusting any of these means editing this file, not a settings screen.
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

// Runs the four hardcoded *individual* risk checks for one candidate. Every check always runs and
// is always returned, whether it passed or not — the decision trace shows what would have needed
// to be true, not just the first failure. Duplicate-instrument handling moved to the Position
// Manager (Mission 3) — a duplicate symbol/side is no longer blindly rejected here, it's
// classified (NEW_POSITION/ADD_TO_POSITION/HOLD_POSITION/BLOCK_POSITION) — see runBotScan.
async function evaluateCandidateRisk(
  candidate: StrategyScore,
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
  portfolioRiskChecks: BotRiskCheck[];
  portfolioSnapshot: PortfolioExposureSnapshot;
  positionAction: PositionAction;
  existingPositionValue: number;
  positionValueAfterTrade: number;
  positionDecisionReason: string;
}): PaperTrade {
  const {
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
    portfolioRiskChecks,
    portfolioSnapshot,
    positionAction,
    existingPositionValue,
    positionValueAfterTrade,
    positionDecisionReason,
  } = params;

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
    reason: `Bot Runner opened this trade automatically: ${candidate.primaryStrategyName} led with the highest confidence (${candidate.overallConfidence}%), agreement was ${candidate.agreement}, position action was ${positionAction}, and every individual, position, and portfolio risk check passed.`,
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
    portfolioRiskStatus: "Passed",
    portfolioRiskSummary: portfolioRiskChecks
      .map((check) => `${check.name}: ${check.passed ? "passed" : "failed"} (${check.detail})`)
      .join(" · "),
    portfolioExposureSnapshot: portfolioSnapshot,
    positionAction,
    existingPositionValue,
    positionValueAfterTrade,
    positionDecisionReason,
  };
}

// One scan: rank every tradeable opportunity the Strategy Engine finds, then walk down the ranked
// list — evaluating individual risk checks, then (Mission 3) the Position Manager's classification
// against any existing position in that instrument, then (Mission 2) portfolio-level risk — for
// each candidate in turn, until one passes all three tiers and a single paper trade is opened, or
// every candidate has been rejected. The loop breaks the instant a candidate passes, so "max one
// trade per scan" is still satisfied structurally, not by a counter. Pure aside from one live
// price fetch per candidate evaluated — never touches persistence itself; the caller adds the
// trade and logs the decision.
export async function runBotScan(
  instruments: Instrument[],
  trades: PaperTrade[],
  scanId: string,
  triggerType: ScanTriggerType,
  // Optional — defaults to the client-safe singleton inside evaluateAllWithHistory() when
  // omitted. The VPS worker passes its own server-only, Alpha-Vantage-capable provider (Maintenance
  // 1.11.2); the browser never passes one, so nothing here changes for existing callers.
  historicalMarketDataProvider?: HistoricalMarketDataProvider,
): Promise<BotScanResult> {
  const startedAt = performance.now();
  const decisionId = makeDecisionId();
  const timestamp = new Date().toISOString();
  const instrumentsScanned = instruments.map((instrument) => instrument.symbol);
  const trace: BotTraceStep[] = [];

  // One baseline for the whole scan — every candidate is checked against the portfolio as it
  // stands right now, since at most one trade can ever open per scan.
  const portfolioSnapshotBefore = buildExposureSnapshot(trades);

  trace.push({
    step: "Scan started",
    detail: `${scanId} started, scanning ${instruments.length} instrument(s).`,
  });
  trace.push({
    step: "Instruments scanned",
    detail: instrumentsScanned.length > 0 ? instrumentsScanned.join(", ") : "None",
  });
  trace.push({
    step: "Portfolio snapshot captured",
    detail: `${portfolioSnapshotBefore.totalOpenTrades} open trade(s), £${portfolioSnapshotBefore.totalCapitalDeployed.toFixed(2)} deployed, £${portfolioSnapshotBefore.availableCash.toFixed(2)} available cash.`,
  });

  // Mission 9 — real SMA/EMA/RSI/momentum/volume-ratio from 90 days of OHLCV history when
  // available, falling back per-instrument to the original snapshot-derived proxies otherwise
  // (buildStrategyContextFromHistory/buildStrategyContext, src/lib/strategy-engine/build-context.ts).
  // The three strategies, the ranking, and every risk rule below are completely unchanged — only
  // the confidence/agreement values feeding into them may now differ, since they're computed from
  // real history rather than a single day's snapshot.
  const scores = await getStrategyEngine().evaluateAllWithHistory(instruments, historicalMarketDataProvider);

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
        triggerType,
        instrumentsScanned,
        candidates: [],
        portfolioSnapshotBefore,
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
        primaryStrategyName: candidate.primaryStrategyName,
        evidenceSummary: candidate.agreementExplanation,
        individualRiskChecks: [],
        individualPassed: false,
        positionEvaluated: false,
        positionChecks: [],
        portfolioRiskEvaluated: false,
        portfolioRiskChecks: [],
        portfolioPassed: false,
        outcome: "Rejected",
        rejectionReason,
      });
      trace.push({ step: "Candidate rejected", detail: `${candidate.instrumentSymbol}: ${rejectionReason}` });
      continue;
    }

    const { riskChecks, price, quantity, status, quote } = await evaluateCandidateRisk(candidate, instrument);
    const failedIndividualChecks = riskChecks.filter((check) => !check.passed);
    const individualPassed = failedIndividualChecks.length === 0;

    trace.push({
      step: "Risk checks evaluated",
      detail: `${candidate.instrumentSymbol}: ${riskChecks.length - failedIndividualChecks.length}/${riskChecks.length} individual risk checks passed.`,
    });

    if (!individualPassed) {
      const rejectionReason = `Individual checks failed: ${failedIndividualChecks.map((check) => check.name).join(", ")}.`;
      candidateEvaluations.push({
        rank,
        instrumentSymbol: candidate.instrumentSymbol,
        instrumentName: candidate.instrumentName,
        side,
        confidence: candidate.overallConfidence,
        agreement: candidate.agreement,
        primaryStrategyName: candidate.primaryStrategyName,
        evidenceSummary: candidate.agreementExplanation,
        price,
        individualRiskChecks: riskChecks,
        individualPassed: false,
        positionEvaluated: false,
        positionChecks: [],
        portfolioRiskEvaluated: false,
        portfolioRiskChecks: [],
        portfolioPassed: false,
        outcome: "Rejected",
        rejectionReason,
      });
      trace.push({ step: "Candidate rejected", detail: `${candidate.instrumentSymbol}: ${rejectionReason}` });
      continue;
    }

    // Position Manager (Mission 3) — classifies against any existing position in this instrument.
    // Only evaluated once individual checks pass, same "no point checking the next tier" rule
    // Mission 2 established for portfolio risk.
    const candidateNotional = quantity * price;
    const positionContext = buildPositionContext(candidate.instrumentSymbol, trades);
    const positionDecision = evaluatePosition({
      context: positionContext,
      trades,
      candidateSide: side,
      candidateConfidence: candidate.overallConfidence,
      candidateAgreement: candidate.agreement,
      candidateNotional,
    });

    trace.push({
      step: "Position evaluated",
      detail:
        `${candidate.instrumentSymbol}: existing position £${positionDecision.existingPositionValue.toFixed(2)}` +
        (positionDecision.latestBotConfidence !== undefined
          ? `, previous confidence ${positionDecision.latestBotConfidence}% vs current ${candidate.overallConfidence}%`
          : "") +
        (positionDecision.latestBotAgreement !== undefined
          ? `, previous agreement ${positionDecision.latestBotAgreement} vs current ${candidate.agreement}`
          : "") +
        (positionContext.minutesSinceLastOpenTrade !== undefined
          ? `, ${positionContext.minutesSinceLastOpenTrade.toFixed(1)} minute(s) since last trade`
          : "") +
        ".",
    });
    trace.push({
      step: "Position decision",
      detail: `${candidate.instrumentSymbol}: ${positionDecision.action} — ${positionDecision.reason}`,
    });

    const positionAllowsTrade =
      positionDecision.action === "NEW_POSITION" || positionDecision.action === "ADD_TO_POSITION";

    if (!positionAllowsTrade) {
      const rejectionReason = `Position Manager: ${positionDecision.action} — ${positionDecision.reason}`;
      candidateEvaluations.push({
        rank,
        instrumentSymbol: candidate.instrumentSymbol,
        instrumentName: candidate.instrumentName,
        side,
        confidence: candidate.overallConfidence,
        agreement: candidate.agreement,
        primaryStrategyName: candidate.primaryStrategyName,
        evidenceSummary: candidate.agreementExplanation,
        price,
        individualRiskChecks: riskChecks,
        individualPassed: true,
        positionEvaluated: true,
        positionAction: positionDecision.action,
        positionChecks: positionDecision.checks,
        existingPositionValue: positionDecision.existingPositionValue,
        positionValueAfterTrade: positionDecision.positionValueAfterTrade,
        positionDecisionReason: positionDecision.reason,
        portfolioRiskEvaluated: false,
        portfolioRiskChecks: [],
        portfolioPassed: false,
        outcome: "Rejected",
        rejectionReason,
      });
      trace.push({ step: "Candidate rejected", detail: `${candidate.instrumentSymbol}: ${rejectionReason}` });
      continue;
    }

    // Portfolio risk (Mission 2) — only reached once the Position Manager has tentatively
    // allowed a new position or an add. If it fails here, the position action is overridden to
    // BLOCK_POSITION so the final recorded decision stays accurate ("portfolio risk fails" is one
    // of the Position Manager's own block conditions per the mission spec, evaluated as its own
    // pipeline stage rather than duplicated inside position-manager.ts).
    const portfolioResult = evaluatePortfolioRisk(
      portfolioSnapshotBefore,
      candidate.instrumentSymbol,
      side,
      candidateNotional,
    );
    const failedPortfolioChecks = portfolioResult.checks.filter((check) => !check.passed);

    trace.push({
      step: "Portfolio risk evaluated",
      detail: `${candidate.instrumentSymbol}: ${portfolioResult.checks.length - failedPortfolioChecks.length}/${portfolioResult.checks.length} portfolio risk checks passed.`,
    });

    if (!portfolioResult.passed) {
      const rejectionReason = `Position Manager tentatively allowed ${positionDecision.action}, but portfolio risk failed: ${failedPortfolioChecks
        .map((check) => check.name)
        .join(", ")} — ${failedPortfolioChecks.map((check) => check.detail).join(" ")}`;
      candidateEvaluations.push({
        rank,
        instrumentSymbol: candidate.instrumentSymbol,
        instrumentName: candidate.instrumentName,
        side,
        confidence: candidate.overallConfidence,
        agreement: candidate.agreement,
        primaryStrategyName: candidate.primaryStrategyName,
        evidenceSummary: candidate.agreementExplanation,
        price,
        individualRiskChecks: riskChecks,
        individualPassed: true,
        positionEvaluated: true,
        positionAction: "BLOCK_POSITION",
        positionChecks: positionDecision.checks,
        existingPositionValue: positionDecision.existingPositionValue,
        positionValueAfterTrade: positionDecision.positionValueAfterTrade,
        positionDecisionReason: `${positionDecision.reason} (overridden to BLOCK_POSITION: portfolio risk failed)`,
        portfolioRiskEvaluated: true,
        portfolioRiskChecks: portfolioResult.checks,
        portfolioPassed: false,
        outcome: "Rejected",
        rejectionReason,
      });
      trace.push({ step: "Candidate rejected", detail: `${candidate.instrumentSymbol}: ${rejectionReason}` });
      continue;
    }

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
      portfolioRiskChecks: portfolioResult.checks,
      portfolioSnapshot: portfolioSnapshotBefore,
      positionAction: positionDecision.action,
      existingPositionValue: positionDecision.existingPositionValue,
      positionValueAfterTrade: positionDecision.positionValueAfterTrade,
      positionDecisionReason: positionDecision.reason,
    });
    candidateEvaluations.push({
      rank,
      instrumentSymbol: candidate.instrumentSymbol,
      instrumentName: candidate.instrumentName,
      side,
      confidence: candidate.overallConfidence,
      agreement: candidate.agreement,
      primaryStrategyName: candidate.primaryStrategyName,
      evidenceSummary: candidate.agreementExplanation,
      price,
      individualRiskChecks: riskChecks,
      individualPassed: true,
      positionEvaluated: true,
      positionAction: positionDecision.action,
      positionChecks: positionDecision.checks,
      existingPositionValue: positionDecision.existingPositionValue,
      positionValueAfterTrade: positionDecision.positionValueAfterTrade,
      positionDecisionReason: positionDecision.reason,
      portfolioRiskEvaluated: true,
      portfolioRiskChecks: portfolioResult.checks,
      portfolioPassed: true,
      outcome: "Trade Opened",
    });
    trace.push({
      step: "Trade opened",
      detail: `Opened a ${side} trade for ${candidate.instrumentSymbol} (${positionDecision.action}).`,
    });
    break;
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
        triggerType,
        instrumentsScanned,
        candidates: candidateEvaluations,
        portfolioSnapshotBefore,
        selectedInstrument: selected.instrumentSymbol,
        selectedInstrumentName: selected.instrumentName,
        actionTaken: "Trade Opened",
        reason:
          rejectedCount > 0
            ? `Opened a ${openedTrade.side} trade for ${selected.instrumentSymbol} (${openedTrade.positionAction}) after ${rejectedCount} higher-ranked candidate(s) failed individual, position, or portfolio risk checks.`
            : `Opened a ${openedTrade.side} trade for ${selected.instrumentSymbol} (${openedTrade.positionAction}): highest-ranked opportunity at ${selected.overallConfidence}% confidence (${selected.agreement}), all individual, position, and portfolio risk checks passed.`,
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
      triggerType,
      instrumentsScanned,
      candidates: candidateEvaluations,
      portfolioSnapshotBefore,
      selectedInstrument: null,
      selectedInstrumentName: null,
      actionTaken: "No Trade",
      reason: `All ${candidateEvaluations.length} candidate(s) failed individual, position, or portfolio risk checks — no trade opened this scan.`,
      trace,
      tradeCreated: false,
      executionTimeMs,
    },
    trade: null,
  };
}
