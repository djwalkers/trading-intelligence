import type { TradePerformanceRecord } from "@/lib/hermes-execution/trade-performance/types";

const WIDTH = 800;
const HEIGHT = 160;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const BUCKETS: { label: string; maxMs: number }[] = [
  { label: "<1h", maxMs: HOUR_MS },
  { label: "1-4h", maxMs: 4 * HOUR_MS },
  { label: "4-24h", maxMs: DAY_MS },
  { label: "1-7d", maxMs: 7 * DAY_MS },
  { label: ">7d", maxMs: Infinity },
];

function bucketFor(holdingTimeMs: number): string {
  const bucket = BUCKETS.find((b) => holdingTimeMs <= b.maxMs);
  return bucket?.label ?? BUCKETS[BUCKETS.length - 1]!.label;
}

/** A simple histogram of holding-time buckets — one hue (accent-blue), bar height by trade count,
 * never by net P/L (a duration chart answers "how long," not "how much"). */
export function TradeDurationChart({ records }: { records: TradePerformanceRecord[] }) {
  if (records.length === 0) {
    return <p className="px-5 py-6 text-sm text-ink-500">No closed trades yet.</p>;
  }

  const counts = new Map(BUCKETS.map((b) => [b.label, 0]));
  for (const record of records) {
    const label = bucketFor(record.holdingTimeMs);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const maxCount = Math.max(...counts.values(), 1);
  const slotWidth = WIDTH / BUCKETS.length;
  const barWidth = slotWidth * 0.6;
  const chartHeight = HEIGHT - 24;

  return (
    <div className="px-4 py-3">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="w-full" role="img" aria-label="Distribution of trade holding times">
        {BUCKETS.map((bucket, index) => {
          const count = counts.get(bucket.label) ?? 0;
          const barHeight = (count / maxCount) * chartHeight;
          const x = index * slotWidth + (slotWidth - barWidth) / 2;
          const y = chartHeight - barHeight;
          return (
            <g key={bucket.label}>
              <rect x={x} y={y} width={barWidth} height={Math.max(1, barHeight)} className="fill-accent-blue" rx={1}>
                <title>
                  {bucket.label}: {count} trade{count === 1 ? "" : "s"}
                </title>
              </rect>
              <text x={x + barWidth / 2} y={HEIGHT - 6} textAnchor="middle" className="fill-ink-500 text-[10px]">
                {bucket.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
