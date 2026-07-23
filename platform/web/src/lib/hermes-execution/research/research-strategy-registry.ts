import { InMemoryStrategyRegistry } from "../strategies/strategy-registry";
import { Demo0001Strategy } from "../strategies/demo-0001-strategy";
import { ResearchVariantStrategy } from "./research-variant-strategy";
import type { StrategyRegistry } from "../strategies/strategy-registry";

// Phase 5 — Strategy Research Laboratory. A SEPARATE registry instance from
// trade-approval/default-strategy-registry.ts (the one and only registry the live runtime ever
// reads from) — this one exists purely so the research page has more than one strategy to select
// and compare. Registering RESEARCH-0001 here can never make it reachable by
// executeApprovedTradeCandidate or any other live code path: nothing outside this research module
// ever imports researchStrategyRegistry.
export const researchStrategyRegistry: StrategyRegistry = new InMemoryStrategyRegistry();

researchStrategyRegistry.register(new Demo0001Strategy());
researchStrategyRegistry.register(new ResearchVariantStrategy());
