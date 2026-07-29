import { describe, expect, it, vi } from "vitest";
import { DailyAccountSummaryService } from "@/lib/hermes-execution/telegram/daily-account-summary-service";
import { InMemoryDailyAccountSummaryStateStore } from "@/lib/hermes-execution/telegram/daily-account-summary-state-store";
import { InMemoryAuditTrail } from "@/lib/hermes-execution/audit-trail";
import { InMemoryTradeLifecycleStore } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-store";
import type { TradeLifecycleRecord } from "@/lib/hermes-execution/trade-lifecycle/types";
import type { PaperBroker } from "@/lib/hermes-execution/paper-broker";
import type { Account, AuditEvent, CompletedTrade, OrderRequest, PaperPosition } from "@/lib/hermes-execution/types";
import type { MarketDataProvider, MarketDataSnapshot } from "@/lib/hermes-execution/market-data/market-data-provider";

// Telegram alert refinement — requirement 3 (daily account summary). "Broker-ground-truth" is
// exercised here specifically by giving the fake broker BOTH a legacy getAccount() balance AND a
// separate, deliberately DIFFERENT raw-portfolio credit figure — every assertion below checks the
// RAW figure was used, never the legacy one, proving this service never substitutes "the legacy
// local paper portfolio balance" the requirement explicitly forbids.

const LEGACY_PAPER_CASH_BALANCE = 999_999; // deliberately implausible — must never appear anywhere

function makeBareBroker(): PaperBroker {
  const account: Account = { cashBalance: LEGACY_PAPER_CASH_BALANCE, startingCashBalance: LEGACY_PAPER_CASH_BALANCE };
  return {
    getAccount: () => account,
    getOpenPositions: () => [],
    getCompletedTrades: () => [],
    placeMarketOrder: async () => {
      throw new Error("not used in these tests");
    },
    closePosition: async () => {
      throw new Error("not used in these tests");
    },
  };
}

interface RawPosition {
  instrumentID: number;
  isBuy?: boolean;
  amount?: number;
  openRate?: number;
  openDateTime?: string;
}

function makeRawPortfolioBroker(credit: number, positions: RawPosition[]) {
  const broker = makeBareBroker();
  return Object.assign(broker, {
    getRawPortfolio: async () => ({ clientPortfolio: { positions, credit } }),
  });
}

function makeMarketDataProvider(prices: Record<string, number>): MarketDataProvider {
  return {
    getMarketData: async (instrument: string): Promise<MarketDataSnapshot> => {
      const latestPrice = prices[instrument];
      if (latestPrice === undefined) throw new Error(`no fixture price for ${instrument}`);
      return {
        instrument,
        timestamp: "2026-07-29T20:00:00.000Z",
        candles: [],
        bid: latestPrice,
        ask: latestPrice,
        spread: 0,
        latestPrice,
        volume: 0,
      };
    },
  };
}

function makeOpenRecord(overrides: Partial<TradeLifecycleRecord> = {}): TradeLifecycleRecord {
  return {
    id: overrides.id ?? "lifecycle-1",
    brokerProvider: "etoro-demo",
    strategyId: "DEMO-0001",
    strategyVersion: 1,
    symbol: "BTC",
    side: "BUY",
    quantity: 9.95,
    sizingMode: "NOTIONAL",
    decision: "BUY",
    confidence: 0.8,
    decisionReasons: [],
    status: "OPEN",
    createdAt: "2026-07-29T10:00:00.000Z",
    updatedAt: "2026-07-29T10:00:00.000Z",
    entryPrice: 60_000,
    openedAt: "2026-07-29T10:00:00.000Z",
    brokerPositionId: "pos-1",
    ...overrides,
  };
}

const AT_21_00_LONDON = new Date("2026-07-29T20:00:00.000Z"); // 21:00 BST
const BEFORE_21_00_LONDON = new Date("2026-07-29T18:00:00.000Z"); // 19:00 BST

function makeService(overrides: Partial<Parameters<typeof buildDeps>[0]> = {}) {
  const deps = buildDeps(overrides);
  return { service: new DailyAccountSummaryService(deps), ...deps };
}

