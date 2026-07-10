import "server-only";
import { parseInteger, requirePairing, ConfigError } from "./env";

export interface ServerConfig {
  alphaVantageApiKey: string | undefined;
  isAlphaVantageConfigured: boolean;
  supabaseUrl: string | undefined;
  supabaseServiceRoleKey: string | undefined;
  isServiceRoleConfigured: boolean;
  workerPollIntervalMs: number;
}

interface RawServerEnv {
  ALPHA_VANTAGE_API_KEY: string | undefined;
  SUPABASE_SERVICE_ROLE_KEY: string | undefined;
  NEXT_PUBLIC_SUPABASE_URL: string | undefined;
  WORKER_POLL_INTERVAL_MS: string | undefined;
}

const DEFAULT_WORKER_POLL_INTERVAL_MS = 30_000;

// Server-only (see the "server-only" import above) — safe to read the full process.env
// dynamically here since none of these values are ever inlined into a client bundle; unlike
// client-config.ts there is no NEXT_PUBLIC_ static-replacement concern to preserve.
export function buildServerConfig(
  env: RawServerEnv = {
    ALPHA_VANTAGE_API_KEY: process.env.ALPHA_VANTAGE_API_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    WORKER_POLL_INTERVAL_MS: process.env.WORKER_POLL_INTERVAL_MS,
  },
): ServerConfig {
  const alphaVantageApiKey = env.ALPHA_VANTAGE_API_KEY || undefined;
  const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY || undefined;
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL || undefined;

  // A service-role key with no Supabase URL configured can never connect to anything — always a
  // mistake, not a valid partial state (mirrors client-config.ts's Supabase URL/anon-key pairing).
  requirePairing(
    { name: "SUPABASE_SERVICE_ROLE_KEY", value: supabaseServiceRoleKey },
    { name: "NEXT_PUBLIC_SUPABASE_URL (for the service-role client)", value: supabaseUrl },
  );

  const workerPollIntervalMs = parseInteger(env.WORKER_POLL_INTERVAL_MS, DEFAULT_WORKER_POLL_INTERVAL_MS, {
    min: 1000,
  });

  return {
    alphaVantageApiKey,
    isAlphaVantageConfigured: Boolean(alphaVantageApiKey),
    supabaseUrl,
    supabaseServiceRoleKey,
    isServiceRoleConfigured: Boolean(supabaseServiceRoleKey && supabaseUrl),
    workerPollIntervalMs,
  };
}

let cached: ServerConfig | null = null;
let cachedError: ConfigError | null = null;

export function getServerConfig(): ServerConfig {
  if (cachedError) throw cachedError;
  if (!cached) {
    try {
      cached = buildServerConfig();
    } catch (error) {
      if (error instanceof ConfigError) cachedError = error;
      throw error;
    }
  }
  return cached;
}
