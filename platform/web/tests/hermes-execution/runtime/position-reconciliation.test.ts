import { describe, expect, it, vi } from "vitest";
import { reconcileBrokerPosition } from "@/lib/hermes-execution/runtime/position-reconciliation";
import { InMemoryAuditTrail } from "@/lib/hermes-execution/audit-trail";
import { InMemoryTradeCandidateRepository } from "@/lib/hermes-execution/trade-approval/trade-candidate-repository";
import { InMemoryTradeLifecycleStore } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-store";
import type { TradeLifecycleRecord } from "@/lib/hermes-execution/trade-lifecycle/types";
import type { InternalStrategy, PaperPosition } from "@/lib/hermes-execution/types";

// Restart-Resilient Autonomy Phase — Phase 1 (Startup and cycle reconciliation).
//
// Covers required scenarios:
//   1. Runtime startup discovers an existing eToro position.
//   3. Reconciled position survives simulated runtime restart.
//   4. Durable lifecycle record uses broker position ID.
// No real network/broker call anywhere — the fake broker below is a plain in-memory object.

const STRATEGY: InternalStrategy = {
  strategyId: "DEMO-0001",
  version: 1,
  sourceType: "HERMES_APPROVED",
  enabled: true,
  instrument: "BTC",
  timeframe: "1h",
  entryRules: [],
  exitRules: [],
  riskRules: { maxPositionValue: 1000 },
};

interface FakeRawPosition {
  positionID: number;
  orderID: number;
  instrumentID: number;
  isBuy?: boolean;
  amount?: number;
  openRate?: number;
  openDateTime?: string;
}

/** A minimal fake satisfying getOpenPositions (the plain PaperBroker interface) plus
 * resolveInstrument/getRawPortfolio/adoptPosition (the duck-typed capabilities
 * position-reconciliation.ts additionally checks for) — deliberately not importing or extending
 * EtoroDemoBroker itself, matching this module's own "never assumes a concrete broker class"
 * discipline. */
function makeFakeEtoroLikeBroker(positions: FakeRawPosition[] = []) {
  const tracked = new Map<string, PaperPosition>();
  let seq = 0;
  return {
    getAccount: () => ({ cashBalance: 100_000, startingCashBalance: 100_000 }),
    getOpenPositions: (): PaperPosition[] => [...tracked.values()],
    getCompletedTrades: () => [],
    placeMarketOrder: async () => {
      throw new Error("not exercised in this test file");
    },
    closePosition: async () => {
      throw new Error("not exercised in this test file");
    },
    resolveInstrument: async (_term: string) => ({ instrumentId: 100000 }),
    getRawPortfolio: async () => ({ clientPortfolio: { positions, credit: 100_000 } }),
    adoptPosition: (
      raw: FakeRawPosition,
      internalInstrument: string,
      strategyContext: { strategyId: string; strategyVersion: number; sourceType: InternalStrategy["sourceType"] },
    ): PaperPosition => {
      seq += 1;
      const position: PaperPosition = {
        positionId: `fake-position-${seq}`,
        strategyId: strategyContext.strategyId,
        strategyVersion: strategyContext.strategyVersion,
        sourceType: strategyContext.sourceType,
        instrument: internalInstrument,
        side: raw.isBuy === false ? "SELL" : "BUY",
        quantity: raw.amount!,
        entryPrice: raw.openRate!,
        entryTimestamp: raw.openDateTime ?? new Date().toISOString(),
        entryOrderId: String(raw.orderID),
        brokerPositionId: String(raw.positionID),
      };
      tracked.set(position.positionId, position);
      return position;
    },
  };
}

