import { getHermesExecutionConfig } from "@/lib/hermes-execution/config";
import { BrokerFactory } from "@/lib/hermes-execution/broker-factory";
import { EtoroDemoBroker } from "@/lib/hermes-execution/etoro/etoro-demo-broker";
import { InMemoryAuditTrail } from "@/lib/hermes-execution/audit-trail";
import { LiveMarketDataProvider } from "@/lib/hermes-execution/market-data/live-market-data-provider";
import { MarketIntelligenceBuilder } from "@/lib/hermes-execution/market-intelligence-builder";

// Phase 2A — Real Historical Candles for Live Market Data. `npm run market:diagnostics` — a
// read-only manual-verification command, purely for comparing this pipeline's own numbers against
// TradingView by eye. It fetches exactly one real live snapshot (a real bid/ask via
// EtoroDemoBroker.getRate, real historical candles via EtoroDemoBroker.getHistoricalCandles) and
// runs it through MarketIntelligenceBuilder.build() — the same, unmodified indicator computation
// the continuous runtime uses — to print current price / last closed candle / EMA20 / EMA50 /
// RSI14 / ATR14 / trend / timestamp. Deliberately does NOT call MarketDecisionEngine, does NOT
// place, close, or size any order, does NOT touch the risk engine or scheduler, and records no
// audit trail (an InMemoryAuditTrail, discarded on exit) — this command can never trade.

export interface DiagnosticsCandle {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface DiagnosticsReport {
  instrument: string;
  timestamp: string;
  currentPrice: number;
  bid: number;
  ask: number;
  lastClosedCandle: DiagnosticsCandle;
  ema20: number;
  ema50: number;
  rsi14: number;
  atr14: number;
  trend: string;
}

// A placeholder identity only — MarketIntelligenceBuilder.build() requires a strategy identity to
// stamp onto its output, but this report is never handed to MarketDecisionEngine or any execution
// path, so nothing downstream can ever mistake it for a real strategy evaluation. sourceType
// "DEMO_ONLY" (never "HERMES_APPROVED") keeps that unmissable even if this object were ever
// inspected out of context.
const DIAGNOSTICS_STRATEGY_IDENTITY = {
  strategyId: "MARKET-DIAGNOSTICS",
  strategyVersion: 0,
  strategySourceType: "DEMO_ONLY" as const,
};

/** Connects to eToro, resolves `instrument`, and fetches one real LiveMarketDataProvider snapshot
 * — exported separately from main() so it's directly unit-testable without invoking the CLI. */
export async function buildDiagnosticsReport(instrument: string): Promise<DiagnosticsReport> {
  const config = getHermesExecutionConfig();
  if (config.etoro.env !== "demo" || !config.etoro.apiKey || !config.etoro.userKey) {
    throw new Error(
      "market:diagnostics requires ETORO_ENV=demo and both ETORO_API_KEY/ETORO_USER_KEY to be set " +
        "— it always connects to the real eToro demo API to fetch a live quote and real historical candles.",
    );
  }

  // Discarded on exit — this command is read-only and never needs its own persisted history.
  const auditTrail = new InMemoryAuditTrail();
  const broker = (await BrokerFactory.create(config, auditTrail, `market-diagnostics-${Date.now()}`, {
    provider: "etoro-demo",
  })) as EtoroDemoBroker;

  await broker.resolveInstrument(instrument);

  const provider = new LiveMarketDataProvider(broker, {
    timeframe: config.marketData.timeframe,
    candleCount: config.marketData.candleCount,
    maxCandleAgeSeconds: config.marketData.maxCandleAgeSeconds,
  });
  const snapshot = await provider.getMarketData(instrument);

  const context = MarketIntelligenceBuilder.build({
    instrument,
    bid: snapshot.bid,
    ask: snapshot.ask,
    positionOpen: false,
    ...DIAGNOSTICS_STRATEGY_IDENTITY,
    candles: snapshot.candles,
  });

  const lastCandle = snapshot.candles[snapshot.candles.length - 1]!;

  return {
    instrument,
    timestamp: context.timestamp,
    currentPrice: context.midPrice,
    bid: context.bid,
    ask: context.ask,
    lastClosedCandle: {
      timestamp: lastCandle.timestamp,
      open: lastCandle.open,
      high: lastCandle.high,
      low: lastCandle.low,
      close: lastCandle.close,
      volume: lastCandle.volume,
    },
    ema20: context.ema20,
    ema50: context.ema50,
    rsi14: context.rsi14,
    atr14: context.atr14,
    trend: context.trend,
  };
}

export function formatDiagnosticsReport(report: DiagnosticsReport): string {
  return [
    `Instrument: ${report.instrument}`,
    `Timestamp: ${report.timestamp}`,
    "",
    `Current price (bid/ask mid, from getRate): ${report.currentPrice.toFixed(2)}`,
    `  Bid: ${report.bid}  Ask: ${report.ask}`,
    "",
    "Last closed candle:",
    `  Timestamp: ${report.lastClosedCandle.timestamp}`,
    `  Open: ${report.lastClosedCandle.open}`,
    `  High: ${report.lastClosedCandle.high}`,
    `  Low: ${report.lastClosedCandle.low}`,
    `  Close: ${report.lastClosedCandle.close}`,
    `  Volume: ${report.lastClosedCandle.volume}`,
    "",
    `EMA20: ${report.ema20.toFixed(2)}`,
    `EMA50: ${report.ema50.toFixed(2)}`,
    `RSI14: ${report.rsi14.toFixed(1)}`,
    `ATR14: ${report.atr14.toFixed(2)}`,
    `Trend: ${report.trend}`,
  ].join("\n");
}

export async function main(): Promise<void> {
  console.log("Market Diagnostics — manual verification against TradingView");
  console.log("================================================================");
  console.log("Read-only: no order will ever be placed, no strategy/risk/execution logic is touched.");

  const config = getHermesExecutionConfig();
  const instrument = config.runtimeTrading.symbol;
  console.log("");
  console.log(`Instrument: ${instrument} (HERMES_TRADING_SYMBOL)`);
  console.log(`Timeframe: ${config.marketData.timeframe}  Candle count: ${config.marketData.candleCount}`);
  console.log("");

  const report = await buildDiagnosticsReport(instrument);
  console.log(formatDiagnosticsReport(report));
}

// Only auto-runs when this file is executed directly (`tsx market-diagnostics.ts`), not when
// imported elsewhere (e.g. its own test file) — same convention as market-decide.ts/market-runtime.ts.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("Market diagnostics failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
