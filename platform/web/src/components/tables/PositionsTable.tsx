import type { PaperPosition } from "@/lib/types";
import { formatCurrencyUSD, formatPercent, formatSignedNumber } from "@/lib/utils/format";
import { plToneClass } from "@/lib/utils/style";

interface PositionsTableProps {
  positions: PaperPosition[];
}

export function PositionsTable({ positions }: PositionsTableProps) {
  if (positions.length === 0) {
    return <p className="px-5 py-6 text-sm text-ink-500">No open paper positions.</p>;
  }

  return (
    <div
      className="overflow-x-auto scrollbar-thin"
      role="region"
      aria-label="Open positions table, scroll horizontally for more columns"
      tabIndex={0}
    >
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <caption className="sr-only">
          Open paper positions with quantity, entry price, and unrealized P/L
        </caption>
        <thead>
          <tr className="border-b border-base-700 text-left text-xs uppercase tracking-wide text-ink-500">
            <th scope="col" className="px-5 py-2.5 font-medium">Instrument</th>
            <th scope="col" className="px-5 py-2.5 font-medium">Quantity</th>
            <th scope="col" className="px-5 py-2.5 font-medium">Avg entry</th>
            <th scope="col" className="px-5 py-2.5 font-medium">Current price</th>
            <th scope="col" className="px-5 py-2.5 font-medium">Market value</th>
            <th scope="col" className="px-5 py-2.5 font-medium">Unrealized P/L</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((position) => (
            <tr key={position.instrumentSymbol} className="border-b border-base-700/60 last:border-0">
              <td className="px-5 py-2.5">
                <div className="flex flex-col">
                  <span className="font-medium text-ink-100">{position.instrumentSymbol}</span>
                  <span className="text-xs text-ink-500">{position.instrumentName}</span>
                </div>
              </td>
              <td className="px-5 py-2.5 text-ink-300">{position.quantity}</td>
              <td className="px-5 py-2.5 text-ink-300">
                {formatCurrencyUSD(position.averageEntryPrice)}
              </td>
              <td className="px-5 py-2.5 text-ink-300">{formatCurrencyUSD(position.currentPrice)}</td>
              <td className="px-5 py-2.5 font-medium text-ink-100">
                {formatCurrencyUSD(position.marketValue)}
              </td>
              <td className={`px-5 py-2.5 ${plToneClass(position.unrealizedPl)}`}>
                {formatSignedNumber(position.unrealizedPl)} ({formatPercent(position.unrealizedPlPercent)})
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