function baseInput(overrides: Partial<Parameters<typeof reconcileBrokerPosition>[0]> = {}) {
  return {
    broker: makeFakeEtoroLikeBroker(),
    instrument: "BTC",
    strategy: STRATEGY,
    brokerProvider: "etoro-demo",
    sizingMode: "NOTIONAL" as const,
    lifecycleStore: new InMemoryTradeLifecycleStore(),
    tradeCandidateRepository: new InMemoryTradeCandidateRepository(),
    auditTrail: new InMemoryAuditTrail(),
    executionRunId: "test-run",
    now: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("reconcileBrokerPosition — no live position", () => {
  it("reports positionOpen: false when the broker's own portfolio has nothing for this instrument", async () => {
    const result = await reconcileBrokerPosition(baseInput({ broker: makeFakeEtoroLikeBroker([]) }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.positionOpen).toBe(false);
  });
});

describe("reconcileBrokerPosition — startup discovery of an existing position (scenario 1)", () => {
  it("discovers a real broker position with no matching local record and adopts it, emitting DISCOVERED + ORPHANED", async () => {
    const broker = makeFakeEtoroLikeBroker([
      { positionID: 3568040809, orderID: 369015901, instrumentID: 100000, isBuy: true, amount: 10, openRate: 64948.33, openDateTime: "2026-01-01T00:00:00.000Z" },
    ]);
    const auditTrail = new InMemoryAuditTrail();
    const lifecycleStore = new InMemoryTradeLifecycleStore();

    const result = await reconcileBrokerPosition(baseInput({ broker, auditTrail, lifecycleStore }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.positionOpen).toBe(true);
    expect(result.record).toBeDefined();
    expect(result.record!.brokerPositionId).toBe("3568040809");
    expect(result.record!.entryPrice).toBe(64948.33);
    expect(result.record!.quantity).toBe(10);
    expect(result.record!.status).toBe("OPEN");
    // Genuinely unknown for an adopted position — never guessed.
    expect(result.record!.stopLoss).toBeUndefined();
    expect(result.record!.takeProfit).toBeUndefined();
    expect(result.record!.candidateId).toBeUndefined();

    const events = (await auditTrail.getEvents()).map((e) => e.eventType);
    expect(events).toEqual(["BROKER_POSITION_DISCOVERED", "BROKER_POSITION_ORPHANED"]);

    // The broker adapter's own tracking is also updated (adoptPosition) — getOpenPositions() now
    // reflects it too, matching a normally-opened position.
    expect(broker.getOpenPositions()).toHaveLength(1);
    expect(broker.getOpenPositions()[0]!.brokerPositionId).toBe("3568040809");
  });
});

describe("reconcileBrokerPosition — matches an existing durable lifecycle record", () => {
  it("emits DISCOVERED + RECONCILED (never ORPHANED) when a durable OPEN record already references the broker position id", async () => {
    const existingRecord: TradeLifecycleRecord = {
      id: "lifecycle-1",
      brokerProvider: "etoro-demo",
      strategyId: "DEMO-0001",
      strategyVersion: 1,
      symbol: "BTC",
      side: "BUY",
      quantity: 10,
      sizingMode: "NOTIONAL",
      stopLoss: 64_000,
      takeProfit: 66_000,
      decision: "BUY",
      confidence: 0.8,
      decisionReasons: ["seed"],
      status: "OPEN",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      openedAt: "2026-01-01T00:00:00.000Z",
      entryPrice: 64948.33,
      brokerPositionId: "3568040809",
      brokerOrderId: "369015901",
    };
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(existingRecord);

    const broker = makeFakeEtoroLikeBroker([
      { positionID: 3568040809, orderID: 369015901, instrumentID: 100000, isBuy: true, amount: 10, openRate: 64948.33 },
    ]);
    const auditTrail = new InMemoryAuditTrail();

    const result = await reconcileBrokerPosition(baseInput({ broker, auditTrail, lifecycleStore }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.positionOpen).toBe(true);
    expect(result.record?.id).toBe("lifecycle-1");
    // The real stop-loss/take-profit are preserved from the durable record, never rediscovered.
    expect(result.record?.stopLoss).toBe(64_000);
    expect(result.record?.takeProfit).toBe(66_000);

    const events = (await auditTrail.getEvents()).map((e) => e.eventType);
    expect(events).toEqual(["BROKER_POSITION_DISCOVERED", "BROKER_POSITION_RECONCILED"]);
  });
});

describe("reconcileBrokerPosition — restart survival (scenario 3)", () => {
  it("a position adopted by one reconciliation call is found via RECONCILED (not ORPHANED again) on a later call against the same durable store", async () => {
    // Simulates: process A discovers + adopts an orphaned position; process A crashes; process B
    // starts fresh (new broker instance, same durable lifecycleStore) and reconciles again.
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    const rawPosition: FakeRawPosition = {
      positionID: 3568040809,
      orderID: 369015901,
      instrumentID: 100000,
      isBuy: true,
      amount: 10,
      openRate: 64948.33,
    };

    const brokerA = makeFakeEtoroLikeBroker([rawPosition]);
    const firstResult = await reconcileBrokerPosition(baseInput({ broker: brokerA, lifecycleStore }));
    expect(firstResult.ok).toBe(true);
    if (!firstResult.ok) throw new Error("unreachable");
    expect(firstResult.record).toBeDefined();

    // A brand-new broker instance (simulating a PM2 restart) — its own trackedPositions map is
    // empty, but the durable lifecycleStore instance survives (in production this would be Supabase).
    const brokerB = makeFakeEtoroLikeBroker([rawPosition]);
    const auditTrailB = new InMemoryAuditTrail();
    const secondResult = await reconcileBrokerPosition(baseInput({ broker: brokerB, lifecycleStore, auditTrail: auditTrailB }));

    expect(secondResult.ok).toBe(true);
    if (!secondResult.ok) throw new Error("unreachable");
    expect(secondResult.positionOpen).toBe(true);
    expect(secondResult.record!.id).toBe(firstResult.record!.id); // the SAME durable record, not a second adoption

    const events = (await auditTrailB.getEvents()).map((e) => e.eventType);
    expect(events).toEqual(["BROKER_POSITION_DISCOVERED", "BROKER_POSITION_RECONCILED"]);
    expect(events).not.toContain("BROKER_POSITION_ORPHANED");
  });

  // Kill-switch exit defect — root cause reproduction. reconcileBrokerPosition() itself reports
  // success (positionOpen: true, the correct durable record) for a position that survived a
  // restart and is re-matched via the "existing OPEN record, broker confirms it's still live"
  // branch (position-reconciliation.ts's own `if (existing.status === "OPEN" ...)`) — but that
  // branch, unlike the orphan-adoption branch just below it in the same function, never calls
  // broker.adoptPosition(...). The brand-new broker instance's own trackedPositions map is left
  // empty, so a LATER close attempt (executeAutomaticExit in exit-monitor.ts) can never find this
  // position via broker.getOpenPositions() and fails with a misleading "already closed" reason —
  // even though the position is genuinely still open. This test proves the gap directly: the
  // broker adapter itself must be able to list/close this position after reconciliation, and today
  // it cannot.
  it("a position re-matched via the existing-OPEN-record branch is registered with the broker adapter, so a later close attempt can find it", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    const rawPosition: FakeRawPosition = {
      positionID: 3568040809,
      orderID: 369015901,
      instrumentID: 100000,
      isBuy: true,
      amount: 10,
      openRate: 64948.33,
    };

    // The durable record already exists BEFORE this broker instance is ever constructed — exactly
    // "a position opened by an earlier process, this one is fresh after a restart."
    const existingRecord: TradeLifecycleRecord = {
      id: "lifecycle-1",
      brokerProvider: "etoro-demo",
      strategyId: "DEMO-0001",
      strategyVersion: 1,
      symbol: "BTC",
      side: "BUY",
      quantity: 10,
      sizingMode: "NOTIONAL",
      decision: "BUY",
      confidence: 0.8,
      decisionReasons: ["seed"],
      status: "OPEN",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      openedAt: "2026-01-01T00:00:00.000Z",
      entryPrice: 64948.33,
      brokerPositionId: "3568040809",
      brokerOrderId: "369015901",
    };
    await lifecycleStore.create(existingRecord);

    const broker = makeFakeEtoroLikeBroker([rawPosition]);

    const result = await reconcileBrokerPosition(baseInput({ broker, lifecycleStore }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.positionOpen).toBe(true);

    // Kill-switch exit defect — root cause. Reconciliation reporting positionOpen: true is not
    // enough on its own: the broker adapter that a later close attempt (executeAutomaticExit in
    // exit-monitor.ts) will actually query via getOpenPositions() must ALSO know about this
    // position, or that close attempt fails with a misleading "already closed" reason despite the
    // position genuinely still being open.
    const brokerOpenPositions = broker.getOpenPositions();
    expect(brokerOpenPositions).toHaveLength(1);
    expect(brokerOpenPositions[0]?.brokerPositionId).toBe("3568040809");
  });

  // Code-review fix — idempotency. adoptPosition always mints a FRESH internal positionId, so
  // calling it unconditionally on every cycle would create a second, duplicate tracked entry for
  // the same real broker position every time reconciliation re-confirms it. Proves the guard: a
  // second reconcileBrokerPosition() call against the SAME broker instance never re-registers.
  it("does not re-register an already-registered position on a second reconciliation pass against the same broker instance", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    const rawPosition: FakeRawPosition = {
      positionID: 3568040809,
      orderID: 369015901,
      instrumentID: 100000,
      isBuy: true,
      amount: 10,
      openRate: 64948.33,
    };
    await lifecycleStore.create({
      id: "lifecycle-1",
      brokerProvider: "etoro-demo",
      strategyId: "DEMO-0001",
      strategyVersion: 1,
      symbol: "BTC",
      side: "BUY",
      quantity: 10,
      sizingMode: "NOTIONAL",
      decision: "BUY",
      confidence: 0.8,
      decisionReasons: ["seed"],
      status: "OPEN",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      openedAt: "2026-01-01T00:00:00.000Z",
      entryPrice: 64948.33,
      brokerPositionId: "3568040809",
      brokerOrderId: "369015901",
    });

    const broker = makeFakeEtoroLikeBroker([rawPosition]);

    const first = await reconcileBrokerPosition(baseInput({ broker, lifecycleStore }));
    expect(first.ok).toBe(true);
    expect(broker.getOpenPositions()).toHaveLength(1);

    // Second cycle, same (never-restarted) broker instance — the broker adapter already knows
    // about this position from the first call.
    const second = await reconcileBrokerPosition(baseInput({ broker, lifecycleStore }));
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("unreachable");
    expect(second.positionOpen).toBe(true);

    // Still exactly one tracked entry — never a duplicate.
    expect(broker.getOpenPositions()).toHaveLength(1);
    expect(broker.getOpenPositions()[0]?.brokerPositionId).toBe("3568040809");
  });

  // Code-review fix — fail closed rather than an uncaught exception. Mirrors the orphan-adoption
  // branch's own amount/openRate guard: EtoroDemoBroker.adoptPosition's own assertValidAmount
  // throws synchronously for an incomplete broker DTO, so this must be checked BEFORE ever calling
  // adoptPosition, not left to propagate as an uncaught exception out of reconcileBrokerPosition.
  it("fails closed with BROKER_RECONCILIATION_FAILED (never an uncaught exception) when a broker position needing registration is missing amount/openRate", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create({
      id: "lifecycle-1",
      brokerProvider: "etoro-demo",
      strategyId: "DEMO-0001",
      strategyVersion: 1,
      symbol: "BTC",
      side: "BUY",
      quantity: 10,
      sizingMode: "NOTIONAL",
      decision: "BUY",
      confidence: 0.8,
      decisionReasons: ["seed"],
      status: "OPEN",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      openedAt: "2026-01-01T00:00:00.000Z",
      entryPrice: 64948.33,
      brokerPositionId: "3568040809",
      brokerOrderId: "369015901",
    });

    // A brand-new broker instance (post-restart, nothing registered yet) whose own raw portfolio
    // read is missing amount/openRate for this position — a genuinely incomplete eToro response.
    const broker = makeFakeEtoroLikeBroker([
      { positionID: 3568040809, orderID: 369015901, instrumentID: 100000, isBuy: true, amount: undefined, openRate: undefined },
    ]);
    const auditTrail = new InMemoryAuditTrail();

    const result = await reconcileBrokerPosition(baseInput({ broker, lifecycleStore, auditTrail }));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/missing its own reported amount\/openRate/);

    const events = (await auditTrail.getEvents()).map((e) => e.eventType);
    expect(events).toContain("BROKER_RECONCILIATION_FAILED");
    expect(broker.getOpenPositions()).toEqual([]); // never registered with incomplete data
  });
});

describe("reconcileBrokerPosition — ambiguous/failed broker state fails closed", () => {
  it("fails closed when more than one live position exists for the configured instrument", async () => {
    const broker = makeFakeEtoroLikeBroker([
      { positionID: 1, orderID: 1, instrumentID: 100000, amount: 10, openRate: 100 },
      { positionID: 2, orderID: 2, instrumentID: 100000, amount: 5, openRate: 100 },
    ]);
    const auditTrail = new InMemoryAuditTrail();
    const result = await reconcileBrokerPosition(baseInput({ broker, auditTrail }));
    expect(result.ok).toBe(false);
    const events = (await auditTrail.getEvents()).map((e) => e.eventType);
    expect(events).toEqual(["BROKER_RECONCILIATION_FAILED"]);
  });

  it("fails closed when the broker's own portfolio read throws", async () => {
    const broker = makeFakeEtoroLikeBroker();
    broker.getRawPortfolio = async () => {
      throw new Error("network unreachable");
    };
    const auditTrail = new InMemoryAuditTrail();
    const result = await reconcileBrokerPosition(baseInput({ broker, auditTrail }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/network unreachable/);
    const events = (await auditTrail.getEvents()).map((e) => e.eventType);
    expect(events).toEqual(["BROKER_RECONCILIATION_FAILED"]);
  });

  it("fails closed when instrument resolution throws", async () => {
    const broker = makeFakeEtoroLikeBroker();
    broker.resolveInstrument = async () => {
      throw new Error("instrument not found");
    };
    const result = await reconcileBrokerPosition(baseInput({ broker }));
    expect(result.ok).toBe(false);
  });
});

describe("reconcileBrokerPosition — brokers without raw-portfolio support", () => {
  it("falls back to broker.getOpenPositions() rather than forcing positionOpen: false", async () => {
    const openPositions: PaperPosition[] = [
      {
        positionId: "p1",
        strategyId: "DEMO-0001",
        strategyVersion: 1,
        sourceType: "HERMES_APPROVED",
        instrument: "BTC",
        side: "BUY",
        quantity: 2,
        entryPrice: 100,
        entryTimestamp: "2026-01-01T00:00:00.000Z",
        entryOrderId: "order-1",
      },
    ];
    const plainBroker = { getOpenPositions: () => openPositions };
    const result = await reconcileBrokerPosition(baseInput({ broker: plainBroker as never }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.positionOpen).toBe(true);
      expect(result.record).toBeUndefined(); // no reconciled record for a broker outside this phase's scope
    }
  });
});

// Restart-Resilient Autonomy Phase — reconciliation/state-machine hardening (safety-review pass).
function makeOpenRecord(overrides: Partial<TradeLifecycleRecord> = {}): TradeLifecycleRecord {
  return {
    id: "lifecycle-1",
    brokerProvider: "etoro-demo",
    strategyId: "DEMO-0001",
    strategyVersion: 1,
    symbol: "BTC",
    side: "BUY",
    quantity: 10,
    sizingMode: "NOTIONAL",
    decision: "BUY",
    confidence: 0.8,
    decisionReasons: ["seed"],
    status: "OPEN",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    openedAt: "2026-01-01T00:00:00.000Z",
    entryPrice: 64948.33,
    brokerPositionId: "3568040809",
    brokerOrderId: "369015901",
    ...overrides,
  };
}

describe("reconcileBrokerPosition — CLOSE_FAILED + broker still open: safe retry", () => {
  it("reverts CLOSE_FAILED to OPEN and emits TRADE_LIFECYCLE_REOPENED_FOR_RETRY, rather than re-adopting a second record", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeOpenRecord({ status: "CLOSE_FAILED" }));
    const broker = makeFakeEtoroLikeBroker([
      { positionID: 3568040809, orderID: 369015901, instrumentID: 100000, isBuy: true, amount: 10, openRate: 64948.33 },
    ]);
    const auditTrail = new InMemoryAuditTrail();

    const result = await reconcileBrokerPosition(baseInput({ broker, auditTrail, lifecycleStore }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.positionOpen).toBe(true);
    expect(result.record?.status).toBe("OPEN");
    expect(result.record?.id).toBe("lifecycle-1");

    const stored = await lifecycleStore.getById("lifecycle-1");
    expect(stored?.status).toBe("OPEN");

    const events = (await auditTrail.getEvents()).map((e) => e.eventType);
    expect(events).toContain("TRADE_LIFECYCLE_REOPENED_FOR_RETRY");
    expect(events).not.toContain("BROKER_POSITION_ORPHANED");

    // Only ever the one record — never a second one for the same broker position.
    expect((await lifecycleStore.list()).length).toBe(1);
  });
});

describe("reconcileBrokerPosition — CLOSE_FAILED + broker absent: reconciled without fabricated economics", () => {
  it("resolves to CLOSED_UNRECONCILED with null exitPrice/realisedPnl, never guessing them", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeOpenRecord({ status: "CLOSE_FAILED" }));
    const broker = makeFakeEtoroLikeBroker([]); // broker now reports nothing for this instrument
    const auditTrail = new InMemoryAuditTrail();

    const result = await reconcileBrokerPosition(baseInput({ broker, auditTrail, lifecycleStore }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.positionOpen).toBe(false);

    const stored = await lifecycleStore.getById("lifecycle-1");
    expect(stored?.status).toBe("CLOSED_UNRECONCILED");
    expect(stored?.exitPrice).toBeUndefined();
    expect(stored?.realisedPnl).toBeUndefined();
    expect(stored?.closedAt).toBeDefined();
    expect(stored?.exitReason).toBeDefined();

    const mismatchEvent = (await auditTrail.getEvents()).find((e) => e.eventType === "BROKER_RECONCILIATION_MISMATCH");
    expect(mismatchEvent).toBeDefined();
    expect(mismatchEvent?.details.resolution).toBe("reconciled-closed-unreconciled");
  });
});

describe("reconcileBrokerPosition — local OPEN but broker absent (required scenario)", () => {
  it("an OPEN record (no close ever attempted) reconciles to CLOSED_UNRECONCILED when the broker reports nothing", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeOpenRecord({ status: "OPEN" }));
    const broker = makeFakeEtoroLikeBroker([]);
    const auditTrail = new InMemoryAuditTrail();

    const result = await reconcileBrokerPosition(baseInput({ broker, auditTrail, lifecycleStore }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.positionOpen).toBe(false);
    const stored = await lifecycleStore.getById("lifecycle-1");
    expect(stored?.status).toBe("CLOSED_UNRECONCILED");
  });

  it("also detects the mismatch for brokers without raw-portfolio support (getOpenPositions()-only path)", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeOpenRecord({ status: "OPEN" }));
    const plainBroker = { getOpenPositions: () => [] as PaperPosition[] };
    const auditTrail = new InMemoryAuditTrail();

    const result = await reconcileBrokerPosition(baseInput({ broker: plainBroker as never, auditTrail, lifecycleStore }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.positionOpen).toBe(false);
    const stored = await lifecycleStore.getById("lifecycle-1");
    expect(stored?.status).toBe("CLOSED_UNRECONCILED");
    const events = (await auditTrail.getEvents()).map((e) => e.eventType);
    expect(events).toContain("BROKER_RECONCILIATION_MISMATCH");
  });
});

