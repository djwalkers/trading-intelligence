import type { PaperTrade } from "@/lib/types";

// A storage-agnostic contract for persisting paper trades.
//
// Deliberately granular (addTrade/closeTrade) rather than a single generic "save the whole
// array" method: a network-backed store needs to know exactly which row to insert vs. update,
// and closing specifically needs to append a trade_events row — a generic save() can't express
// either without re-diffing the entire array on every change.
export interface PaperTradeStore {
  load(): Promise<PaperTrade[]>;
  addTrade(trade: PaperTrade): Promise<void>;
  closeTrade(trade: PaperTrade): Promise<void>;
}
