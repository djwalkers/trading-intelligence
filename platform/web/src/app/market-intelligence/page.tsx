import { MarketIntelligenceView } from "@/components/market-intelligence/MarketIntelligenceView";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { marketOverview, marketStatus, opportunities, instruments } from "@/lib/mock";
import { getStrategyEngine } from "@/lib/strategy-engine";
import { applyStrategyEngineToOpportunity } from "@/lib/utils/opportunity-strategy";

export const metadata = {
  title: "Market Intelligence | Trading Intelligence Platform",
};

export default function MarketIntelligencePage() {
  const strategyScores = getStrategyEngine().evaluateAll(instruments);
  const scoresBySymbol = new Map(strategyScores.map((score) => [score.instrumentSymbol, score]));

  const enrichedOpportunities = opportunities.map((opportunity) => {
    const score = scoresBySymbol.get(opportunity.instrumentSymbol);
    return score ? applyStrategyEngineToOpportunity(opportunity, score) : opportunity;
  });

  return (
    <>
      <MarketIntelligenceView
        overview={marketOverview}
        opportunities={enrichedOpportunities}
        marketStatus={marketStatus}
        strategyScores={strategyScores}
      />

      {/* Phase 2A.1 — Internal Market Diagnostics UI. The nav entry into the diagnostics page —
          read-only market-data/indicator inspection, kept separate from this page's own trading
          opportunity view. */}
      <SectionPanel
        title="Market Diagnostics"
        description="Internal, read-only view of live market-data quality and indicator calculations — for operational verification, not trading."
        viewAllHref="/market-intelligence/diagnostics"
      >
        <p className="px-5 py-4 text-xs text-ink-500">
          Inspect the current provider, candle history, EMA/RSI/ATR/trend, and data-quality checks without using
          TradingView.
        </p>
      </SectionPanel>

      {/* Phase 2B — Decision Intelligence: Historical Analysis Persistence. Distinct from the
          existing, unrelated /decision-intelligence page (the mock/strategy-engine bot's own "AI
          Decision History") — this one is Hermes-specific, nested here under Market Intelligence. */}
      <SectionPanel
        title="Decision Intelligence"
        description="Full historical record of every Hermes trading-runtime analysis cycle — read-only."
        viewAllHref="/market-intelligence/decision-intelligence"
      >
        <p className="px-5 py-4 text-xs text-ink-500">
          Every scheduler cycle, decision, and (if any) execution — timeline, distributions, strategy usage, and CSV
          export.
        </p>
      </SectionPanel>
    </>
  );
}