/** A read-only fake store that simply returns a fixed set of records from list()/listOpen() — used
 * to construct an "already duplicated" state reconciliation itself must detect, without going
 * through InMemoryTradeLifecycleStore's own create()-time uniqueness enforcement (which correctly
 * refuses to let a SECOND active record for the same identity be created in the first place — the
 * scenario these tests need to construct is "such duplicates already exist regardless of how,"
 * e.g. pre-existing data from before this invariant existed, or a real Postgres row a migration
 * predates). Every write method throws — not exercised by these read-focused tests. */
function makeFixedRecordsStore(records: TradeLifecycleRecord[]) {
  return {
    async create(): Promise<void> {
      throw new Error("not exercised — this fake store is read-only");
    },
    async getById(id: string) {
      return records.find((r) => r.id === id) ?? null;
    },
    async update(): Promise<void> {
      throw new Error("not exercised — this fake store is read-only");
    },
    async list() {
      return records;
    },
    async listOpen() {
      return records.filter((r) => r.status === "OPEN" || r.status === "CLOSE_REQUESTED");
    },
    async listClosed() {
      return records.filter((r) => r.status === "CLOSED");
    },
    async listUnreconciled() {
      return records.filter((r) => r.status === "CLOSED_UNRECONCILED");
    },
    async countConfirmedEntriesForUtcDay(): Promise<number> {
      throw new Error("not exercised — this fake store is read-only");
    },
    async listActiveLifecycleRecords(scope: { strategyId: string; instrument: string; statuses: readonly string[] }) {
      const statuses = new Set(scope.statuses);
      return records.filter((r) => r.strategyId === scope.strategyId && r.symbol === scope.instrument && statuses.has(r.status));
    },
    async listRecoverableLifecycleRecords(): Promise<TradeLifecycleRecord[]> {
      throw new Error("not exercised — this fake store is read-only");
    },
    async findLifecycleRecordsByBrokerPositionId(brokerPositionId: string) {
      return records.filter((r) => r.brokerPositionId === brokerPositionId);
    },
    async sumRealisedPnlForClosedTrades(): Promise<never> {
      throw new Error("not exercised — this fake store is read-only");
    },
    async countUnreconciledClosedTrades(): Promise<number> {
      throw new Error("not exercised — this fake store is read-only");
    },
  };
}

