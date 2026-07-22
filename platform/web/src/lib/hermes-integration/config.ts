import "server-only";
import { ConfigError } from "@/lib/config/env";

// Hermes Integration API v1. Same cached-singleton, fail-closed convention as
// hermes-execution/config.ts and lib/config/server-config.ts — reused directly (ConfigError),
// not reimplemented.
//
// Unlike HERMES_TELEGRAM_ENABLED or every other optional-but-paired feature in this codebase,
// there is no supported "on, but unauthenticated" state for this API: an absent
// HERMES_INTEGRATION_TOKEN means every /api/hermes/* request is rejected (see auth.ts), not that
// the API silently opens up. A token that IS set but too short/blank is always a config-build-time
// error — never silently accepted.

export interface HermesIntegrationConfig {
  token: string;
}

export interface RawHermesIntegrationEnv {
  HERMES_INTEGRATION_TOKEN: string | undefined;
}

export const MIN_HERMES_INTEGRATION_TOKEN_LENGTH = 32;

export function buildHermesIntegrationConfig(
  env: RawHermesIntegrationEnv = { HERMES_INTEGRATION_TOKEN: process.env.HERMES_INTEGRATION_TOKEN },
): HermesIntegrationConfig | null {
  const raw = env.HERMES_INTEGRATION_TOKEN;
  if (raw === undefined || raw.trim().length === 0) {
    return null;
  }
  if (raw.length < MIN_HERMES_INTEGRATION_TOKEN_LENGTH) {
    throw new ConfigError(
      `HERMES_INTEGRATION_TOKEN is set but only ${raw.length} character(s) long — it must be at ` +
        `least ${MIN_HERMES_INTEGRATION_TOKEN_LENGTH} characters to be accepted.`,
    );
  }
  return { token: raw };
}

let cached: HermesIntegrationConfig | null | undefined; // undefined = not yet computed this process
let cachedError: ConfigError | null = null;

/** Fails closed once and remembers it — matches getHermesExecutionConfig()/getServerConfig()'s own
 * "compute once, cache the ConfigError too" convention, so a misconfigured token fails every
 * request identically rather than re-parsing (and potentially re-throwing inconsistently) each
 * time. See instrumentation.ts for where this is also called once, proactively, at server start. */
export function getHermesIntegrationConfig(): HermesIntegrationConfig | null {
  if (cachedError) throw cachedError;
  if (cached === undefined) {
    try {
      cached = buildHermesIntegrationConfig();
    } catch (error) {
      if (error instanceof ConfigError) cachedError = error;
      throw error;
    }
  }
  return cached;
}

/** Test-only escape hatch — mirrors resetHermesExecutionConfigCacheForTests(). */
export function resetHermesIntegrationConfigCacheForTests(): void {
  cached = undefined;
  cachedError = null;
}
