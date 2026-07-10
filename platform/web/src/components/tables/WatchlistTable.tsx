import type { Instrument, MarketDataSource, MarketQuote, StrategyScore } from "@/lib/types";
import { formatCompactNumber, formatCurrencyUSD, formatDateTime, formatPercent } from "@/lib/utils/format";
import { dataSourceLabel, plToneClass } from "@/lib/utils/style";
import { Badge } from "@/components/ui/Badge";

interface WatchlistTableProps {
  instruments: Instrument[];
  quotes?: Record<string, MarketQuote>;
  dataSource?: MarketDataSource;
  strategyScores?: StrategyScore[];
}

export function WatchlistTable({
  instruments,
  quotes = {},
  dataSource,
  strategyScores,
}: WatchlistTableProps) {
  const scoresBySymbol = new Map(
    (strategyScores ?? []).map((score) => [score.instrumentSymbol, score]),
  );
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
            {strategyScores ? <th className="px-5 py-2.5 font-medium">Primary strategy</th> : null}
          </tr>
        </thead>
        <tbody>
          {instruments.map((instrument) => {
            const quote = quotes[instrument.symbol];
            const price = quote?.price ?? instrument.price;
            const changeAbsolute = quote?.changeAbsolute ?? instrument.changeAbsolute;
            const changePercent = quote?.changePercent ?? instrument.changePercent;
            const score = scoresBySymbol.get(instrument.symbol);
            // Bug fix (Build 1.12.1): dayHigh/dayLow are authored once as static mock data, but the
            // displayed price can move independently (mock drift, or a live quote) — without this,
            // the current price could render outside its own displayed day range, which is never
            // correct for a real day-range figure. Widening the bounds to include the current price
            // keeps the invariant true without altering the underlying mock data or any calculation
            // the AI Engine reads (buildExposureSnapshot etc. never read dayHigh/dayLow).
            const dayLow = Math.min(instrument.dayLow, price);
            const dayHigh = Math.max(instrument.dayHigh, price);

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
                  {formatCurrencyUSD(dayLow)} &ndash; {formatCurrencyUSD(dayHigh)}
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
                      {dataSourceLabel(dataSource)}
                    </Badge>
                  </td>
                ) : null}
                {strategyScores ? (
                  <td className="px-5 py-2.5 text-ink-300">{score?.primaryStrategyName ?? "—"}</td>
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
