import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { MarketDiagnosticsResult } from "@/lib/hermes-execution/market-diagnostics-service";
import type { MarketDiagnosticsFetchResult } from "@/app/market-intelligence/diagnostics/actions";

const { fetchMarketDiagnosticsMock } = vi.hoisted(() => ({ fetchMarketDiagnosticsMock: vi.fn() }));
vi.mock("@/app/market-intelligence/diagnostics/actions", () => ({
  fetchMarketDiagnostics: fetchMarketDiagnosticsMock,
}));

const { MarketDiagnosticsView } = await import("@/components/market-intelligence/diagnostics/MarketDiagnosticsView");

function makeCandles(count: number, withVolume = true): MarketDiagnosticsResult["candles"] {
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  return Array.from({ length: count }, (_, i) => {
    const price = 50_000 + i;
    return { timestamp: new Date(start + i * 3_600_000).toISOString(), open: price, high: price + 10, low: price - 10, close: price };
  });
}

function makeResult(overrides: Partial<MarketDiagnosticsResult> = {}): MarketDiagnosticsResult {
  const candles = makeCandles(60);
  return {
    instrument: "BTC",
    provider: "live",
    brokerProvider: "etoro-demo",
    timeframe: "1h",
    requestedCandleCount: 60,
    receivedCandleCount: 60,
    fetchedAt: "2026-01-01T05:00:00.000Z",
    firstCandleTimestamp: candles[0]!.timestamp,
    lastCandleTimestamp: candles[candles.length - 1]!.timestamp,
    currentQuote: { bid: 50_059, ask: 50_061, mid: 50_060 },
    lastClosedCandle: { ...candles[candles.length - 1]!, volume: 42 },
    indicators: { ema20: 50_050, ema50: 50_030, rsi14: 55, atr14: 12, trend: "Bullish" },
    series: {
      timestamps: candles.map((c) => c.timestamp),
      ema20: candles.map(() => 50_050),
      ema50: candles.map(() => 50_030),
      rsi14: candles.map(() => 55),
    },
    validation: {
      fallbackOccurred: false,
      dataAgeSeconds: 30,
      maxCandleAgeSeconds: 7_200,
      volumeAvailable: true,
      duplicateTimestampsPassed: true,
      ohlcValidationPassed: true,
      staleDataValidationPassed: true,
    },
    candles,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MarketDiagnosticsView — loading state", () => {
  it("shows a loading placeholder when there is no initial data and no error", () => {
    render(<MarketDiagnosticsView initial={{ ok: false, error: { code: "BROKER_CONNECTION_FAILED", message: "pending" } }} />);
    // The status header still renders even with no data, and the error is surfaced immediately —
    // this specific case (no data, an error present) exercises the "no data yet" + error path.
    expect(screen.getByTestId("no-data-placeholder")).toBeInTheDocument();
  });

  it("shows 'Refreshing…' on the button and a loading indicator while a refresh is in flight", async () => {
    const result = makeResult();
    let resolveRefresh!: (value: MarketDiagnosticsFetchResult) => void;
    fetchMarketDiagnosticsMock.mockImplementation(
      () =>
        new Promise<MarketDiagnosticsFetchResult>((resolve) => {
          resolveRefresh = resolve;
        }),
    );

    const user = userEvent.setup();
    render(<MarketDiagnosticsView initial={{ ok: true, diagnostics: result }} />);

    await user.click(screen.getByTestId("refresh-button"));
    expect(screen.getByTestId("refresh-button")).toHaveTextContent("Refreshing…");
    expect(screen.getByTestId("loading-indicator")).toBeInTheDocument();

    resolveRefresh({ ok: true, diagnostics: result });
    await waitFor(() => expect(screen.getByTestId("refresh-button")).toHaveTextContent("Refresh"));
  });
});

describe("MarketDiagnosticsView — success rendering", () => {
  it("renders the quote, indicators, and provider/broker/instrument/timeframe badges from the initial result", () => {
    render(<MarketDiagnosticsView initial={{ ok: true, diagnostics: makeResult() }} />);

    expect(screen.getByTestId("provider-badge")).toHaveTextContent("Live market data");
    expect(screen.getByText("etoro-demo")).toBeInTheDocument();
    expect(screen.getByText("BTC")).toBeInTheDocument();
    expect(screen.getByText("50,050.00")).toBeInTheDocument(); // EMA20
    expect(screen.getByTestId("trend-badge")).toHaveTextContent("Bullish");
  });
});