describe("reconcileBrokerPosition — duplicate local records fail closed (required scenario)", () => {
  it("more than one locally-active record for the same strategy+instrument fails closed with DUPLICATE_LIFECYCLE_RECORD_DETECTED", async () => {
    const lifecycleStore = makeFixedRecordsStore([
      makeOpenRecord({ id: "lifecycle-1", brokerPositionId: "111", status: "OPEN" }),
      makeOpenRecord({ id: "lifecycle-2", brokerPositionId: "222", status: "CLOSE_FAILED" }),
    ]);
    const auditTrail = new InMemoryAuditTrail();

    const result = await reconcileBrokerPosition(baseInput({ auditTrail, lifecycleStore }));

    expect(result.ok).toBe(false);
    const events = (await auditTrail.getEvents()).map((e) => e.eventType);
    expect(events).toEqual(["DUPLICATE_LIFECYCLE_RECORD_DETECTED"]);
  });

  it("more than one local record referencing the SAME brokerPositionId fails closed", async () => {
    const lifecycleStore = makeFixedRecordsStore([
      // Different strategies so the strategy+instrument pre-check doesn't fire first — isolates
      // the brokerPositionId-duplicate detection path specifically.
      makeOpenRecord({ id: "lifecycle-1", strategyId: "DEMO-0001", status: "CLOSE_FAILED" }),
      makeOpenRecord({ id: "lifecycle-2", strategyId: "DEMO-0002", status: "CLOSE_FAILED" }),
    ]);
    const broker = makeFakeEtoroLikeBroker([
      { positionID: 3568040809, orderID: 369015901, instrumentID: 100000, isBuy: true, amount: 10, openRate: 64948.33 },
    ]);
    const auditTrail = new InMemoryAuditTrail();

    const result = await reconcileBrokerPosition(baseInput({ broker, auditTrail, lifecycleStore }));

    expect(result.ok).toBe(false);
    const events = (await auditTrail.getEvents()).map((e) => e.eventType);
    expect(events).toContain("DUPLICATE_LIFECYCLE_RECORD_DETECTED");
  });

  it("broker reports a position live whose exact id is already recorded CLOSED locally — anomalous, fails closed rather than guessing", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(
      makeOpenRecord({ status: "CLOSED", closedAt: "2026-01-02T00:00:00.000Z", exitPrice: 65000, exitReason: "take-profit", realisedPnl: 100 }),
    );
    const broker = makeFakeEtoroLikeBroker([
      { positionID: 3568040809, orderID: 369015901, instrumentID: 100000, isBuy: true, amount: 10, openRate: 64948.33 },
    ]);
    const auditTrail = new InMemoryAuditTrail();

    const result = await reconcileBrokerPosition(baseInput({ broker, auditTrail, lifecycleStore }));

    expect(result.ok).toBe(false);
    const events = (await auditTrail.getEvents()).map((e) => e.eventType);
    expect(events).toEqual(["BROKER_POSITION_DISCOVERED", "BROKER_RECONCILIATION_FAILED"]);
  });
});

