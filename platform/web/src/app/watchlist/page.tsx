import { PageHeader } from "@/components/ui/PageHeader";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { WatchlistTable } from "@/components/tables/WatchlistTable";
import { WatchlistHealthSummary } from "@/components/watchlist/WatchlistHealthSummary";
import { instruments, opportunities } from "@/lib/mock";
import { summarizeIntelligenceScores } from "@/lib/utils/intelligence-score";

export const metadata = {
  title: "Watchlist | Trading Intelligence Platform",
};

export default function WatchlistPage() {
  const healthSummary = summarizeIntelligenceScores(opportunities);

  return (
    <>
      <PageHeader
        title="Watchlist"
        description="Tracked instruments with current price, intraday change, and volume."
      />

      <SectionPanel
        title="Watchlist health"
        description="Tracked instruments grouped by Intelligence Score"
        viewAllHref="/market-intelligence"
      >
        <WatchlistHealthSummary summary={healthSummary} />
      </SectionPanel>

      <SectionPanel title="Tracked instruments" description={`${instruments.length} instruments`}>
        <WatchlistTable instruments={instruments} />
      </SectionPanel>
    </>
  );
}
