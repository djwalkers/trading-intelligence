import { describe, expect, it } from "vitest";
import { recoverStaleLifecycleRecords } from "@/lib/hermes-execution/runtime/lifecycle-recovery";
import { InMemoryAuditTrail } from "@/lib/hermes-execution/audit-trail";
import { InMemoryTradeCandidateRepository } from "@/lib/hermes-execution/trade-approval/trade-candidate-repository";
import { InMemoryTradeLifecycleStore, TradeLifecycleUniqueConstraintViolationError } from "@/lib/hermes-execution/trade-lifecycle/trade-lifecycle-store";
import type { TradeLifecycleRecord, TradeLifecycleStatus } from "@/lib/hermes-execution/trade-lifecycle/types";
import type { AuditEvent } from "@/lib/hermes-execution/types";
import type { InternalStrategy, PaperPosition } from "@/lib/hermes-execution/types";

// Restart-Resilient Autonomy Phase — crash-window recovery (deployment safety review). Covers the
// required test scenarios 1-5, 9, 10, 11: stale DECISION_CREATED/APPROVED safely abandoned,
// EXECUTION_SUBMITTED correlated/abandoned/ambiguous, idempotency, restart survival, and recovery
// audit-failure blocking continuation. No real broker/network call anywhere.

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

const NOW = new Date("2026-01-01T01:00:00.000Z");
const RECOVERY_THRESHOLD_MS = 5 * 60_000;

function makeRecord(overrides: Partial<TradeLifecycleRecord> = {}): TradeLifecycleRecord {
  return {
    id: "lifecycle-1",
    strategyId: "DEMO-0001",
    strategyVersion: 1,
    brokerProvider: "etoro-demo",
    symbol: "BTC",
    side: "BUY",
    quantity: 10,
    sizingMode: "NOTIONAL",
    decision: "BUY",
    confidence: 0.8,
    decisionReasons: ["seed"],
    status: "DECISION_CREATED",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z", // 1 hour before NOW — well past the 5-minute threshold
    ...overrides,
  };
}

interface FakeRawPosition {
  positionID: number;
  orderID: number;
  instrumentID: number;
  isBuy?: boolean;
  amount?: number;
  openRate?: number;
  openDateTime?: string;
}

/** A plain broker — only getOpenPositions() (the universally-available PaperBroker interface),
 * deliberately WITHOUT getRawPortfolio/resolveInstrument, for the "broker cannot make an
 * authoritative claim" ambiguous case. */
function makePlainBroker(openPositions: PaperPosition[] = []) {
  return {
    getAccount: () => ({ cashBalance: 100_000, startingCashBalance: 100_000 }),
    getOpenPositions: (): PaperPosition[] => openPositions,
    getCompletedTrades: () => [],
    placeMarketOrder: async () => {
      throw new Error("not exercised in this test file");
    },
    closePosition: async () => {
      throw new Error("not exercised in this test file");
    },
  };
}

/** Same "raw-portfolio-capable" fake convention position-reconciliation.test.ts already
 * establishes — deliberately not importing/extending EtoroDemoBroker. */
function makeEtoroLikeBroker(positions: FakeRawPosition[] = []) {
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

function baseInput(overrides: Partial<Parameters<typeof recoverStaleLifecycleRecords>[0]> = {}) {
  return {
    broker: makePlainBroker(),
    instrument: "BTC",
    strategy: STRATEGY,
    brokerProvider: "etoro-demo",
    lifecycleStore: new InMemoryTradeLifecycleStore(),
    tradeCandidateRepository: new InMemoryTradeCandidateRepository(),
    auditTrail: new InMemoryAuditTrail(),
    executionRunId: "test-run",
    now: NOW,
    recoveryThresholdMs: RECOVERY_THRESHOLD_MS,
    ...overrides,
  };
}

describe("recoverStaleLifecycleRecords — staleness threshold", () => {
  it("does not touch a record younger than the recovery threshold", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeRecord({ status: "DECISION_CREATED", updatedAt: "2026-01-01T00:58:00.000Z" })); // 2 min old
    const auditTrail = new InMemoryAuditTrail();

    await recoverStaleLifecycleRecords(baseInput({ lifecycleStore, auditTrail }));

    expect((await lifecycleStore.getById("lifecycle-1"))?.status).toBe("DECISION_CREATED");
    expect(await auditTrail.getEvents()).toEqual([]);
  });
});