// Deployment safety review (final hardening pass): EXECUTION_RECONCILIATION_REQUIRED must be
// treated as a local active/unresolved position — see position-reconciliation.ts's own early-return
// comment for why this is neither the OPEN/CLOSE_REQUESTED/CLOSE_FAILED broker-matching path nor
// the reconcileLocalActiveButBrokerAbsent mismatch-resolution path.
describe("reconcileBrokerPosition — EXECUTION_RECONCILIATION_REQUIRED is treated as active/unresolved", () => {
  it("returns positionOpen: true with no record, regardless of what the broker itself reports", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeOpenRecord({ status: "EXECUTION_RECONCILIATION_REQUIRED", brokerPositionId: undefined, entryPrice: undefined, openedAt: undefined }));
    const broker = makeFakeEtoroLikeBroker([]); // broker shows nothing — still must not fail closed or adopt an orphan
    const auditTrail = new InMemoryAuditTrail();

    const result = await reconcileBrokerPosition(baseInput({ broker, auditTrail, lifecycleStore }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.positionOpen).toBe(true);
    expect(result.record).toBeUndefined();

    // Never touched — resolution is left to the next lifecycle-recovery.ts sweep, not reconciliation.
    const stored = await lifecycleStore.getById("lifecycle-1");
    expect(stored?.status).toBe("EXECUTION_RECONCILIATION_REQUIRED");
    expect(await auditTrail.getEvents()).toEqual([]);
  });

  it("does not attempt orphan-adoption or throw a uniqueness violation even when the broker DOES report a live position", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeOpenRecord({ status: "EXECUTION_RECONCILIATION_REQUIRED", brokerPositionId: undefined, entryPrice: undefined, openedAt: undefined }));
    const broker = makeFakeEtoroLikeBroker([
      { positionID: 3568040809, orderID: 369015901, instrumentID: 100000, isBuy: true, amount: 10, openRate: 64948.33 },
    ]);
    const auditTrail = new InMemoryAuditTrail();

    const result = await reconcileBrokerPosition(baseInput({ broker, auditTrail, lifecycleStore }));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.positionOpen).toBe(true);
    expect(result.record).toBeUndefined();
    // Only ever the one record — no second (orphan-adopted) record was created.
    expect((await lifecycleStore.list()).length).toBe(1);
  });
});

