// Main Dashboard Hermes/eToro fix. Plain DTOs matching the JSON shapes GET /api/hermes/portfolio,
// GET /api/hermes/positions, and GET /api/hermes/summary already return (via their browser-facing
// proxies — see dashboard-proxy.ts) — never re-derived or renamed here, so a shape change in those
// routes is a compile error here too, not a silent mismatch.

export interface HermesPortfolioData {
  accountMode: string;
  provider: string;
  cash: number;
  investedValue: number;
  realisedPnl: number | null;
  realisedPnlScope: string;
  realisedTradeCount: number;
  unreconciledClosedTradeCount: number;
  unrealisedPnl: number | null;
  unrealisedPnlComplete: boolean;
  unrealisedPnlUnavailableReason: string | null;
  equity: number | null;
  equitySource: "BROKER" | "CALCULATED" | "UNAVAILABLE";
  openPositionCount: number;
  currency: "USD";
  positionsAreLiveGroundTruth: boolean;
  timestamp: string;
}

export interface HermesPositionItem {
  instrument: string;
  // Instrument-resolution defect fix. The broker's own raw numeric instrument id, preserved
  // alongside the friendly `instrument` symbol above — see broker-snapshot.ts's own doc comment.
  brokerInstrumentId: number | null;
  side: "BUY" | "SELL" | "unknown";
  quantity: number | null;
  units: number | null;
  entryPrice: number | null;
  currentPrice: number | null;
  unrealisedPnl: number | null;
  pricingTimestamp: string | null;
  pricingSource: "broker" | "unavailable";
  // Instrument-resolution defect fix. Explicit diagnostic provenance for why this position's
  // pricing is unavailable — null exactly when pricingSource === "broker".
  pricingFailureReason: string | null;
  openedAt: string | null;
  provider: string;
  accountMode: string;
  brokerPositionId: string | null;
}

export interface HermesPositionsData {
  positions: HermesPositionItem[];
  count: number;
  provider: string;
  accountMode: string;
  positionsAreLiveGroundTruth: boolean;
}

export interface HermesSummaryData {
  timestamp: string;
  health: {
    status: string;
    runtimeMode: string;
    brokerProvider: string;
    // Runtime Processes panel (Operations Centre). Additive fields — null whenever the server's
    // own HermesExecutionConfig failed to load, never a guessed default.
    killSwitchEnabled: boolean | null;
    schedulerEnabled: boolean | null;
    schedulerIntervalMs: number | null;
  };
  runtime: { state: string; lastRunAt: string | null; successfulRunCount: number; failedRunCount: number } | null;
  openPositionCount: number | null;
  latestDecision: { timestamp: string; symbol: string; outcome: string; confidence: number | null } | null;
  recentFailure: { eventType: string; timestamp: string; message: string } | null;
  unreconciledClosures: unknown[];
  warnings: string[];
}
