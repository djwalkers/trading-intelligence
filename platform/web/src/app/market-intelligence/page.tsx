import { MarketIntelligenceView } from "@/components/market-intelligence/MarketIntelligenceView";
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
    <MarketIntelligenceView
      overview={marketOverview}
      opportunities={enrichedOpportunities}
      marketStatus={marketStatus}
      strategyScores={strategyScores}
    />
  );
}
