import type { MarketDataProvider, MarketDataSnapshot } from "./market-data/market-data-provider";
import { MarketIntelligenceBuilder } from "./market-intelligence-builder";
import type { MarketDecisionContext } from "./market-decision-engine";
import type { PaperBroker } from "./paper-broker";
import type { InternalStrategy } from "./types";

// Milestone 7 — 24/7 Scheduler & Runtime Control. Extracted (unchanged in behaviour) from
// market-decide.ts's previously-private `buildContext` helper so the new continuous runtime
// (runtime/trading-runtime.ts) can reuse the exact same "pull a MarketDataSnapshot, then hand it to
// MarketIntelligenceBuilder" assembly step instead of reimplementing it — the architectural
// principle this milestone is built around ("must not duplicate or reimplement market intelligence
// ..."). market-decide.ts now calls this same function; nothing about what it does changed.

export interface MarketDecisionContextResult {
  snapshot: MarketDataSnapshot;
  context: MarketDecisionContext;
}

/** Pulls one self-consistent MarketDataSnapshot from `marketDataProvider` and hands it to
 * MarketIntelligenceBuilder to produce a full MarketDecisionContext — the one place this assembly
 * happens, reused by every caller that needs a context before invoking the decision/execution
 * pipeline. Only depends on `getOpenPositions()` from the broker (not the full PaperBroker
 * interface), matching this pipeline's existing "depend on the narrowest shape needed" convention
 * (see LiveMarketDataProvider's RateSource). */
export async function buildMarketDecisionContext(
  marketDataProvider: MarketDataProvider,
  broker: Pick<PaperBroker, "getOpenPositions">,
  instrument: string,
  strategy: InternalStrategy,
): Promise<MarketDecisionContextResult> {
  const snapshot = await marketDataProvider.getMarketData(instrument);
  const positionOpen = broker.getOpenPositions().some((p) => p.instrument === instrument);

  const context = MarketIntelligenceBuilder.build({
    instrument,
    bid: snapshot.bid,
    ask: snapshot.ask,
    positionOpen,
    strategyId: strategy.strategyId,
    strategyVersion: strategy.version,
    strategySourceType: strategy.sourceType,
    candles: snapshot.candles,
  });
  return { snapshot, context };
}
