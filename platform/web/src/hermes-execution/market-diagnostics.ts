import { getHermesExecutionConfig } from "@/lib/hermes-execution/config";
import {
  getMarketDiagnostics,
  MarketDiagnosticsError,
  type MarketDiagnosticsResult,
} from "@/lib/hermes-execution/market-diagnostics-service";

// Phase 2A — Real Historical Candles for Live Market Data (Phase 2A.1 follow-up). `npm run
// market:diagnostics` — a read-only manual-verification command, purely for comparing this
// pipeline's own numbers against TradingView by eye. All of the actual work (config-driven
// provider selection, broker connection, candle fetch/validation, indicator computation) now lives
// in market-diagnostics-service.ts — the exact same function `GET /api/hermes/market-diagnostics`
// calls — so this file is CLI formatting only, never a second implementation of any of that logic.
// Deliberately does NOT call MarketDecisionEngine, does NOT place, close, or size any order, does
// NOT touch the risk engine or scheduler, and records no audit trail of its own — this command can
// never trade.

export function formatDiagnosticsReport(report: MarketDiagnosticsResult): string {
  return [
    `Instrument: ${report.instrument}`,
    `Provider: ${report.provider} (broker: ${report.brokerProvider})`,
    `Timeframe: ${report.timeframe}  Requested candles: ${report.requestedCandleCount}  Received: ${report.receivedCandleCount}`,
    `Fetched at: ${report.fetchedAt}`,
    "",
    `Current price (bid/ask mid): ${report.currentQuote.mid.toFixed(2)}`,
    `  Bid: ${report.currentQuote.bid}  Ask: ${report.currentQuote.ask}`,
    "",
    "Last closed candle:",
    `  Timestamp: ${report.lastClosedCandle.timestamp}`,
    `  Open: ${report.lastClosedCandle.open}`,
    `  High: ${report.lastClosedCandle.high}`,
    `  Low: ${report.lastClosedCandle.low}`,
    `  Close: ${report.lastClosedCandle.close}`,
    `  Volume: ${report.lastClosedCandle.volume !== undefined ? report.lastClosedCandle.volume : "n/a (not reported by eToro for this candle)"}`,
    "",
    `EMA20: ${report.indicators.ema20.toFixed(2)}`,
    `EMA50: ${report.indicators.ema50.toFixed(2)}`,
    `RSI14: ${report.indicators.rsi14.toFixed(1)}`,
    `ATR14: ${report.indicators.atr14.toFixed(2)}`,
    `Trend: ${report.indicators.trend}`,
    "",
    `Data age: ${Math.round(report.validation.dataAgeSeconds)}s  Volume available: ${report.validation.volumeAvailable}  Fallback occurred: ${report.validation.fallbackOccurred}`,
  ].join("\n");
}

export async function main(): Promise<void> {
  console.log("Market Diagnostics — manual verification against TradingView");
  console.log("================================================================");
  console.log("Read-only: no order will ever be placed, no strategy/risk/execution logic is touched.");
  console.log("");

  try {
    const report = await getMarketDiagnostics({ instrument: getHermesExecutionConfig().runtimeTrading.symbol });
    console.log(formatDiagnosticsReport(report));
  } catch (error) {
    if (error instanceof MarketDiagnosticsError) {
      console.error(`Market diagnostics failed [${error.code}]: ${error.message}`);
    } else {
      console.error("Market diagnostics failed:", error instanceof Error ? error.message : error);
    }
    process.exitCode = 1;
  }
}

// Only auto-runs when this file is executed directly (`tsx market-diagnostics.ts`), not when
// imported elsewhere (e.g. its own test file) — same convention as market-decide.ts/market-runtime.ts.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("Market diagnostics crashed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
