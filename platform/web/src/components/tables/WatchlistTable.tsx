import type { Instrument, MarketDataSource, MarketQuote } from "@/lib/types";
import { formatCompactNumber, formatCurrencyUSD, formatDateTime, formatPercent } from "@/lib/utils/format";
import { plToneClass } from "@/lib/utils/style";
import { Badge } from "@/components/ui/Badge";

interface WatchlistTableProps {
  instruments: Instrument[];
  quotes?: Record<string, MarketQuote>;
  dataSource?: MarketDataSource;
}

export function WatchlistTable({ instruments, quotes = {}, dataSource }: WatchlistTableProps) {
  return (
    <div className="overflow-x-auto scrollbar-thin">
      <table className="w-full min-w-[820px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-base-700 text-left text-xs uppercase tracking-wide text-ink-500">
            <th className="px-5 py-2.5 font-medium">Instrument</th>
            <th className="px-5 py-2.5 font-medium">Price</th>
            <th className="px-5 py-2.5 font-medium">Change</th>
            <th className="px-5 py-2.5 font-medium">Day range</th>
            <th className="px-5 py-2.5 font-medium">Volume</th>
            <th className="px-5 py-2.5 font-medium">Updated</th>
            {dataSource ? <th className="px-5 py-2.5 font-medium">Source</th> : null}
          </tr>
        </thead>
        <tbody>
          {instruments.map((instrument) => {
            const quote = quotes[instrument.symbol];
            const price = quote?.price ?? instrument.price;
            const changeAbsolute = quote?.changeAbsolute ?? instrument.changeAbsolute;
            const changePercent = quote?.changePercent ?? instrument.changePercent;

            return (
              <tr key={instrument.symbol} className="border-b border-base-700/60 last:border-0">
                <td className="px-5 py-2.5">
                  <div className="flex flex-col">
                    <span className="font-medium text-ink-100">{instrument.symbol}</span>
                    <span className="text-xs text-ink-500">{instrument.name}</span>
                  </div>
                </td>
                <td className="px-5 py-2.5 font-medium text-ink-100">{formatCurrencyUSD(price)}</td>
                <td className={`px-5 py-2.5 ${plToneClass(changeAbsolute)}`}>
                  {formatSignedCurrency(changeAbsolute)} ({formatPercent(changePercent)})
                </td>
                <td className="whitespace-nowrap px-5 py-2.5 text-ink-400">
                  {formatCurrencyUSD(instrument.dayLow)} &ndash; {formatCurrencyUSD(instrument.dayHigh)}
                </td>
                <td className="px-5 py-2.5 text-ink-400">{formatCompactNumber(instrument.volume)}</td>
                <td className="whitespace-nowrap px-5 py-2.5 text-ink-500">
                  {quote ? formatDateTime(quote.lastUpdated) : "—"}
                </td>
                {dataSource ? (
                  <td className="px-5 py-2.5">
                    <Badge
                      className={
                        dataSource === "External"
                          ? "border-accent-blue/25 bg-accent-blue/10 text-accent-blue"
                          : "border-base-600 bg-base-800 text-ink-300"
                      }
                    >
                      {dataSource}
                    </Badge>
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function formatSignedCurrency(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatCurrencyUSD(value)}`;
}
