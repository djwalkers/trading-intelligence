import { Badge } from "@/components/ui/Badge";
import type { MarketDiagnosticsResult } from "@/lib/hermes-execution/market-diagnostics-service";
import { formatPrice, INDICATOR_EXPLANATIONS, trendBadgeClasses } from "./diagnostics-format";

interface IndicatorCardsProps {
  data: MarketDiagnosticsResult;
}

function IndicatorCard({ label, value, explanation }: { label: string; value: string; explanation: string }) {
  return (
    <div className="panel flex flex-col gap-2 p-5">
      <span className="text-sm text-ink-400">{label}</span>
      <span className="text-2xl font-semibold tracking-tight text-ink-100">{value}</span>
      <p className="text-xs leading-relaxed text-ink-500">{explanation}</p>
    </div>
  );
}

// Phase 2A.1 — Internal Market Diagnostics UI, section D. Plain-English explanations only — never
// phrased as a recommendation ("what to do"), only a description ("what this number means"). See
// diagnostics-format.ts's own INDICATOR_EXPLANATIONS doc comment.
export function IndicatorCards({ data }: IndicatorCardsProps) {
  const { ema20, ema50, rsi14, atr14, trend } = data.indicators;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <IndicatorCard
          label="EMA20"
          value={formatPrice(ema20)}
          explanation={`${INDICATOR_EXPLANATIONS.ema20} ${INDICATOR_EXPLANATIONS.emaRelationship}`}
        />
        <IndicatorCard label="EMA50" value={formatPrice(ema50)} explanation={INDICATOR_EXPLANATIONS.ema50} />
        <IndicatorCard
          label="RSI14"
          value={rsi14.toFixed(1)}
          explanation={`${INDICATOR_EXPLANATIONS.rsi14} ${INDICATOR_EXPLANATIONS.rsiNeutral}`}
        />
        <IndicatorCard label="ATR14" value={formatPrice(atr14)} explanation={INDICATOR_EXPLANATIONS.atr14} />
      </div>

      <div className="panel flex flex-wrap items-center justify-between gap-3 p-5">
        <div className="flex flex-col gap-1">
          <span className="text-sm text-ink-400">Trend</span>
          <p className="text-xs leading-relaxed text-ink-500">{INDICATOR_EXPLANATIONS.trend}</p>
        </div>
        <Badge className={trendBadgeClasses(trend)} data-testid="trend-badge">
          {trend}
        </Badge>
      </div>

      <p className="text-xs text-ink-600">
        These values describe historical and current market data only. They are not financial advice and do not represent
        a trade recommendation.
      </p>
    </div>
  );
}