describe("reconcileBrokerPosition — database uniqueness violation during orphan adoption (required scenario)", () => {
  it("a store-level uniqueness violation on create() is reported as a specific reconciliation failure, not a thrown/generic error", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    // A pre-existing CLOSE_FAILED record for the SAME strategy+instrument but a DIFFERENT
    // brokerPositionId than what this cycle's broker read reports. This is exactly one record, so
    // the upfront "more than one locally-active record" pre-check does not fire, and
    // findLocalRecordsByBrokerPositionId finds no match for the NEW id either — reconciliation
    // proceeds all the way to store.create() for a genuine-looking orphan, which is where the
    // store's own active-strategy-instrument uniqueness invariant (mirroring migration 0026's own
    // partial unique index) actually catches the collision — the same "a race this process's own
    // pre-checks missed" backstop this hardening pass adds.
    await lifecycleStore.create(makeOpenRecord({ id: "lifecycle-other", brokerPositionId: "999999", status: "CLOSE_FAILED" }));
    const broker = makeFakeEtoroLikeBroker([
      { positionID: 3568040809, orderID: 369015901, instrumentID: 100000, isBuy: true, amount: 10, openRate: 64948.33 },
    ]);
    const auditTrail = new InMemoryAuditTrail();

    const result = await reconcileBrokerPosition(baseInput({ broker, auditTrail, lifecycleStore }));

    expect(result.ok).toBe(false);
    const detail = (await auditTrail.getEvents()).find((e) => e.eventType === "DUPLICATE_LIFECYCLE_RECORD_DETECTED");
    expect(detail).toBeDefined();
    expect(detail?.details.detectedBy).toBe("database-constraint");

    // Never left as a silently-adopted duplicate — the pre-existing record is untouched, and no
    // second record was created.
    expect((await lifecycleStore.list()).length).toBe(1);
  });
});

