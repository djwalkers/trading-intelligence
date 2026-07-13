import { describe, expect, it } from "vitest";
import { buildPaperTradeFromOpportunity, buildPaperTradeFromSignal } from "@/lib/utils/paper-trade";
import type { EntryPriceInfo, Opportunity, Signal } from "@/lib/types";

const entryPriceInfo: EntryPriceInfo = {
  price: 150,
  source: "External",
  provider: "Finnhub",
  timestamp: "2026-01-01T00:00:00.000Z",
  mode: "Connected",
};

const signal: Signal = {
  id: "signal-1",
  instrumentSymbol: "AAPL",
  instrumentName: "Apple Inc.",
  signalType: "BUY",
  confidencePercent: 80,
  strategyName: "Momentum",
  reason: "Strong upward momentum.",
  timestamp: "2026-01-01T00:00:00.000Z",
};

const opportunity: Opportunity = {
  id: "opportunity-1",
  instrumentSymbol: "AAPL",
  instrumentName: "Apple Inc.",
  signalType: "BUY",
  confidencePercent: 80,
  reasons: ["Strong momentum"],
  recommendation: "Buy",
  narrative: "Strong setup.",
  evidence: [{ label: "Momentum", score: 80 }],
  whyEvidence: ["Momentum is strong"],
  invalidationFactors: ["A break below support"],
  intelligenceFactors: {
    trend: 80,
    momentum: 80,
    volume: 70,
    volatility: 60,
    marketContext: 70,
    risk: 70,
    reward: 80,
  },
};

describe("buildPaperTradeFromSignal", () => {
  it("always classifies dataProvenance as sample_data, regardless of the entry quote's own mode", () => {
    const trade = buildPaperTradeFromSignal(signal, entryPriceInfo);
    expect(trade.dataProvenance).toBe("sample_data");
  });

  it("stays sample_data even when the entry quote connected to a real external provider", () => {
    const trade = buildPaperTradeFromSignal(signal, { ...entryPriceInfo, source: "External", mode: "Connected" });
    expect(trade.dataProvenance).toBe("sample_data");
  });
});

describe("buildPaperTradeFromOpportunity", () => {
  it("always classifies dataProvenance as sample_data, regardless of the entry quote's own mode", () => {
    const trade = buildPaperTradeFromOpportunity(opportunity, entryPriceInfo);
    expect(trade.dataProvenance).toBe("sample_data");
  });
});
