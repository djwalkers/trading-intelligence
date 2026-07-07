import type { PaperTrade } from "@/lib/types";
import type { PaperTradeStore } from "./paper-trade-store";

const NOT_IMPLEMENTED_MESSAGE =
  "SupabasePaperTradeStore is a placeholder — the real schema exists " +
  "(platform/web/supabase/migrations/) but no live connection is implemented yet. " +
  "See docs/database/SUPABASE-SETUP.md and SUPABASE-PERSISTENCE-PLAN.md.";

// Placeholder implementation. It exists so the persistence abstraction has two real
// implementations to compile against, and so a future build can fill in the Supabase client
// calls without changing PaperTradeStore's shape or any of its callers. It is never selected by
// getPaperTradeStore() yet — see that file for why.
export class SupabasePaperTradeStore implements PaperTradeStore {
  async load(): Promise<PaperTrade[]> {
    throw new Error(NOT_IMPLEMENTED_MESSAGE);
  }

  async save(): Promise<void> {
    throw new Error(NOT_IMPLEMENTED_MESSAGE);
  }
}