function buildDeps(overrides: {
  broker?: PaperBroker;
  marketDataProvider?: MarketDataProvider;
  lifecycleStore?: InMemoryTradeLifecycleStore;
  auditTrail?: InMemoryAuditTrail;
  now?: () => Date;
} = {}) {
  const broker = overrides.broker ?? makeRawPortfolioBroker(77_191.35, []);
  const marketDataProvider = overrides.marketDataProvider ?? makeMarketDataProvider({});
  const lifecycleStore = overrides.lifecycleStore ?? new InMemoryTradeLifecycleStore();
  const auditTrail = overrides.auditTrail ?? new InMemoryAuditTrail();
  const stateStore = new InMemoryDailyAccountSummaryStateStore();
  const sent: string[] = [];
  const alertSender = { sendAlert: vi.fn(async (text: string) => { sent.push(text); }) };
  const now = overrides.now ?? (() => AT_21_00_LONDON);

  return {
    broker,
    marketDataProvider,
    lifecycleStore,
    auditTrail,
    stateStore,
    alertSender,
    sent,
    now,
    executionRunId: "test-run",
    brokerProvider: "etoro-demo" as const,
  };
}

describe("DailyAccountSummaryService — timing gate", () => {
  it("sends nothing before 21:00 London time", async () => {
    const { service, alertSender } = makeService({ now: () => BEFORE_21_00_LONDON });
    await service.maybeSend();
    expect(alertSender.sendAlert).not.toHaveBeenCalled();
  });

  it("sends once at/after 21:00 London time", async () => {
    const { service, alertSender } = makeService();
    await service.maybeSend();
    expect(alertSender.sendAlert).toHaveBeenCalledOnce();
  });
});

describe("DailyAccountSummaryService — uses broker-ground-truth data, never the legacy local paper portfolio balance", () => {
  it("uses the raw portfolio's own credit/positions, never PaperBroker.getAccount()'s cash balance", async () => {
    const broker = makeRawPortfolioBroker(77_191.35, [{ instrumentID: 1001, isBuy: true, amount: 14.96, openRate: 64_000 }]);
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeOpenRecord({ quantity: 14.96, entryPrice: 64_000 }));
    const marketDataProvider = makeMarketDataProvider({ BTC: 64_000 }); // flat price -> 0 unrealised

    const { service, sent } = makeService({ broker, lifecycleStore, marketDataProvider });
    await service.maybeSend();

    expect(sent[0]).toContain("Available cash: £77,191.35");
    expect(sent[0]).toContain("Invested value: £14.96");
    expect(sent[0]).toContain("Account balance: £77,206.31");
    expect(sent[0]).not.toContain(String(LEGACY_PAPER_CASH_BALANCE));
  });

  it("falls back to getAccount()/getOpenPositions() for a broker with no raw ground-truth read, and marks invested value/balance Unavailable rather than guessing", async () => {
    const broker = makeBareBroker();
    const { service, sent } = makeService({ broker });
    await service.maybeSend();

    expect(sent[0]).toContain("Available cash: £999,999.00"); // that broker's own only truth
    expect(sent[0]).toContain("Invested value: Unavailable");
    expect(sent[0]).toContain("Account balance: Unavailable");
  });
});

