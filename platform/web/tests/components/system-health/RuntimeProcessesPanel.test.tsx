import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import { RuntimeProcessesPanel } from "@/components/system-health/RuntimeProcessesPanel";
import { REFRESH_INTERVAL_MS } from "@/lib/operations/use-runtime-processes-data";

// Runtime Processes panel — Operations Centre. Mirrors HermesPortfolioSection.test.tsx's own
// established convention: mock global fetch, render the REAL component (which uses the real hook
// internally), assert on rendered output — never mock the hook itself.

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function mockFetchSequence(handler: (path: string) => Response) {
  return vi.fn(async (input: string | URL | Request) => handler(String(input)));
}

function processFixture(overrides: Record<string, unknown> = {}) {
  return {
    key: "web",
    name: "Trading Intelligence Web",
    pm2Name: "trading-intelligence-web",
    available: true,
    pm2Id: 2,
    status: "online",
    uptimeMs: 2 * 60 * 60_000 + 14 * 60_000, // 2h 14m
    restartCount: 5,
    cpuPercent: 0.4,
    memoryBytes: 118 * 1024 * 1024,
    ...overrides,
  };
}

const PROCESSES_BODY = {
  ok: true,
  data: {
    processes: [
      processFixture(),
      processFixture({
        key: "hermes-runtime",
        name: "Hermes Market Runtime",
        pm2Name: "hermes-market-runtime",
        pm2Id: 3,
        uptimeMs: 60_000, // 1m
        restartCount: 0,
        cpuPercent: 0.1,
        memoryBytes: 95 * 1024 * 1024,
      }),
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

function defaultHandler(path: string): Response {
  if (path.includes("/api/dashboard/operations-processes")) return jsonResponse(PROCESSES_BODY);
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

describe("RuntimeProcessesPanel", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("renders both monitored processes by their friendly names", async () => {
    global.fetch = mockFetchSequence(defaultHandler) as unknown as typeof fetch;
    render(<RuntimeProcessesPanel />);
    await flushMicrotasks();

    expect(screen.getByText("Trading Intelligence Web")).toBeInTheDocument();
    expect(screen.getByText("Hermes Market Runtime")).toBeInTheDocument();
  });

  it("never renders the legacy worker process name anywhere on the page", async () => {
    global.fetch = mockFetchSequence(defaultHandler) as unknown as typeof fetch;
    render(<RuntimeProcessesPanel />);
    await flushMicrotasks();

    expect(screen.queryByText(/trading-intelligence-worker/i)).not.toBeInTheDocument();
  });

  it("shows the correct PM2 status label per process", async () => {
    global.fetch = mockFetchSequence((path) => {
      if (path.includes("/api/dashboard/operations-processes")) {
        return jsonResponse({
          ok: true,
          data: {
            processes: [processFixture({ status: "online" }), processFixture({ key: "hermes-runtime", pm2Name: "hermes-market-runtime", status: "errored" })],
            timestamp: "2026-08-07T09:00:00.000Z",
          },
        });
      }
      return defaultHandler(path);
    }) as unknown as typeof fetch;
    render(<RuntimeProcessesPanel />);
    await flushMicrotasks();

    const webCard = screen.getByTestId("runtime-process-card-web");
    expect(within(webCard).getByText("Online")).toBeInTheDocument();
    const hermesCard = screen.getByTestId("runtime-process-card-hermes-runtime");
    expect(within(hermesCard).getByText("Errored")).toBeInTheDocument();
  });

  it("formats uptime, restarts, CPU, and memory using the shared human-readable formatters", async () => {
    global.fetch = mockFetchSequence(defaultHandler) as unknown as typeof fetch;
    render(<RuntimeProcessesPanel />);
    await flushMicrotasks();

    const webCard = screen.getByTestId("runtime-process-card-web");
    expect(within(webCard).getByText("2h 14m")).toBeInTheDocument();
    expect(within(webCard).getByText("5")).toBeInTheDocument(); // restart count
    expect(within(webCard).getByText("0.4%")).toBeInTheDocument();
    expect(within(webCard).getByText("118 MB")).toBeInTheDocument();
  });

  it("renders Hermes operational information: mode, broker, scheduler, last cycle, open positions", async () => {
    global.fetch = mockFetchSequence(defaultHandler) as unknown as typeof fetch;
    render(<RuntimeProcessesPanel />);
    await flushMicrotasks();

    const hermesCard = screen.getByTestId("runtime-process-card-hermes-runtime");
    expect(within(hermesCard).getByText("Demo")).toBeInTheDocument();
    expect(within(hermesCard).getByText(/etoro-demo/i)).toBeInTheDocument();
    expect(within(hermesCard).getByText(/60/)).toBeInTheDocument(); // scheduler interval (60s)
    expect(within(hermesCard).getByText("1")).toBeInTheDocument(); // open position count
  });

  it("shows kill switch DISABLED with a healthy/green treatment in Demo mode", async () => {
    global.fetch = mockFetchSequence(defaultHandler) as unknown as typeof fetch;
    render(<RuntimeProcessesPanel />);
    await flushMicrotasks();

    const hermesCard = screen.getByTestId("runtime-process-card-hermes-runtime");
    const indicator = within(hermesCard).getByTestId("kill-switch-indicator");
    expect(indicator).toHaveTextContent(/disabled/i);
    expect(indicator.className).toContain("accent-teal");
  });

  it("shows kill switch ENABLED with an amber/red attention treatment in Demo mode", async () => {
    global.fetch = mockFetchSequence((path) => {
      if (path.includes("hermes-summary")) {
        return jsonResponse({ ok: true, data: { ...SUMMARY_BODY.data, health: { ...SUMMARY_BODY.data.health, killSwitchEnabled: true } } });
      }
      return defaultHandler(path);
    }) as unknown as typeof fetch;
    render(<RuntimeProcessesPanel />);
    await flushMicrotasks();

    const hermesCard = screen.getByTestId("runtime-process-card-hermes-runtime");
    const indicator = within(hermesCard).getByTestId("kill-switch-indicator");
    expect(indicator).toHaveTextContent(/enabled/i);
    expect(indicator.className).toContain("accent-amber");
  });

  it("keeps the kill switch treatment prominent/cautionary in Live mode even when disabled — never the calm Demo-mode green", async () => {
    global.fetch = mockFetchSequence((path) => {
      if (path.includes("hermes-summary")) {
        return jsonResponse({ ok: true, data: { ...SUMMARY_BODY.data, health: { ...SUMMARY_BODY.data.health, runtimeMode: "live", killSwitchEnabled: false } } });
      }
      return defaultHandler(path);
    }) as unknown as typeof fetch;
    render(<RuntimeProcessesPanel />);
    await flushMicrotasks();

    const hermesCard = screen.getByTestId("runtime-process-card-hermes-runtime");
    const indicator = within(hermesCard).getByTestId("kill-switch-indicator");
    expect(indicator).toHaveTextContent(/disabled/i);
    expect(indicator.className).not.toContain("accent-teal");
  });

  it("shows Demo mode with a calm treatment (not the prominent live-mode treatment)", async () => {
    global.fetch = mockFetchSequence(defaultHandler) as unknown as typeof fetch;
    render(<RuntimeProcessesPanel />);
    await flushMicrotasks();

    const hermesCard = screen.getByTestId("runtime-process-card-hermes-runtime");
    const modeIndicator = within(hermesCard).getByTestId("runtime-mode-indicator");
    expect(modeIndicator).toHaveTextContent(/demo/i);
  });

  it("gives a non-demo runtime mode a visually distinct, prominent treatment", async () => {
    global.fetch = mockFetchSequence((path) => {
      if (path.includes("hermes-summary")) {
        return jsonResponse({ ok: true, data: { ...SUMMARY_BODY.data, health: { ...SUMMARY_BODY.data.health, runtimeMode: "live" } } });
      }
      return defaultHandler(path);
    }) as unknown as typeof fetch;
    render(<RuntimeProcessesPanel />);
    await flushMicrotasks();

    const hermesCard = screen.getByTestId("runtime-process-card-hermes-runtime");
    const modeIndicator = within(hermesCard).getByTestId("runtime-mode-indicator");
    expect(modeIndicator).toHaveTextContent(/live/i);
    // A visually distinct treatment — asserted via a different class list than the demo case,
    // never asserted by exact colour hex (implementation detail) but by "not the calm/demo class".
    expect(modeIndicator.className).not.toContain("border-base-600");
  });

  it("shows the latest Hermes failure/warning when one is present", async () => {
    global.fetch = mockFetchSequence((path) => {
      if (path.includes("hermes-summary")) {
        return jsonResponse({
          ok: true,
          data: { ...SUMMARY_BODY.data, recentFailure: { eventType: "BROKER_RECONCILIATION_FAILED", timestamp: "2026-08-07T08:58:00.000Z", message: "Could not read broker portfolio" } },
        });
      }
      return defaultHandler(path);
    }) as unknown as typeof fetch;
    render(<RuntimeProcessesPanel />);
    await flushMicrotasks();

    const hermesCard = screen.getByTestId("runtime-process-card-hermes-runtime");
    expect(within(hermesCard).getByText(/Could not read broker portfolio/)).toBeInTheDocument();
  });

  it("renders open positions as an accessible link to the existing Hermes portfolio view when count > 0", async () => {
    global.fetch = mockFetchSequence(defaultHandler) as unknown as typeof fetch; // SUMMARY_BODY: openPositionCount 1
    render(<RuntimeProcessesPanel />);
    await flushMicrotasks();

    const hermesCard = screen.getByTestId("runtime-process-card-hermes-runtime");
    const link = within(hermesCard).getByRole("link", { name: "View 1 open position" });
    expect(link).toHaveAttribute("href", "/");
    expect(link).toHaveTextContent("1");
  });

  it("renders open positions as plain non-interactive text (no link) when count is 0", async () => {
    global.fetch = mockFetchSequence((path) => {
      if (path.includes("hermes-summary")) return jsonResponse({ ok: true, data: { ...SUMMARY_BODY.data, openPositionCount: 0 } });
      return defaultHandler(path);
    }) as unknown as typeof fetch;
    render(<RuntimeProcessesPanel />);
    await flushMicrotasks();

    const hermesCard = screen.getByTestId("runtime-process-card-hermes-runtime");
    // Scoped to the "Open positions" metric's own container, not the whole card — the PM2 side of
    // this same card also has its own unrelated "0" (restart count) in this fixture.
    const openPositionsContainer = within(hermesCard).getByText("Open positions").parentElement!;
    expect(within(openPositionsContainer).queryByRole("link")).not.toBeInTheDocument();
    expect(openPositionsContainer).toHaveTextContent("0");
  });

  it("uses a pluralised accessible label describing the number of open positions for the link", async () => {
    global.fetch = mockFetchSequence((path) => {
      if (path.includes("hermes-summary")) return jsonResponse({ ok: true, data: { ...SUMMARY_BODY.data, openPositionCount: 2 } });
      return defaultHandler(path);
    }) as unknown as typeof fetch;
    render(<RuntimeProcessesPanel />);
    await flushMicrotasks();

    const hermesCard = screen.getByTestId("runtime-process-card-hermes-runtime");
    expect(within(hermesCard).getByRole("link", { name: "View 2 open positions" })).toBeInTheDocument();
  });

  it("shows the summary strip counts (monitored / online / stopped / errored)", async () => {
    global.fetch = mockFetchSequence(defaultHandler) as unknown as typeof fetch;
    render(<RuntimeProcessesPanel />);
    await flushMicrotasks();

    const strip = screen.getByTestId("runtime-processes-summary-strip");
    expect(within(strip).getByText(/2 monitored/i)).toBeInTheDocument();
    expect(within(strip).getByText(/2 online/i)).toBeInTheDocument();
  });

  it("shows a degraded-state warning when the PM2 endpoint cannot be reached, without crashing", async () => {
    global.fetch = mockFetchSequence((path) => {
      if (path.includes("/api/dashboard/operations-processes")) return jsonResponse({ ok: false, error: { code: "PM2_UNAVAILABLE", message: "PM2 did not respond in time." } }, 503);
      return defaultHandler(path);
    }) as unknown as typeof fetch;
    render(<RuntimeProcessesPanel />);
    await flushMicrotasks();

    expect(screen.getByTestId("runtime-processes-degraded")).toHaveTextContent(/PM2 did not respond in time/);
  });

  it("shows a loading state on first render before data arrives", () => {
    global.fetch = mockFetchSequence(defaultHandler) as unknown as typeof fetch;
    render(<RuntimeProcessesPanel />);
    expect(screen.getByTestId("runtime-processes-loading")).toBeInTheDocument();
  });

  it("the manual refresh button triggers a re-fetch", async () => {
    const fetchMock = mockFetchSequence(defaultHandler);
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<RuntimeProcessesPanel />);
    await flushMicrotasks();

    const callsBefore = fetchMock.mock.calls.length;
    const button = screen.getByTestId("runtime-processes-refresh-button");
    expect(button).toHaveAccessibleName(/refresh/i);
    await act(async () => {
      button.click();
    });
    await flushMicrotasks();

    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it("auto-refreshes approximately every 30 seconds", async () => {
    const fetchMock = mockFetchSequence(defaultHandler);
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<RuntimeProcessesPanel />);
    await flushMicrotasks();

    const callsAfterMount = fetchMock.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
    });

    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });

  it("retains the last successful process data on screen when a later refresh fails", async () => {
    global.fetch = mockFetchSequence(defaultHandler) as unknown as typeof fetch;
    render(<RuntimeProcessesPanel />);
    await flushMicrotasks();
    expect(screen.getByText("Trading Intelligence Web")).toBeInTheDocument();

    global.fetch = mockFetchSequence((path) => {
      if (path.includes("/api/dashboard/operations-processes")) return jsonResponse({ ok: false, error: { code: "PM2_UNAVAILABLE", message: "down" } }, 503);
      return defaultHandler(path);
    }) as unknown as typeof fetch;
    const button = screen.getByTestId("runtime-processes-refresh-button");
    await act(async () => {
      button.click();
    });
    await flushMicrotasks();

    // The degraded warning is now visible, AND the last-known process cards are still rendered.
    expect(screen.getByTestId("runtime-processes-degraded")).toBeInTheDocument();
    expect(screen.getByText("Trading Intelligence Web")).toBeInTheDocument();
  });

  it("represents a missing/unavailable monitored process explicitly, never crashing or showing a fabricated status", async () => {
    global.fetch = mockFetchSequence((path) => {
      if (path.includes("/api/dashboard/operations-processes")) {
        return jsonResponse({
          ok: true,
          data: {
            processes: [
              processFixture(),
              { key: "hermes-runtime", name: "Hermes Market Runtime", pm2Name: "hermes-market-runtime", available: false, pm2Id: null, status: "unknown", uptimeMs: null, restartCount: null, cpuPercent: null, memoryBytes: null },
            ],
            timestamp: "2026-08-07T09:00:00.000Z",
          },
        });
      }
      return defaultHandler(path);
    }) as unknown as typeof fetch;
    render(<RuntimeProcessesPanel />);
    await flushMicrotasks();

    const hermesCard = screen.getByTestId("runtime-process-card-hermes-runtime");
    expect(within(hermesCard).getByText(/not found|unavailable/i)).toBeInTheDocument();
  });
});
