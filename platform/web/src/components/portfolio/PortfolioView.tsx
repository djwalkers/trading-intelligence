"use client";

import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard } from "@/components/ui/StatCard";
import { SectionPanel } from "@/components/ui/SectionPanel";
import { InfoNote } from "@/components/ui/InfoNote";
import { PositionsTable } from "@/components/tables/PositionsTable";
import { PaperTradesTable } from "@/components/tables/PaperTradesTable";
import { CloseTradeModal } from "@/components/trading/CloseTradeModal";
import { usePaperTrades } from "@/lib/state/paper-trades-context";
import { useCloseTradeFlow } from "@/lib/state/use-close-trade-flow";
import {
  calculatePaperTradePerformance,
  calculateTradePnl,
  calculateTradePnlPercent,
  getCurrentMockPrice,
} from "@/lib/utils/paper-trade";
import type { PaperPortfolio } from "@/lib/types";
import { formatCurrencyGBP, formatPercent, formatSignedNumber } from "@/lib/utils/format";
import { plToneClass } from "@/lib/utils/style";

interface PortfolioViewProps {
  paperPortfolio: PaperPortfolio;
}

const RECENT_TRADES_LIMIT = 5;

export function PortfolioView({ paperPortfolio }: PortfolioViewProps) {
  const { trades } = usePaperTrades();
  const { closingTrade, requestClose, confirmClose, cancelClose } = useCloseTradeFlow();

  const openTrades = trades.filter((trade) => trade.status === "Open");
  const closedTrades = trades.filter((trade) => trade.status === "Closed");
  const performance = calculatePaperTradePerformance(trades);

  const committedCapital = openTrades.reduce(
    (sum, trade) => sum + trade.quantity * trade.entryPrice,
    0,
  );
  const adjustedCashBalance =
    paperPortfolio.cashBalance - committedCapital + performance.realisedPnl;

  const currentPrice = closingTrade ? getCurrentMockPrice(closingTrade.instrumentSymbol) : 0;

  return (
    <>
      <PageHeader
        title="Paper Portfolio"
        description="Simulated portfolio performance. No real capital is deployed and no orders are executed."
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Starting value" value={formatCurrencyGBP(paperPortfolio.startingValue)} />
        <StatCard label="Current value" value={formatCurrencyGBP(paperPortfolio.currentValue)} />
        <StatCard
          label="Daily P/L"
          value={formatCurrencyGBP(paperPortfolio.dailyPl)}
          sublabel={formatPercent(paperPortfolio.dailyPlPercent)}
          subValueClassName={plToneClass(paperPortfolio.dailyPl)}
        />
        <StatCard
          label="Total return"
          value={formatPercent(paperPortfolio.totalReturnPercent)}
          sublabel={`Cash balance ${formatCurrencyGBP(adjustedCashBalance)}`}
          subValueClassName={plToneClass(paperPortfolio.totalReturnPercent)}
        />
      </div>

      <SectionPanel
        title="Paper trading performance"
        description="Aggregate results across every paper trade placed in this browser"
      >
        <div className="grid grid-cols-1 gap-4 px-5 py-4 sm:grid-cols-2 lg:grid-cols-5">
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
          <StatCard
            label="Total paper P/L"
            value={formatSignedNumber(performance.totalPnl)}
            valueClassName={plToneClass(performance.totalPnl)}
          />
        </div>
      </SectionPanel>

      <SectionPanel
        title="Open positions"
        description={`${paperPortfolio.positions.length} positions`}
      >
        <PositionsTable positions={paperPortfolio.positions} />
      </SectionPanel>

      <SectionPanel
        title="Open trades"
        description={`${openTrades.length} open trade${openTrades.length === 1 ? "" : "s"}`}
        viewAllHref="/trade-journal"
      >
        <PaperTradesTable
          trades={openTrades.slice(0, RECENT_TRADES_LIMIT)}
          onCloseTrade={requestClose}
          emptyMessage="No open paper trades. Place one from the Signals or Market Intelligence page."
        />
      </SectionPanel>

      <SectionPanel
        title="Closed trades"
        description={`${closedTrades.length} closed trade${closedTrades.length === 1 ? "" : "s"}`}
        viewAllHref="/trade-journal"
      >
        <PaperTradesTable
          trades={closedTrades.slice(0, RECENT_TRADES_LIMIT)}
          onCloseTrade={requestClose}
          emptyMessage="No closed paper trades yet."
        />
      </SectionPanel>

      <InfoNote>
        This is a simulated, paper-only portfolio. Prices and fills are mocked; no broker connection
        or real execution exists in this build. Paper trades open and close at mock prices only —
        nothing here is a real order or real capital.
      </InfoNote>

      {closingTrade ? (
        <CloseTradeModal
          instrumentSymbol={closingTrade.instrumentSymbol}
          instrumentName={closingTrade.instrumentName}
          side={closingTrade.side}
          quantity={closingTrade.quantity}
          entryPrice={closingTrade.entryPrice}
          currentPrice={currentPrice}
          estimatedPnl={calculateTradePnl(closingTrade, currentPrice)}
          estimatedPnlPercent={calculateTradePnlPercent(closingTrade, currentPrice)}
          onConfirm={confirmClose}
          onCancel={cancelClose}
        />
      ) : null}
    </>
  );
}
