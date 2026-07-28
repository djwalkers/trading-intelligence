import type { AuditTrail } from "../audit-trail";
import type { InternalStrategy, OrderSizingMode } from "../types";
import type { PaperBroker } from "../paper-broker";
import type { MarketDataProvider } from "../market-data/market-data-provider";
import type { TradeCandidateRepository } from "../trade-approval/trade-candidate-repository";
import type { TradePerformanceRepository } from "../trade-performance/trade-performance-repository";
import { computeInstrumentPerformance, computePerformanceByConfidenceBand } from "../trade-performance/compute-instrument-performance";
import { calculateNotional } from "../order-sizing";
import { resolveMarketSession } from "../market-session";
import { buildMarketDecisionContext } from "../build-market-decision-context";
import type { MarketHoursPolicy } from "./market-hours-policy";
import { proposeUniverse, type HermesAgentAdapterConfig } from "../hermes-agent/hermes-agent-adapter";
import type { HermesCliRunner } from "../hermes-agent/hermes-cli-runner";
import { selectTopProposals } from "../hermes-agent/rank-proposals";
import { buildHermesUniverseInput } from "../hermes-agent/build-hermes-universe-input";
import type { HermesAgentStrategy } from "../hermes-agent/hermes-agent-strategy";
import type { HermesInstrumentSnapshot, ValidatedHermesProposal } from "../hermes-agent/types";

// Prototype 1.0 — official Hermes Agent decision integration. THE multi-instrument DECISION
// orchestrator: one Hermes call per scan (never one per instrument), producing a ranked/selected
// proposal set and setting it on the shared HermesAgentStrategy instance.
//
// Deliberately narrow (Phase 3 redesign): this module ONLY decides which instruments Hermes gets
// to propose for and which proposals are accepted this scan. It does NOT run recovery,
// reconciliation, candidate repair, duplicate suppression, or candidate creation itself any more —
// those all now happen once per instrument inside TradingRuntime's own per-instrument cycle
// (runtime/trading-runtime.ts's runInstrumentCycle), reusing the EXACT SAME existing, unmodified
// logic that already ran for a single instrument, now looped across the whole configured universe.
// Running reconciliation here AND again in the per-instrument loop would mean two broker
// reconciliation passes per cycle — this scanner instead reads the broker's own already-current
// `getOpenPositions()` snapshot directly (one shared read for the whole scan; never re-fetched per
// instrument), which is exactly the same broker-level truth reconciliation itself is ultimately
// grounded in, without performing a second authoritative reconciliation pass.
//
// checkForDuplicateEntry is also no longer called here: the per-instrument loop's own existing
// fresh-candidate-creation step already calls it, immediately before createTradeCandidateForDecision
// — calling it twice would be duplicated business logic for no additional safety.

export interface UniverseScannerDeps {
  broker: PaperBroker;
  marketDataProvider: MarketDataProvider;
  /** Read-only here — used only to resolve a completed trade's originating confidence for
   * performance-by-confidence-band context. No candidate is created or mutated by this module. */
  tradeCandidateRepository: TradeCandidateRepository;
  tradePerformance?: { repository: TradePerformanceRepository };
  auditTrail: AuditTrail;
  executionRunId: string;
  /** The InternalStrategy metadata HermesAgentStrategy is registered under (see
   * hermes-agent-strategy.ts's own getHermesAgentInternalStrategy()). */
  strategy: InternalStrategy;
  /** The SAME shared HermesAgentStrategy instance MarketDecisionEngine's default registry resolves
   * `strategy.strategyId` to — this scanner calls setScanProposals() on it once per scan. */
  hermesAgentStrategy: HermesAgentStrategy;
  hermesAdapterConfig: HermesAgentAdapterConfig;
  hermesCliRunner: HermesCliRunner;
  instrumentUniverse: string[];
  maxProposalsPerScan: number;
  maxOpenPositions: number;
  maxOpenPositionsPerInstrument: number;
  orderSizingMode: OrderSizingMode;
  /** Applied only to non-crypto instruments — crypto is always treated as 24/7 eligible (see
   * resolveMarketSession's own CRYPTO_SYMBOLS list, reused here rather than duplicated). */
  equityMarketHoursPolicy: MarketHoursPolicy;
  now: Date;
}

