import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { REFRESH_INTERVAL_MS, STALE_THRESHOLD_MS, useRuntimeProcessesData } from "@/lib/operations/use-runtime-processes-data";

// Runtime Processes panel — Operations Centre. Mirrors use-hermes-dashboard-data.test.ts's own
// established conventions exactly (fake timers, mocked global fetch, flushMicrotasks helper) — two
// endpoints this time: /api/operations/processes (PM2 health, required for "ready") and
// /api/dashboard/hermes-summary (Hermes operational state, best-effort/supplementary, exactly like
// the main dashboard hook already treats its own summary fetch).

const PROCESSES_BODY = {
  ok: true,
  data: {
    processes: [
      { key: "web", name: "Trading Intelligence Web", pm2Name: "trading-intelligence-web", available: true, pm2Id: 2, status: "online", uptimeMs: 3_600_000, restartCount: 1, cpuPercent: 0.2, memoryBytes: 150 * 1024 * 1024 },
      { key: "hermes-runtime", name: "Hermes Market Runtime", pm2Name: "hermes-market-runtime", available: true, pm2Id: 3, status: "online", uptimeMs: 7_200_000, restartCount: 0, cpuPercent: 0.4, memoryBytes: 118 * 1024 * 1024 },
    ],
    timestamp: "2026-08-07T09:00:00.000Z",
  },
};

const SUMMARY_BODY = {
  ok: true,
  data: {
    timestamp: "2026-08-07T09:00:00.000Z",
    health: { status: "healthy", runtimeMode: "demo", brokerProvider: "etoro-demo", killSwitchEnabled: false, schedulerEnabled: true, schedulerIntervalMs: 60_000 },
    runtime: { state: "RUNNING", lastRunAt: "2026-08-07T08:59:00.000Z", successfulRunCount: 10, failedRunCount: 0 },
    openPositionCount: 1,
    latestDecision: { timestamp: "2026-08-07T08:59:00.000Z", symbol: "BTC", outcome: "HOLD", confidence: 0.6 },
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
  if (path.includes("/api/operations/processes")) return jsonResponse(PROCESSES_BODY);
  if (path.includes("hermes-summary")) return jsonResponse(SUMMARY_BODY);
  throw new Error(`unexpected path: ${path}`);
}

const originalFetch = global.fetch;

async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("useRuntimeProcessesData", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("fetches both endpoints on mount and becomes ready", async () => {
    global.fetch = mockFetchSequence(defaultHandler) as unknown as typeof fetch;
    const { result } = renderHook(() => useRuntimeProcessesData());
    await flushMicrotasks();

    expect(result.current.state.status).toBe("ready");
    expect(result.current.processes?.processes).toHaveLength(2);
    expect(result.current.hermesSummary?.health.runtimeMode).toBe("demo");
    expect(result.current.lastRefreshedAt).not.toBeNull();
  });

  it("refreshes automatically every 30 seconds", async () => {
    const fetchMock = mockFetchSequence(defaultHandler);
    global.fetch = fetchMock as unknown as typeof fetch;
    renderHook(() => useRuntimeProcessesData());
    await flushMicrotasks();

    const callsAfterMount = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
    });

    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });

  it("the manual refresh() function triggers an immediate re-fetch of both endpoints", async () => {
    const fetchMock = mockFetchSequence(defaultHandler);
    global.fetch = fetchMock as unknown as typeof fetch;
    const { result } = renderHook(() => useRuntimeProcessesData());
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
    const { result } = renderHook(() => useRuntimeProcessesData());
    await flushMicrotasks();
    expect(result.current.isStale).toBe(false);

    global.fetch = vi.fn(async () => jsonResponse({ ok: false, error: { code: "PM2_UNAVAILABLE", message: "down" } }, 503)) as unknown as typeof fetch;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STALE_THRESHOLD_MS + REFRESH_INTERVAL_MS);
    });

    expect(result.current.isStale).toBe(true);
  });

  it("retains the last successful PM2 process data when a later refresh fails — never blanked out", async () => {
    global.fetch = mockFetchSequence(defaultHandler) as unknown as typeof fetch;
    const { result } = renderHook(() => useRuntimeProcessesData());
    await flushMicrotasks();
    expect(result.current.processes?.processes).toHaveLength(2);

    global.fetch = vi.fn(async () => jsonResponse({ ok: false, error: { code: "PM2_UNAVAILABLE", message: "PM2 did not respond in time." } }, 503)) as unknown as typeof fetch;
    act(() => {
      result.current.refresh();
    });
    await flushMicrotasks();

    // Degraded state is visible...
    expect(result.current.state.status).toBe("degraded");
    if (result.current.state.status === "degraded") {
      expect(result.current.state.message).toContain("PM2 did not respond in time");
    }
    // ...but the last successful data is still there, not cleared.
    expect(result.current.processes?.processes).toHaveLength(2);
  });

  it("shows a concise degraded state when the PM2 endpoint cannot be reached at all (network failure)", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useRuntimeProcessesData());
    await flushMicrotasks();

    expect(result.current.state.status).toBe("degraded");
    expect(result.current.processes).toBeNull();
  });

  it("a Hermes-summary-only failure never blocks PM2 process data from becoming ready (best-effort, matching the main dashboard's own convention)", async () => {
    global.fetch = mockFetchSequence((path) => {
      if (path.includes("hermes-summary")) return jsonResponse({ ok: false, error: { code: "UNKNOWN_ERROR", message: "boom" } }, 500);
      return defaultHandler(path);
    }) as unknown as typeof fetch;
    const { result } = renderHook(() => useRuntimeProcessesData());
    await flushMicrotasks();

    expect(result.current.state.status).toBe("ready");
    expect(result.current.processes).not.toBeNull();
    expect(result.current.hermesSummary).toBeNull();
  });

  it("retains the last successful Hermes summary when a later refresh's summary fetch fails, even though PM2 data still refreshes fine", async () => {
    global.fetch = mockFetchSequence(defaultHandler) as unknown as typeof fetch;
    const { result } = renderHook(() => useRuntimeProcessesData());
    await flushMicrotasks();
    expect(result.current.hermesSummary?.health.runtimeMode).toBe("demo");

    global.fetch = mockFetchSequence((path) => {
      if (path.includes("hermes-summary")) return jsonResponse({ ok: false, error: { code: "UNKNOWN_ERROR", message: "boom" } }, 500);
      return defaultHandler(path);
    }) as unknown as typeof fetch;
    act(() => {
      result.current.refresh();
    });
    await flushMicrotasks();

    // The refresh as a whole is still "ready" (PM2 succeeded) and the last-known Hermes summary is
    // still there, not cleared, on this best-effort request's own transient failure.
    expect(result.current.state.status).toBe("ready");
    expect(result.current.hermesSummary?.health.runtimeMode).toBe("demo");
  });
});
