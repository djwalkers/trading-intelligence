"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { setItemSafely } from "@/lib/persistence/safe-local-storage";

export type SchedulerMode = "Manual" | "Every15" | "Every30" | "Every60";
export type SchedulerStatus = "Stopped" | "Running";

// Minutes between scans for each non-Manual mode — null for Manual, since there's nothing to
// schedule. Exported so the Dashboard panel and System Health can display the active interval
// without duplicating this mapping.
export const SCHEDULE_INTERVAL_MINUTES: Record<SchedulerMode, number | null> = {
  Manual: null,
  Every15: 15,
  Every30: 30,
  Every60: 60,
};

const STORAGE_KEY = "trading-intelligence.bot-scheduler.v1";

interface BotSchedulerState {
  mode: SchedulerMode;
  status: SchedulerStatus;
  nextScanAt: string | null;
  lastScanAt: string | null;
  // Set only when start()/recordScan() didn't cause the stop — e.g. "signed out" or "persistence
  // fell back to local storage." Cleared on the next start().
  stopReason: string | null;
}

const DEFAULT_STATE: BotSchedulerState = {
  mode: "Manual",
  status: "Stopped",
  nextScanAt: null,
  lastScanAt: null,
  stopReason: null,
};

interface BotSchedulerContextValue extends BotSchedulerState {
  setMode: (mode: SchedulerMode) => void;
  start: () => void;
  stop: (reason?: string) => void;
  recordScan: (timestamp: string) => void;
}

const BotSchedulerContext = createContext<BotSchedulerContextValue | null>(null);

function nextScanFrom(epochMs: number, mode: SchedulerMode): string | null {
  const minutes = SCHEDULE_INTERVAL_MINUTES[mode];
  if (minutes === null) return null;
  return new Date(epochMs + minutes * 60 * 1000).toISOString();
}

function writeStorage(state: BotSchedulerState) {
  setItemSafely(STORAGE_KEY, JSON.stringify(state), "bot-scheduler");
}

// Deliberately local-browser-only, like the bot decision log (Mission 1) — this is scheduling
// PREFERENCE state, not user data needing Supabase. State survives a page reload (a running
// schedule stays "Running" across a refresh), but the actual tick execution only happens while a
// BotRunnerPanel is mounted on the Dashboard — this is genuinely browser-based scheduling, not a
// background worker. See docs/product/MISSION-4-SCHEDULED-BOT-SCANS.md for the full disclosure of
// what this does and doesn't guarantee.
export function BotSchedulerProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<BotSchedulerState>(DEFAULT_STATE);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Deferred into a microtask rather than read synchronously in the effect body — same pattern
    // as the bot decision log (Mission 1): React's purity rule flags a direct setState call
    // there, and this keeps the very first client render matching the server's default state.
    Promise.resolve().then(() => {
      try {
        const stored = window.localStorage.getItem(STORAGE_KEY);
        if (stored) setState(JSON.parse(stored));
      } catch {
        // Corrupt or inaccessible storage — start from the default (Manual, Stopped).
      }
    });
  }, []);

  function setMode(mode: SchedulerMode) {
    setState((previous) => {
      // Selecting Manual while running doesn't mean anything — there's no interval left to run
      // on, so stop rather than leave a "Running" schedule with a null next-scan time.
      const next: BotSchedulerState =
        mode === "Manual" && previous.status === "Running"
          ? { ...previous, mode, status: "Stopped", nextScanAt: null, stopReason: null }
          : previous.status === "Running"
            ? { ...previous, mode, nextScanAt: nextScanFrom(Date.now(), mode) }
            : { ...previous, mode };
      writeStorage(next);
      return next;
    });
  }

  function start() {
    setState((previous) => {
      if (previous.mode === "Manual") return previous;
      const next: BotSchedulerState = {
        ...previous,
        status: "Running",
        stopReason: null,
        nextScanAt: nextScanFrom(Date.now(), previous.mode),
      };
      writeStorage(next);
      return next;
    });
  }

  function stop(reason?: string) {
    setState((previous) => {
      const next: BotSchedulerState = {
        ...previous,
        status: "Stopped",
        nextScanAt: null,
        stopReason: reason ?? null,
      };
      writeStorage(next);
      return next;
    });
  }

  function recordScan(timestamp: string) {
    setState((previous) => {
      const next: BotSchedulerState = {
        ...previous,
        lastScanAt: timestamp,
        nextScanAt:
          previous.status === "Running"
            ? nextScanFrom(new Date(timestamp).getTime(), previous.mode)
            : previous.nextScanAt,
      };
      writeStorage(next);
      return next;
    });
  }

  return (
    <BotSchedulerContext.Provider value={{ ...state, setMode, start, stop, recordScan }}>
      {children}
    </BotSchedulerContext.Provider>
  );
}

export function useBotScheduler() {
  const context = useContext(BotSchedulerContext);
  if (!context) {
    throw new Error("useBotScheduler must be used within a BotSchedulerProvider");
  }
  return context;
}
