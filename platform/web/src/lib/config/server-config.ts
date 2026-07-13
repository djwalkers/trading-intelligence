import "server-only";
import { parseBoolean, parseInteger, requirePairing, ConfigError } from "./env";

export interface ServerConfig {
  alphaVantageApiKey: string | undefined;
  isAlphaVantageConfigured: boolean;
  supabaseUrl: string | undefined;
  supabaseServiceRoleKey: string | undefined;
  isServiceRoleConfigured: boolean;
  workerPollIntervalMs: number;
  // Market Universe (Phase 2A) price-eligibility checks reuse the same Finnhub key the browser
  // already uses for live quotes (NEXT_PUBLIC_MARKET_DATA_PROVIDER/_API_KEY are confirmed
  // client-exposed already, so reading them server-side here introduces no new secret) — read
  // through this central config rather than a one-off process.env access in market-universe.
  finnhubProviderName: string | undefined;
  finnhubApiKey: string | undefined;
  isFinnhubConfigured: boolean;
  // Default false/absent — the worker's actual traded instrument list is always src/lib/mock's
  // static 5-symbol list in Phase 2A, regardless of this flag (see process-schedule.ts). When
  // true, the worker additionally logs a Market Universe observability summary once per scan
  // cycle; it never changes what gets traded. See docs/product/PHASE-2A-MARKET-UNIVERSE.md.
  isMarketUniverseWorkerObservabilityEnabled: boolean;
}

interface RawServerEnv {
  ALPHA_VANTAGE_API_KEY: string | undefined;
  SUPABASE_SERVICE_ROLE_KEY: string | undefined;
  NEXT_PUBLIC_SUPABASE_URL: string | undefined;
  WORKER_POLL_INTERVAL_MS: string | undefined;
  NEXT_PUBLIC_MARKET_DATA_PROVIDER: string | undefined;
  NEXT_PUBLIC_MARKET_DATA_API_KEY: string | undefined;
  MARKET_UNIVERSE_WORKER_ENABLED: string | undefined;
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
    NEXT_PUBLIC_MARKET_DATA_PROVIDER: process.env.NEXT_PUBLIC_MARKET_DATA_PROVIDER,
    NEXT_PUBLIC_MARKET_DATA_API_KEY: process.env.NEXT_PUBLIC_MARKET_DATA_API_KEY,
    MARKET_UNIVERSE_WORKER_ENABLED: process.env.MARKET_UNIVERSE_WORKER_ENABLED,
  },
): ServerConfig {
  const alphaVantageApiKey = env.ALPHA_VANTAGE_API_KEY || undefined;
  const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY || undefined;
  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL || undefined;
  const finnhubProviderName = env.NEXT_PUBLIC_MARKET_DATA_PROVIDER || undefined;
  const finnhubApiKey = env.NEXT_PUBLIC_MARKET_DATA_API_KEY || undefined;
  const isMarketUniverseWorkerObservabilityEnabled = parseBoolean(
    env.MARKET_UNIVERSE_WORKER_ENABLED,
    false,
  );

  // A service-role key with no Supabase URL configured can never connect to anything — always a
  // mistake, not a valid partial state (mirrors client-config.ts's Supabase URL/anon-key pairing).
  requirePairing(
    { name: "SUPABASE_SERVICE_ROLE_KEY", value: supabaseServiceRoleKey },
    { name: "NEXT_PUBLIC_SUPABASE_URL (for the service-role client)", value: supabaseUrl },
  );
  requirePairing(
    { name: "NEXT_PUBLIC_MARKET_DATA_PROVIDER", value: finnhubProviderName },
    { name: "NEXT_PUBLIC_MARKET_DATA_API_KEY", value: finnhubApiKey },
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
    finnhubProviderName,
    finnhubApiKey,
    isFinnhubConfigured: Boolean(finnhubProviderName && finnhubApiKey),
    isMarketUniverseWorkerObservabilityEnabled,
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
