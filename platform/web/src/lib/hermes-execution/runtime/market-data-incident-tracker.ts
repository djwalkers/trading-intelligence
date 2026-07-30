// Candle-gap production incident fix. In-process, never-persisted incident tracker for market-data
// degradation across the whole configured universe — mirrors OpposingSignalStabilityTracker's own
// "plain class held on TradingRuntime, reset on restart, no repository" convention exactly. Exists
// specifically to answer "should this cycle send a Telegram alert" without ever spamming one every
// single cycle a degraded condition persists, and without ever losing track of which instruments
// are currently affected across cycles.
//
// Deliberately separate from the per-cycle, per-instrument MARKET_DATA_DEGRADED/MARKET_DATA_RECOVERED
// audit events (trading-runtime.ts fires those unconditionally, every cycle, for full audit-trail
// completeness) — this tracker instead decides whether THIS cycle's overall state (across every
// instrument) should also produce a rate-limited MARKET_DATA_INCIDENT_ALERT/MARKET_DATA_INCIDENT_RECOVERED
// event, the two event types wired into Telegram.

export interface InstrumentDegradation {
  instrument: string;
  reason: string;
  firstDetectedAt: string;
}

export type MarketDataIncidentEvent =
  | { kind: "none" }
  | { kind: "new-incident"; affectedInstruments: InstrumentDegradation[] }
  | { kind: "reminder"; affectedInstruments: InstrumentDegradation[] }
  | { kind: "recovered"; recoveredInstruments: string[]; incidentDurationMs: number };

export interface InstrumentDegradationInput {
  instrument: string;
  degraded: boolean;
  reason?: string;
}

/** Default: don't remind more often than once every 30 minutes while a market-data incident
 * persists — frequent enough that an operator isn't left wondering if the runtime noticed, rare
 * enough that a multi-hour outage doesn't flood a Telegram chat with one message per 30s cycle. */
export const DEFAULT_MARKET_DATA_INCIDENT_REMINDER_INTERVAL_MS = 30 * 60_000;

export class MarketDataIncidentTracker {
  private readonly degraded = new Map<string, InstrumentDegradation>();
  private incidentStartedAt: string | undefined;
  private lastAlertSentAt: string | undefined;

  constructor(private readonly reminderIntervalMs: number = DEFAULT_MARKET_DATA_INCIDENT_REMINDER_INTERVAL_MS) {}

  /** Called once per cycle, after every configured instrument's own Phase A outcome is known this
   * cycle. Pure state update + a single decision about whether THIS cycle should also emit a
   * rate-limited incident-level event — never called per-instrument, never called more than once
   * per cycle. */
  recordCycleResult(now: Date, results: readonly InstrumentDegradationInput[]): MarketDataIncidentEvent {
    const previouslyDegraded = new Set(this.degraded.keys());
    const currentlyDegradedSet = new Set(results.filter((r) => r.degraded).map((r) => r.instrument));

    for (const result of results) {
      if (!result.degraded) continue;
      if (!this.degraded.has(result.instrument)) {
        this.degraded.set(result.instrument, {
          instrument: result.instrument,
          reason: result.reason ?? "unknown reason",
          firstDetectedAt: now.toISOString(),
        });
      } else {
        // Keep the reason current (a persisting incident may change shape cycle to cycle) without
        // resetting firstDetectedAt — the incident's own start time never moves once set.
        const existing = this.degraded.get(result.instrument)!;
        this.degraded.set(result.instrument, { ...existing, reason: result.reason ?? existing.reason });
      }
    }

    const recovered = [...previouslyDegraded].filter((instrument) => !currentlyDegradedSet.has(instrument));
    for (const instrument of recovered) this.degraded.delete(instrument);

    if (this.degraded.size === 0) {
      if (recovered.length === 0) return { kind: "none" };
      const incidentDurationMs = this.incidentStartedAt ? now.getTime() - Date.parse(this.incidentStartedAt) : 0;
      this.incidentStartedAt = undefined;
      this.lastAlertSentAt = undefined;
      return { kind: "recovered", recoveredInstruments: recovered, incidentDurationMs };
    }

    const affectedInstruments = [...this.degraded.values()];

    if (this.incidentStartedAt === undefined) {
      this.incidentStartedAt = now.toISOString();
      this.lastAlertSentAt = now.toISOString();
      return { kind: "new-incident", affectedInstruments };
    }

    const msSinceLastAlert = now.getTime() - Date.parse(this.lastAlertSentAt!);
    if (msSinceLastAlert >= this.reminderIntervalMs) {
      this.lastAlertSentAt = now.toISOString();
      return { kind: "reminder", affectedInstruments };
    }

    return { kind: "none" };
  }

  /** Test/diagnostic use only — the current set of degraded instruments this tracker believes are
   * still affected, independent of whether an alert has been sent for them. */
  currentlyDegradedInstruments(): string[] {
    return [...this.degraded.keys()];
  }
}
