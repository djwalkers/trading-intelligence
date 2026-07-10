export type AppErrorCode =
  | "CONFIGURATION_ERROR"
  | "PERSISTENCE_ERROR"
  | "MARKET_DATA_ERROR"
  | "AUTOMATION_ERROR"
  | "TRADE_EXECUTION_ERROR"
  | "UNKNOWN_ERROR";

interface AppErrorOptions {
  code: AppErrorCode;
  userMessage: string;
  diagnosticMessage: string;
  retryable: boolean;
  context?: Record<string, unknown>;
  cause?: unknown;
}

// A stable shape for turning any thrown value into something safe to log and safe to show a user.
// `userMessage` is plain-language and never includes exception internals; `diagnosticMessage` (and
// `cause`, the original error) are for logs only and must never be rendered in the UI or included
// in an API response body.
export class AppError extends Error {
  readonly code: AppErrorCode;
  readonly userMessage: string;
  readonly diagnosticMessage: string;
  readonly retryable: boolean;
  readonly context?: Record<string, unknown>;
  readonly cause?: unknown;

  constructor(options: AppErrorOptions) {
    super(options.diagnosticMessage);
    this.name = "AppError";
    this.code = options.code;
    this.userMessage = options.userMessage;
    this.diagnosticMessage = options.diagnosticMessage;
    this.retryable = options.retryable;
    this.context = options.context;
    this.cause = options.cause;
  }
}

const DEFAULT_USER_MESSAGES: Record<AppErrorCode, string> = {
  CONFIGURATION_ERROR: "This platform is misconfigured. Please contact whoever manages this deployment.",
  PERSISTENCE_ERROR: "Your changes may not be saved right now. They're still visible in this session.",
  MARKET_DATA_ERROR: "Live prices are temporarily unavailable — showing the most recent data available.",
  AUTOMATION_ERROR: "Automatic scanning couldn't be updated. Please try again.",
  TRADE_EXECUTION_ERROR: "This paper trade couldn't be completed. No trade was placed.",
  UNKNOWN_ERROR: "Something went wrong. Please try again.",
};

function extractMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Non-serializable error value";
  }
}

// Normalises any thrown value (an Error, a string, a Supabase error object, anything) into an
// AppError with a stable code and a safe user-facing message, without leaking the original
// exception's internals anywhere the UI or an API response could surface it. Already-normalised
// AppErrors pass through unchanged so this is safe to call defensively at every catch boundary.
export function toAppError(
  error: unknown,
  code: AppErrorCode = "UNKNOWN_ERROR",
  overrides?: { userMessage?: string; retryable?: boolean; context?: Record<string, unknown> },
): AppError {
  if (error instanceof AppError) return error;

  return new AppError({
    code,
    userMessage: overrides?.userMessage ?? DEFAULT_USER_MESSAGES[code],
    diagnosticMessage: extractMessage(error),
    retryable: overrides?.retryable ?? true,
    context: overrides?.context,
    cause: error,
  });
}
