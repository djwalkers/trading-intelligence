import "server-only";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { logger } from "@/lib/logger/logger";
import type { RawRegistryStrategy, RegistryLoadResult, RegistryRejection } from "./types";

// This phase's own, independent understanding of the Hermes strategy-registry schema — no code
// or dependency is shared with Hermes Lab's Python services/. If that schema's contract changes,
// this file's SUPPORTED_STRATEGY_SCHEMA_VERSIONS / validateRawStrategy are what need updating,
// not the other way around.
export const SUPPORTED_STRATEGY_SCHEMA_VERSIONS = ["1.0.0"];

const STRATEGY_ID_PATTERN = /^STRAT-\d{4}$/;
const VALID_STATUSES = ["active", "retired", "superseded"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural validation only (required fields present, basic types/enums correct) — deliberately
 * not a full JSON Schema implementation, matching this phase's "minimal dependencies" mandate.
 * Returns a human-readable rejection reason, or undefined if the document is well-formed. */
export function validateRawStrategy(raw: unknown): string | undefined {
  if (!isPlainObject(raw)) return "Document is not a JSON object";

  const requiredTopLevel: Array<keyof RawRegistryStrategy> = [
    "schemaVersion",
    "strategyId",
    "version",
    "status",
    "sourceHypothesisId",
    "supportingResearchRuns",
    "promotionStatus",
    "supportedMarkets",
    "timeframe",
    "entryDefinition",
    "exitDefinition",
    "riskDefinition",
    "confidence",
    "createdAt",
    "lastReviewedAt",
  ];
  const missing = requiredTopLevel.filter((field) => !(field in raw));
  if (missing.length > 0) return `Missing required field(s): ${missing.join(", ")}`;

  if (typeof raw.schemaVersion !== "string") return "schemaVersion must be a string";
  if (typeof raw.strategyId !== "string" || !STRATEGY_ID_PATTERN.test(raw.strategyId)) {
    return `strategyId must match ${STRATEGY_ID_PATTERN} (got ${JSON.stringify(raw.strategyId)})`;
  }
  if (typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) {
    return "version must be a positive integer";
  }
  if (typeof raw.status !== "string" || !VALID_STATUSES.includes(raw.status)) {
    return `status must be one of ${VALID_STATUSES.join(", ")}`;
  }
  if (typeof raw.sourceHypothesisId !== "string") return "sourceHypothesisId must be a string";
  if (!Array.isArray(raw.supportingResearchRuns)) return "supportingResearchRuns must be an array";
  if (!isPlainObject(raw.promotionStatus) || typeof raw.promotionStatus.decision !== "string") {
    return "promotionStatus must be an object with a string decision";
  }
  if (!Array.isArray(raw.supportedMarkets) || raw.supportedMarkets.length === 0) {
    return "supportedMarkets must be a non-empty array";
  }
  if (typeof raw.timeframe !== "string") return "timeframe must be a string";
  if (!isPlainObject(raw.entryDefinition) || typeof raw.entryDefinition.rule !== "string") {
    return "entryDefinition must be an object with a string rule";
  }
  if (!isPlainObject(raw.exitDefinition) || typeof raw.exitDefinition.rule !== "string") {
    return "exitDefinition must be an object with a string rule";
  }
  if (!isPlainObject(raw.riskDefinition)) return "riskDefinition must be an object";
  if (!isPlainObject(raw.confidence) || typeof raw.confidence.level !== "string") {
    return "confidence must be an object with a string level";
  }

  return undefined;
}

export interface RegistryClient {
  /** True only if the configured path exists and looks like a strategy registry (has a
   * strategies/ directory) — false covers both "not configured" and "path doesn't exist". */
  isConnected(): Promise<boolean>;
  /** Every currently-active, schema-valid, de-duplicated strategy document. An empty array (with
   * no rejections) is a valid, expected result — not an error. */
  listActiveStrategies(): Promise<RegistryLoadResult>;
}

/**
 * Reads strategy documents directly from a Hermes Lab strategy-registry/ directory on disk.
 * Read-only: no file under the registry is ever written, moved, or deleted by this client.
 *
 * This is the one piece of the pipeline this phase expects to be replaced later (per the
 * "easy replacement of temporary components" mandate) — any future consumer only needs to
 * implement RegistryClient's two methods; nothing downstream depends on the filesystem.
 */
export class FileSystemRegistryClient implements RegistryClient {
  constructor(private readonly registryPath: string) {}

  private strategiesDir(): string {
    return path.join(this.registryPath, "strategies");
  }

  async isConnected(): Promise<boolean> {
    try {
      const stat = await fs.stat(this.strategiesDir());
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  async listActiveStrategies(): Promise<RegistryLoadResult> {
    const rejected: RegistryRejection[] = [];
    let filenames: string[];

    try {
      filenames = (await fs.readdir(this.strategiesDir())).filter((f) => f.endsWith(".json"));
    } catch {
      // Missing strategies/ directory (or missing registry path entirely) is treated as a valid
      // empty registry, not a crash — isConnected() is the correct way to distinguish "empty" from
      // "misconfigured/unreachable" for anything that needs to tell those apart.
      logger.warn("Hermes Strategy Registry strategies/ directory was not found; treating as empty", {
        component: "hermes-execution",
        registryPath: this.registryPath,
      });
      return { strategies: [], rejected: [] };
    }

    const seenIds = new Map<string, string>();
    const strategies: RawRegistryStrategy[] = [];

    for (const filename of [...filenames].sort()) {
      const filePath = path.join(this.strategiesDir(), filename);

      let parsed: unknown;
      try {
        const text = await fs.readFile(filePath, "utf-8");
        parsed = JSON.parse(text);
      } catch (error) {
        const reason = `Could not read/parse as JSON: ${(error as Error).message}`;
        rejected.push({ source: filename, reason });
        logger.warn("Hermes Strategy Registry document rejected", {
          component: "hermes-execution",
          source: filename,
          reason,
        });
        continue;
      }

      const validationError = validateRawStrategy(parsed);
      if (validationError) {
        rejected.push({ source: filename, reason: validationError });
        logger.warn("Hermes Strategy Registry document rejected", {
          component: "hermes-execution",
          source: filename,
          reason: validationError,
        });
        continue;
      }

      const doc = parsed as RawRegistryStrategy;

      if (!SUPPORTED_STRATEGY_SCHEMA_VERSIONS.includes(doc.schemaVersion)) {
        const reason = `Unsupported schemaVersion "${doc.schemaVersion}" (this reader supports: ${SUPPORTED_STRATEGY_SCHEMA_VERSIONS.join(", ")})`;
        rejected.push({ source: filename, reason });
        logger.warn("Hermes Strategy Registry document rejected", {
          component: "hermes-execution",
          source: filename,
          strategyId: doc.strategyId,
          reason,
        });
        continue;
      }

      if (seenIds.has(doc.strategyId)) {
        const reason = `Duplicate strategyId "${doc.strategyId}" (already loaded from ${seenIds.get(doc.strategyId)})`;
        rejected.push({ source: filename, reason });
        logger.warn("Hermes Strategy Registry document rejected", {
          component: "hermes-execution",
          source: filename,
          strategyId: doc.strategyId,
          reason,
        });
        continue;
      }
      seenIds.set(doc.strategyId, filename);

      if (doc.status !== "active") continue; // valid document, just not part of the active set

      strategies.push(doc);
    }

    return { strategies, rejected };
  }
}
