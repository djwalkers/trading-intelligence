import type { DecisionRecord } from "@/lib/decision-intelligence";
import { formatSignedNumber } from "@/lib/utils/format";
import { plToneClass } from "@/lib/utils/style";

interface SummaryStatProps {
  label: string;
  value: string;
  valueClassName?: string;
}

function SummaryStat({ label, value, valueClassName }: SummaryStatProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-ink-500">{label}</span>
      <span className={`text-sm font-medium ${valueClassName ?? "text-ink-100"}`}>{value}</span>
    </div>
  );
}

// Mission 11 — a compact rollup of accepted decisions' outcomes, not a performance dashboard: no
// charts, no equity curve, just counts and a single aggregate P/L figure, per the mission's own
// "do not present this as proof of strategy profitability" instruction. Rejected decisions are
// deliberately excluded from every count here — this panel is about what happened to trades that
// were actually placed, not the full candidate history the table below shows.
export function OutcomeSummaryPanel({ records }: { records: DecisionRecord[] }) {
  const accepted = records.filter((record) => record.actionTaken === "Trade Opened");
  const closed = accepted.filter((record) => record.outcome !== "Pending");
  const pending = accepted.length - closed.length;
  const wins = accepted.filter((record) => record.outcome === "Win").length;
  const losses = accepted.filter((record) => record.outcome === "Loss").length;
  const neutral = accepted.filter((record) => record.outcome === "Neutral").length;
  const realisedPnl = accepted.reduce((sum, record) => sum + (record.realisedPnl ?? 0), 0);
  const winLossTotal = wins + losses;
  const winRate = winLossTotal > 0 ? Math.round((wins / winLossTotal) * 100) : null;

  return (
    <div className="flex flex-col gap-3 px-5 py-4">
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <SummaryStat label="Accepted decisions" value={String(accepted.length)} />
        <SummaryStat label="Closed outcomes" value={String(closed.length)} />
        <SummaryStat label="Pending outcomes" value={String(pending)} />
        <SummaryStat
          label="Realised P/L"
          value={formatSignedNumber(realisedPnl)}
          valueClassName={plToneClass(realisedPnl)}
        />
        <SummaryStat label="Wins" value={String(wins)} valueClassName="text-accent-teal" />
        <SummaryStat label="Losses" value={String(losses)} valueClassName="text-accent-red" />
        <SummaryStat label="Neutral" value={String(neutral)} />
        <SummaryStat label="Win rate" value={winRate === null ? "—" : `${winRate}%`} />
      </div>
      <p className="text-xs text-ink-600">
        Win rate is Wins ÷ (Wins + Losses) only — Neutral and Pending outcomes are excluded, and
        Rejected candidates are never counted here at all. This is a small paper-trading sample,
        not proof of strategy profitability.
      </p>
    </div>
  );
}
