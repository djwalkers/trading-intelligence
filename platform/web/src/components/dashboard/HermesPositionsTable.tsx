import { Badge } from "@/components/ui/Badge";
import type { HermesPositionItem } from "@/lib/hermes-dashboard/types";
import { formatMaybeBrokerAmount, formatMaybeNumber, formatMaybeTimestamp } from "@/lib/hermes-dashboard/format";

// Main Dashboard Hermes/eToro fix — requirement 4 (positions section). Renders GET
// /api/hermes/positions's own data verbatim (via the dashboard proxy) — instrument/side/quantity/
// units/entryPrice/currentPrice/unrealisedPnl/openedAt/provider/accountMode, one row per open
// position. `instrument` is already mapped from a raw broker instrumentID to its configured symbol
// (e.g. "BTC") by broker-snapshot.ts itself, whenever a known mapping exists — this component never
// does that mapping itself and never shows a raw numeric id as if it were a symbol by choice; an
// unmapped id reaching here (broker-snapshot.ts's own documented fallback) is shown exactly as
// received, never hidden.
//
// Missing-financial-data fix. `quantity` ("Invested value") is eToro's own notional/margin `amount`
// — the pre-existing "display value" concept, distinct from `units` (the true underlying-asset
// quantity, already leverage-adjusted — the figure `currentPrice`/`unrealisedPnl` were actually
// computed from). `currentPrice`/`unrealisedPnl` show "Unavailable" (never a stale/zero value)
// whenever this specific position's own `pricingSource` is "unavailable" — see broker-snapshot.ts's
// priceOpenPositions().

interface HermesPositionsTableProps {
  positions: HermesPositionItem[];
}

const SIDE_BADGE_CLASSES: Record<HermesPositionItem["side"], string> = {
  BUY: "border-accent-teal/30 bg-accent-teal/10 text-accent-teal",
  SELL: "border-accent-red/30 bg-accent-red/10 text-accent-red",
  unknown: "border-base-600 bg-base-800 text-ink-400",
};

export function HermesPositionsTable({ positions }: HermesPositionsTableProps) {
  if (positions.length === 0) {
    return (
      <p className="px-5 py-6 text-sm text-ink-500" data-testid="hermes-positions-empty">
        No open positions on the eToro demo account right now.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] text-left text-sm">
        <thead>
          <tr className="border-b border-base-700/60 text-xs uppercase tracking-wide text-ink-500">
            <th className="px-5 py-2 font-medium">Instrument</th>
            <th className="px-3 py-2 font-medium">Direction</th>
            <th className="px-3 py-2 font-medium">Invested value</th>
            <th className="px-3 py-2 font-medium">Units</th>
            <th className="px-3 py-2 font-medium">Entry price</th>
            <th className="px-3 py-2 font-medium">Current price</th>
            <th className="px-3 py-2 font-medium">Unrealised P/L</th>
            <th className="px-3 py-2 font-medium">Opened</th>
            <th className="px-5 py-2 font-medium">Provider</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-base-700/60">
          {positions.map((position, index) => (
            <tr key={`${position.instrument}-${index}`} data-testid="hermes-position-row">
              <td className="px-5 py-3 font-medium text-ink-100">{position.instrument}</td>
              <td className="px-3 py-3">
                <Badge className={SIDE_BADGE_CLASSES[position.side]}>{position.side}</Badge>
              </td>
              <td className="px-3 py-3 text-ink-200">{formatMaybeBrokerAmount(position.quantity)}</td>
              <td className="px-3 py-3 text-ink-200">{formatMaybeNumber(position.units)}</td>
              <td className="px-3 py-3 text-ink-200">{formatMaybeBrokerAmount(position.entryPrice)}</td>
              <td className="px-3 py-3 text-ink-400">
                {position.pricingSource === "broker" ? formatMaybeBrokerAmount(position.currentPrice) : "Unavailable"}
              </td>
              <td className="px-3 py-3 text-ink-400">
                {position.pricingSource === "broker" ? formatMaybeBrokerAmount(position.unrealisedPnl) : "Unavailable"}
              </td>
              <td className="px-3 py-3 text-ink-400">{formatMaybeTimestamp(position.openedAt)}</td>
              <td className="px-5 py-3 text-ink-500">
                {position.provider} · {position.accountMode}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
