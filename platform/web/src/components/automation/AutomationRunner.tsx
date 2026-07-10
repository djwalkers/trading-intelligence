"use client";

import { useEffect, useRef } from "react";
import { instruments } from "@/lib/mock";
import { useAuth } from "@/lib/auth/auth-context";
import { usePersistenceStatus } from "@/lib/state/use-persistence-status";
import { useBotScheduler } from "@/lib/state/bot-scheduler-context";
import { useBotScanRunner } from "@/lib/state/use-bot-scan-runner";

// How often the schedule is checked to see if it's time to run — not the schedule interval
// itself. 10s is plenty granular against a 15/30/60-minute schedule.
const TICK_INTERVAL_MS = 10_000;

// Build 1.12.0 — the tick-interval effect that used to live inside BotRunnerPanel (Mission 4),
// extracted verbatim and mounted once at the app-shell level (see AppShell.tsx) instead of tied to
// whichever page happened to render the Bot Runner panel. Same behaviour, same safety checks, same
// disclosed limitation (this is browser-based scheduling — it only advances while this browser tab
// is open; there is no background worker here, see the VPS Worker for that) — the only change is
// that "this browser tab" now means any page of the app, not specifically the Dashboard, so
// navigating to Settings or anywhere else no longer pauses the automatic scan schedule.
export function AutomationRunner() {
  const { isConfigured, isLoading, user } = useAuth();
  const persistenceStatus = usePersistenceStatus();
  const scheduler = useBotScheduler();
  const { runScan, isScanning } = useBotScanRunner(instruments);

  // Ref-captured so the interval set up below (once, for the app's lifetime) always reads the
  // latest values without needing to be torn down and recreated on every render — recreating it
  // would risk a missed or doubled tick right at the boundary. Updated in an effect (not directly
  // during render) since mutating a ref's .current while rendering is not allowed.
  const latestRef = useRef({ scheduler, isConfigured, isLoading, user, persistenceStatus, isScanning, runScan });
  useEffect(() => {
    latestRef.current = { scheduler, isConfigured, isLoading, user, persistenceStatus, isScanning, runScan };
  });

  useEffect(() => {
    const timer = setInterval(() => {
      const { scheduler, isConfigured, isLoading, user, persistenceStatus, isScanning, runScan } =
        latestRef.current;

      if (scheduler.status !== "Running") return;
      if (isScanning) return; // avoid overlapping runs; try again next tick

      // Safety: never run while signed out. Supabase configured + no session means the write
      // would fail anyway (AuthRequiredError) — stop rather than keep polling uselessly.
      if (isConfigured && !isLoading && !user) {
        scheduler.stop("Signed out — automatic scans require an active session.");
        return;
      }

      // Safety: stop rather than keep silently writing to local storage after the database was
      // the expected store — the user should notice and decide what to do next.
      if (persistenceStatus.fallbackReason) {
        scheduler.stop(`Database unavailable: ${persistenceStatus.fallbackReason}`);
        return;
      }

      if (!scheduler.nextScanAt || Date.now() < new Date(scheduler.nextScanAt).getTime()) return;

      runScan("Scheduled");
    }, TICK_INTERVAL_MS);

    return () => clearInterval(timer);
  }, []);

  return null;
}
