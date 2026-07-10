"use client";

import { useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { InfoNote } from "@/components/ui/InfoNote";
import { TradeJournalList } from "@/components/trading/TradeJournalList";
import { CloseTradeModal } from "@/components/trading/CloseTradeModal";
import { usePaperTrades } from "@/lib/state/paper-trades-context";
import { useCloseTradeFlow } from "@/lib/state/use-close-trade-flow";
import { usePersistenceStatus } from "@/lib/state/use-persistence-status";
import { calculateTradePnl, calculateTradePnlPercent } from "@/lib/utils/paper-trade";
import type { PaperTrade } from "@/lib/types";

type TradeJournalFilter =
  | "All"
  | "Open"
  | "Closed"
  | "Signals"
  | "Market Intelligence"
  | "Bot"
  | "BUY"
  | "SELL";

const FILTERS: { key: TradeJournalFilter; label: string }[] = [
  { key: "All", label: "All" },
  { key: "Open", label: "Open" },
  { key: "Closed", label: "Closed" },
  { key: "Signals", label: "Signals" },
  { key: "Market Intelligence", label: "Market Intelligence" },
  { key: "Bot", label: "Bot" },
  { key: "BUY", label: "BUY" },
  { key: "SELL", label: "SELL" },
];

function matchesFilter(trade: PaperTrade, filter: TradeJournalFilter): boolean {
  switch (filter) {
    case "All":
      return true;
    case "Open":
      return trade.status === "Open";
    case "Closed":
      return trade.status === "Closed";
    case "Signals":
      return trade.source === "Signal";
    case "Market Intelligence":
      return trade.source === "Market Intelligence";
    case "Bot":
      return trade.source === "Bot";
    case "BUY":
      return trade.side === "BUY";
    case "SELL":
      return trade.side === "SELL";
  }
}

export function TradeJournalView() {
  const { trades } = usePaperTrades();
  const [filter, setFilter] = useState<TradeJournalFilter>("All");
  const { closingTrade, currentPrice, isPriceLoading, requestClose, confirmClose, cancelClose } =
    useCloseTradeFlow();
  const persistenceStatus = usePersistenceStatus();

  const filteredTrades = trades.filter((trade) => matchesFilter(trade, filter));

  return (
    <>
      <PageHeader
        title="Trade Journal"
        description="A complete record of every paper trade placed in this browser, from signals and Market Intelligence alike."
      />

      <div className="panel flex flex-wrap gap-2 px-4 py-3">
        {FILTERS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setFilter(item.key)}
            aria-pressed={filter === item.key}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-teal/50 ${
              filter === item.key
                ? "bg-base-800 text-ink-100"
                : "text-ink-400 hover:bg-base-800/50 hover:text-ink-100"
            }`}
          >
            {item.label}
          </button>
        ))}
      </div>

      <SectionPanel
        title="Paper trades"
        description={
          filter === "All"
            ? `${trades.length} trade${trades.length === 1 ? "" : "s"} recorded`
            : `${filteredTrades.length} of ${trades.length} trades shown`
        }
      >
        <TradeJournalList
          trades={filteredTrades}
          onCloseTrade={requestClose}
          emptyMessage={
            trades.length === 0
              ? "No paper trades yet. Place one from Signals or Market Intelligence, or let the AI Engine trade automatically — every trade, open or closed, will be recorded here."
              : "No trades match this filter."
          }
        />
      </SectionPanel>

      <InfoNote>
        Trade history is stored using{" "}
        <strong className="font-medium text-ink-200">
          {persistenceStatus.mode === "Supabase" ? "your database" : "local browser storage"}
        </strong>
        , with local browser storage used as a fallback if the database is unavailable. Nothing
        here represents a real order or real capital.
      </InfoNote>

      {closingTrade ? (
        <CloseTradeModal
          instrumentSymbol={closingTrade.instrumentSymbol}
          instrumentName={closingTrade.instrumentName}
          side={closingTrade.side}
          quantity={closingTrade.quantity}
          entryPrice={closingTrade.entryPrice}
          currentPrice={currentPrice}
          isPriceLoading={isPriceLoading}
          estimatedPnl={calculateTradePnl(closingTrade, currentPrice ?? closingTrade.entryPrice)}
          estimatedPnlPercent={calculateTradePnlPercent(
            closingTrade,
            currentPrice ?? closingTrade.entryPrice,
          )}
          onConfirm={confirmClose}
          onCancel={cancelClose}
        />
      ) : null}
    </>
  );
}
