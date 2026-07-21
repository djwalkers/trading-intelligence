import type { SchedulerClock, SchedulerTimerHandle } from "./scheduler-clock";

// Milestone 7 — 24/7 Scheduler & Runtime Control. Pure timer mechanics only — TradingScheduler
// knows nothing about trading, pause state, market hours, or overlap; it only knows "call onTick
// every intervalMs, starting either immediately or after the first interval." TradingRuntime
// supplies the tick handler and decides what a tick actually means (run a cycle, skip it, etc.) —
// see trading-runtime.ts. This split is what "introduce a scheduler abstraction rather than
// directly scattering setInterval calls" asks for: exactly one place owns a timer.
//
// Self-rescheduling via `clock.scheduleOnce`, not a single `setInterval` — the next tick is only
// scheduled once `onTick` (synchronously) returns, so a slow or overlapping-guarded tick handler
// can never cause two pending timers to stack up the way a raw `setInterval` could.

export interface TradingSchedulerOptions {
  clock: SchedulerClock;
  intervalMs: number;
  onTick: () => void;
  /** When true, the first tick fires as soon as start() is called (0ms delay) instead of waiting a
   * full intervalMs first. */
  immediateFirstRun: boolean;
}

export class TradingScheduler {
  private timer: SchedulerTimerHandle | null = null;
  private nextRunAt: Date | null = null;

  constructor(private readonly options: TradingSchedulerOptions) {}

  /** Idempotent-unsafe by design — TradingRuntime is the only caller and only ever calls this once
   * per RUNNING period (see its own state machine); calling start() twice without an intervening
   * stop() would leak the first timer, so this class trusts its one caller rather than guarding
   * against a misuse it never itself produces. */
  start(): void {
    const delay = this.options.immediateFirstRun ? 0 : this.options.intervalMs;
    this.scheduleNext(delay);
  }

  stop(): void {
    this.timer?.cancel();
    this.timer = null;
    this.nextRunAt = null;
  }

  getNextRunAt(): Date | null {
    return this.nextRunAt;
  }

  private scheduleNext(delayMs: number): void {
    this.nextRunAt = new Date(this.options.clock.now().getTime() + delayMs);
    this.timer = this.options.clock.scheduleOnce(() => this.fire(), delayMs);
  }

  private fire(): void {
    this.options.onTick();
    // Reschedules unconditionally after every tick, including a tick that threw synchronously (it
    // shouldn't — TradingRuntime's onTick handler never throws, see its own doc comment) — a
    // scheduler that could silently stop ticking after one bad tick would be a worse failure mode
    // than a tick that (incorrectly) throws being retried on schedule.
    this.scheduleNext(this.options.intervalMs);
  }
}
