import { Badge } from "@/components/ui/Badge";
import type { PaperTrade } from "@/lib/types";
import {
  formatCurrencyUSD,
  formatDateTime,
  formatPercent,
  formatSignedNumber,
} from "@/lib/utils/format";
import {
  paperTradeStatusClasses,
  plToneClass,
  recommendationClasses,
  signalToneClasses,
  tradeSourceClasses,
} from "@/lib/utils/style";

interface TradeJournalEntryProps {
  trade: PaperTrade;
  onCloseTrade: (trade: PaperTrade) => void;
}

export function TradeJournalEntry({ trade, onCloseTrade }: TradeJournalEntryProps) {
  const isOpen = trade.status === "Open";

  return (
    <div className="flex flex-col gap-3 px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-col">
            <span className="font-medium text-ink-100">{trade.instrumentSymbol}</span>
            <span className="text-xs text-ink-500">{trade.instrumentName}</span>
          </div>
          <Badge className={signalToneClasses(trade.side)}>{trade.side}</Badge>
          <Badge className={tradeSourceClasses(trade.source)}>{trade.source}</Badge>
        </div>
        <div className="flex items-center gap-3">
          <Badge className={paperTradeStatusClasses(trade.status)}>{trade.status}</Badge>
          {isOpen ? (
            <button
              type="button"
              onClick={() => onCloseTrade(trade)}
              className="whitespace-nowrap rounded-lg border border-base-600 bg-base-800 px-3 py-1.5 text-xs font-medium text-ink-300 transition-colors hover:bg-base-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50"
            >
              Close Trade
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-500">
        <span>Qty {trade.quantity}</span>
        <span>Entry {formatCurrencyUSD(trade.entryPrice)}</span>
        {!isOpen && trade.exitPrice !== undefined ? (
          <span>Exit {formatCurrencyUSD(trade.exitPrice)}</span>
        ) : null}
        <span>Confidence {trade.signalConfidence}%</span>
        <span>{trade.strategyName}</span>
        <span>Opened {formatDateTime(trade.timestamp)}</span>
        {!isOpen && trade.closedAt ? <span>Closed {formatDateTime(trade.closedAt)}</span> : null}
      </div>

      {!isOpen && trade.realisedPnl !== undefined ? (
        <p className={`text-sm font-medium ${plToneClass(trade.realisedPnl)}`}>
          Realised P/L: {formatSignedNumber(trade.realisedPnl)}
          {trade.realisedPnlPercent !== undefined
            ? ` (${formatPercent(trade.realisedPnlPercent)})`
            : ""}
        </p>
      ) : null}

      <p className="text-sm text-ink-400">{trade.reason}</p>

      {trade.intelligence ? (
        <div className="mt-1 flex flex-col gap-3 rounded-xl2 border border-base-700 bg-base-850 px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium uppercase tracking-wide text-ink-500">
              Market Intelligence
            </span>
            <Badge className={recommendationClasses(trade.intelligence.recommendation)}>
              {trade.intelligence.recommendation}
            </Badge>
          </div>

          <div>
            <p className="text-xs font-medium text-ink-400">Evidence</p>
            <ul className="mt-1.5 flex flex-col gap-1">
              {trade.intelligence.evidenceFactors.map((item, index) => (
                <li key={index} className="flex items-start gap-2 text-xs text-ink-400">
                  <span
                    className="mt-1 h-1 w-1 shrink-0 rounded-full bg-ink-500"
                    aria-hidden="true"
                  />
                  {item}
                </li>
              ))}
            </ul>
          </div>

          <div>
            <p className="text-xs font-medium text-ink-400">What could change</p>
            <ul className="mt-1.5 flex flex-col gap-1">
              {trade.intelligence.invalidationFactors.map((item, index) => (
                <li key={index} className="flex items-start gap-2 text-xs text-ink-400">
                  <span
                    className="mt-1 h-1 w-1 shrink-0 rounded-full bg-accent-amber"
                    aria-hidden="true"
                  />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}
