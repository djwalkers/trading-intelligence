import type { PaperTrade } from "@/lib/types";
import { Badge } from "@/components/ui/Badge";
import { formatCurrencyUSD, formatDateTime, formatSignedNumber } from "@/lib/utils/format";
import {
  paperTradeStatusClasses,
  plToneClass,
  signalToneClasses,
  tradeSourceClasses,
} from "@/lib/utils/style";

interface PaperTradesTableProps {
  trades: PaperTrade[];
  prices?: Record<string, number>;
  onCloseTrade: (trade: PaperTrade) => void;
  emptyMessage?: string;
}

export function PaperTradesTable({
  trades,
  prices = {},
  onCloseTrade,
  emptyMessage = "No paper trades yet.",
}: PaperTradesTableProps) {
  if (trades.length === 0) {
    return <p className="px-5 py-6 text-sm text-ink-500">{emptyMessage}</p>;
  }

  return (
    <div
      className="overflow-x-auto scrollbar-thin"
      role="region"
      aria-label="Paper trades table, scroll horizontally for more columns"
      tabIndex={0}
    >
      <table className="w-full min-w-[760px] border-collapse text-sm">
        <caption className="sr-only">Paper trades with side, quantity, price, and status</caption>
        <thead>
          <tr className="border-b border-base-700 text-left text-xs uppercase tracking-wide text-ink-500">
            <th scope="col" className="px-5 py-2.5 font-medium">Instrument</th>
            <th scope="col" className="px-5 py-2.5 font-medium">Side</th>
            <th scope="col" className="px-5 py-2.5 font-medium">Source</th>
            <th scope="col" className="px-5 py-2.5 font-medium">Quantity</th>
            <th scope="col" className="px-5 py-2.5 font-medium">Entry price</th>
            <th scope="col" className="px-5 py-2.5 font-medium">Current price</th>
            <th scope="col" className="px-5 py-2.5 font-medium">Opened</th>
            <th scope="col" className="px-5 py-2.5 font-medium">Status</th>
            <th scope="col" className="px-5 py-2.5 font-medium">Action</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((trade) => (
            <tr key={trade.id} className="border-b border-base-700/60 last:border-0">
              <td className="px-5 py-2.5">
                <div className="flex flex-col">
                  <span className="font-medium text-ink-100">{trade.instrumentSymbol}</span>
                  <span className="text-xs text-ink-500">{trade.instrumentName}</span>
                </div>
              </td>
              <td className="px-5 py-2.5">
                <Badge className={signalToneClasses(trade.side)}>{trade.side}</Badge>
              </td>
              <td className="px-5 py-2.5">
                <Badge className={tradeSourceClasses(trade.source)}>{trade.source}</Badge>
              </td>
              <td className="px-5 py-2.5 text-ink-300">{trade.quantity}</td>
              <td className="px-5 py-2.5 text-ink-300">{formatCurrencyUSD(trade.entryPrice)}</td>
              <td className="px-5 py-2.5 text-ink-300">
                {trade.status === "Open" && prices[trade.instrumentSymbol] !== undefined
                  ? formatCurrencyUSD(prices[trade.instrumentSymbol] as number)
                  : "—"}
              </td>
              <td className="whitespace-nowrap px-5 py-2.5 text-ink-500">
                {formatDateTime(trade.timestamp)}
              </td>
              <td className="px-5 py-2.5">
                <Badge className={paperTradeStatusClasses(trade.status)}>{trade.status}</Badge>
              </td>
              <td className="px-5 py-2.5">
                {trade.status === "Open" ? (
                  <button
                    type="button"
                    onClick={() => onCloseTrade(trade)}
                    className="whitespace-nowrap rounded-lg border border-base-600 bg-base-800 px-3 py-1.5 text-xs font-medium text-ink-300 transition-colors hover:bg-base-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50"
                  >
                    Close Trade
                  </button>
                ) : trade.realisedPnl !== undefined ? (
                  <span className={`text-xs font-medium ${plToneClass(trade.realisedPnl)}`}>
                    {formatSignedNumber(trade.realisedPnl)}
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
