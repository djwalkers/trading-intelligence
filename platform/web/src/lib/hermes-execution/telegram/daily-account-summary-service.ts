import type { AuditTrail } from "../audit-trail";
import type { AuditEvent } from "../types";
import type { PaperBroker } from "../paper-broker";
import type { MarketDataProvider } from "../market-data/market-data-provider";
import type { TradeLifecycleStore } from "../trade-lifecycle/trade-lifecycle-store";
import type { BrokerProvider } from "../config";
import { calculateRealisedPnl } from "../trade-lifecycle/calculations";
import { classifyWinLoss } from "../trade-performance/calculate-trade-performance";
import { hasRawPortfolio } from "../runtime/position-reconciliation";
import type { AlertSender } from "./telegram-alerting-audit-trail";
import type { DailyAccountSummaryStateStore } from "./daily-account-summary-state-store";
import { formatBrokerProviderLabel, formatGbp, formatLondonCalendarDate, formatLondonTimestamp, formatSignedGbp, isLondonTimeAtOrAfter21 } from "./format-alert-values";

// Telegram alert refinement — requirement 3 (daily account summary). Deliberately its OWN direct
// send path — NEVER dispatched through TelegramAlertingAuditTrail's generic per-event formatAlert
// (see that file's own top-of-file doc comment) — because this is the one alert whose OWN caller
// needs to know whether delivery genuinely succeeded, to decide whether it may safely persist
// "today's summary was sent" (a failed send must remain retryable within the same day; a
// successful one must never be duplicated, including across a process restart).
//
// "Broker-ground-truth" is taken literally: available cash, invested value, and open position count
// are read from the broker's OWN raw portfolio call (RawPortfolioBroker.getRawPortfolio(), the same
// duck-typed capability position-reconciliation.ts already uses) whenever the configured broker
// supports it — NEVER from PaperBroker.getAccount(), which for a broker like EtoroDemoBroker
// reflects only what THIS process instance itself has tracked, not the real remote account. A
// broker without a raw ground-truth read falls back to getAccount()/getOpenPositions() (that
// broker's own only available truth — see hasRawPortfolio's own duck-type check) with invested
// value/account balance reported "Unavailable" rather than guessed.
//
// Unrealised P/L is computed from the LOCAL TradeLifecycleStore's own OPEN records — NOT "the
// legacy local paper portfolio balance" this feature is designed to avoid (that phrase means a
// broker's own fake, self-contained cash simulation; a TradeLifecycleRecord's entryPrice/side/
// quantity/sizingMode are the DURABLE RECORD of what the real broker actually confirmed at open
// time) — combined with a genuinely fresh, live current price fetched at generation time (never a
// stale scan-cycle price, never an estimate: the exact same calculateRealisedPnl formula already
// trusted for realised P/L and MFE/MAE, with the live current price standing in for the exit
// price). If the count of locally-tracked OPEN records doesn't match the broker's own reported open
// position count, or if any required figure (price, entry price) is unavailable, unrealised P/L is
// reported "Unavailable" rather than a partial or possibly-wrong sum — never estimated.

export interface DailyAccountSummaryServiceDeps {
  broker: PaperBroker;
  marketDataProvider: MarketDataProvider;
  lifecycleStore: TradeLifecycleStore;
  auditTrail: AuditTrail;
  alertSender: AlertSender;
  stateStore: DailyAccountSummaryStateStore;
  executionRunId: string;
  brokerProvider: BrokerProvider;
  /** Injectable for deterministic tests; defaults to the real current time. */
  now?: () => Date;
}

interface AccountSnapshot {
  availableCash: number;
  investedValue: number | undefined;
  accountBalance: number | undefined;
  openPositionCount: number;
  positionsAreLiveGroundTruth: boolean;
}

