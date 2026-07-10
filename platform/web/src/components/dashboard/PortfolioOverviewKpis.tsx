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
  const { trades, isHydrated } = usePaperTrades();
  const snapshot = buildExposureSnapshot(trades);
  // Build 1.12.1 — while trades are still loading (most noticeable for a database-backed account
  // over the network), show a plain loading marker instead of a misleading "£0.00 / 0" that would
  // otherwise flash before the real figures arrive.
  const loadingValue = "…";

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard label="Portfolio value" value={formatCurrencyGBP(paperPortfolio.currentValue)} />
      <StatCard
        label="Cash available"
        value={isHydrated ? formatCurrencyGBP(snapshot.availableCash) : loadingValue}
      />
      <StatCard
        label="Open positions"
        value={isHydrated ? String(snapshot.totalOpenTrades) : loadingValue}
      />
      <StatCard
        label="Today's P/L"
        value={formatCurrencyGBP(paperPortfolio.dailyPl)}
        sublabel={formatPercent(paperPortfolio.dailyPlPercent)}
        subValueClassName={plToneClass(paperPortfolio.dailyPl)}
      />
    </div>
  );
}
