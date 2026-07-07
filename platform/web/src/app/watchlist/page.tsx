import { PageHeader } from "@/components/ui/PageHeader";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { WatchlistTable } from "@/components/tables/WatchlistTable";
import { instruments } from "@/lib/mock";

export const metadata = {
  title: "Watchlist | Trading Intelligence Platform",
};

export default function WatchlistPage() {
  return (
    <>
      <PageHeader
        title="Watchlist"
        description="Tracked instruments with current price, intraday change, and volume."
      />

      <SectionPanel title="Tracked instruments" description={`${instruments.length} instruments`}>
        <WatchlistTable instruments={instruments} />
      </SectionPanel>
    </>
  );
}
