import "server-only";
import { getClientConfig } from "@/lib/config/client-config";
import { ConfigError } from "@/lib/config/env";
import { APP_VERSION } from "@/lib/version";
import type { HealthStatus } from "./health-status";

export interface ServiceHealth {
  application: HealthStatus;
  persistence: HealthStatus;
  marketData: HealthStatus;
  automation: HealthStatus;
}

export interface ApplicationHealth {
  status: HealthStatus;
  version: string;
  timestamp: string;
  services: ServiceHealth;
  // Whether this deployment is using a live external market data provider or built-in sample
  // data — a deployment-wide fact, unlike scan mode (Manual/Automatic), which is per-user/
  // per-browser and already shown in the Operations Centre rather than here.
  dataMode: "Live" | "Sample data";
  configurationIssue?: string;
}

// Build 1.13.0 — assembles the health endpoint's response from information this process can
// genuinely determine. Deliberately does NOT attempt a live network call to Supabase or the
// market data provider: a config-presence check is fast, safe for frequent polling, and can never
// itself cause a trading action or mutate state — the honest tradeoff is that this reports
// "configured", not "definitely reachable right now." `automation` is always "unknown" for the
// same reason src/components/system-health/VPSWorkerStatusPanel.tsx already discloses: this Next.js
// process has no live channel to the separate VPS worker process, so claiming to know its health
// would be fabricated, not measured.
export function getApplicationHealth(): ApplicationHealth {
  const services: ServiceHealth = {
    application: "healthy",
    persistence: "healthy",
    marketData: "healthy",
    automation: "unknown",
  };

  let dataMode: "Live" | "Sample data" = "Sample data";
  let configurationIssue: string | undefined;

  try {
    const clientConfig = getClientConfig();
    dataMode = clientConfig.isExternalMarketDataConfigured ? "Live" : "Sample data";
    // Both "Supabase configured" and "not configured" (local-storage mode) are fully healthy,
    // functioning states for this app — only a half-configured pairing is a real problem, and
    // getClientConfig() already throws ConfigError for that case, caught below.
  } catch (error) {
    if (error instanceof ConfigError) {
      services.persistence = "degraded";
      services.marketData = "degraded";
      configurationIssue = error.message;
    }
  }

  const overall: HealthStatus = Object.values(services).some((value) => value === "unavailable")
    ? "unavailable"
    : Object.values(services).some((value) => value === "degraded")
      ? "degraded"
      : "healthy";

  return {
    status: overall,
    version: APP_VERSION,
    timestamp: new Date().toISOString(),
    services,
    dataMode,
    configurationIssue,
  };
}
