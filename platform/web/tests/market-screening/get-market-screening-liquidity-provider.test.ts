import { describe, expect, it } from "vitest";
import { getMarketScreeningLiquidityProvider } from "@/lib/market-screening/get-market-screening-liquidity-provider";
import { StubMarketScreeningLiquidityProvider } from "@/lib/market-screening/stub-market-screening-liquidity-provider";

describe("getMarketScreeningLiquidityProvider", () => {
  it("resolves a StubMarketScreeningLiquidityProvider", () => {
    expect(getMarketScreeningLiquidityProvider()).toBeInstanceOf(StubMarketScreeningLiquidityProvider);
  });

  it("returns the same cached instance on repeated calls", () => {
    expect(getMarketScreeningLiquidityProvider()).toBe(getMarketScreeningLiquidityProvider());
  });
});
