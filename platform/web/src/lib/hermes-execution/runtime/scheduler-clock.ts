// Milestone 7 — 24/7 Scheduler & Runtime Control. The one seam between "when things fire" and real
// wall-clock time/timers — TradingScheduler and TradingRuntime depend only on this interface, never
// on `Date`/`setTimeout` directly, so tests drive them with a synchronous fake instead of real
// waiting (see tests/hermes-execution/runtime/support/manual-scheduler-clock.ts).

export interface SchedulerTimerHandle {
  cancel(): void;
}

export interface SchedulerClock {
  now(): Date;
  /** Schedules `callback` to run exactly once, after `delayMs`. Returns a handle that cancels it if
   * it hasn't fired yet — never fires more than once per call. */
  scheduleOnce(callback: () => void, delayMs: number): SchedulerTimerHandle;
}

/** The real clock — wraps `Date`/`setTimeout`/`clearTimeout` directly. The only SchedulerClock
 * implementation this milestone ships for production use; a later VPS deployment could swap in a
 * different one (e.g. one that survives process restarts) without touching TradingScheduler or
 * TradingRuntime. */
export class SystemSchedulerClock implements SchedulerClock {
  now(): Date {
    return new Date();
  }

  scheduleOnce(callback: () => void, delayMs: number): SchedulerTimerHandle {
    const handle = setTimeout(callback, delayMs);
    return { cancel: () => clearTimeout(handle) };
  }
}
