import { Demo0001Strategy } from "./demo-0001-strategy";
import { InMemoryStrategyRegistry } from "./strategy-registry";
import type { StrategyRegistry } from "./strategy-registry";

// Phase 3 — Strategy-Driven Decision Engine. The one registry MarketDecisionEngine actually uses
// at runtime (its `registry` parameter defaults to this). Registering "Strategy B" in the future
// means adding one line here — market-decision-engine.ts itself never changes (requirement 5).
//
// Only DEMO-0001 is registered today. If the Hermes Strategy Registry (registry-client.ts) is ever
// used to source a different eligible strategy for a live cycle, MarketDecisionEngine.evaluate()
// will throw UnknownStrategyError for that strategyId until a matching Strategy implementation is
// added and registered here — a deliberate, documented limitation of this phase, not a regression
// (see the Phase 3 report's "remaining limitations").
export const defaultStrategyRegistry: StrategyRegistry = new InMemoryStrategyRegistry();

defaultStrategyRegistry.register(new Demo0001Strategy());