describe("DailyAccountSummaryService — null financial fields display 'Unavailable', never zero", () => {
  it("invested value/account balance are 'Unavailable' when any open position is missing its own amount", async () => {
    const broker = makeRawPortfolioBroker(1000, [
      { instrumentID: 1001, isBuy: true, amount: 10, openRate: 100 },
      { instrumentID: 1002, isBuy: true, amount: undefined, openRate: 50 }, // missing
    ]);
    const { service, sent } = makeService({ broker });
    await service.maybeSend();

    expect(sent[0]).toContain("Invested value: Unavailable");
    expect(sent[0]).toContain("Account balance: Unavailable");
    expect(sent[0]).not.toContain("Invested value: £0.00");
  });

  it("unrealised P/L is 'Unavailable' when the local OPEN-record count doesn't match the broker's own reported position count", async () => {
    const broker = makeRawPortfolioBroker(1000, [{ instrumentID: 1001, isBuy: true, amount: 10, openRate: 100 }]);
    // No local OPEN record at all for the one broker-reported position — a genuine mismatch.
    const { service, sent } = makeService({ broker });
    await service.maybeSend();

    expect(sent[0]).toContain("Unrealised P/L: Unavailable");
  });

  it("unrealised P/L is computed (not 'Unavailable') when broker/local counts match and a live price is available", async () => {
    const broker = makeRawPortfolioBroker(1000, [{ instrumentID: 1001, isBuy: true, amount: 10, openRate: 100 }]);
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeOpenRecord({ quantity: 10, entryPrice: 100, side: "BUY", sizingMode: "NOTIONAL" }));
    const marketDataProvider = makeMarketDataProvider({ BTC: 110 }); // +10% move

    const { service, sent } = makeService({ broker, lifecycleStore, marketDataProvider });
    await service.maybeSend();

    // NOTIONAL: quantity * percentReturn = 10 * 0.10 = 1.00
    expect(sent[0]).toContain("Unrealised P/L: £1.00");
  });

  it("unrealised P/L is 'Unavailable' when the live market-data fetch fails", async () => {
    const broker = makeRawPortfolioBroker(1000, [{ instrumentID: 1001, isBuy: true, amount: 10, openRate: 100 }]);
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeOpenRecord({ quantity: 10, entryPrice: 100 }));
    const marketDataProvider = makeMarketDataProvider({}); // no fixture -> throws

    const { service, sent } = makeService({ broker, lifecycleStore, marketDataProvider });
    await service.maybeSend();

    expect(sent[0]).toContain("Unrealised P/L: Unavailable");
  });

  it("realised P/L today is a genuine 0 (never 'Unavailable') when no trades closed today — a real computed answer, not a missing one", async () => {
    const { service, sent } = makeService();
    await service.maybeSend();
    expect(sent[0]).toContain("Realised P/L today: £0.00");
  });
});

describe("DailyAccountSummaryService — today's trade stats, derived from the audit trail", () => {
  function makeTodayEvent(eventType: AuditEvent["eventType"], details: Record<string, unknown>): AuditEvent {
    return { timestamp: "2026-07-29T12:00:00.000Z", eventType, executionRunId: "test-run", instrument: "BTC", details };
  }

  it("counts trades opened/closed today and classifies wins/losses from realisedPnl", async () => {
    const auditTrail = new InMemoryAuditTrail();
    await auditTrail.record(makeTodayEvent("TRADE_OPENED", {}));
    await auditTrail.record(makeTodayEvent("TRADE_OPENED", {}));
    await auditTrail.record(makeTodayEvent("TRADE_CLOSED", { realisedPnl: 12.5 }));
    await auditTrail.record(makeTodayEvent("TRADE_CLOSED", { realisedPnl: -0.06 }));
    // A different (earlier) calendar day — must not be counted.
    await auditTrail.record({ timestamp: "2026-07-28T12:00:00.000Z", eventType: "TRADE_CLOSED", executionRunId: "test-run", instrument: "BTC", details: { realisedPnl: 100 } });

    const { service, sent } = makeService({ auditTrail });
    await service.maybeSend();

    expect(sent[0]).toContain("Trades opened: 2");
    expect(sent[0]).toContain("Trades closed: 2");
    expect(sent[0]).toContain("Realised P/L today: £12.44"); // 12.5 + -0.06, never including yesterday's 100
    expect(sent[0]).toContain("Results: 1 win / 1 loss");
  });
});