describe("MarketDiagnosticsView — provider/fallback badges", () => {
  it("shows an amber 'Mock market data' badge for provider: mock", () => {
    render(<MarketDiagnosticsView initial={{ ok: true, diagnostics: makeResult({ provider: "mock" }) }} />);
    const badge = screen.getByTestId("provider-badge");
    expect(badge).toHaveTextContent("Mock market data");
    expect(badge.className).toContain("amber");
  });

  it("shows a teal 'No fallback' badge when fallbackOccurred is false", () => {
    render(<MarketDiagnosticsView initial={{ ok: true, diagnostics: makeResult() }} />);
    const badge = screen.getByTestId("fallback-badge");
    expect(badge).toHaveTextContent("No fallback");
    expect(badge.className).toContain("teal");
  });
});

describe("MarketDiagnosticsView — stale-data rendering", () => {
  it("shows a 'Near stale threshold' freshness badge when data age is close to the configured max", () => {
    const result = makeResult({
      validation: {
        fallbackOccurred: false,
        dataAgeSeconds: 6_900,
        maxCandleAgeSeconds: 7_200,
        volumeAvailable: true,
        duplicateTimestampsPassed: true,
        ohlcValidationPassed: true,
        staleDataValidationPassed: true,
      },
    });
    render(<MarketDiagnosticsView initial={{ ok: true, diagnostics: result }} />);
    expect(screen.getByTestId("freshness-badge")).toHaveTextContent("Near stale threshold");
  });

  it("shows a 'Fresh' freshness badge for recently fetched data", () => {
    render(<MarketDiagnosticsView initial={{ ok: true, diagnostics: makeResult() }} />);
    expect(screen.getByTestId("freshness-badge")).toHaveTextContent("Fresh");
  });
});

describe("MarketDiagnosticsView — missing-volume rendering", () => {
  it("shows 'Unavailable (not a validation failure)' rather than implying a failure", () => {
    const candles = makeCandles(60);
    const result = makeResult({
      lastClosedCandle: { ...candles[candles.length - 1]!, volume: undefined },
      validation: {
        fallbackOccurred: false,
        dataAgeSeconds: 30,
        maxCandleAgeSeconds: 7_200,
        volumeAvailable: false,
        duplicateTimestampsPassed: true,
        ohlcValidationPassed: true,
        staleDataValidationPassed: true,
      },
    });
    render(<MarketDiagnosticsView initial={{ ok: true, diagnostics: result }} />);
    expect(screen.getByText(/Unavailable \(not a validation failure\)/)).toBeInTheDocument();
    // The three real validation checks still show "passed" — missing volume never fails them.
    expect(screen.getByText(/OHLC validation: passed/)).toBeInTheDocument();
    expect(screen.getByText(/Stale-data validation: passed/)).toBeInTheDocument();
  });
});

describe("MarketDiagnosticsView — failed refresh retains the last valid result", () => {
  beforeEach(() => {
    fetchMarketDiagnosticsMock.mockReset();
  });

  it("keeps showing the last successful data and shows an error banner when a refresh fails", async () => {
    const goodResult = makeResult();
    fetchMarketDiagnosticsMock.mockResolvedValue({
      ok: false,
      error: { code: "CANDLE_FETCH_FAILED", message: "eToro timed out" },
    });

    const user = userEvent.setup();
    render(<MarketDiagnosticsView initial={{ ok: true, diagnostics: goodResult }} />);

    // The dashboard is showing real data before the failed refresh.
    expect(screen.getByText("50,050.00")).toBeInTheDocument();

    await user.click(screen.getByTestId("refresh-button"));

    await waitFor(() => {
      expect(screen.getByTestId("error-banner")).toHaveTextContent("eToro timed out");
    });
    // The last-known-good data is still on screen — never cleared by a failed refresh, and never
    // silently replaced with mock/synthetic data.
    expect(screen.getByText("50,050.00")).toBeInTheDocument();
    expect(screen.queryByTestId("no-data-placeholder")).not.toBeInTheDocument();
  });

  it("clears a previous error once a subsequent refresh succeeds", async () => {
    const result = makeResult();
    fetchMarketDiagnosticsMock.mockResolvedValueOnce({
      ok: false,
      error: { code: "CANDLE_FETCH_FAILED", message: "eToro timed out" },
    });
    fetchMarketDiagnosticsMock.mockResolvedValueOnce({ ok: true, diagnostics: result });

    const user = userEvent.setup();
    render(<MarketDiagnosticsView initial={{ ok: true, diagnostics: result }} />);

    await user.click(screen.getByTestId("refresh-button"));
    await waitFor(() => expect(screen.getByTestId("error-banner")).toBeInTheDocument());

    await user.click(screen.getByTestId("refresh-button"));
    await waitFor(() => expect(screen.queryByTestId("error-banner")).not.toBeInTheDocument());
  });
});
