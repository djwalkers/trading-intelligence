// Build 1.12.0 — a pure presentation rollup, not a new business/trading calculation: it just
// counts how many of the already-tracked status flags this app computes elsewhere (database
// connectivity, market data, historical data, AI decision history, VPS worker) are currently
// reporting a problem, the same way the very first Dashboard already did with its one-line
// "N of M services running" figure. Nothing here decides whether a trade is safe to place.
export interface PlatformHealthCheck {
  label: string;
  healthy: boolean;
  detail: string | null;
}

export interface PlatformHealthSummary {
  healthPercent: number;
  healthyCount: number;
  totalCount: number;
  issues: PlatformHealthCheck[];
}

export function summarizePlatformHealth(checks: PlatformHealthCheck[]): PlatformHealthSummary {
  const healthyCount = checks.filter((check) => check.healthy).length;
  const totalCount = checks.length;
  const healthPercent = totalCount === 0 ? 100 : Math.round((healthyCount / totalCount) * 100);
  const issues = checks.filter((check) => !check.healthy);

  return { healthPercent, healthyCount, totalCount, issues };
}
