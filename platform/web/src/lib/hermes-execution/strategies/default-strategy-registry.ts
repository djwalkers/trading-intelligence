import { Demo0001Strategy } from "./demo-0001-strategy";
import { InMemoryStrategyRegistry } from "./strategy-registry";
import type { StrategyRegistry } from "./strategy-registry";
import { HermesAgentStrategy } from "../hermes-agent/hermes-agent-strategy";

// Phase 3 — Strategy-Driven Decision Engine. The one registry MarketDecisionEngine actually uses
// at runtime (its `registry` parameter defaults to this). Registering "Strategy B" in the future
// means adding one line here — market-decision-engine.ts itself never changes (requirement 5).
//
// If the Hermes Strategy Registry (registry-client.ts) is ever used to source a different eligible
// strategy for a live cycle, MarketDecisionEngine.evaluate() will throw UnknownStrategyError for
// that strategyId until a matching Strategy implementation is added and registered here — a
// deliberate, documented limitation of this phase, not a regression (see the Phase 3 report's
// "remaining limitations").
export const defaultStrategyRegistry: StrategyRegistry = new InMemoryStrategyRegistry();

defaultStrategyRegistry.register(new Demo0001Strategy());

// Prototype 1.0 — official Hermes Agent decision integration. The one shared HermesAgentStrategy
// instance — exported so runtime/universe-scanner.ts can call `setScanProposals()` on the SAME
// instance MarketDecisionEngine.evaluate() resolves via this registry (see that strategy's own
// doc comment for why it must be one shared, stateful-per-scan instance, not a fresh one per
// lookup).
export const hermesAgentStrategy = new HermesAgentStrategy();
defaultStrategyRegistry.register(hermesAgentStrategy);
