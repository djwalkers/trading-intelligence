import type { InternalStrategy } from "./types";

export const DEMO_STRATEGY_ID = "DEMO-0001";

export const DEMO_ONLY_LABEL =
  "DEMO_ONLY — deterministic fixture strategy for exercising the execution pipeline. Not evidence-backed. Never eligible for live trading.";

/**
 * The one demo strategy this phase ships, so the execution pipeline can be proven end-to-end
 * while Hermes Lab's Strategy Registry continues to hold zero eligible strategies. It:
 *   - lives entirely in Trading Intelligence — no file here is read from or written to the Hermes
 *     Strategy Registry;
 *   - is visibly marked via sourceType "DEMO_ONLY" and the demoLabel string, so nothing downstream
 *     (risk engine, audit trail, UI) can present it as though it were HERMES_APPROVED;
 *   - is disabled by default and loads only in demo mode: this function returns null — the
 *     strategy simply does not exist as far as the rest of the pipeline is concerned — unless
 *     demoExecutionModeEnabled is explicitly true. There is no other code path that produces it.
 *
 * Do not treat its entry/exit thresholds as a claim about a real trading edge — they exist only
 * to make the fixture dataset in src/hermes-execution/fixtures/demo-candles.json trigger a full,
 * deterministic no-signal -> entry -> hold -> exit lifecycle.
 */
export function getDemoStrategy(demoExecutionModeEnabled: boolean): InternalStrategy | null {
  if (!demoExecutionModeEnabled) return null;

  return {
    strategyId: DEMO_STRATEGY_ID,
    version: 1,
    sourceType: "DEMO_ONLY",
    enabled: true,
    instrument: "DEMO-USD",
    timeframe: "1m",
    entryRules: [{ type: "CROSSES_ABOVE_MA", period: 5 }],
    exitRules: [
      { type: "TAKE_PROFIT", percent: 2 },
      { type: "STOP_LOSS", percent: 1 },
      { type: "CROSSES_BELOW_MA", period: 5 },
    ],
    riskRules: { maxPositionValue: 500 },
    demoLabel: DEMO_ONLY_LABEL,
  };
}