describe("recoverStaleLifecycleRecords — DECISION_CREATED/APPROVED safely abandoned (required scenarios 1 & 2)", () => {
  it.each<TradeLifecycleStatus>(["DECISION_CREATED", "APPROVED"])(
    "abandons a stale %s record when the broker proves no position/order exists",
    async (status) => {
      const lifecycleStore = new InMemoryTradeLifecycleStore();
      await lifecycleStore.create(makeRecord({ status }));
      const auditTrail = new InMemoryAuditTrail();

      await recoverStaleLifecycleRecords(baseInput({ lifecycleStore, auditTrail, broker: makePlainBroker([]) }));

      const stored = await lifecycleStore.getById("lifecycle-1");
      expect(stored?.status).toBe("EXECUTION_ABANDONED");
      expect(stored?.closedAt).toBeDefined();
      expect(stored?.exitReason).toBeDefined();

      const events = await auditTrail.getEvents();
      expect(events.map((e) => e.eventType)).toEqual(["LIFECYCLE_RECOVERY_ABANDONED"]);
    },
  );

  it("flags ambiguous (never abandons) when the broker unexpectedly shows a live position for a pre-broker-call status", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeRecord({ status: "DECISION_CREATED" }));
    const auditTrail = new InMemoryAuditTrail();
    const openPositions: PaperPosition[] = [
      {
        positionId: "p1",
        strategyId: "DEMO-0001",
        strategyVersion: 1,
        sourceType: "HERMES_APPROVED",
        instrument: "BTC",
        side: "BUY",
        quantity: 10,
        entryPrice: 100,
        entryTimestamp: NOW.toISOString(),
        entryOrderId: "order-1",
      },
    ];

    await recoverStaleLifecycleRecords(baseInput({ lifecycleStore, auditTrail, broker: makePlainBroker(openPositions) }));

    const stored = await lifecycleStore.getById("lifecycle-1");
    expect(stored?.status).toBe("EXECUTION_RECONCILIATION_REQUIRED");
    const events = await auditTrail.getEvents();
    expect(events.map((e) => e.eventType)).toEqual(["LIFECYCLE_RECOVERY_AMBIGUOUS"]);
  });
});

describe("recoverStaleLifecycleRecords — EXECUTION_SUBMITTED correlated to an existing broker position (required scenario 3)", () => {
  it("attaches the EXISTING record to a matched broker position (OPEN) — never creates a second record", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeRecord({ status: "EXECUTION_SUBMITTED" }));
    const auditTrail = new InMemoryAuditTrail();
    const broker = makeEtoroLikeBroker([
      { positionID: 3568040809, orderID: 369015901, instrumentID: 100000, isBuy: true, amount: 10, openRate: 64_948.33 },
    ]);

    await recoverStaleLifecycleRecords(baseInput({ lifecycleStore, auditTrail, broker: broker as never }));

    const stored = await lifecycleStore.getById("lifecycle-1");
    expect(stored?.status).toBe("OPEN");
    expect(stored?.brokerPositionId).toBe("3568040809");
    expect(stored?.entryPrice).toBe(64_948.33);
    expect(stored?.openedAt).toBeDefined();

    expect(await lifecycleStore.list()).toHaveLength(1); // never a second record

    const events = await auditTrail.getEvents();
    expect(events.map((e) => e.eventType)).toEqual(["LIFECYCLE_RECOVERY_CORRELATED"]);

    // The broker adapter's own tracking was updated too (adoptPosition), so the normal
    // exit-monitor/closePosition path can find it later.
    expect(broker.getOpenPositions()).toHaveLength(1);
  });

  it("abandons (never attaches) when the position is already tracked by a DIFFERENT local record", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeRecord({ id: "lifecycle-1", status: "EXECUTION_SUBMITTED", symbol: "BTC" }));
    // A second, already-OPEN record for a DIFFERENT instrument already claims this exact broker
    // position id — realistic only as a defensive/legacy-data scenario, but the recovery logic
    // must not double-attach regardless.
    await lifecycleStore.create(
      makeRecord({
        id: "lifecycle-other",
        status: "OPEN",
        symbol: "ETH",
        brokerPositionId: "3568040809",
        entryPrice: 100,
        openedAt: NOW.toISOString(),
      }),
    );
    const auditTrail = new InMemoryAuditTrail();
    const broker = makeEtoroLikeBroker([
      { positionID: 3568040809, orderID: 369015901, instrumentID: 100000, isBuy: true, amount: 10, openRate: 64_948.33 },
    ]);

    await recoverStaleLifecycleRecords(baseInput({ lifecycleStore, auditTrail, broker: broker as never }));

    const stored = await lifecycleStore.getById("lifecycle-1");
    expect(stored?.status).toBe("EXECUTION_ABANDONED");
  });
});

