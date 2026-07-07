import { MarketIntelligenceView } from "@/components/market-intelligence/MarketIntelligenceView";
import { marketOverview, marketStatus, opportunities } from "@/lib/mock";

export const metadata = {
  title: "Market Intelligence | Trading Intelligence Platform",
};

export default function MarketIntelligencePage() {
  return (
    <MarketIntelligenceView
      overview={marketOverview}
      opportunities={opportunities}
      marketStatus={marketStatus}
    />
  );
}
