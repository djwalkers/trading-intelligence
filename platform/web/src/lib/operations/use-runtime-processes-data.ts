"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RuntimeProcessesData } from "./types";
import type { HermesSummaryData } from "@/lib/hermes-dashboard/types";

// Runtime Processes panel — Operations Centre. Mirrors use-hermes-dashboard-data.ts's own
// established conventions exactly (30s auto-refresh, manual refresh, stale-data detection, retain
// last successful data on failure) — fetches exactly two endpoints per refresh:
//   - /api/dashboard/operations-processes — PM2 process health. Required for "ready": this panel's
//     primary purpose is process monitoring, so a failure here is the section's own degraded state.
//   - /api/dashboard/hermes-summary — Hermes operational state (mode/broker/kill-switch/scheduler/
//     last cycle/open positions). Best-effort/supplementary, exactly like the main dashboard hook
//     already treats its own summary fetch — a failure here never blocks the PM2 cards themselves
//     from rendering, it only means the Hermes-specific fields on the Hermes card show
//     "Unavailable".
//
// Split-deployment defect fix. This hook must NEVER fetch /api/operations/processes directly — that
// route only produces a real result on the VPS (the only host PM2 runs on); called from the browser
// on Vercel it correctly, but uselessly, fails with "the PM2 executable could not be started on
// this server". /api/dashboard/operations-processes is the same-origin route that bridges to it
// server-side, across hosts, with a bearer token attached — see dashboard-proxy.ts's own
// proxyOperationsProcessesGet.

export const REFRESH_INTERVAL_MS = 30_000;
// 3 missed refreshes before a stale warning, not 1 — avoids flapping on a single slow/late poll
// (matches use-hermes-dashboard-data.ts's own STALE_THRESHOLD_MS reasoning exactly).
export const STALE_THRESHOLD_MS = 90_000;

export type RuntimeProcessesFetchState = { status: "loading" } | { status: "ready" } | { status: "degraded"; message: string };

export interface RuntimeProcessesDataResult {
  state: RuntimeProcessesFetchState;
  processes: RuntimeProcessesData | null;
  hermesSummary: HermesSummaryData | null;
  lastRefreshedAt: string | null;
  isStale: boolean;
  refresh: () => void;
}

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

async function fetchJson<T>(path: string): Promise<{ ok: true; data: T } | { ok: false; message: string }> {
  let response: Response;
  try {
    response = await fetch(path, { cache: "no-store" });
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Network request failed." };
  }
  let body: Envelope<T>;
  try {
    body = await response.json();
  } catch {
    return { ok: false, message: `Unexpected response (HTTP ${response.status}).` };
  }
  if (!body.ok || response.status >= 400) {
    return { ok: false, message: body.error?.message ?? `Request failed (HTTP ${response.status}).` };
  }
  return { ok: true, data: body.data as T };
}

export function useRuntimeProcessesData(): RuntimeProcessesDataResult {
  const [state, setState] = useState<RuntimeProcessesFetchState>({ status: "loading" });
  const [processes, setProcesses] = useState<RuntimeProcessesData | null>(null);
  const [hermesSummary, setHermesSummary] = useState<HermesSummaryData | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const [isStale, setIsStale] = useState(false);
  const isFetchingRef = useRef(false);

  const load = useCallback(async () => {
    if (isFetchingRef.current) return; // never overlap two in-flight refreshes
    isFetchingRef.current = true;
    try {
      const [processesResult, summaryResult] = await Promise.all([
        fetchJson<RuntimeProcessesData>("/api/dashboard/operations-processes"),
        fetchJson<HermesSummaryData>("/api/dashboard/hermes-summary"),
      ]);

      if (!processesResult.ok) {
        // Never clears `processes`/`hermesSummary` — the last successful data (if any) stays
        // visible, clearly marked stale/degraded, rather than blanking the panel on a transient
        // failure.
        setState({ status: "degraded", message: processesResult.message });
        return;
      }

      setProcesses(processesResult.data);
      // A summary-only failure retains the last successful Hermes summary (if any), exactly like
      // the PM2 side above — never blanks an already-rendered Hermes operational section on a
      // single transient hiccup of only this best-effort request.
      setHermesSummary((prev) => (summaryResult.ok ? summaryResult.data : prev));
      setState({ status: "ready" });
      setLastRefreshedAt(new Date().toISOString());
      setIsStale(false);
    } finally {
      isFetchingRef.current = false;
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const interval = setInterval(() => {
      void load();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    const onFocus = () => void load();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void load();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [load]);

  useEffect(() => {
    const check = () => {
      if (!lastRefreshedAt) return;
      setIsStale(Date.now() - new Date(lastRefreshedAt).getTime() > STALE_THRESHOLD_MS);
    };
    check();
    const interval = setInterval(check, 5_000);
    return () => clearInterval(interval);
  }, [lastRefreshedAt]);

  return { state, processes, hermesSummary, lastRefreshedAt, isStale, refresh: () => void load() };
}