describe("DailyAccountSummaryService — sent once per Europe/London calendar day", () => {
  it("does not send a second time later the same day", async () => {
    const stateStore = new InMemoryDailyAccountSummaryStateStore();
    const deps = buildDeps();
    const service = new DailyAccountSummaryService({ ...deps, stateStore });

    await service.maybeSend();
    await service.maybeSend();
    await service.maybeSend();

    expect(deps.alertSender.sendAlert).toHaveBeenCalledOnce();
  });

  it("sends again the FOLLOWING day", async () => {
    const stateStore = new InMemoryDailyAccountSummaryStateStore();
    const deps = buildDeps();
    let now = AT_21_00_LONDON;
    const service = new DailyAccountSummaryService({ ...deps, stateStore, now: () => now });

    await service.maybeSend();
    now = new Date(AT_21_00_LONDON.getTime() + 24 * 60 * 60_000);
    await service.maybeSend();

    expect(deps.alertSender.sendAlert).toHaveBeenCalledTimes(2);
  });
});

describe("DailyAccountSummaryService — restart safety (does not duplicate an already successful summary)", () => {
  it("a fresh service instance sharing the same persisted state store does not resend today's already-sent summary", async () => {
    const stateStore = new InMemoryDailyAccountSummaryStateStore();
    const deps = buildDeps();

    const first = new DailyAccountSummaryService({ ...deps, stateStore });
    await first.maybeSend();
    expect(deps.alertSender.sendAlert).toHaveBeenCalledOnce();

    // A brand-new instance (simulating a process restart) with no in-memory cache of its own, but
    // the SAME underlying persisted state (a real restart re-reads the same on-disk JSON file).
    const second = new DailyAccountSummaryService({ ...deps, stateStore });
    await second.maybeSend();

    expect(deps.alertSender.sendAlert).toHaveBeenCalledOnce(); // still exactly once, never twice
  });
});

describe("DailyAccountSummaryService — notification failures remain non-blocking", () => {
  it("a failed send never throws, and leaves today's summary retryable (not marked as sent)", async () => {
    const stateStore = new InMemoryDailyAccountSummaryStateStore();
    const deps = buildDeps();
    deps.alertSender.sendAlert = vi.fn(async () => {
      throw new Error("Hermes gateway delivery failed: timeout");
    });
    const service = new DailyAccountSummaryService({ ...deps, stateStore });

    await expect(service.maybeSend()).resolves.toBeUndefined();
    expect(await stateStore.load()).toBeNull(); // never persisted as sent

    const events = await deps.auditTrail.getEvents();
    expect(events.some((e) => e.eventType === "TELEGRAM_NOTIFICATION_FAILED")).toBe(true);
  });

  it("retries successfully on a later call the same day after a prior failure", async () => {
    const stateStore = new InMemoryDailyAccountSummaryStateStore();
    const deps = buildDeps();
    let shouldFail = true;
    deps.alertSender.sendAlert = vi.fn(async (text: string) => {
      if (shouldFail) throw new Error("temporary outage");
      deps.sent.push(text);
    });
    const service = new DailyAccountSummaryService({ ...deps, stateStore });

    await service.maybeSend();
    expect(deps.sent).toHaveLength(0);

    shouldFail = false;
    await service.maybeSend();
    expect(deps.sent).toHaveLength(1);
  });

  it("a failure while gathering data (e.g. a broker read throwing) never throws into the caller", async () => {
    const broker: PaperBroker = {
      ...makeBareBroker(),
      getAccount: () => {
        throw new Error("broker unreachable");
      },
    };
    const { service } = makeService({ broker });
    await expect(service.maybeSend()).resolves.toBeUndefined();
  });
});

describe("DailyAccountSummaryService — message shape", () => {
  it("includes the DEMO label, provider, and an Updated timestamp in Europe/London time", async () => {
    const { service, sent } = makeService();
    await service.maybeSend();
    expect(sent[0]).toContain("📊 DAILY TRADING SUMMARY [DEMO]");
    expect(sent[0]).toContain("Provider: eToro Demo");
    expect(sent[0]).toContain("Updated: 29 Jul 2026, 21:00 BST");
  });

  it("records a DAILY_PORTFOLIO_SUMMARY audit event on success", async () => {
    const { service, auditTrail } = makeService();
    await service.maybeSend();
    const events = await auditTrail.getEvents();
    expect(events.some((e) => e.eventType === "DAILY_PORTFOLIO_SUMMARY")).toBe(true);
  });
});
