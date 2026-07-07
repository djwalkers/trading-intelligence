import type { PaperTrade } from "@/lib/types";

// A storage-agnostic contract for persisting paper trades. `load`/`save` are async so a future
// network-backed implementation (Supabase) can share this interface with the synchronous
// localStorage implementation used today.
export interface PaperTradeStore {
  load(): Promise<PaperTrade[]>;
  save(trades: PaperTrade[]): Promise<void>;
}