describe("recoverStaleLifecycleRecords — EXECUTION_SUBMITTED proven absent (required scenario 4)", () => {
  it("terminally abandons when the broker's own portfolio read confirms nothing exists", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeRecord({ status: "EXECUTION_SUBMITTED" }));
    const auditTrail = new InMemoryAuditTrail();
    const broker = makeEtoroLikeBroker([]); // clean, authoritative negative

    await recoverStaleLifecycleRecords(baseInput({ lifecycleStore, auditTrail, broker: broker as never }));

    const stored = await lifecycleStore.getById("lifecycle-1");
    expect(stored?.status).toBe("EXECUTION_ABANDONED");
    expect(stored?.exitPrice).toBeUndefined();
    expect(stored?.realisedPnl).toBeUndefined();
    const events = await auditTrail.getEvents();
    expect(events.map((e) => e.eventType)).toEqual(["LIFECYCLE_RECOVERY_ABANDONED"]);
  });
});

describe("recoverStaleLifecycleRecords — EXECUTION_SUBMITTED ambiguous, blocks new entries (required scenario 5)", () => {
  it("flags EXECUTION_RECONCILIATION_REQUIRED when the broker cannot make an authoritative claim (no raw-portfolio capability)", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeRecord({ status: "EXECUTION_SUBMITTED" }));
    const auditTrail = new InMemoryAuditTrail();

    await recoverStaleLifecycleRecords(baseInput({ lifecycleStore, auditTrail, broker: makePlainBroker([]) }));

    const stored = await lifecycleStore.getById("lifecycle-1");
    expect(stored?.status).toBe("EXECUTION_RECONCILIATION_REQUIRED");
    const events = await auditTrail.getEvents();
    expect(events.map((e) => e.eventType)).toEqual(["LIFECYCLE_RECOVERY_AMBIGUOUS"]);
  });

  it("flags ambiguous when the broker's own portfolio read throws", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeRecord({ status: "EXECUTION_SUBMITTED" }));
    const auditTrail = new InMemoryAuditTrail();
    const broker = makeEtoroLikeBroker([]);
    broker.getRawPortfolio = async () => {
      throw new Error("network unreachable");
    };

    await recoverStaleLifecycleRecords(baseInput({ lifecycleStore, auditTrail, broker: broker as never }));

    expect((await lifecycleStore.getById("lifecycle-1"))?.status).toBe("EXECUTION_RECONCILIATION_REQUIRED");
  });

  it("flags ambiguous when more than one broker position matches the instrument", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeRecord({ status: "EXECUTION_SUBMITTED" }));
    const auditTrail = new InMemoryAuditTrail();
    const broker = makeEtoroLikeBroker([
      { positionID: 1, orderID: 1, instrumentID: 100000, amount: 10, openRate: 100 },
      { positionID: 2, orderID: 2, instrumentID: 100000, amount: 5, openRate: 100 },
    ]);

    await recoverStaleLifecycleRecords(baseInput({ lifecycleStore, auditTrail, broker: broker as never }));

    expect((await lifecycleStore.getById("lifecycle-1"))?.status).toBe("EXECUTION_RECONCILIATION_REQUIRED");
  });

  it("blocks a fresh entry attempt for the same strategy+instrument while EXECUTION_RECONCILIATION_REQUIRED — the active-uniqueness invariant still applies", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeRecord({ status: "EXECUTION_SUBMITTED" }));
    const auditTrail = new InMemoryAuditTrail();

    await recoverStaleLifecycleRecords(baseInput({ lifecycleStore, auditTrail, broker: makePlainBroker([]) }));
    expect((await lifecycleStore.getById("lifecycle-1"))?.status).toBe("EXECUTION_RECONCILIATION_REQUIRED");

    await expect(
      lifecycleStore.create(makeRecord({ id: "lifecycle-2", status: "DECISION_CREATED" })),
    ).rejects.toThrow(TradeLifecycleUniqueConstraintViolationError);
  });
});

