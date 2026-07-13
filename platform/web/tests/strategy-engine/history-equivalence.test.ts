import { describe, expect, it } from "vitest";
import { getStrategyEngine, HISTORY_LOOKBACK_DAYS } from "@/lib/strategy-engine";
import { MockHistoricalMarketDataProvider } from "@/lib/market-data/mock-historical-market-data-provider";
import { getInstrumentBySymbol } from "@/lib/mock/instruments";
import type { OHLCVCandle, StrategyScore } from "@/lib/types";

// Sprint 290 — runBotScan (src/lib/bot/bot-runner.ts) no longer calls
// getStrategyEngine().evaluateAllWithHistory() directly; it fetches candles itself via
// getHistoricalCandlesWithTelemetry() and evaluates each instrument through the same already-public
// evaluateInstrumentWithHistory() that evaluateAllWithHistory() uses internally per instrument. This
// test proves that substitution is genuinely behaviour-preserving: both paths must produce
// byte-identical StrategyScore[] output (aside from each call's own evaluatedAt timestamp).
function stripEvaluatedAt(scores: StrategyScore[]) {
  return scores.map(({ evaluatedAt: _evaluatedAt, ...rest }) => rest);
}

describe("evaluateAllWithHistory vs. the inlined telemetry + evaluateInstrumentWithHistory path", () => {
  it("produce identical StrategyScore[] output for the same instruments and provider", async () => {
    const provider = new MockHistoricalMarketDataProvider();
    const instruments = ["AAPL", "MSFT", "TSLA", "NVDA", "SPY"].map((symbol) => {
      const instrument = getInstrumentBySymbol(symbol);
      if (!instrument) throw new Error(`Missing fixture instrument: ${symbol}`);
      return instrument;
    });

    const viaEvaluateAllWithHistory = await getStrategyEngine().evaluateAllWithHistory(instruments, provider);

    const symbols = instruments.map((instrument) => instrument.symbol);
    const { candles } = await provider.getHistoricalCandlesWithTelemetry(symbols, HISTORY_LOOKBACK_DAYS);
    const candlesBySymbol = new Map<string, OHLCVCandle[]>();
    for (const candle of candles) {
      const existing = candlesBySymbol.get(candle.symbol);
      if (existing) existing.push(candle);
      else candlesBySymbol.set(candle.symbol, [candle]);
    }
    const viaInlinedPath = instruments.map((instrument) =>
      getStrategyEngine().evaluateInstrumentWithHistory(instrument, candlesBySymbol.get(instrument.symbol) ?? []),
    );

    expect(stripEvaluatedAt(viaInlinedPath)).toEqual(stripEvaluatedAt(viaEvaluateAllWithHistory));
  });
});
