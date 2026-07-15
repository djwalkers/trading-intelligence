import type {
  MarketScreeningLiquidityProvider,
  MarketScreeningLiquiditySnapshotResult,
} from "./market-screening-liquidity-provider";

// No liquidity data provider has been approved yet (Sprint 293 blocked adoption pending licensing
// clarification). This stub exists purely so the rest of the market-screening framework — factory
// resolution, the worker's integration seam, telemetry — can be built and exercised safely ahead of
// that decision. Never throws, never makes a network call, always resolves.
export class StubMarketScreeningLiquidityProvider implements MarketScreeningLiquidityProvider {
  async getDailyLiquiditySnapshot(): Promise<MarketScreeningLiquiditySnapshotResult> {
    return { status: "unavailable", reason: "Provider not configured." };
  }
}
