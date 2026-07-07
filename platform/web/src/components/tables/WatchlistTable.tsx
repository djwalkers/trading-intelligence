import type { Instrument } from "@/lib/types";
import { formatCompactNumber, formatCurrencyUSD, formatPercent } from "@/lib/utils/format";
import { plToneClass } from "@/lib/utils/style";

interface WatchlistTableProps {
  instruments: Instrument[];
}

export function WatchlistTable({ instruments }: WatchlistTableProps) {
  return (
    <div className="overflow-x-auto scrollbar-thin">
      <table className="w-full min-w-[640px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-base-700 text-left text-xs uppercase tracking-wide text-ink-500">
            <th className="px-5 py-2.5 font-medium">Instrument</th>
            <th className="px-5 py-2.5 font-medium">Price</th>
            <th className="px-5 py-2.5 font-medium">Change</th>
            <th className="px-5 py-2.5 font-medium">Day range</th>
            <th className="px-5 py-2.5 font-medium">Volume</th>
          </tr>
        </thead>
        <tbody>
          {instruments.map((instrument) => (
            <tr key={instrument.symbol} className="border-b border-base-700/60 last:border-0">
              <td className="px-5 py-2.5">
                <div className="flex flex-col">
                  <span className="font-medium text-ink-100">{instrument.symbol}</span>
                  <span className="text-xs text-ink-500">{instrument.name}</span>
                </div>
              </td>
              <td className="px-5 py-2.5 font-medium text-ink-100">
                {formatCurrencyUSD(instrument.price)}
              </td>
              <td className={`px-5 py-2.5 ${plToneClass(instrument.changeAbsolute)}`}>
                {formatPercent(instrument.changePercent)}
              </td>
              <td className="whitespace-nowrap px-5 py-2.5 text-ink-400">
                {formatCurrencyUSD(instrument.dayLow)} &ndash; {formatCurrencyUSD(instrument.dayHigh)}
              </td>
              <td className="px-5 py-2.5 text-ink-400">{formatCompactNumber(instrument.volume)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
