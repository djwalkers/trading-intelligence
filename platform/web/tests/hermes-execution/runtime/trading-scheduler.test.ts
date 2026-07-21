import { describe, expect, it } from "vitest";
import { TradingScheduler } from "@/lib/hermes-execution/runtime/trading-scheduler";
import { ManualSchedulerClock } from "./support/manual-scheduler-clock";

const START = new Date("2026-01-01T00:00:00.000Z");

describe("TradingScheduler — immediate first run enabled", () => {
  it("fires the first tick at 0ms delay, without waiting a full interval", async () => {
    const clock = new ManualSchedulerClock(START);
    let ticks = 0;
    const scheduler = new TradingScheduler({ clock, intervalMs: 60_000, immediateFirstRun: true, onTick: () => (ticks += 1) });

    scheduler.start();
    await clock.advance(0);
    expect(ticks).toBe(1);
  });
});

describe("TradingScheduler — immediate first run disabled", () => {
  it("waits a full interval before the first tick", async () => {
    const clock = new ManualSchedulerClock(START);
    let ticks = 0;
    const scheduler = new TradingScheduler({ clock, intervalMs: 60_000, immediateFirstRun: false, onTick: () => (ticks += 1) });

    scheduler.start();
    await clock.advance(0);
    expect(ticks).toBe(0);

    await clock.advance(59_999);
    expect(ticks).toBe(0);

    await clock.advance(1);
    expect(ticks).toBe(1);
  });
});

describe("TradingScheduler — recurring scheduling", () => {
  it("fires again every intervalMs after the first tick", async () => {
    const clock = new ManualSchedulerClock(START);
    let ticks = 0;
    const scheduler = new TradingScheduler({ clock, intervalMs: 10_000, immediateFirstRun: true, onTick: () => (ticks += 1) });

    scheduler.start();
    await clock.advance(0);
    expect(ticks).toBe(1);

    await clock.advance(10_000);
    expect(ticks).toBe(2);

    await clock.advance(10_000);
    expect(ticks).toBe(3);
  });

  it("fires multiple due ticks when the clock jumps past several intervals at once", async () => {
    const clock = new ManualSchedulerClock(START);
    let ticks = 0;
    const scheduler = new TradingScheduler({ clock, intervalMs: 10_000, immediateFirstRun: false, onTick: () => (ticks += 1) });

    scheduler.start();
    await clock.advance(35_000); // 3 full intervals due (10s, 20s, 30s)
    expect(ticks).toBe(3);
  });
});

describe("TradingScheduler.getNextRunAt", () => {
  it("is null before start()", () => {
    const clock = new ManualSchedulerClock(START);
    const scheduler = new TradingScheduler({ clock, intervalMs: 10_000, immediateFirstRun: true, onTick: () => {} });
    expect(scheduler.getNextRunAt()).toBeNull();
  });

  it("reflects the next scheduled fire time, updated after each tick", async () => {
    const clock = new ManualSchedulerClock(START);
    const scheduler = new TradingScheduler({ clock, intervalMs: 10_000, immediateFirstRun: false, onTick: () => {} });

    scheduler.start();
    expect(scheduler.getNextRunAt()?.toISOString()).toBe("2026-01-01T00:00:10.000Z");

    await clock.advance(10_000);
    expect(scheduler.getNextRunAt()?.toISOString()).toBe("2026-01-01T00:00:20.000Z");
  });

  it("is null after stop()", async () => {
    const clock = new ManualSchedulerClock(START);
    const scheduler = new TradingScheduler({ clock, intervalMs: 10_000, immediateFirstRun: true, onTick: () => {} });
    scheduler.start();
    scheduler.stop();
    expect(scheduler.getNextRunAt()).toBeNull();
  });
});

describe("TradingScheduler.stop", () => {
  it("cancels the pending timer — no further ticks fire", async () => {
    const clock = new ManualSchedulerClock(START);
    let ticks = 0;
    const scheduler = new TradingScheduler({ clock, intervalMs: 10_000, immediateFirstRun: false, onTick: () => (ticks += 1) });

    scheduler.start();
    expect(clock.pendingCount()).toBe(1);
    scheduler.stop();
    expect(clock.pendingCount()).toBe(0);

    await clock.advance(100_000);
    expect(ticks).toBe(0);
  });
});
