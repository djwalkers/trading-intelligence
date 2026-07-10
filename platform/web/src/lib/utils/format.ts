export function formatCurrencyGBP(value: number): string {
  return new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatCurrencyUSD(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatPercent(value: number, options?: { showSign?: boolean }): string {
  const showSign = options?.showSign ?? true;
  const sign = showSign && value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export function formatSignedNumber(value: number, fractionDigits = 2): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(fractionDigits)}`;
}

export function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

export function formatDateTime(isoString: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(isoString));
}

// Build 1.12.1 — scan ids are internal identifiers (a browser-local counter like "SCAN-000001", or
// a server process-namespaced one like "WORKER-83691-000042") that should never surface their raw
// form to a first-time user — the worker-style id in particular exposes an OS process id, exactly
// the kind of implementation detail this build's terminology audit flags. This extracts the
// trailing sequence number and presents it as a plain "Scan #N", regardless of which system
// produced it — the underlying stored value is unchanged, only how it's displayed.
export function formatScanId(scanId: string): string {
  const match = scanId.match(/(\d+)$/);
  const digits = match?.[1];
  if (!digits) return scanId;
  return `Scan #${parseInt(digits, 10)}`;
}

export function formatRelativeTime(isoString: string): string {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const diffMinutes = Math.round(diffMs / 60_000);

  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;

  const diffDays = Math.round(diffHours / 24);
  return `${diffDays}d ago`;
}
