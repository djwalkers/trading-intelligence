"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { HermesPortfolioData, HermesPositionsData, HermesSummaryData } from "./types";

// Main Dashboard Hermes/eToro fix — requirement 5 (refresh behaviour) and requirement 6 (states).
// The one hook the main Dashboard's Hermes/eToro section uses for ALL of its data: fetches
// portfolio + positions (both required for "ready") and summary (best-effort — a summary failure
// never blocks portfolio/positions from displaying, matching /api/hermes/summary's own "each
// subsystem degrades independently" design) from the three same-origin, unauthenticated proxy
// routes (/api/dashboard/hermes-*  — see dashboard-proxy.ts for why those exist rather than calling
// /api/hermes/* directly). NEVER reads paper-trades-context/local-storage-paper-trade-store — on
// any failure, `state` becomes "error"/"unauthorized" and the LAST successful data (if any) is kept
// visible, clearly marked stale — never silently replaced with legacy local paper figures.

export const REFRESH_INTERVAL_MS = 30_000;
// 3 missed refreshes before a stale warning, not 1 — avoids flapping on a single slow/late poll.
export const STALE_THRESHOLD_MS = 90_000;

export type HermesDashboardFetchState =
  | { status: "loading" }
  | { status: "ready" }
  | { status: "error"; message: string }
  | { status: "unauthorized"; message: string };

export interface HermesDashboardData {
  state: HermesDashboardFetchState;
  portfolio: HermesPortfolioData | null;
  positions: HermesPositionsData | null;
  summary: HermesSummaryData | null;
  lastRefreshedAt: string | null;
  isStale: boolean;
  refresh: () => void;
}

interface HermesEnvelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

async function fetchHermesJson<T>(path: string): Promise<{ ok: true; data: T } | { ok: false; unauthorized: boolean; message: string }> {
  let response: Response;
  try {
    response = await fetch(path, { cache: "no-store" });
  } catch (error) {
    return { ok: false, unauthorized: false, message: error instanceof Error ? error.message : "Network request failed." };
  }
  let body: HermesEnvelope<T>;
  try {
    body = await response.json();
  } catch {
    return { ok: false, unauthorized: false, message: `Unexpected response (HTTP ${response.status}).` };
  }
  if (!body.ok || response.status >= 400) {
    return {
      ok: false,
      unauthorized: response.status === 401 || body.error?.code === "UNAUTHORIZED",
      message: body.error?.message ?? `Request failed (HTTP ${response.status}).`,
    };
  }
  return { ok: true, data: body.data as T };
}

export function useHermesDashboardData(): HermesDashboardData {
  const [state, setState] = useState<HermesDashboardFetchState>({ status: "loading" });
  const [portfolio, setPortfolio] = useState<HermesPortfolioData | null>(null);
  const [positions, setPositions] = useState<HermesPositionsData | null>(null);
  const [summary, setSummary] = useState<HermesSummaryData | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);
  const [isStale, setIsStale] = useState(false);
  const isFetchingRef = useRef(false);

  const load = useCallback(async () => {
    if (isFetchingRef.current) return; // never overlap two in-flight refreshes
    isFetchingRef.current = true;
    try {
      const [portfolioResult, positionsResult, summaryResult] = await Promise.all([
        fetchHermesJson<HermesPortfolioData>("/api/dashboard/hermes-portfolio"),
        fetchHermesJson<HermesPositionsData>("/api/dashboard/hermes-positions"),
        fetchHermesJson<HermesSummaryData>("/api/dashboard/hermes-summary"),
      ]);

      // Portfolio and positions are both required for "ready" — never a partially-blank dashboard.
      if (!portfolioResult.ok) {
        setState(
          portfolioResult.unauthorized
            ? { status: "unauthorized", message: portfolioResult.message }
            : { status: "error", message: portfolioResult.message },
        );
        return;
      }
      if (!positionsResult.ok) {
        setState(
          positionsResult.unauthorized
            ? { status: "unauthorized", message: positionsResult.message }
            : { status: "error", message: positionsResult.message },
        );
        return;
      }

      setPortfolio(portfolioResult.data);
      setPositions(positionsResult.data);
      // Summary is best-effort/supplementary (runtime/decision status) — never blocks the core
      // portfolio+positions figures from being shown.
      setSummary(summaryResult.ok ? summaryResult.data : null);
      setState({ status: "ready" });
      setLastRefreshedAt(new Date().toISOString());
      setIsStale(false);
    } finally {
      isFetchingRef.current = false;
    }
  }, []);

  // Initial fetch on mount.
  useEffect(() => {
    void load();
  }, [load]);

  // Periodic refresh.
  useEffect(() => {
    const interval = setInterval(() => {
      void load();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [load]);

  // Refresh when the tab regains focus/visibility.
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

  // Stale-data detection — re-checked every few seconds against the last successful refresh,
  // independent of whether a refresh attempt is currently in flight or has been failing.
  useEffect(() => {
    const check = () => {
      if (!lastRefreshedAt) return;
      setIsStale(Date.now() - new Date(lastRefreshedAt).getTime() > STALE_THRESHOLD_MS);
    };
    check();
    const interval = setInterval(check, 5_000);
    return () => clearInterval(interval);
  }, [lastRefreshedAt]);

  return { state, portfolio, positions, summary, lastRefreshedAt, isStale, refresh: () => void load() };
}
