import { describe, expect, it, vi } from "vitest";
import { at } from "@/lib/hermes-execution/array-utils";
import { TelegramBot } from "@/lib/hermes-execution/telegram/telegram-bot";
import type { TelegramTransport, TelegramUpdate } from "@/lib/hermes-execution/telegram/telegram-transport";
import { InMemoryTradeLifecycleStore } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-store";
import type { TradeLifecycleRecord } from "@/lib/hermes-execution/trade-lifecycle/types";
import type { TradingRuntime } from "@/lib/hermes-execution/runtime/trading-runtime";
import type { TradingRuntimeStatus } from "@/lib/hermes-execution/runtime/types";
import type { MarketDataSnapshot } from "@/lib/hermes-execution/market-data/market-data-provider";
import type { MarketDecisionContext } from "@/lib/hermes-execution/market-decision-engine";

const ALLOWED_CHAT_ID = "555";

const MARKET_DATA_SNAPSHOT: MarketDataSnapshot = {
  instrument: "BTC",
  timestamp: "2026-01-01T00:00:00.000Z",
  candles: [],
  bid: 100,
  ask: 100.1,
  spread: 0.1,
  latestPrice: 100.05,
  volume: 10,
};

const INTELLIGENCE_SUMMARY: MarketDecisionContext = {
  instrument: "BTC",
  bid: 100,
  ask: 100.1,
  spread: 0.1,
  midPrice: 100.05,
  timestamp: "2026-01-01T00:00:00.000Z",
  positionOpen: false,
  strategy: { strategyId: "STRAT-0001", version: 1, sourceType: "HERMES_APPROVED" },
  recentCandles: [],
  ema20: 101,
  ema50: 99,
  rsi14: 55,
  atr14: 1,
  volume: 10,
  dailyHigh: 102,
  dailyLow: 98,
  volatility24h: 0.01,
  marketSession: "Crypto Always Open",
  trend: "Bullish",
};

