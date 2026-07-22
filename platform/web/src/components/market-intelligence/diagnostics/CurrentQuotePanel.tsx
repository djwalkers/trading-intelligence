import { StatCard } from "@/components/ui/StatCard";
import type { MarketDiagnosticsResult } from "@/lib/hermes-execution/market-diagnostics-service";
import { formatPrice, formatSpread } from "./diagnostics-format";

interface CurrentQuotePanelProps {
  data: MarketDiagnosticsResult;
}

// Phase 2A.1 — Internal Market Diagnostics UI, section B.
export function CurrentQuotePanel({ data }: CurrentQuotePanelProps) {
  const { bid, ask, mid } = data.currentQuote;
  const lastClose = data.lastClosedCandle.close;
  const diffFromLastClose = mid - lastClose;
  const diffPercent = lastClose !== 0 ? (diffFromLastClose / lastClose) * 100 : 0;

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
      <StatCard label="Bid" value={formatPrice(bid)} />
      <StatCard label="Ask" value={formatPrice(ask)} />
      <StatCard label="Mid" value={formatPrice(mid)} valueClassName="text-accent-teal" />
      <StatCard label="Spread" value={formatSpread(ask - bid)} />
      <StatCard
        label="Mid vs. last close"
        value={`${diffFromLastClose >= 0 ? "+" : ""}${formatPrice(diffFromLastClose)}`}
        sublabel={`${diffPercent >= 0 ? "+" : ""}${diffPercent.toFixed(3)}% · last close ${formatPrice(lastClose)}`}
        valueClassName={diffFromLastClose >= 0 ? "text-accent-teal" : "text-accent-red"}
      />
    </div>
  );
}
