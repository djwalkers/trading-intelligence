import type { PaperTrade } from "@/lib/types";
import { TradeJournalEntry } from "@/components/trading/TradeJournalEntry";

interface TradeJournalListProps {
  trades: PaperTrade[];
  onCloseTrade: (trade: PaperTrade) => void;
  emptyMessage: string;
}

export function TradeJournalList({ trades, onCloseTrade, emptyMessage }: TradeJournalListProps) {
  if (trades.length === 0) {
    return <p className="px-5 py-6 text-sm text-ink-500">{emptyMessage}</p>;
  }

  return (
    <div className="divide-y divide-base-700/60">
      {trades.map((trade) => (
        <TradeJournalEntry key={trade.id} trade={trade} onCloseTrade={onCloseTrade} />
      ))}
    </div>
  );
}
