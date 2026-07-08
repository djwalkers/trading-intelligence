"use client";

import { useEffect, useState } from "react";
import { getPaperTradeStore } from "@/lib/persistence/get-paper-trade-store";
import type { PersistenceStatus } from "@/lib/persistence/persistence-status";

// The initial status (mode + null lastSyncedAt) depends only on whether Supabase env vars are
// present, which is identical on the server and the client — so, unlike the trades list, there
// is no hydration-mismatch risk in reading it directly during the lazy initializer.
export function usePersistenceStatus(): PersistenceStatus {
  const [status, setStatus] = useState<PersistenceStatus>(() => getPaperTradeStore().getStatus());

  useEffect(() => {
    return getPaperTradeStore().subscribeStatus(setStatus);
  }, []);

  return status;
}
