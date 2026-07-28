import type { TradePerformanceRecord } from "./types";
import type { HermesInstrumentPerformanceContext } from "../hermes-agent/types";

// Prototype 1.0 — official Hermes Agent decision integration. Pure, additive twin of
// trade-performance-analytics.ts's own computeStrategyPerformance — scoped by instrument instead
// of strategyId, and shaped as the exact HermesInstrumentPerformanceContext the universe scanner
// feeds to Hermes. Reuses trade_performance rows exactly as they already exist (see this table's
// own migration comment: a row is only ever written from a genuinely CLOSED trade with confirmed
// exit economics) — CLOSED_UNRECONCILED positions never produce a row here at all, so they are
// excluded from realised performance by construction, not by an extra filter this function adds.

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Undefined means "insufficient history" (zero completed trades for this instrument) — never a
 * zeroed-out summary presented as though it were real data. */
export function computeInstrumentPerformance(
  instrument: string,
  records: readonly TradePerformanceRecord[],
): HermesInstrumentPerformanceContext | undefined {
  const forInstrument = records.filter((r) => r.instrument === instrument);
  if (forInstrument.length === 0) return undefined;

  const wins = forInstrument.filter((r) => r.winLoss === "WIN");
  const losses = forInstrument.filter((r) => r.winLoss === "LOSS");

  return {
    completedTrades: forInstrument.length,
    wins: wins.length,
    losses: losses.length,
    winRate: wins.length / forInstrument.length,
    averageReturnPercent: mean(forInstrument.map((r) => r.returnPercent)),
    realisedPnl: forInstrument.reduce((sum, r) => sum + r.netPnl, 0),
    averageHoldingTimeMs: mean(forInstrument.map((r) => r.holdingTimeMs)),
    stopLossExits: forInstrument.filter((r) => r.exitReason === "STOP_LOSS").length,
    takeProfitExits: forInstrument.filter((r) => r.exitReason === "TAKE_PROFIT").length,
  };
}

export interface ConfidenceBandPerformance {
  band: string;
  trades: number;
  winRate: number;
  averageReturnPercent: number;
}

const CONFIDENCE_BANDS: ReadonlyArray<{ label: string; min: number; max: number }> = [
  { label: "0.0-0.5", min: 0, max: 0.5 },
  { label: "0.5-0.65", min: 0.5, max: 0.65 },
  { label: "0.65-0.8", min: 0.65, max: 0.8 },
  { label: "0.8-1.0", min: 0.8, max: 1.0001 },
];

/**
 * Performance grouped by the confidence the ORIGINATING candidate was created with (TradeCandidate
 * .confidence, joined by candidateId) — lets Hermes see "how have my own high-confidence calls
 * actually performed" rather than a single blended figure. Bands with zero trades are omitted
 * entirely (never a fabricated 0% win rate for a band nothing has been proposed in yet).
 */
export function computePerformanceByConfidenceBand(
  records: readonly TradePerformanceRecord[],
  candidateConfidenceById: ReadonlyMap<string, number>,
): ConfidenceBandPerformance[] {
  const bands: ConfidenceBandPerformance[] = [];
  for (const band of CONFIDENCE_BANDS) {
    const inBand = records.filter((r) => {
      if (!r.candidateId) return false;
      const confidence = candidateConfidenceById.get(r.candidateId);
      return confidence !== undefined && confidence >= band.min && confidence < band.max;
    });
    if (inBand.length === 0) continue;
    const wins = inBand.filter((r) => r.winLoss === "WIN");
    bands.push({
      band: band.label,
      trades: inBand.length,
      winRate: wins.length / inBand.length,
      averageReturnPercent: mean(inBand.map((r) => r.returnPercent)),
    });
  }
  return bands;
}
