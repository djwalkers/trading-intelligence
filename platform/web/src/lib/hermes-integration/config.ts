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
//
// Split-deployment fix. The Trading Intelligence frontend and the Hermes runtime (which owns
// /api/hermes/*) can now run on entirely different hosts (frontend on Vercel, Hermes on a VPS) —
// dashboard-proxy.ts can therefore no longer assume /api/hermes/* lives on the SAME origin as the
// request it is handling. HERMES_INTEGRATION_BASE_URL is the explicit remote origin to call
// instead, and is now REQUIRED together with the token — same "no half-configured pair" philosophy
// this file already applies to the token alone. Both absent means the feature is genuinely off
// (existing behaviour, unchanged); either one present without the other is always a config-build-
// time error, never a silent same-origin fallback (that fallback is exactly the bug this fixes).

export interface HermesIntegrationConfig {
  token: string;
  /** Normalised (trailing slash stripped) absolute URL `/api/hermes/*` is called against — see
   * dashboard-proxy.ts, which appends its own literal "/api/hermes/<path>" after this. Always
   * `http:`/`https:`; `https:` is enforced for anything other than a loopback host
   * (localhost/127.0.0.1/::1) — see buildHermesIntegrationConfig's own validation. */
  baseUrl: string;
}

export interface RawHermesIntegrationEnv {
  HERMES_INTEGRATION_TOKEN: string | undefined;
  HERMES_INTEGRATION_BASE_URL: string | undefined;
}

export const MIN_HERMES_INTEGRATION_TOKEN_LENGTH = 32;

// Loopback hostnames only — never NODE_ENV-based. The actual risk this guards against (a bearer
// token crossing a real network in cleartext) depends entirely on WHERE the traffic goes, not on
// which mode this process happens to be running in: a genuinely local VPS same-host deployment
// (http://127.0.0.1:PORT) is safe regardless of NODE_ENV, and a real remote host is never safe over
// plain http regardless of NODE_ENV either.
// Node's URL parser reports an IPv6 literal's hostname WITH its brackets (`new
// URL("http://[::1]:3000").hostname === "[::1]"`, confirmed) — included here in that exact form,
// never the bare "::1", which would never actually match.
const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Strips only trailing slashes — a configured value with or without one must resolve to the exact
 * same upstream URL, never a double slash (".../  /api/hermes/...") or a missing one. */
function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

export function buildHermesIntegrationConfig(
  env: RawHermesIntegrationEnv = {
    HERMES_INTEGRATION_TOKEN: process.env.HERMES_INTEGRATION_TOKEN,
    HERMES_INTEGRATION_BASE_URL: process.env.HERMES_INTEGRATION_BASE_URL,
  },
): HermesIntegrationConfig | null {
  const rawToken = env.HERMES_INTEGRATION_TOKEN;
  const rawBaseUrl = env.HERMES_INTEGRATION_BASE_URL;
  const tokenSet = rawToken !== undefined && rawToken.trim().length > 0;
  const baseUrlSet = rawBaseUrl !== undefined && rawBaseUrl.trim().length > 0;

  if (!tokenSet && !baseUrlSet) {
    return null;
  }
  if (!baseUrlSet) {
    throw new ConfigError(
      "HERMES_INTEGRATION_TOKEN is set but HERMES_INTEGRATION_BASE_URL is not — both are required " +
        "together now that the frontend and the Hermes runtime may run on different hosts (the " +
        "dashboard proxy can no longer assume /api/hermes/* is on the same host as the request).",
    );
  }
  if (!tokenSet) {
    throw new ConfigError("HERMES_INTEGRATION_BASE_URL is set but HERMES_INTEGRATION_TOKEN is not — both are required together.");
  }

  if (rawToken!.length < MIN_HERMES_INTEGRATION_TOKEN_LENGTH) {
    throw new ConfigError(
      `HERMES_INTEGRATION_TOKEN is set but only ${rawToken!.length} character(s) long — it must be at ` +
        `least ${MIN_HERMES_INTEGRATION_TOKEN_LENGTH} characters to be accepted.`,
    );
  }

  const normalizedBaseUrl = normalizeBaseUrl(rawBaseUrl!);
  if (normalizedBaseUrl.length === 0) {
    throw new ConfigError("HERMES_INTEGRATION_BASE_URL is set but blank (or whitespace-only).");
  }

  let parsed: URL;
  try {
    parsed = new URL(normalizedBaseUrl);
  } catch {
    throw new ConfigError(`HERMES_INTEGRATION_BASE_URL is not a valid absolute URL: "${rawBaseUrl}".`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError(
      `HERMES_INTEGRATION_BASE_URL must use http:// or https://, received "${parsed.protocol}" ("${rawBaseUrl}").`,
    );
  }
  const isLocal = LOCAL_HOSTNAMES.has(parsed.hostname);
  if (!isLocal && parsed.protocol !== "https:") {
    throw new ConfigError(
      `HERMES_INTEGRATION_BASE_URL ("${rawBaseUrl}") must use https:// — plain http:// is only ` +
        `permitted for localhost/127.0.0.1/::1. A bearer token must never cross a real network in cleartext.`,
    );
  }
  // The full normalized value (never reduced to parsed.origin) is kept — a reverse-proxied
  // deployment may legitimately configure a path prefix (e.g. "https://vps.example.com/hermes"),
  // and dashboard-proxy.ts always appends its own literal "/api/hermes/<path>" after this.
  return { token: rawToken!, baseUrl: normalizedBaseUrl };
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