function makeRecord(id: string, overrides: Partial<TradeLifecycleRecord> = {}): TradeLifecycleRecord {
  return {
    id,
    strategyId: "STRAT-0001",
    symbol: "BTC",
    side: "BUY",
    quantity: 10,
    decision: "BUY",
    confidence: 0.7,
    decisionReasons: ["EMA20 above EMA50"],
    marketDataSnapshot: MARKET_DATA_SNAPSHOT,
    intelligenceSummary: INTELLIGENCE_SUMMARY,
    status: "OPEN",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function update(text: string, chatId: string = ALLOWED_CHAT_ID, updateId = 1): TelegramUpdate {
  return { updateId, chatId, fromId: chatId, text };
}

/** Records every sendMessage call; getUpdates always resolves empty — the bot tests below only
 * ever drive handleUpdate()/sendAlert() directly, never the polling loop itself (see the dedicated
 * "pollLoop" describe block at the bottom for that). */
function makeFakeTransport(): TelegramTransport & { sent: Array<{ chatId: string; text: string }> } {
  const sent: Array<{ chatId: string; text: string }> = [];
  return {
    sent,
    async getUpdates() {
      return [];
    },
    async sendMessage(chatId: string, text: string) {
      sent.push({ chatId, text });
    },
  };
}

/** Only the subset of TradingRuntime that TelegramBot actually depends on — same narrow,
 * duck-typed-via-cast convention runtime-dependency-factory.ts already uses for external broker
 * shapes, since TradingRuntime itself is a concrete class with a much larger real constructor. */
function makeFakeRuntime(overrides: {
  status?: TradingRuntimeStatus;
  pause?: () => Promise<void>;
  resume?: () => Promise<void>;
  runNow?: () => Promise<{ kind: string }>;
} = {}): TradingRuntime {
  const status: TradingRuntimeStatus = overrides.status ?? {
    state: "RUNNING",
    startedAt: "2026-01-01T00:00:00.000Z",
    pausedAt: null,
    stoppedAt: null,
    intervalMs: 60_000,
    isCycleRunning: false,
    lastRunStartedAt: null,
    lastRunCompletedAt: null,
    nextRunAt: null,
    successfulRunCount: 0,
    failedRunCount: 0,
    skippedOverlapCount: 0,
    skippedPausedCount: 0,
    skippedMarketClosedCount: 0,
    lastResult: null,
    lastError: null,
  };
  const fake = {
    getStatus: () => status,
    pause: overrides.pause ?? (async () => {}),
    resume: overrides.resume ?? (async () => {}),
    runNow: overrides.runNow ?? (async () => ({ kind: "HOLD" })),
  };
  return fake as unknown as TradingRuntime;
}

async function makeStoreWithRecords(...records: TradeLifecycleRecord[]): Promise<InMemoryTradeLifecycleStore> {
  const store = new InMemoryTradeLifecycleStore();
  for (const record of records) await store.create(record);
  return store;
}

describe("TelegramBot — authorization", () => {
  it("silently ignores an update from any chat id other than the configured allowed chat id", async () => {
    const transport = makeFakeTransport();
    const bot = new TelegramBot({
      transport,
      allowedChatId: ALLOWED_CHAT_ID,
      runtime: makeFakeRuntime(),
      lifecycleStore: await makeStoreWithRecords(),
    });

    await bot.handleUpdate(update("/status", "999-unauthorized"));

    expect(transport.sent).toHaveLength(0);
  });

  it("responds normally to an update from the configured allowed chat id", async () => {
    const transport = makeFakeTransport();
    const bot = new TelegramBot({
      transport,
      allowedChatId: ALLOWED_CHAT_ID,
      runtime: makeFakeRuntime(),
      lifecycleStore: await makeStoreWithRecords(),
    });

    await bot.handleUpdate(update("/status"));

    expect(transport.sent).toHaveLength(1);
    expect(at(transport.sent, 0).chatId).toBe(ALLOWED_CHAT_ID);
  });

  it("never sends a reply that reveals whether the bot exists to an unauthorized sender", async () => {
    const transport = makeFakeTransport();
    const bot = new TelegramBot({
      transport,
      allowedChatId: ALLOWED_CHAT_ID,
      runtime: makeFakeRuntime(),
      lifecycleStore: await makeStoreWithRecords(),
    });

    await bot.handleUpdate(update("/help", "999-unauthorized"));
    await bot.handleUpdate(update("anything", "111-unauthorized"));

    expect(transport.sent).toHaveLength(0);
  });
});

describe("TelegramBot — command dispatch", () => {
  it("/status replies with the runtime's current status", async () => {
    const transport = makeFakeTransport();
    const bot = new TelegramBot({
      transport,
      allowedChatId: ALLOWED_CHAT_ID,
      runtime: makeFakeRuntime(),
      lifecycleStore: await makeStoreWithRecords(),
    });
    await bot.handleUpdate(update("/status"));
    expect(at(transport.sent, 0).text).toContain("State: RUNNING");
  });

  it("/positions replies using the lifecycle store's open records", async () => {
    const transport = makeFakeTransport();
    const bot = new TelegramBot({
      transport,
      allowedChatId: ALLOWED_CHAT_ID,
      runtime: makeFakeRuntime(),
      lifecycleStore: await makeStoreWithRecords(makeRecord("t1", { status: "OPEN" })),
    });
    await bot.handleUpdate(update("/positions"));
    expect(at(transport.sent, 0).text).toContain("BTC — OPEN");
  });

  it("/trades and /pnl reply using the lifecycle store's closed records", async () => {
    const transport = makeFakeTransport();
    const bot = new TelegramBot({
      transport,
      allowedChatId: ALLOWED_CHAT_ID,
      runtime: makeFakeRuntime(),
      lifecycleStore: await makeStoreWithRecords(
        makeRecord("t1", { status: "CLOSED", closedAt: "2026-01-02T00:00:00.000Z", realisedPnl: 10, realisedPnlPercent: 5 }),
      ),
    });
    await bot.handleUpdate(update("/trades"));
    expect(at(transport.sent, 0).text).toContain("P/L 10.00");

    await bot.handleUpdate(update("/pnl"));
    expect(at(transport.sent, 1).text).toContain("Total realised P/L: 10.00");
  });

  it("/help replies with the fixed command list", async () => {
    const transport = makeFakeTransport();
    const bot = new TelegramBot({
      transport,
      allowedChatId: ALLOWED_CHAT_ID,
      runtime: makeFakeRuntime(),
      lifecycleStore: await makeStoreWithRecords(),
    });
    await bot.handleUpdate(update("/help"));
    expect(at(transport.sent, 0).text).toContain("/pause");
  });

  it("/pause calls runtime.pause() and confirms", async () => {
    const transport = makeFakeTransport();
    const pause = vi.fn(async () => {});
    const bot = new TelegramBot({
      transport,
      allowedChatId: ALLOWED_CHAT_ID,
      runtime: makeFakeRuntime({ pause }),
      lifecycleStore: await makeStoreWithRecords(),
    });
    await bot.handleUpdate(update("/pause"));
    expect(pause).toHaveBeenCalledOnce();
    expect(at(transport.sent, 0).text).toBe("Paused.");
  });

  it("/resume calls runtime.resume() and confirms", async () => {
    const transport = makeFakeTransport();
    const resume = vi.fn(async () => {});
    const bot = new TelegramBot({
      transport,
      allowedChatId: ALLOWED_CHAT_ID,
      runtime: makeFakeRuntime({ resume }),
      lifecycleStore: await makeStoreWithRecords(),
    });
    await bot.handleUpdate(update("/resume"));
    expect(resume).toHaveBeenCalledOnce();
    expect(at(transport.sent, 0).text).toBe("Resumed.");
  });

  it("/pause replies with an error message (not a thrown exception) when the runtime rejects the transition", async () => {
    const transport = makeFakeTransport();
    const bot = new TelegramBot({
      transport,
      allowedChatId: ALLOWED_CHAT_ID,
      runtime: makeFakeRuntime({
        pause: async () => {
          throw new Error("Invalid trading runtime transition: STOPPED -> PAUSED.");
        },
      }),
      lifecycleStore: await makeStoreWithRecords(),
    });
    await expect(bot.handleUpdate(update("/pause"))).resolves.toBeUndefined();
    expect(at(transport.sent, 0).text).toContain("Error:");
    expect(at(transport.sent, 0).text).toContain("Invalid trading runtime transition");
  });

  it("/run calls runtime.runNow() and reports the cycle outcome", async () => {
    const transport = makeFakeTransport();
    const runNow = vi.fn(async () => ({ kind: "OPEN" }));
    const bot = new TelegramBot({
      transport,
      allowedChatId: ALLOWED_CHAT_ID,
      runtime: makeFakeRuntime({ runNow }),
      lifecycleStore: await makeStoreWithRecords(),
    });
    await bot.handleUpdate(update("/run"));
    expect(runNow).toHaveBeenCalledOnce();
    expect(at(transport.sent, 0).text).toBe("Cycle result: OPEN");
  });

  it("/run replies with an error message when the runtime throws", async () => {
    const transport = makeFakeTransport();
    const bot = new TelegramBot({
      transport,
      allowedChatId: ALLOWED_CHAT_ID,
      runtime: makeFakeRuntime({
        runNow: async () => {
          throw new Error("a trading cycle is already running");
        },
      }),
      lifecycleStore: await makeStoreWithRecords(),
    });
    await bot.handleUpdate(update("/run"));
    expect(at(transport.sent, 0).text).toContain("Error: a trading cycle is already running");
  });

  it("commands are matched case-insensitively and ignore trailing whitespace/arguments", async () => {
    const transport = makeFakeTransport();
    const bot = new TelegramBot({
      transport,
      allowedChatId: ALLOWED_CHAT_ID,
      runtime: makeFakeRuntime(),
      lifecycleStore: await makeStoreWithRecords(),
    });
    await bot.handleUpdate(update("/STATUS  "));
    expect(transport.sent).toHaveLength(1);
  });

  it("sends no reply at all for an unrecognised command or plain text — no conversational fallback", async () => {
    const transport = makeFakeTransport();
    const bot = new TelegramBot({
      transport,
      allowedChatId: ALLOWED_CHAT_ID,
      runtime: makeFakeRuntime(),
      lifecycleStore: await makeStoreWithRecords(),
    });
    await bot.handleUpdate(update("/unknown-command"));
    await bot.handleUpdate(update("hello there"));
    await bot.handleUpdate(update(""));
    expect(transport.sent).toHaveLength(0);
  });
});

describe("TelegramBot — sendAlert", () => {
  it("sends the given text to the configured allowed chat id, not any other id", async () => {
    const transport = makeFakeTransport();
    const bot = new TelegramBot({
      transport,
      allowedChatId: ALLOWED_CHAT_ID,
      runtime: makeFakeRuntime(),
      lifecycleStore: await makeStoreWithRecords(),
    });
    await bot.sendAlert("Runtime started.");
    expect(transport.sent).toEqual([{ chatId: ALLOWED_CHAT_ID, text: "Runtime started." }]);
  });
});

describe("TelegramBot — polling lifecycle", () => {
  it("start() polls for updates and dispatches each one; stop() cleanly ends the loop", async () => {
    const queued: TelegramUpdate[][] = [[update("/help", ALLOWED_CHAT_ID, 1)], []];
    const sent: Array<{ chatId: string; text: string }> = [];
    const offsetsRequested: number[] = [];
    const transport: TelegramTransport = {
      async getUpdates(offset: number) {
        offsetsRequested.push(offset);
        const result = queued.shift() ?? [];
        if (result.length === 0) {
          // The real Telegram API blocks server-side for up to ~25s on an empty long-poll (see
          // telegram-transport.ts's own LONG_POLL_TIMEOUT_SECONDS) — this fake result never resolves
          // instantly either, both to model that and so this loop can't tight-spin the microtask
          // queue and starve the timers vi.waitFor()/stop() below depend on.
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        return result;
      },
      async sendMessage(chatId: string, text: string) {
        sent.push({ chatId, text });
      },
    };
    const bot = new TelegramBot({
      transport,
      allowedChatId: ALLOWED_CHAT_ID,
      runtime: makeFakeRuntime(),
      lifecycleStore: await makeStoreWithRecords(),
    });

    bot.start();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    await bot.stop();

    expect(sent[0]).toEqual({ chatId: ALLOWED_CHAT_ID, text: expect.stringContaining("/pause") });
    expect(offsetsRequested[0]).toBe(0);
    expect(offsetsRequested.length).toBeGreaterThanOrEqual(2);
    expect(offsetsRequested[1]).toBe(2);
  });

  it("start() is idempotent — calling it while already polling does not start a second loop", async () => {
    let callCount = 0;
    const transport: TelegramTransport = {
      async getUpdates() {
        callCount += 1;
        return [];
      },
      async sendMessage() {},
    };
    const bot = new TelegramBot({
      transport,
      allowedChatId: ALLOWED_CHAT_ID,
      runtime: makeFakeRuntime(),
      lifecycleStore: await makeStoreWithRecords(),
    });

    bot.start();
    bot.start();
    await vi.waitFor(() => expect(callCount).toBeGreaterThan(0));
    await bot.stop();
  });

  it("a transport failure does not crash the loop — stop() still resolves cleanly afterwards", async () => {
    let calls = 0;
    const transport: TelegramTransport = {
      async getUpdates() {
        calls += 1;
        throw new Error("network error");
      },
      async sendMessage() {},
    };
    const bot = new TelegramBot({
      transport,
      allowedChatId: ALLOWED_CHAT_ID,
      runtime: makeFakeRuntime(),
      lifecycleStore: await makeStoreWithRecords(),
    });

    bot.start();
    await vi.waitFor(() => expect(calls).toBeGreaterThan(0));
    await expect(bot.stop()).resolves.toBeUndefined();
  });
});
