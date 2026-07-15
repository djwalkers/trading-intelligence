import { describe, expect, it } from "vitest";
import { StubMarketScreeningLiquidityProvider } from "@/lib/market-screening/stub-market-screening-liquidity-provider";

describe("StubMarketScreeningLiquidityProvider", () => {
  it("always resolves to an unavailable result", async () => {
    const provider = new StubMarketScreeningLiquidityProvider();
    const result = await provider.getDailyLiquiditySnapshot();
    expect(result).toEqual({ status: "unavailable", reason: "Provider not configured." });
  });

  it("never throws and is stable across repeated calls", async () => {
    const provider = new StubMarketScreeningLiquidityProvider();
    const results = await Promise.all([
      provider.getDailyLiquiditySnapshot(),
      provider.getDailyLiquiditySnapshot(),
      provider.getDailyLiquiditySnapshot(),
    ]);
    for (const result of results) {
      expect(result.status).toBe("unavailable");
    }
  });
});
