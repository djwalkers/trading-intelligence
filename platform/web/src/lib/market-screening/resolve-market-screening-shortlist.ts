import "server-only";
import type { Instrument } from "@/lib/types";
import { instruments as staticInstruments } from "@/lib/mock";
import { getMarketScreeningLiquidityProvider } from "./get-market-screening-liquidity-provider";
import type { MarketScreeningRolloutStage } from "./types";
import type { MarketScreeningShortlistResult } from "./market-screening-shortlist-result";

// Sprint 294 §1's "exactly one new step, inserted immediately before executeBotScan." With the
// rollout stage fixed to "off" (server-config.ts's default), every call resolves to the static
// list — the exact same array reference the worker used before this module existed, so
// `executeBotScan` receives byte-for-byte identical input. Shadow/Staged/Full (actually consulting
// the provider's result, blending it with the static list, or replacing it outright) are unbuilt —
// explicitly out of scope for this sprint. Passing `instruments` lets tests substitute a fixture
// without needing to reach into `@/lib/mock`.
export async function resolveMarketScreeningShortlist(
  rolloutStage: MarketScreeningRolloutStage,
  instruments: Instrument[] = staticInstruments,
): Promise<MarketScreeningShortlistResult> {
  if (rolloutStage === "off") {
    return {
      source: "fallback-static-list",
      instruments,
      reason: "Market screening disabled (rollout stage: off).",
    };
  }

  const snapshot = await getMarketScreeningLiquidityProvider().getDailyLiquiditySnapshot();
  return {
    source: "fallback-static-list",
    instruments,
    reason:
      snapshot.status === "unavailable"
        ? snapshot.reason
        : "Market screening rollout stage not yet implemented.",
  };
}