describe("recoverStaleLifecycleRecords — idempotency (required scenario 9)", () => {
  it("a second sweep pass over an already-EXECUTION_ABANDONED record is a safe no-op", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeRecord({ status: "DECISION_CREATED" }));
    const auditTrail = new InMemoryAuditTrail();

    await recoverStaleLifecycleRecords(baseInput({ lifecycleStore, auditTrail, broker: makePlainBroker([]) }));
    expect((await lifecycleStore.getById("lifecycle-1"))?.status).toBe("EXECUTION_ABANDONED");
    const eventsAfterFirst = await auditTrail.getEvents();

    // Second pass, later in time — EXECUTION_ABANDONED is terminal and not in the recoverable set,
    // so this must not touch the record or emit a second event.
    await recoverStaleLifecycleRecords(
      baseInput({ lifecycleStore, auditTrail, broker: makePlainBroker([]), now: new Date(NOW.getTime() + 60 * 60_000) }),
    );

    expect((await lifecycleStore.getById("lifecycle-1"))?.status).toBe("EXECUTION_ABANDONED");
    expect(await auditTrail.getEvents()).toEqual(eventsAfterFirst);
  });

  it("re-running the sweep while still EXECUTION_RECONCILIATION_REQUIRED re-emits the ambiguous event but does not error or duplicate records", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeRecord({ status: "EXECUTION_SUBMITTED" }));
    const auditTrail = new InMemoryAuditTrail();

    await recoverStaleLifecycleRecords(baseInput({ lifecycleStore, auditTrail, broker: makePlainBroker([]) }));
    await recoverStaleLifecycleRecords(
      baseInput({ lifecycleStore, auditTrail, broker: makePlainBroker([]), now: new Date(NOW.getTime() + 60 * 60_000) }),
    );

    expect((await lifecycleStore.getById("lifecycle-1"))?.status).toBe("EXECUTION_RECONCILIATION_REQUIRED");
    expect(await lifecycleStore.list()).toHaveLength(1);
    const events = await auditTrail.getEvents();
    expect(events.map((e) => e.eventType)).toEqual(["LIFECYCLE_RECOVERY_AMBIGUOUS", "LIFECYCLE_RECOVERY_AMBIGUOUS"]);
  });
});

describe("recoverStaleLifecycleRecords — survives a simulated restart (required scenario 10)", () => {
  it("a fresh broker instance + a fresh sweep call, sharing the same durable store, still correctly recovers the stale record", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore(); // stands in for Supabase durability across the "restart"
    await lifecycleStore.create(makeRecord({ status: "EXECUTION_SUBMITTED" }));

    // "Process A" — crashes before ever running recovery.
    // "Process B" (post-restart) — a brand-new broker instance, a brand-new audit trail, the SAME
    // durable lifecycleStore.
    const brokerB = makeEtoroLikeBroker([
      { positionID: 3568040809, orderID: 369015901, instrumentID: 100000, isBuy: true, amount: 10, openRate: 64_948.33 },
    ]);
    const auditTrailB = new InMemoryAuditTrail();

    await recoverStaleLifecycleRecords(baseInput({ lifecycleStore, auditTrail: auditTrailB, broker: brokerB as never }));

    const stored = await lifecycleStore.getById("lifecycle-1");
    expect(stored?.status).toBe("OPEN");
    expect(stored?.brokerPositionId).toBe("3568040809");
    expect(await lifecycleStore.list()).toHaveLength(1);
  });
});

describe("recoverStaleLifecycleRecords — recovery audit failure blocks automatic continuation (required scenario 11)", () => {
  class FailingAuditTrail extends InMemoryAuditTrail {
    async record(event: AuditEvent): Promise<void> {
      throw new Error("disk full — simulated durability failure");
    }
  }

  it("propagates the audit failure and never transitions the record when the ABANDON audit write fails", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeRecord({ status: "DECISION_CREATED" }));
    const auditTrail = new FailingAuditTrail();

    await expect(recoverStaleLifecycleRecords(baseInput({ lifecycleStore, auditTrail, broker: makePlainBroker([]) }))).rejects.toThrow(
      /disk full/,
    );

    // The store was never updated — audited-before-store-write means a durability failure leaves
    // the record exactly as it was, safe to retry next cycle, never silently abandoned without a trail.
    expect((await lifecycleStore.getById("lifecycle-1"))?.status).toBe("DECISION_CREATED");
  });

  it("propagates the audit failure and never attaches the record when the CORRELATE audit write fails", async () => {
    const lifecycleStore = new InMemoryTradeLifecycleStore();
    await lifecycleStore.create(makeRecord({ status: "EXECUTION_SUBMITTED" }));
    const auditTrail = new FailingAuditTrail();
    const broker = makeEtoroLikeBroker([
      { positionID: 3568040809, orderID: 369015901, instrumentID: 100000, isBuy: true, amount: 10, openRate: 64_948.33 },
    ]);

    await expect(
      recoverStaleLifecycleRecords(baseInput({ lifecycleStore, auditTrail, broker: broker as never })),
    ).rejects.toThrow(/disk full/);

    expect((await lifecycleStore.getById("lifecycle-1"))?.status).toBe("EXECUTION_SUBMITTED");
  });
});
