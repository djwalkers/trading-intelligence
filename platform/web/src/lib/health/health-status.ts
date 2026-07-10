// Build 1.13.0 — a small, consistent status vocabulary used across the health endpoint and any
// UI that surfaces operational status. Exact meaning of each level:
//
// - "healthy": the subsystem is configured (or deliberately unconfigured with a working fallback)
//   and there is no known problem with it.
// - "degraded": the subsystem is configured, but incompletely or inconsistently — it will likely
//   misbehave until fixed (e.g. one half of a required variable pair is set, the other missing).
// - "unavailable": the subsystem cannot function at all right now.
// - "unknown": this process has no reliable way to determine the subsystem's real state (e.g.
//   whether the separate VPS worker process is actually running) — never reported as "healthy"
//   merely because nothing is known to be wrong.
export type HealthStatus = "healthy" | "degraded" | "unavailable" | "unknown";