async function readAccountSnapshot(broker: PaperBroker): Promise<AccountSnapshot> {
  if (hasRawPortfolio(broker)) {
    const raw = await broker.getRawPortfolio();
    const positions = raw.clientPortfolio.positions;
    const availableCash = raw.clientPortfolio.credit;
    const everyPositionHasAmount = positions.every((position) => typeof position.amount === "number");
    const investedValue = everyPositionHasAmount ? positions.reduce((sum, position) => sum + (position.amount ?? 0), 0) : undefined;
    return {
      availableCash,
      investedValue,
      accountBalance: investedValue !== undefined ? availableCash + investedValue : undefined,
      openPositionCount: positions.length,
      positionsAreLiveGroundTruth: true,
    };
  }

  const account = broker.getAccount();
  return {
    availableCash: account.cashBalance,
    investedValue: undefined,
    accountBalance: undefined,
    openPositionCount: broker.getOpenPositions().length,
    positionsAreLiveGroundTruth: false,
  };
}

/** Undefined (never a partial/wrong sum) whenever the local OPEN-record count doesn't match the
 * broker's own reported open position count, or any required figure for any single open position
 * is unavailable — see this file's own top-of-file doc comment. */
async function computeUnrealisedPnl(deps: DailyAccountSummaryServiceDeps, openPositionCount: number): Promise<number | undefined> {
  const openRecords = await deps.lifecycleStore.listOpen();
  if (openRecords.length !== openPositionCount) return undefined;
  if (openRecords.length === 0) return 0;

  let total = 0;
  for (const record of openRecords) {
    if (record.entryPrice === undefined) return undefined;
    try {
      const snapshot = await deps.marketDataProvider.getMarketData(record.symbol);
      total += calculateRealisedPnl(record.sizingMode, record.side, record.entryPrice, snapshot.latestPrice, record.quantity);
    } catch {
      // A single malformed/unreachable live price makes the WHOLE unrealised-P/L figure
      // unavailable (never a partial sum silently missing one position's contribution) — never
      // lets the rest of the daily summary (which doesn't depend on this) fail to send.
      return undefined;
    }
  }
  return total;
}

interface TodayStats {
  tradesOpenedToday: number;
  tradesClosedToday: number;
  realisedPnlToday: number;
  winsToday: number;
  lossesToday: number;
}

function computeTodayStats(events: AuditEvent[], todayLondon: string): TodayStats {
  let tradesOpenedToday = 0;
  let tradesClosedToday = 0;
  let realisedPnlToday = 0;
  let winsToday = 0;
  let lossesToday = 0;

  for (const event of events) {
    if (formatLondonCalendarDate(new Date(event.timestamp)) !== todayLondon) continue;
    if (event.eventType === "TRADE_OPENED") {
      tradesOpenedToday += 1;
    } else if (event.eventType === "TRADE_CLOSED") {
      tradesClosedToday += 1;
      const realisedPnl = event.details.realisedPnl;
      if (typeof realisedPnl === "number" && Number.isFinite(realisedPnl)) {
        realisedPnlToday += realisedPnl;
        const winLoss = classifyWinLoss(realisedPnl);
        if (winLoss === "WIN") winsToday += 1;
        else if (winLoss === "LOSS") lossesToday += 1;
      }
    }
  }

  return { tradesOpenedToday, tradesClosedToday, realisedPnlToday, winsToday, lossesToday };
}

function formatDailySummaryAlert(
  now: Date,
  brokerProvider: BrokerProvider,
  account: AccountSnapshot,
  unrealisedPnl: number | undefined,
  stats: TodayStats,
): string {
  const pluralWin = stats.winsToday === 1 ? "win" : "wins";
  const pluralLoss = stats.lossesToday === 1 ? "loss" : "losses";

  return [
    "📊 DAILY TRADING SUMMARY [DEMO]",
    "",
    `Provider: ${formatBrokerProviderLabel(brokerProvider)}`,
    `Account balance: ${account.accountBalance !== undefined ? formatGbp(account.accountBalance) : "Unavailable"}`,
    `Available cash: ${formatGbp(account.availableCash)}`,
    `Invested value: ${account.investedValue !== undefined ? formatGbp(account.investedValue) : "Unavailable"}`,
    `Open positions: ${account.openPositionCount}`,
    "",
    `Realised P/L today: ${formatSignedGbp(stats.realisedPnlToday)}`,
    `Unrealised P/L: ${unrealisedPnl !== undefined ? formatSignedGbp(unrealisedPnl) : "Unavailable"}`,
    `Trades opened: ${stats.tradesOpenedToday}`,
    `Trades closed: ${stats.tradesClosedToday}`,
    `Results: ${stats.winsToday} ${pluralWin} / ${stats.lossesToday} ${pluralLoss}`,
    "",
    `Updated: ${formatLondonTimestamp(now.toISOString())}`,
  ].join("\n");
}

