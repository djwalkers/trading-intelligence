import { requirePairing, parseUrl, ConfigError } from "./env";

export interface ClientConfig {
  marketDataProviderName: string | undefined;
  marketDataApiKey: string | undefined;
  isExternalMarketDataConfigured: boolean;
  supabaseUrl: string | undefined;
  supabaseAnonKey: string | undefined;
  isSupabaseConfigured: boolean;
}

interface RawClientEnv {
  NEXT_PUBLIC_MARKET_DATA_PROVIDER: string | undefined;
  NEXT_PUBLIC_MARKET_DATA_API_KEY: string | undefined;
  NEXT_PUBLIC_SUPABASE_URL: string | undefined;
  NEXT_PUBLIC_SUPABASE_ANON_KEY: string | undefined;
}

// Next.js/Turbopack only inlines `process.env.NEXT_PUBLIC_*` into the client bundle when that
// exact member expression appears literally in code — it does not follow values through a
// generic parameter or destructure. Keeping these as literal reads here (rather than accepting an
// arbitrary `env` object throughout this module) is required for the client bundle to receive real
// values at all; `buildClientConfig()` below accepts an optional override purely for unit tests.
function readRealEnv(): RawClientEnv {
  return {
    NEXT_PUBLIC_MARKET_DATA_PROVIDER: process.env.NEXT_PUBLIC_MARKET_DATA_PROVIDER,
    NEXT_PUBLIC_MARKET_DATA_API_KEY: process.env.NEXT_PUBLIC_MARKET_DATA_API_KEY,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  };
}

// Neither market data nor Supabase is required to run this app — both are optional, gracefully
// degrading to sample data / local storage when unset. What IS invalid is a *half*-set pair (one
// variable present, its partner missing), which is always a configuration mistake rather than a
// legitimate "off" state, so that case throws a ConfigError instead of silently behaving as fully
// unconfigured.
export function buildClientConfig(env: RawClientEnv = readRealEnv()): ClientConfig {
  const marketDataProviderName = env.NEXT_PUBLIC_MARKET_DATA_PROVIDER || undefined;
  const marketDataApiKey = env.NEXT_PUBLIC_MARKET_DATA_API_KEY || undefined;
  requirePairing(
    { name: "NEXT_PUBLIC_MARKET_DATA_PROVIDER", value: marketDataProviderName },
    { name: "NEXT_PUBLIC_MARKET_DATA_API_KEY", value: marketDataApiKey },
  );

  const supabaseUrl = env.NEXT_PUBLIC_SUPABASE_URL || undefined;
  const supabaseAnonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY || undefined;
  requirePairing(
    { name: "NEXT_PUBLIC_SUPABASE_URL", value: supabaseUrl },
    { name: "NEXT_PUBLIC_SUPABASE_ANON_KEY", value: supabaseAnonKey },
  );
  if (supabaseUrl) parseUrl(supabaseUrl);

  return {
    marketDataProviderName,
    marketDataApiKey,
    isExternalMarketDataConfigured: Boolean(marketDataProviderName && marketDataApiKey),
    supabaseUrl,
    supabaseAnonKey,
    isSupabaseConfigured: Boolean(supabaseUrl && supabaseAnonKey),
  };
}

let cached: ClientConfig | null = null;
let cachedError: ConfigError | null = null;

// Validated once per module load (browser session or server render), not on every call —
// deliberately re-throws the same cached error on subsequent calls rather than re-running
// validation, so a misconfiguration is reported consistently everywhere it's read from.
export function getClientConfig(): ClientConfig {
  if (cachedError) throw cachedError;
  if (!cached) {
    try {
      cached = buildClientConfig();
    } catch (error) {
      if (error instanceof ConfigError) cachedError = error;
      throw error;
    }
  }
  return cached;
}
