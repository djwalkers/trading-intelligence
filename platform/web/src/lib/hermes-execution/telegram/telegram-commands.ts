import type { TradingRuntimeStatus } from "../runtime/types";
import type { TradeLifecycleRecord } from "../trade-lifecycle/types";

// Prototype V1 — pure formatting only. Every figure here already exists on TradingRuntimeStatus or
// TradeLifecycleRecord (Missions 6/7) — this file never recomputes P/L, MFE/MAE, or runtime state,
// it only aggregates/renders already-computed fields as plain text, the same way a UI would. Kept
// separate from telegram-bot.ts's orchestration (polling, authorization, dispatch) so each command's
// actual output is directly unit-testable without a transport, runtime, or store in play.

export function formatStatus(status: TradingRuntimeStatus): string {
  const lines = [
    `State: ${status.state}`,
    `Started: ${status.startedAt ?? "—"}`,
    `Cycle running: ${status.isCycleRunning ? "yes" : "no"}`,
    `Next run: ${status.nextRunAt ?? "—"}`,
    `Successful/failed cycles: ${status.successfulRunCount}/${status.failedRunCount}`,
    `Skipped (overlap/paused/market-closed): ${status.skippedOverlapCount}/${status.skippedPausedCount}/${status.skippedMarketClosedCount}`,
  ];
  if (status.lastResult) {
    lines.push(
      `Last decision: ${status.lastResult.decision} on ${status.lastResult.instrument} ` +
        `(candidate created: ${status.lastResult.candidateCreated}, executed this cycle: ${status.lastResult.executedCandidateIds.length})`,
    );
  }
  if (status.lastError) {
    lines.push(`Last error: ${status.lastError.message} (${status.lastError.occurredAt})`);
  }
  return lines.join("\n");
}

function formatOnePosition(record: TradeLifecycleRecord): string {
  const parts = [
    `${record.symbol} — ${record.status}`,
    `entry ${record.entryPrice ?? "—"}`,
    `qty ${record.quantity}`,
  ];
  if (record.maximumFavourableExcursion !== undefined || record.maximumAdverseExcursion !== undefined) {
    parts.push(`MFE ${(record.maximumFavourableExcursion ?? 0).toFixed(2)} / MAE ${(record.maximumAdverseExcursion ?? 0).toFixed(2)}`);
  }
  return parts.join(", ");
}

export function formatPositions(openRecords: TradeLifecycleRecord[]): string {
  if (openRecords.length === 0) return "No open positions.";
  return openRecords.map((record) => formatOnePosition(record)).join("\n");
}

function formatOneTrade(record: TradeLifecycleRecord): string {
  const pnl = record.realisedPnl !== undefined ? record.realisedPnl.toFixed(2) : "—";
  const pnlPercent = record.realisedPnlPercent !== undefined ? `${record.realisedPnlPercent.toFixed(2)}%` : "—";
  return `${record.symbol}: entry ${record.entryPrice ?? "—"} -> exit ${record.exitPrice ?? "—"}, P/L ${pnl} (${pnlPercent}), reason: ${record.exitReason ?? "—"}`;
}

/** Most recent first, capped at `limit` — Telegram messages have a practical length limit, and "the
 * last few trades" is what /trades is for; /pnl (below) covers the full aggregate. */
export function formatTrades(closedRecords: TradeLifecycleRecord[], limit = 10): string {
  if (closedRecords.length === 0) return "No completed trades yet.";
  const sorted = [...closedRecords].sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""));
  return sorted.slice(0, limit).map((record) => formatOneTrade(record)).join("\n");
}

export interface PnlSummary {
  tradeCount: number;
  winCount: number;
  winRate: number;
  totalRealisedPnl: number;
  averageRealisedPnlPercent: number;
}

/** A simple aggregation over already-computed TradeLifecycleRecord fields — win rate, total
 * realised P/L, average realised P/L% — never a re-derivation of any individual trade's own P/L. */
export function summarizePnl(closedRecords: TradeLifecycleRecord[]): PnlSummary {
  const withPnl = closedRecords.filter((record) => record.realisedPnl !== undefined);
  const winCount = withPnl.filter((record) => (record.realisedPnl ?? 0) > 0).length;
  const totalRealisedPnl = withPnl.reduce((sum, record) => sum + (record.realisedPnl ?? 0), 0);
  const percentValues = withPnl
    .map((record) => record.realisedPnlPercent)
    .filter((value): value is number => value !== undefined);
  const averageRealisedPnlPercent =
    percentValues.length > 0 ? percentValues.reduce((sum, value) => sum + value, 0) / percentValues.length : 0;

  return {
    tradeCount: withPnl.length,
    winCount,
    winRate: withPnl.length > 0 ? winCount / withPnl.length : 0,
    totalRealisedPnl,
    averageRealisedPnlPercent,
  };
}

export function formatPnl(closedRecords: TradeLifecycleRecord[]): string {
  const summary = summarizePnl(closedRecords);
  if (summary.tradeCount === 0) return "No completed trades yet.";
  return [
    `Trades: ${summary.tradeCount}`,
    `Win rate: ${(summary.winRate * 100).toFixed(1)}%`,
    `Total realised P/L: ${summary.totalRealisedPnl.toFixed(2)}`,
    `Average realised P/L: ${summary.averageRealisedPnlPercent.toFixed(2)}%`,
  ].join("\n");
}

/** Restart-Resilient Autonomy Phase — CLOSED_UNRECONCILED operator visibility (deployment safety
 * review). Deliberately its own command, never folded into /trades: a CLOSED_UNRECONCILED record
 * has no confirmed exit price or realised P&L, and must never be silently mixed into (or read as if
 * it were) a normal, fully-valued closed trade — formatTrades/formatPnl above only ever receive
 * `listClosed()` (status CLOSED only), so those two commands already structurally exclude these
 * records; this command is the one place they ARE surfaced, with both unknowns explicitly labelled. */
export function formatReconciliation(unreconciledRecords: TradeLifecycleRecord[]): string {
  if (unreconciledRecords.length === 0) return "No unreconciled closures — every closed position has a confirmed exit price and P/L.";
  const sorted = [...unreconciledRecords].sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""));
  const lines = sorted.map(
    (record) =>
      `${record.symbol} (${record.id}): closed ${record.closedAt ?? "—"} — exit price UNKNOWN, realised P/L UNKNOWN. ` +
      `Reason: ${record.exitReason ?? "—"}.`,
  );
  return [`${unreconciledRecords.length} unreconciled closure(s) — exit price/P&L could not be confirmed:`, ...lines].join("\n");
}

export function formatHelp(): string {
  return [
    "Available commands:",
    "/status — runtime state and last cycle outcome",
    "/positions — currently open positions",
    "/trades — most recent completed trades",
    "/pnl — win rate and realised P/L summary",
    "/reconciliation — closed positions with unknown exit price/P&L (CLOSED_UNRECONCILED)",
    "/pause — pause the scheduler",
    "/resume — resume the scheduler",
    "/run — run one cycle immediately",
    "/help — this message",
  ].join("\n");
}
