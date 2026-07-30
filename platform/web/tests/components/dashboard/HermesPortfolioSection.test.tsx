import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { HermesPortfolioSection } from "@/components/dashboard/HermesPortfolioSection";
import { REFRESH_INTERVAL_MS, STALE_THRESHOLD_MS } from "@/lib/hermes-dashboard/use-hermes-dashboard-data";
import { paperPortfolio } from "@/lib/mock/portfolio";

// Main Dashboard Hermes/eToro fix — requirement 9's own test list, exercised end-to-end against
// the real component tree (HermesPortfolioSection -> use-hermes-dashboard-data -> mocked fetch).
// Fake timers throughout, matching use-hermes-dashboard-data.test.ts's own established pattern
// (waitFor cannot be used under fake timers — see that file's own doc comment).

const PORTFOLIO_BODY = {
  ok: true,
  data: {
    accountMode: "demo",
    provider: "etoro-demo",
    cash: 77_191.35,
    investedValue: 14.96,
    realisedPnl: -0.06,
    realisedPnlScope: "Since trade lifecycle tracking began — aggregated from durable, Supabase-backed trade lifecycle records.",
    realisedTradeCount: 3,
    unreconciledClosedTradeCount: 0,
    unrealisedPnl: null,
    unrealisedPnlComplete: false,
    unrealisedPnlUnavailableReason: "Could not fetch a live price for: BTC.",
    equity: null,
    equitySource: "UNAVAILABLE",
    openPositionCount: 1,
    currency: "USD",
    timestamp: "2026-07-29T21:00:00.000Z",
    positionsAreLiveGroundTruth: true,
  },
};
const POSITIONS_BODY = {
  ok: true,
  data: {
    positions: [
      {
        instrument: "BTC",
        side: "BUY",
        quantity: 9.95,
        units: 9.95,
        entryPrice: 64_208.29,
        currentPrice: null,
        unrealisedPnl: null,
        pricingTimestamp: null,
        pricingSource: "unavailable",
        openedAt: "2026-07-29T15:18:00.000Z",
        provider: "etoro-demo",
        accountMode: "demo",
        brokerPositionId: null,
      },
    ],
    count: 1,
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

async function flushMicrotasks(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

describe("HermesPortfolioSection", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("renders the eToro Demo Portfolio heading with the broker-ground-truth provenance labels — never describing this as a simulated account", async () => {
    global.fetch = mockFetchSequence(defaultHandler) as unknown as typeof fetch;
    render(<HermesPortfolioSection />);
    await flushMicrotasks();

    expect(screen.getByText("eToro Demo Portfolio")).toBeInTheDocument();
    expect(screen.getAllByText(/Broker ground truth/i).length).toBeGreaterThan(0);
    expect(screen.getByTestId("hermes-ground-truth-badge")).toHaveTextContent(/broker ground truth/i);
    expect(screen.getByTestId("hermes-provenance")).toHaveTextContent("etoro-demo");
    expect(screen.getByTestId("hermes-provenance")).toHaveTextContent("demo");
    expect(screen.getByTestId("hermes-ground-truth-badge")).toBeInTheDocument();
  });

  it("uses GET /api/hermes/portfolio values for the KPI cards (via the dashboard proxy)", async () => {
    global.fetch = mockFetchSequence(defaultHandler) as unknown as typeof fetch;
    render(<HermesPortfolioSection />);
    await flushMicrotasks();

    const kpis = screen.getByTestId("hermes-portfolio-kpis");
    expect(kpis).toHaveTextContent("$77,191.35"); // broker cash
    expect(kpis).toHaveTextContent("$14.96"); // invested value
    expect(kpis).toHaveTextContent("1"); // open positions
    expect(kpis).toHaveTextContent("-$0.06"); // realised P/L
  });

  it("uses GET /api/hermes/positions values for the positions table (via the dashboard proxy)", async () => {
    global.fetch = mockFetchSequence(defaultHandler) as unknown as typeof fetch;
    render(<HermesPortfolioSection />);
    await flushMicrotasks();

    expect(screen.getByTestId("hermes-position-row")).toHaveTextContent("BTC");
    expect(screen.getByTestId("hermes-position-row")).toHaveTextContent("BUY");
  });

  it("shows 'Unavailable' for null financial fields (unrealisedPnl/equity here) — never £0.00 or $0.00", async () => {
    global.fetch = mockFetchSequence(defaultHandler) as unknown as typeof fetch;
    render(<HermesPortfolioSection />);
    await flushMicrotasks();

    const kpis = screen.getByTestId("hermes-portfolio-kpis");
    expect(kpis).toHaveTextContent("Unavailable");
    expect(kpis.textContent).not.toContain("$0.00");
  });

  it("labels an internally-computed equity figure 'Calculated equity' — never presenting it as broker-supplied", async () => {
    global.fetch = mockFetchSequence((path) => {
      if (path.includes("hermes-portfolio")) {
        return jsonResponse({
          ok: true,
          data: { ...PORTFOLIO_BODY.data, unrealisedPnl: 42.5, unrealisedPnlComplete: true, unrealisedPnlUnavailableReason: null, equity: 77_248.81, equitySource: "CALCULATED" },
        });
      }
      return defaultHandler(path);
    }) as unknown as typeof fetch;
    render(<HermesPortfolioSection />);
    await flushMicrotasks();

    const kpis = screen.getByTestId("hermes-portfolio-kpis");
    expect(kpis).toHaveTextContent("Calculated equity");
    expect(kpis).toHaveTextContent("$77,248.81");
    expect(kpis).toHaveTextContent("$42.50");
  });

  it("shows the unreconciled closed-trade count alongside realised P/L when non-zero", async () => {
    global.fetch = mockFetchSequence((path) => {
      if (path.includes("hermes-portfolio")) {
        return jsonResponse({ ok: true, data: { ...PORTFOLIO_BODY.data, unreconciledClosedTradeCount: 2 } });
      }
      return defaultHandler(path);
    }) as unknown as typeof fetch;
    render(<HermesPortfolioSection />);
    await flushMicrotasks();

    const kpis = screen.getByTestId("hermes-portfolio-kpis");
    expect(kpis).toHaveTextContent("2 closed trade(s) excluded");
  });

  it("never prefixes a broker-native amount with £ — uses $ / USD until currency handling is resolved", async () => {
    global.fetch = mockFetchSequence(defaultHandler) as unknown as typeof fetch;
    render(<HermesPortfolioSection />);
    await flushMicrotasks();

    const kpis = screen.getByTestId("hermes-portfolio-kpis");
    expect(kpis.textContent).not.toContain("£");
    expect(kpis.textContent).toContain("$");
  });

  it("renders an empty-positions message when there are no open positions", async () => {
    global.fetch = mockFetchSequence((path) => {
      if (path.includes("hermes-positions")) return jsonResponse({ ...POSITIONS_BODY, data: { ...POSITIONS_BODY.data, positions: [], count: 0 } });
      return defaultHandler(path);
    }) as unknown as typeof fetch;
    render(<HermesPortfolioSection />);
    await flushMicrotasks();

    expect(screen.getByTestId("hermes-positions-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("hermes-position-row")).not.toBeInTheDocument();
  });

  it("shows a clear API-error state, and never falls back to legacy local paper balances", async () => {
    global.fetch = vi.fn(async () => jsonResponse({ ok: false, error: { code: "BROKER_UNAVAILABLE", message: "eToro unreachable" } }, 503)) as unknown as typeof fetch;

    render(<HermesPortfolioSection />);
    await flushMicrotasks();

    expect(screen.getByTestId("hermes-error")).toBeInTheDocument();
    expect(screen.getByTestId("hermes-error")).toHaveTextContent("eToro unreachable");
    expect(screen.queryByTestId("hermes-portfolio-kpis")).not.toBeInTheDocument();
    // The legacy paper-portfolio mock's own distinctive figure (previously fed into this exact
    // dashboard section via PortfolioOverviewKpis) must never appear as a fallback value.
    expect(document.body.textContent).not.toContain(String(paperPortfolio.currentValue));
  });

  it("shows a distinct unauthorised state for a 401 response", async () => {
    global.fetch = vi.fn(async () => jsonResponse({ ok: false, error: { code: "UNAUTHORIZED", message: "token missing" } }, 401)) as unknown as typeof fetch;
    render(<HermesPortfolioSection />);
    await flushMicrotasks();

    expect(screen.getByTestId("hermes-unauthorized")).toBeInTheDocument();
    expect(screen.queryByTestId("hermes-error")).not.toBeInTheDocument();
  });

  it("legacy paper-portfolio figures never appear anywhere in the rendered Hermes section", async () => {
    global.fetch = mockFetchSequence(defaultHandler) as unknown as typeof fetch;
    render(<HermesPortfolioSection />);
    await flushMicrotasks();

    // Confirms the component never reads/renders the legacy mock/local paper-trading data source
    // (@/lib/mock/portfolio, @/lib/state/paper-trades-context) at all — only real Hermes API data.
    expect(document.body.textContent).not.toContain(String(paperPortfolio.currentValue));
    expect(document.body.textContent).not.toContain(String(paperPortfolio.cashBalance));
    expect(document.body.textContent).not.toContain(String(paperPortfolio.dailyPl));
  });

  it("shows the last-refreshed time and a manual refresh button", async () => {
    global.fetch = mockFetchSequence(defaultHandler) as unknown as typeof fetch;
    render(<HermesPortfolioSection />);
    await flushMicrotasks();

    expect(screen.getByTestId("hermes-last-refreshed")).toHaveTextContent(/refreshed/i);
    expect(screen.getByTestId("hermes-refresh-button")).toBeInTheDocument();
  });

  it("shows a stale-data warning while remaining 'ready' once the last successful refresh is old enough", async () => {
    global.fetch = mockFetchSequence(defaultHandler) as unknown as typeof fetch;
    render(<HermesPortfolioSection />);
    await flushMicrotasks();
    expect(screen.queryByTestId("hermes-stale-warning")).not.toBeInTheDocument();

    // Simulate every subsequent poll hanging (e.g. an unresponsive broker) rather than failing
    // outright — the last-known-good figures stay on screen (never blanked), but time keeps
    // passing without a fresh successful refresh, so staleness becomes visible.
    global.fetch = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(STALE_THRESHOLD_MS + REFRESH_INTERVAL_MS);
    });

    expect(screen.getByTestId("hermes-stale-warning")).toBeInTheDocument();
    expect(screen.getByTestId("hermes-portfolio-kpis")).toBeInTheDocument();
  });
});