export class DailyAccountSummaryService {
  private readonly now: () => Date;
  /** undefined = not yet loaded from the state store this process's lifetime; null = loaded, and
   * nothing has ever been sent. Avoids a disk read on every single cycle — only the first call
   * this process makes ever reads the store; every send after that updates this cache directly. */
  private cachedLastSentDate: string | undefined | null = undefined;

  constructor(private readonly deps: DailyAccountSummaryServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Checked once per trading cycle (never per instrument — see trading-runtime.ts's own
   * runCycleBody call site). A no-op almost every cycle: returns immediately unless the LOCAL
   * Europe/London clock has reached 21:00 AND today's summary has not already been sent. Never
   * throws — any failure (a broker read, a market-data fetch, the send itself) is caught, logged via
   * a TELEGRAM_NOTIFICATION_FAILED audit event, and left retryable on a later cycle; Telegram must
   * never block or delay trading. */
  async maybeSend(): Promise<void> {
    try {
      const now = this.now();
      if (!isLondonTimeAtOrAfter21(now)) return;

      const todayLondon = formatLondonCalendarDate(now);
      if (this.cachedLastSentDate === undefined) {
        const persisted = await this.deps.stateStore.load();
        this.cachedLastSentDate = persisted?.lastSentDate ?? null;
      }
      if (this.cachedLastSentDate === todayLondon) return;

      const account = await readAccountSnapshot(this.deps.broker);
      const unrealisedPnl = await computeUnrealisedPnl(this.deps, account.openPositionCount);
      const events = await this.deps.auditTrail.getEvents();
      const stats = computeTodayStats(events, todayLondon);
      const message = formatDailySummaryAlert(now, this.deps.brokerProvider, account, unrealisedPnl, stats);

      try {
        await this.deps.alertSender.sendAlert(message);
      } catch (error) {
        await this.recordDeliveryFailure(now, error);
        return;
      }

      await this.deps.auditTrail.record({
        timestamp: now.toISOString(),
        eventType: "DAILY_PORTFOLIO_SUMMARY",
        executionRunId: this.deps.executionRunId,
        details: {
          brokerProvider: this.deps.brokerProvider,
          accountBalance: account.accountBalance ?? null,
          availableCash: account.availableCash,
          investedValue: account.investedValue ?? null,
          openPositionCount: account.openPositionCount,
          realisedPnlToday: stats.realisedPnlToday,
          unrealisedPnl: unrealisedPnl ?? null,
          tradesOpenedToday: stats.tradesOpenedToday,
          tradesClosedToday: stats.tradesClosedToday,
          winsToday: stats.winsToday,
          lossesToday: stats.lossesToday,
          positionsAreLiveGroundTruth: account.positionsAreLiveGroundTruth,
        },
      });

      this.cachedLastSentDate = todayLondon;
      await this.deps.stateStore.save({ lastSentDate: todayLondon });
    } catch (error) {
      await this.recordDeliveryFailure(this.now(), error, "daily-summary-generation-failed");
    }
  }

  private async recordDeliveryFailure(now: Date, error: unknown, originalEventType = "DAILY_PORTFOLIO_SUMMARY"): Promise<void> {
    try {
      await this.deps.auditTrail.record({
        timestamp: now.toISOString(),
        eventType: "TELEGRAM_NOTIFICATION_FAILED",
        executionRunId: this.deps.executionRunId,
        details: {
          originalEventType,
          reason: error instanceof Error ? error.message : "unknown delivery failure",
        },
      });
    } catch {
      // Best-effort observability only — matches TelegramAlertingAuditTrail's own established
      // convention: a broken audit trail must never surface here either.
    }
  }
}
