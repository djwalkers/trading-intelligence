import type { StrategyContext, StrategyResult } from "@/lib/types";

// Named "Strategy" for this module's own consumers (the engine and each strategy
// implementation). Deliberately NOT re-exported through @/lib/types — that barrel already
// exports an unrelated `Strategy` type (the Strategies page's mock rule metadata, Build 0.1.0).
// Same word, two different concepts from two different builds; kept apart rather than
// overloading one name for both.
export interface Strategy {
  id: string;
  name: string;
  evaluate(context: StrategyContext): StrategyResult;
}
