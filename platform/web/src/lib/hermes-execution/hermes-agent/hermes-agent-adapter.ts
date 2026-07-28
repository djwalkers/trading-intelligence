import type { HermesCliRunner } from "./hermes-cli-runner";
import { validateHermesUniverseResponse } from "./validate-hermes-response";
import { buildHermesCliEnv, buildHermesNeutralCwd, buildHermesOneshotArgs } from "./build-hermes-cli-isolation";
import type { HermesUniverseDecisionResult, HermesUniverseInput } from "./types";
import { HERMES_ALLOWED_ACTIONS, HERMES_VALIDATION_LIMITS } from "./types";

// Prototype 1.0 — official Hermes Agent decision integration. THE only module that ever invokes
// the official Hermes Agent CLI — one call per market-universe scan, never one call per
// instrument (see runtime/universe-scanner.ts, this adapter's one caller). Uses the CONFIRMED,
// exact one-shot invocation method, hardened for isolation (verified live against the installed
// CLI's own --help, read-only, no inference call — see build-hermes-cli-isolation.ts's own
// top-of-file comment for the exact confirmed text):
//
//     <cliPath> --safe-mode --oneshot=<prompt>
//
// `--safe-mode` is the officially-documented control that disables ALL customizations — user
// config, AGENTS.md/memory injection, plugins, and MCP servers — for exactly this reason: a
// trading-decision call must never run as an unrestricted operational agent capable of executing
// tools, reading this repository's own AGENTS.md, or reaching an MCP server. `--oneshot=<prompt>`
// (the long-form `--flag=value` join, never a bare `-z <prompt>` two-token pair) is what makes
// prompt content structurally incapable of being parsed as a separate CLI flag, regardless of
// what the market/portfolio text embedded in it happens to contain. The subprocess is spawned
// without a shell, in a neutral (non-repository) working directory, with a minimal allow-listed
// environment — never this application's own `process.cwd()`/`process.env` (see
// hermes-cli-runner.ts and build-hermes-cli-isolation.ts). No other invocation method is
// implemented — never falls back to `hermes chat`, an MCP call, or any other surface. Never calls
// a broker, never sends a Telegram message, never throws past its own boundary: every failure mode
// (a CLI invocation failure, malformed output, a validation violation) is a normal, typed
// `{ ok: false }` return value — the caller's own contract is "fail closed means no executable
// proposal," never a crashed scan. Every byte of stdout is treated as untrusted text — see
// validate-hermes-response.ts, the only place it is ever parsed or trusted.

export interface HermesAgentAdapterConfig {
  cliPath: string;
  decisionTimeoutMs: number;
  maxStdoutBytes: number;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Builds the single prompt sent to Hermes for this scan — the structured input as JSON, plus an
 * explicit, tightly-constrained instruction set describing exactly the response schema required.
 * Deliberately restates every hard constraint in plain language (never trusts the schema alone to
 * be self-explanatory to the model) — the adapter still runtime-validates the response regardless
 * of what this prompt asks for; this is a strong hint, never the enforcement mechanism itself. */
export function buildHermesUniversePrompt(input: HermesUniverseInput): string {
  const schemaDescription = [
    "Respond with ONLY a single JSON object, no prose before or after it, matching exactly this shape:",
    '{"proposals":[{"instrument":"ETH","action":"BUY","confidence":0.82,"reasoning":["short reason 1","short reason 2"],"suggestedStopLossPercent":2,"suggestedTakeProfitPercent":4}]}',
    "",
    "Strict rules:",
    `- "instrument" must be exactly one of the configured universe: ${input.universe.join(", ")}.`,
    `- "action" must be exactly one of: ${HERMES_ALLOWED_ACTIONS.join(", ")}.`,
    `- "confidence" must be a number between ${HERMES_VALIDATION_LIMITS.minConfidence} and ${HERMES_VALIDATION_LIMITS.maxConfidence}.`,
    `- "reasoning" must be an array of at most ${HERMES_VALIDATION_LIMITS.maxReasoningItems} short strings (each under ${HERMES_VALIDATION_LIMITS.maxReasoningItemLength} characters).`,
    `- "suggestedStopLossPercent" (optional) must be a positive number no greater than ${HERMES_VALIDATION_LIMITS.maxStopLossPercent}.`,
    `- "suggestedTakeProfitPercent" (optional) must be a positive number no greater than ${HERMES_VALIDATION_LIMITS.maxTakeProfitPercent}.`,
    "- Include at most one proposal per instrument — never propose the same instrument twice.",
    "- Only propose BUY/SELL for instruments where marketHoursEligible is true and unavailableReason is absent.",
    "- Do NOT include position size, quantity, notional amount, leverage, broker choice, order instructions, or any field not listed above — this application ignores or rejects them, and they will never be acted on.",
    "- Do not include any text outside the single JSON object.",
  ].join("\n");

  return [
    "You are providing a trading opportunity analysis for a demo/virtual paper-trading account. " +
      "You are NOT executing any trade yourself — you are only proposing ranked candidates for a " +
      "separate, deterministic risk and execution system to review.",
    "",
    "Structured market and portfolio context for this scan (JSON):",
    JSON.stringify(input),
    "",
    schemaDescription,
  ].join("\n");
}

/**
 * Runs exactly one Hermes Agent one-shot call for this universe scan and returns validated,
 * ranked-eligible proposals (or a fail-closed result). Never calls the broker, never sends a
 * Telegram message, never retries — a single bounded attempt per scan.
 */
export async function proposeUniverse(
  input: HermesUniverseInput,
  config: HermesAgentAdapterConfig,
  runner: HermesCliRunner,
): Promise<HermesUniverseDecisionResult> {
  const prompt = buildHermesUniversePrompt(input);

  let runResult;
  try {
    runResult = await runner.run(config.cliPath, buildHermesOneshotArgs(prompt), {
      timeoutMs: config.decisionTimeoutMs,
      maxStdoutBytes: config.maxStdoutBytes,
      cwd: buildHermesNeutralCwd(),
      env: buildHermesCliEnv(),
    });
  } catch (error) {
    // Defence in depth only — HermesCliRunner's own contract is "never throws," but the adapter
    // must still fail closed rather than propagate an unexpected exception if that contract is
    // ever violated by a future implementation.
    return { ok: false, stage: "invocation", reason: `Unexpected error invoking the Hermes CLI: ${toErrorMessage(error)}` };
  }

  if (!runResult.ok) {
    switch (runResult.reason) {
      case "timeout":
        return { ok: false, stage: "invocation", reason: `Hermes CLI call timed out after ${config.decisionTimeoutMs}ms.` };
      case "non-zero-exit":
        return {
          ok: false,
          stage: "invocation",
          reason: `Hermes CLI exited with code ${runResult.exitCode}. stderr: ${runResult.stderrExcerpt}`,
        };
      case "oversized-stdout":
        return {
          ok: false,
          stage: "invocation",
          reason: `Hermes CLI produced more than the configured maximum of ${config.maxStdoutBytes} stdout bytes.`,
        };
      case "spawn-error":
        return { ok: false, stage: "invocation", reason: `Could not start the Hermes CLI: ${runResult.message}` };
    }
  }

  return validateHermesUniverseResponse(runResult.stdout, input.universe);
}
