"use client";

import { StatCard } from "@/components/ui/StatCard";
import { usePaperTrades } from "@/lib/state/paper-trades-context";
import { useMarketQuotes } from "@/lib/state/use-market-quotes";
import { calculatePaperTradePerformance } from "@/lib/utils/paper-trade";
import { formatSignedNumber } from "@/lib/utils/format";
import { plToneClass } from "@/lib/utils/style";

export function PaperTradingSummary() {
  const { trades } = usePaperTrades();
  const openSymbols = [
    ...new Set(trades.filter((trade) => trade.status === "Open").map((trade) => trade.instrumentSymbol)),
  ];
  const { prices } = useMarketQuotes(openSymbols);
  const performance = calculatePaperTradePerformance(trades, prices);

  return (
    <div className="grid grid-cols-1 gap-4 px-5 py-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard label="Open trades" value={String(performance.openCount)} />
      <StatCard label="Closed trades" value={String(performance.closedCount)} />
      <StatCard
        label="Realised P/L"
        value={formatSignedNumber(performance.realisedPnl)}
        valueClassName={plToneClass(performance.realisedPnl)}
      />
      <StatCard
        label="Unrealised P/L"
        value={formatSignedNumber(performance.unrealisedPnl)}
        valueClassName={plToneClass(performance.unrealisedPnl)}
      />
    </div>
  );
}
