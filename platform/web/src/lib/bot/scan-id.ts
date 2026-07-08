const SCAN_ID_COUNTER_KEY = "trading-intelligence.bot-scan-counter.v1";

// A simple, local, monotonically-increasing counter — not a database sequence, and deliberately
// not folded into BotDecisionLogProvider's React state, since it's read and written synchronously
// at call time (always from a click handler, never during render or an effect body), so no state
// or effect is involved at all.
export function reserveScanId(): string {
  if (typeof window === "undefined") return "SCAN-000001";

  let counter = 0;
  try {
    counter = Number(window.localStorage.getItem(SCAN_ID_COUNTER_KEY)) || 0;
  } catch {
    counter = 0;
  }

  counter += 1;

  try {
    window.localStorage.setItem(SCAN_ID_COUNTER_KEY, String(counter));
  } catch {
    // Storage unavailable — the id still increments for this call, just won't persist.
  }

  return `SCAN-${String(counter).padStart(6, "0")}`;
}
