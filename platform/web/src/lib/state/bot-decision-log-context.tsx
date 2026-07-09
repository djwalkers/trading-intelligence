"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { BotDecision } from "@/lib/bot";

// Bumped to v2 in Mission 1.1 (candidates/trace/scanId replaced the old flat riskChecks list), to
// v3 in Mission 2 (candidates gained individual/portfolio risk fields, decisions gained a
// portfolio exposure snapshot), to v4 in Mission 3 (candidates gained Position Manager fields),
// and to v5 in Mission 4 (decisions gained triggerType) — old entries are deliberately left
// behind rather than migrated; this is a local-browser-only log, not data worth writing migration
// code for.
const STORAGE_KEY = "trading-intelligence.bot-decisions.v5";
// A prototype decision log, not an audit trail — bounded so localStorage can't grow unbounded
// across many manual scans in one browser.
const MAX_ENTRIES = 50;

interface BotDecisionLogContextValue {
  decisions: BotDecision[];
  addDecision: (decision: BotDecision) => void;
}

const BotDecisionLogContext = createContext<BotDecisionLogContextValue | null>(null);

// Deliberately local-browser-only, unlike PaperTrade — this is a simple, read-mostly log for a
// manually-triggered prototype feature, not user data that needs to survive a device switch or
// be user-scoped via Supabase. "Use local state/Supabase persistence only if simple; do not
// overbuild" — a second storage-agnostic store abstraction for this would be overbuilding.
export function BotDecisionLogProvider({ children }: { children: ReactNode }) {
  const [decisions, setDecisions] = useState<BotDecision[]>([]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Deferred into a microtask rather than read synchronously in the effect body — React's
    // purity rule flags a direct setState call there, and this also keeps the very first client
    // render matching the server's empty state, avoiding a hydration mismatch.
    Promise.resolve().then(() => {
      try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        if (stored) setDecisions(JSON.parse(stored));
      } catch {
        // Corrupt or inaccessible storage — start from an empty log.
      }
    });
  }, []);

  function addDecision(decision: BotDecision) {
    setDecisions((previous) => {
      const next = [decision, ...previous].slice(0, MAX_ENTRIES);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      }
      return next;
    });
  }

  return (
    <BotDecisionLogContext.Provider value={{ decisions, addDecision }}>
      {children}
    </BotDecisionLogContext.Provider>
  );
}

export function useBotDecisionLog() {
  const context = useContext(BotDecisionLogContext);
  if (!context) {
    throw new Error("useBotDecisionLog must be used within a BotDecisionLogProvider");
  }
  return context;
}