export interface UniverseScanResult {
  eligibleInstrumentCount: number;
  skippedInstruments: Array<{ instrument: string; reason: string }>;
  selectedProposals: ValidatedHermesProposal[];
  hermesRejected?: { reason: string };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs exactly one multi-instrument scan: builds a structured snapshot for every eligible
 * instrument (from already-available broker/market-data state — no reconciliation pass), makes ONE
 * Hermes call for the whole universe, validates/ranks/selects proposals, and sets the selection on
 * the shared HermesAgentStrategy instance. A single instrument's data-fetch failure is isolated
 * (recorded, skipped) and never aborts the rest of the scan. Never calls the broker to place/close
 * an order, never sends a Telegram message, never creates a candidate directly. */
export async function runUniverseScan(deps: UniverseScannerDeps): Promise<UniverseScanResult> {
  const {
    broker,
    marketDataProvider,
    tradeCandidateRepository,
    tradePerformance,
    auditTrail,
    executionRunId,
    strategy,
    hermesAgentStrategy,
    hermesAdapterConfig,
    hermesCliRunner,
    instrumentUniverse,
    maxProposalsPerScan,
    maxOpenPositions,
    maxOpenPositionsPerInstrument,
    orderSizingMode,
    equityMarketHoursPolicy,
    now,
  } = deps;

  const skippedInstruments: Array<{ instrument: string; reason: string }> = [];
  const instrumentSnapshots: HermesInstrumentSnapshot[] = [];

  // One shared broker-position read for the entire scan — never re-fetched per instrument (see
  // this file's own top-of-file comment on why this replaces a second reconciliation pass).
  const openPositions = broker.getOpenPositions();
  const positionByInstrument = new Map(openPositions.map((p) => [p.instrument, p]));

  let performanceByConfidenceBand;
  let allPerformanceRecords: Awaited<ReturnType<TradePerformanceRepository["list"]>> = [];
  if (tradePerformance) {
    try {
      allPerformanceRecords = await tradePerformance.repository.list({});
    } catch {
      allPerformanceRecords = [];
    }
  }

  for (const instrument of instrumentUniverse) {
    try {
      const isCrypto = resolveMarketSession(instrument, now) === "Crypto Always Open";
      const assetClass: "crypto" | "equity" = isCrypto ? "crypto" : "equity";
      const marketHoursEligible = isCrypto || equityMarketHoursPolicy.isMarketOpen(now);

      if (!marketHoursEligible) {
        instrumentSnapshots.push({
          instrument,
          assetClass,
          marketHoursEligible: false,
          quote: { bid: 0, ask: 0, spread: 0, midPrice: 0 },
          unavailableReason: "Outside configured equity market hours.",
          currentPosition: undefined,
        });
        skippedInstruments.push({ instrument, reason: "outside-market-hours" });
        continue;
      }

      const { context } = await buildMarketDecisionContext(marketDataProvider, broker, instrument, strategy);
      const recentPerformance = computeInstrumentPerformance(instrument, allPerformanceRecords);
      const brokerPosition = positionByInstrument.get(instrument);

      instrumentSnapshots.push({
        instrument,
        assetClass,
        marketHoursEligible: true,
        quote: { bid: context.bid, ask: context.ask, spread: context.spread, midPrice: context.midPrice },
        recentCandles: context.recentCandles.map((c) => ({
          timestamp: c.timestamp,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          volume: 0,
        })),
        indicators: { ema20: context.ema20, ema50: context.ema50, rsi14: context.rsi14, atr14: context.atr14, trend: context.trend },
        currentPosition: brokerPosition ? { side: brokerPosition.side, quantity: brokerPosition.quantity, entryPrice: brokerPosition.entryPrice } : undefined,
        recentPerformance,
      });
    } catch (error) {
      // Isolates a single instrument's own unexpected failure (e.g. a market-data fetch throwing)
      // from the rest of the scan — the mission's own explicit requirement.
      instrumentSnapshots.push({
        instrument,
        assetClass: resolveMarketSession(instrument, now) === "Crypto Always Open" ? "crypto" : "equity",
        marketHoursEligible: false,
        quote: { bid: 0, ask: 0, spread: 0, midPrice: 0 },
        unavailableReason: `Unexpected error: ${toErrorMessage(error)}`,
        currentPosition: undefined,
      });
      skippedInstruments.push({ instrument, reason: toErrorMessage(error) });
    }
  }

  const eligibleInstrumentCount = instrumentSnapshots.filter((s) => s.marketHoursEligible && !s.unavailableReason).length;

  const account = broker.getAccount();
  const totalInvestedExposure = openPositions.reduce((sum, p) => sum + calculateNotional(orderSizingMode, p.quantity, p.entryPrice), 0);

  if (allPerformanceRecords.length > 0) {
    const candidateConfidenceById = new Map<string, number>();
    for (const record of allPerformanceRecords) {
      if (record.candidateId) {
        const candidate = await tradeCandidateRepository.getById(record.candidateId);
        if (candidate) candidateConfidenceById.set(record.candidateId, candidate.confidence);
      }
    }
    performanceByConfidenceBand = computePerformanceByConfidenceBand(allPerformanceRecords, candidateConfidenceById);
  }

  const universeInput = buildHermesUniverseInput({
    scanTimestamp: now.toISOString(),
    universe: instrumentUniverse,
    instrumentSnapshots,
    portfolio: {
      availableCash: account.cashBalance,
      totalInvestedExposure,
      openPositionCount: openPositions.length,
      maxOpenPositions,
      maxOpenPositionsPerInstrument,
      recentDrawdown: 0,
    },
    performanceByConfidenceBand,
  });

  const hermesResult = await proposeUniverse(universeInput, hermesAdapterConfig, hermesCliRunner);

  if (!hermesResult.ok) {
    await auditTrail.record({
      timestamp: now.toISOString(),
      eventType: "HERMES_RESPONSE_REJECTED",
      executionRunId,
      strategyId: strategy.strategyId,
      details: { reason: hermesResult.reason, stage: hermesResult.stage },
    });
    hermesAgentStrategy.setScanProposals([]);
    await auditTrail.record({
      timestamp: now.toISOString(),
      eventType: "UNIVERSE_SCAN_COMPLETED",
      executionRunId,
      strategyId: strategy.strategyId,
      details: { eligibleInstrumentCount, selectedProposalCount: 0, hermesRejected: true },
    });
    return { eligibleInstrumentCount, skippedInstruments, selectedProposals: [], hermesRejected: { reason: hermesResult.reason } };
  }

  const ranked = selectTopProposals(hermesResult.proposals, maxProposalsPerScan);

  // Defence in depth: never trust Hermes's own respect for marketHoursEligible/unavailableReason —
  // re-check against what THIS scan already determined, independently.
  const eligibleInstrumentSet = new Set(
    instrumentSnapshots.filter((s) => s.marketHoursEligible && !s.unavailableReason).map((s) => s.instrument),
  );

  let projectedOpenCount = openPositions.length;
  const selected: ValidatedHermesProposal[] = [];
  for (const proposal of ranked) {
    if (!eligibleInstrumentSet.has(proposal.instrument)) continue;

    const brokerPosition = positionByInstrument.get(proposal.instrument);
    if (proposal.action === "BUY") {
      if (brokerPosition) continue; // already at the per-instrument ceiling (max 1 open position per instrument)
      if (projectedOpenCount >= maxOpenPositions) continue; // portfolio-wide ceiling
      projectedOpenCount += 1;
      selected.push(proposal);
    } else {
      // SELL: only ever closes an existing long — never opens a short (not supported). Fails
      // closed (skips the proposal) when there is no existing long position for this instrument.
      if (!brokerPosition || brokerPosition.side !== "BUY") continue;
      selected.push(proposal);
    }
  }

  hermesAgentStrategy.setScanProposals(selected);

  for (const proposal of selected) {
    await auditTrail.record({
      timestamp: now.toISOString(),
      eventType: "HERMES_PROPOSAL_SELECTED",
      executionRunId,
      strategyId: strategy.strategyId,
      instrument: proposal.instrument,
      details: { action: proposal.action, confidence: proposal.confidence },
    });
  }

  await auditTrail.record({
    timestamp: now.toISOString(),
    eventType: "UNIVERSE_SCAN_COMPLETED",
    executionRunId,
    strategyId: strategy.strategyId,
    details: { eligibleInstrumentCount, selectedProposalCount: selected.length },
  });

  return { eligibleInstrumentCount, skippedInstruments, selectedProposals: selected };
}

/** Thin stateful wrapper preventing overlapping scans — mirrors TradingRuntime's own
 * `isCycleRunning` convention exactly. A scan requested while one is already in flight is skipped,
 * never queued and never run concurrently. */
export class UniverseScanner {
  private scanning = false;

  constructor(private readonly deps: UniverseScannerDeps) {}

  async scan(now: Date): Promise<UniverseScanResult | { skipped: true }> {
    if (this.scanning) return { skipped: true };
    this.scanning = true;
    try {
      return await runUniverseScan({ ...this.deps, now });
    } finally {
      this.scanning = false;
    }
  }
}
