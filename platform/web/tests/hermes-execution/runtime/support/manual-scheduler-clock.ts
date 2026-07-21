import type { SchedulerClock, SchedulerTimerHandle } from "@/lib/hermes-execution/runtime/scheduler-clock";

// Milestone 7 test support — a synchronous, manually-advanced SchedulerClock. Every scheduler/
// runtime test drives time through this instead of real setTimeout/Date, per the mission's own "do
// not rely on real waiting or long setTimeout-based integration tests."

interface PendingTimer {
  id: number;
  fireAt: number;
  callback: () => void;
}

/** Resolves any already-queued microtasks (promise chains with no real timer/I/O in between) before
 * a test's next assertion — bounded, not time-based, so this never makes a test flaky or slow. Every
 * test double used alongside this clock (mock brokers, MockMarketDataProvider, InMemory* stores)
 * resolves its own promises without any real I/O or timer, so a bounded flush reliably drains a
 * whole async chain (e.g. TradingRuntime.attemptCycle -> buildMarketDecisionContext ->
 * runMarketDecisionCycleWithLifecycle -> ...). */
export async function flushMicrotasks(rounds = 300): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}

export class ManualSchedulerClock implements SchedulerClock {
  private currentTimeMs: number;
  private pending: PendingTimer[] = [];
  private nextId = 0;

  constructor(initial: Date) {
    this.currentTimeMs = initial.getTime();
  }

  now(): Date {
    return new Date(this.currentTimeMs);
  }

  scheduleOnce(callback: () => void, delayMs: number): SchedulerTimerHandle {
    const id = (this.nextId += 1);
    const timer: PendingTimer = { id, fireAt: this.currentTimeMs + delayMs, callback };
    this.pending.push(timer);
    return {
      cancel: () => {
        this.pending = this.pending.filter((p) => p.id !== id);
      },
    };
  }

  /** How many timers are currently pending — useful for asserting stop() actually cancelled the
   * scheduler's timer. */
  pendingCount(): number {
    return this.pending.length;
  }

  /** Advances the clock by `ms`, firing every timer due at or before the new time, in fireAt order,
   * flushing microtasks after each fire so any async work it kicks off (e.g. an unawaited
   * `void this.attemptCycle(...)`) settles before the next timer (or the caller's next assertion)
   * runs. Firing a timer can itself schedule a new one (TradingScheduler self-reschedules) — this
   * loop only ever fires timers due within the original target time, never one newly scheduled
   * beyond it, so it always terminates. */
  async advance(ms: number): Promise<void> {
    const target = this.currentTimeMs + ms;
    for (;;) {
      const due = this.pending.filter((p) => p.fireAt <= target).sort((a, b) => a.fireAt - b.fireAt);
      const next = due[0];
      if (!next) break;
      this.pending = this.pending.filter((p) => p.id !== next.id);
      this.currentTimeMs = next.fireAt;
      next.callback();
      await flushMicrotasks();
    }
    this.currentTimeMs = target;
  }
}
