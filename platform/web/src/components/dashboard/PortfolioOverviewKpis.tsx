"use client";

import { StatCard } from "@/components/ui/StatCard";
import { usePaperTrades } from "@/lib/state/paper-trades-context";
import { buildExposureSnapshot } from "@/lib/bot";
import { formatCurrencyGBP, formatPercent } from "@/lib/utils/format";
import { plToneClass } from "@/lib/utils/style";
import type { PaperPortfolio } from "@/lib/types";

interface PortfolioOverviewKpisProps {
  paperPortfolio: PaperPortfolio;
}

// Build 1.12.0 — four KPI cards answering "how is my paper portfolio doing," reusing the exact
// same figures already shown elsewhere rather than computing anything new: buildExposureSnapshot()
// is the same pure function the AI Engine's own risk checks use (src/lib/bot/portfolio-risk.ts),
// and paperPortfolio.currentValue/dailyPl are the same mock figures the Paper Portfolio page shows.
export function PortfolioOverviewKpis({ paperPortfolio }: PortfolioOverviewKpisProps) {
  const { trades } = usePaperTrades();
  const snapshot = buildExposureSnapshot(trades);

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard label="Portfolio value" value={formatCurrencyGBP(paperPortfolio.currentValue)} />
      <StatCard label="Cash available" value={formatCurrencyGBP(snapshot.availableCash)} />
      <StatCard label="Open positions" value={String(snapshot.totalOpenTrades)} />
      <StatCard
        label="Today's P/L"
        value={formatCurrencyGBP(paperPortfolio.dailyPl)}
        sublabel={formatPercent(paperPortfolio.dailyPlPercent)}
        subValueClassName={plToneClass(paperPortfolio.dailyPl)}
      />
    </div>
  );
}
