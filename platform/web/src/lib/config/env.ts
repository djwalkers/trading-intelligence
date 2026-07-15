// Build 1.13.0 — small, dependency-free parsing/validation primitives shared by client-config.ts
// and server-config.ts. Pure functions only (no process.env reads here) so they're trivially unit
// testable, and so this file is safe to import from either a client or server module.

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off"]);

export function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === "") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  throw new ConfigError(`Expected a boolean-like value ("true"/"false"/"1"/"0"), received "${raw}".`);
}

export function parseInteger(
  raw: string | undefined,
  fallback: number,
  options?: { min?: number },
): number {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new ConfigError(`Expected an integer, received "${raw}".`);
  }
  if (options?.min !== undefined && parsed < options.min) {
    throw new ConfigError(`Expected an integer >= ${options.min}, received ${parsed}.`);
  }
  return parsed;
}

// Same fail-loudly convention as parseBoolean/parseInteger — an unrecognised value is always a
// misconfiguration worth stopping on, never something to silently coerce to the fallback.
export function parseEnum<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  if (raw === undefined || raw === "") return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
  throw new ConfigError(`Expected one of ${allowed.join(", ")}, received "${raw}".`);
}

export function parseUrl(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  try {
    new URL(raw);
  } catch {
    throw new ConfigError(`Expected a valid URL, received "${raw}".`);
  }
  return raw;
}

interface NamedValue {
  name: string;
  value: string | undefined;
}

// Several pairs of variables in this app only make sense set together (e.g. a Supabase URL with
// no anon key, or vice versa, is always a mistake, never a valid partial configuration) — this
// catches that class of error at startup instead of the app quietly behaving as if Supabase were
// entirely unconfigured.
export function requirePairing(a: NamedValue, b: NamedValue): void {
  const aSet = Boolean(a.value);
  const bSet = Boolean(b.value);
  if (aSet !== bSet) {
    const missing = aSet ? b.name : a.name;
    const present = aSet ? a.name : b.name;
    throw new ConfigError(
      `${present} is set but ${missing} is not — both must be set together, or neither.`,
    );
  }
}
