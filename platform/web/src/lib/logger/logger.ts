import { APP_VERSION } from "@/lib/version";

export type LogLevel = "debug" | "info" | "warn" | "error";

// Deliberately loose beyond the named fields — callers may attach any additional safe,
// non-sensitive context. Never put credentials, tokens, raw storage payloads, or full personal/
// financial records in here (see docs/product/BUILD-1.13.0.md, "Logging approach").
export interface LogContext {
  component?: string;
  scanId?: string;
  triggerType?: string;
  instrument?: string;
  strategyId?: string;
  outcome?: string;
  errorCode?: string;
  [key: string]: unknown;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

// Usable from both client and server code (plain console calls, no server-only import) — the
// existing bracket-tagged `console.error("[persistence] ...")` convention already in this codebase
// is preserved and formalised here as `context.component`, rather than replaced with something
// unrecognisable. Development output stays verbose (one call per field, easy to read in a
// terminal); production output collapses to a single-line JSON string per entry (easy to grep or
// feed to a log aggregator) and drops "debug" entirely to reduce noise.
export function log(level: LogLevel, message: string, context: LogContext = {}): void {
  if (level === "debug" && isProduction()) return;

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    version: APP_VERSION,
    ...context,
  };

  const consoleMethod = level === "debug" ? console.debug : level === "info" ? console.info : level === "warn" ? console.warn : console.error;

  if (isProduction()) {
    consoleMethod(JSON.stringify(entry));
  } else {
    const tag = context.component ? `[${context.component}]` : "";
    consoleMethod(`${tag} ${message}`.trim(), context);
  }
}

export const logger = {
  debug: (message: string, context?: LogContext) => log("debug", message, context),
  info: (message: string, context?: LogContext) => log("info", message, context),
  warn: (message: string, context?: LogContext) => log("warn", message, context),
  error: (message: string, context?: LogContext) => log("error", message, context),
};
