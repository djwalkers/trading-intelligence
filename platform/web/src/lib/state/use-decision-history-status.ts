"use client";

import { useEffect, useState } from "react";
import { getDecisionHistoryStore } from "@/lib/decision-intelligence";
import type { DecisionHistoryStatus } from "@/lib/decision-intelligence";

// Mirrors usePersistenceStatus (src/lib/state/use-persistence-status.ts) exactly, for the
// decision-history store instead of the paper-trade store.
export function useDecisionHistoryStatus(): DecisionHistoryStatus {
  const [status, setStatus] = useState<DecisionHistoryStatus>(() => getDecisionHistoryStore().getStatus());

  useEffect(() => {
    return getDecisionHistoryStore().subscribeStatus(setStatus);
  }, []);

  return status;
}