// Egress-containment fix (production incident: Supabase egress ~800% over the Free-plan quota).
// reconcileBrokerPosition ran unconditionally on every instrument's every cycle — its own local-
// active-record pre-check used to call lifecycleStore.list() (a full-table select("*")) every time.
// Pinning that it now calls the bounded, scoped alternatives is the regression test proving this
// specific egress source cannot silently come back.
describe("reconcileBrokerPosition — egress-containment regression", () => {
  it("never calls lifecycleStore.list() — the local-active-record pre-check uses listActiveLifecycleRecords instead", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    const listSpy = vi.spyOn(lifecycleStore, "list");
    const listActiveSpy = vi.spyOn(lifecycleStore, "listActiveLifecycleRecords");

    await reconcileBrokerPosition(baseInput({ lifecycleStore }));

    expect(listSpy).not.toHaveBeenCalled();
    expect(listActiveSpy).toHaveBeenCalledWith(expect.objectContaining({ strategyId: "DEMO-0001", instrument: "BTC" }));
  });

  it("the broker-position-discovered path also never calls list() — uses findLifecycleRecordsByBrokerPositionId instead", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    const broker = makeFakeEtoroLikeBroker([
      { positionID: 3568040809, orderID: 369015901, instrumentID: 100000, isBuy: true, amount: 10, openRate: 64948.33 },
    ]);
    const listSpy = vi.spyOn(lifecycleStore, "list");
    const findByBrokerPositionIdSpy = vi.spyOn(lifecycleStore, "findLifecycleRecordsByBrokerPositionId");

    await reconcileBrokerPosition(baseInput({ broker, lifecycleStore }));

    expect(listSpy).not.toHaveBeenCalled();
    expect(findByBrokerPositionIdSpy).toHaveBeenCalledWith("3568040809");
  });
});
