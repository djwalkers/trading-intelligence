import "server-only";
import type { MarketScreeningLiquidityProvider } from "./market-screening-liquidity-provider";
import { StubMarketScreeningLiquidityProvider } from "./stub-market-screening-liquidity-provider";

let provider: MarketScreeningLiquidityProvider | null = null;

// Mirrors get-server-historical-market-data-provider.ts's module-scoped singleton pattern. Always
// resolves the stub today — swapping in a real, approved provider later is a change inside this one
// function, not a change to any caller (resolve-market-screening-shortlist.ts, the worker).
export function getMarketScreeningLiquidityProvider(): MarketScreeningLiquidityProvider {
  if (!provider) provider = new StubMarketScreeningLiquidityProvider();
  return provider;
}
