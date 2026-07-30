import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { REFRESH_INTERVAL_MS, STALE_THRESHOLD_MS, useHermesDashboardData } from "@/lib/hermes-dashboard/use-hermes-dashboard-data";

// Main Dashboard Hermes/eToro fix — requirement 5 (refresh behaviour), requirement 6 (states),
// requirement 9 (tests: refresh/focus revalidation, stale-data state, API errors never fall back
// to legacy paper balances). Every test here mocks global fetch; no real network call is ever made,
// and paper-trades-context/local-storage-paper-trade-store are never imported by this hook at all —
// there is nothing here that COULD leak legacy paper data even accidentally.
//
// Uses fake timers throughout — `waitFor` polls via a REAL setTimeout, which never advances under
// vi.useFakeTimers(), so every wait here is instead `act(async () => { await
// vi.advanceTimersByTimeAsync(...) })` followed by a direct, synchronous assertion.

const PORTFOLIO_BODY = {
  ok: true,
  data: {
    accountMode: "demo",
    provider: "etoro-demo",
    cash: 77_191.35,
    investedValue: 14.96,
    realisedPnl: -0.06,
    realisedPnlScope: "since last runtime start",
    unrealisedPnl: null,
    equity: null,
    openPositionCount: 1,
    timestamp: "2026-07-29T21:00:00.000Z",
    positionsAreLiveGroundTruth: true,
  },
};
const POSITIONS_BODY = {
  ok: true,
  data: {
    positions: [],
    count: 0,
    provider: "etoro-demo",
    accountMode: "demo",
    positionsAreLiveGroundTruth: true,
  },
};
const SUMMARY_BODY = {
  ok: true,
  data: {
    timestamp: "2026-07-29T21:00:00.000Z",
    health: { status: "healthy", runtimeMode: "demo", brokerProvider: "etoro-demo" },
    runtime: { state: "RUNNING", lastRunAt: "2026-07-29T20:59:00.000Z", successfulRunCount: 10, failedRunCount: 0 },
    openPositionCount: 1,
    latestDecision: null,
    recentFailure: null,
    unreconciledClosures: [],
    warnings: [],
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function mockFetchSequence(handler: (path: string) => Response) {
  return vi.fn(async (input: string | URL | Request) => handler(String(input)));
}

function defaultHandler(path: string): Response {
  if (path.includes("hermes-portfolio")) return jsonResponse(PORTFOLIO_BODY);
  if (path.includes("hermes-positions")) return jsonResponse(POSITIONS_BODY);
  if (path.includes("hermes-summary")) return jsonResponse(SUMMARY_BODY);
  throw new Error(`unexpected path: ${path}`);
}

const originalFetch = global.fetch;

/** Flushes pending microtasks (the mocked fetch's own promise chain) without needing any real
 * elapsed time — fake timers don't affect Promise scheduling, only setTimeout/setInterval. */
async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("useHermesDashboardData", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("fetches all three endpoints on mount and becomes ready", async () => {
    global.fetch = mockFetchSequence(defaultHandler) as unknown as typeof fetch;
    const { result } = renderHook(() => useHermesDashboardData());
    await flushMicrotasks();

    expect(result.current.state.status).toBe("ready");
    expect(result.current.portfolio?.cash).toBe(77_191.35);
    expect(result.current.positions?.count).toBe(0);
    expect(result.current.summary?.health.status).toBe("healthy");
    expect(result.current.lastRefreshedAt).not.toBeNull();
  });

  it("refreshes automatically every 30 seconds", async () => {
    const fetchMock = mockFetchSequence(defaultHandler);
    global.fetch = fetchMock as unknown as typeof fetch;
    renderHook(() => useHermesDashboardData());
    await flushMicrotasks();

    const callsAfterMount = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
    });

    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });

  it("refreshes when the tab regains focus", async () => {
    const fetchMock = mockFetchSequence(defaultHandler);
    global.fetch = fetchMock as unknown as typeof fetch;
    renderHook(() => useHermesDashboardData());
    await flushMicrotasks();

    const callsBeforeFocus = fetchMock.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flushMicrotasks();

    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBeforeFocus);
  });

  it("the manual refresh() function triggers an immediate re-fetch", async () => {
    const fetchMock = mockFetchSequence(defaultHandler);
    global.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() => useHermesDashboardData());
    await flushMicrotasks();

    const callsBeforeRefresh = fetchMock.mock.calls.length;
    act(() => {
      result.current.refresh();
    });
    await flushMicrotasks();

    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBeforeRefresh);
  });

  it("shows isStale: true once the last successful refresh is older than the stale threshold", async () => {
    global.fetch = mockFetchSequence(defaultHandler) as unknown as typeof fetch;
    const { result } = renderHook(() => useHermesDashboardData());
    await flushMicrotasks();
    expect(result.current.state.status).toBe("ready");
    expect(result.current.isStale).toBe(false);

    // Make every subsequent refresh attempt fail, so lastRefreshedAt stops advancing while time
    // keeps moving forward — this is the only way staleness can genuinely occur, since a healthy
    // refresh every 30s would otherwise always keep it fresh.
    global.fetch = vi.fn(async () => jsonResponse({ ok: false, error: { code: "BROKER_UNAVAILABLE", message: "down" } }, 503)) as unknown as typeof fetch;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(STALE_THRESHOLD_MS + REFRESH_INTERVAL_MS);
    });

    expect(result.current.isStale).toBe(true);
  });

  it("an API error never falls back to legacy paper balances — state becomes 'error', not 'ready' with stale/fabricated data", async () => {
    global.fetch = vi.fn(async () => jsonResponse({ ok: false, error: { code: "BROKER_UNAVAILABLE", message: "eToro unreachable" } }, 503)) as unknown as typeof fetch;
    const { result } = renderHook(() => useHermesDashboardData());
    await flushMicrotasks();

    expect(result.current.state.status).toBe("error");
    if (result.current.state.status === "error") {
      expect(result.current.state.message).toContain("eToro unreachable");
    }
    expect(result.current.portfolio).toBeNull();
  });

  it("a 401 response becomes an explicit 'unauthorized' state, distinct from a generic error", async () => {
    global.fetch = vi.fn(async () => jsonResponse({ ok: false, error: { code: "UNAUTHORIZED", message: "no token" } }, 401)) as unknown as typeof fetch;
    const { result } = renderHook(() => useHermesDashboardData());
    await flushMicrotasks();

    expect(result.current.state.status).toBe("unauthorized");
  });

  it("a network-level failure (fetch itself rejecting) is treated as 'error', never silently ignored", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useHermesDashboardData());
    await flushMicrotasks();

    expect(result.current.state.status).toBe("error");
  });

  it("a summary-only failure never blocks portfolio/positions from becoming ready (best-effort)", async () => {
    global.fetch = mockFetchSequence((path) => {
      if (path.includes("hermes-summary")) return jsonResponse({ ok: false, error: { code: "UNKNOWN_ERROR", message: "boom" } }, 500);
      return defaultHandler(path);
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useHermesDashboardData());
    await flushMicrotasks();

    expect(result.current.state.status).toBe("ready");
    expect(result.current.portfolio).not.toBeNull();
    expect(result.current.summary).toBeNull();
  });
});
