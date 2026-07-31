import type { AssetClass, InstrumentCatalogueEntry } from "../instrument-catalogue/instrument-catalogue";

// Phase 1 — Declarative Strategy Foundation. A strategy HERE is validated DATA, never executable
// code: no formula strings, no expression evaluation, no dynamic import, no function bodies. This
// is deliberately a SEPARATE, new concept from `strategies/strategy.ts`'s own `Strategy` interface
// (an executable class implementing checkEntryConditions/evaluate/etc., registered with
// `InMemoryStrategyRegistry` and actually driving live trading decisions) and from
// `registry-client.ts`'s `RawRegistryStrategy` (the EXTERNAL Hermes Lab research-hypothesis
// registry, read from a `HERMES_STRATEGY_REGISTRY_PATH` outside this repo, with string-based
// entryDefinition.rule/exitDefinition.rule). Nothing in this module is wired into either of those
// pipelines — this is a standalone schema + registry that does not yet drive any trading decision.
//
// This module is pure: no filesystem I/O, no broker/execution/approval/lifecycle/risk import, no
// network call. See strategy-definition-registry.ts for the (also read-only, filesystem-only)
// loader that uses these types/functions.

export const STRATEGY_DEFINITION_SCHEMA_VERSION = 1;

export type StrategyStatus = "DRAFT" | "VALIDATED" | "APPROVED_FOR_BACKTEST" | "APPROVED_FOR_DEMO" | "RETIRED" | "DISABLED";
const KNOWN_STATUSES: readonly StrategyStatus[] = ["DRAFT", "VALIDATED", "APPROVED_FOR_BACKTEST", "APPROVED_FOR_DEMO", "RETIRED", "DISABLED"];

export type StrategyFamily = "TREND_FOLLOWING" | "MEAN_REVERSION" | "MOMENTUM" | "BREAKOUT" | "OTHER";
const KNOWN_FAMILIES: readonly StrategyFamily[] = ["TREND_FOLLOWING", "MEAN_REVERSION", "MOMENTUM", "BREAKOUT", "OTHER"];

/** Only "1h" is actually supported today — deliberately an array (not a hardcoded literal type)
 * so a future timeframe is added by extending this one list + the union below it, never by
 * redesigning the schema itself. */
export const SUPPORTED_TIMEFRAMES = ["1h"] as const;
export type SupportedTimeframe = (typeof SUPPORTED_TIMEFRAMES)[number];

/** The only fields a strategy may ever reference — plain OHLCV, matching `Candle`'s own shape
 * (types.ts). Never a broker-specific or execution-specific field. */
export const SAFE_MARKET_FIELDS = ["open", "high", "low", "close", "volume"] as const;
export type SafeMarketField = (typeof SAFE_MARKET_FIELDS)[number];

/** Deliberately small — Phase 0's own "safe subset" mandate. Each maps 1:1 to an existing pure
 * function in technical-indicators.ts (calculateEma/calculateRsi/calculateAtr) — this schema never
 * invents a new indicator calculation, only names one that could later be computed by the existing,
 * already-tested function of the same name. */
export type IndicatorType = "EMA" | "RSI" | "ATR";
const KNOWN_INDICATOR_TYPES: readonly IndicatorType[] = ["EMA", "RSI", "ATR"];

/** The exact, closed set of keys a JSON indicator object may have — anything else (in particular a
 * "formula"/"expression"/"script" field) is rejected outright, never silently ignored. */
const INDICATOR_KEYS = ["id", "type", "sourceField", "parameters", "outputAlias"] as const;

/** The exact, closed set of top-level document keys — an unrecognised root field (a misspelling, or
 * an attempt to sneak in a control field this list of names doesn't happen to catch) is rejected
 * outright rather than silently ignored. `parameters` remains the one deliberately open sub-object
 * (author-declared tunable values) — findProhibitedFields still reaches into it regardless. */
const ROOT_KEYS = [
  "schemaVersion",
  "strategyId",
  "strategyVersion",
  "name",
  "description",
  "status",
  "strategyFamily",
  "assetClass",
  "supportedInstruments",
  "timeframe",
  "dataRequirements",
  "indicators",
  "entryRules",
  "signalExitRules",
  "parameters",
  "eligibility",
  "backtestPolicy",
  "provenance",
  "limitations",
] as const;
const ELIGIBILITY_KEYS = ["requiresReadOnlyVerified", "requiresStage4Verified", "requiresConfiguredUniverse", "notes"] as const;
const BACKTEST_POLICY_KEYS = ["minHistoryBars", "warmupBars", "notes"] as const;
const PROVENANCE_KEYS = ["author", "createdAt", "notes"] as const;

export interface IndicatorDefinition {
  /** Stable identifier for this indicator within the strategy — never reused as a display label. */
  id: string;
  type: IndicatorType;
  sourceField: SafeMarketField;
  /** Only `period` today (a positive integer) — kept as its own object (not a bare number) so a
   * future indicator needing more than one parameter never requires a shape change to
   * IndicatorDefinition itself. */
  parameters: { period: number };
  /** The name entry/exit rules reference this indicator's computed value by — unique across every
   * indicator AND every declared market field in the same strategy (see validateStrategyDefinition). */
  outputAlias: string;
}

export type ComparisonOperator = "GREATER_THAN" | "LESS_THAN" | "GREATER_THAN_OR_EQUAL" | "LESS_THAN_OR_EQUAL";
const COMPARISON_OPERATORS: readonly ComparisonOperator[] = ["GREATER_THAN", "LESS_THAN", "GREATER_THAN_OR_EQUAL", "LESS_THAN_OR_EQUAL"];
export type CrossOperator = "CROSSES_ABOVE" | "CROSSES_BELOW";
const CROSS_OPERATORS: readonly CrossOperator[] = ["CROSSES_ABOVE", "CROSSES_BELOW"];
export type LogicalOperator = "AND" | "OR";
const LOGICAL_OPERATORS: readonly LogicalOperator[] = ["AND", "OR"];

/** An operand may only ever be: a declared indicator's output, a safe market-data field, or a
 * validated numeric constant — never a formula, never a free-form expression. */
export type RuleOperand =
  | { kind: "INDICATOR_ALIAS"; alias: string }
  | { kind: "MARKET_FIELD"; field: SafeMarketField }
  | { kind: "CONSTANT"; value: number };

/**
 * A typed rule tree — never a string, never evaluated as code. `BETWEEN`/comparison/cross nodes
 * always compare at least one non-constant operand (a rule comparing two literal constants, e.g.
 * "5 > 3", is always trivially true/false and never references market data — rejected as malformed,
 * see validateRuleNode). `AND`/`OR` require at least two child rules — a single-child boolean
 * combinator is meaningless and rejected as malformed for the same reason.
 */
export type RuleNode =
  | { operator: ComparisonOperator; left: RuleOperand; right: RuleOperand }
  | { operator: "BETWEEN"; operand: RuleOperand; lowerBound: RuleOperand; upperBound: RuleOperand }
  | { operator: CrossOperator; left: RuleOperand; right: RuleOperand }
  | { operator: LogicalOperator; rules: RuleNode[] };

export type SignalExitRule = { kind: "CONDITION"; rule: RuleNode } | { kind: "MAX_BARS_HELD"; maxBars: number };

export interface EligibilityConstraints {
  /** Purely declarative — a strategy author's own stated assumption about what capability level an
   * instrument needs before this strategy should be considered for that instrument. Never itself
   * grants or changes catalogue/runtime state (see this module's own top-of-file note). */
  requiresReadOnlyVerified: boolean;
  requiresStage4Verified: boolean;
  requiresConfiguredUniverse: boolean;
  notes: string[];
}

export interface BacktestPolicy {
  /** Bars of history a backtest needs before this strategy's indicators are meaningful (e.g. an
   * EMA50 needs at least 50 prior bars) — declarative only; this phase runs no backtest itself. */
  minHistoryBars: number;
  warmupBars: number;
  notes: string[];
}

export interface StrategyProvenance {
  author: string;
  createdAt: string;
  notes: string[];
}

export interface StrategyDefinitionDocument {
  schemaVersion: number;
  strategyId: string;
  strategyVersion: string;
  name: string;
  description: string;
  status: StrategyStatus;
  strategyFamily: StrategyFamily;
  assetClass: AssetClass;
  supportedInstruments: string[];
  timeframe: SupportedTimeframe;
  dataRequirements: SafeMarketField[];
  indicators: IndicatorDefinition[];
  entryRules: RuleNode;
  signalExitRules: SignalExitRule[];
  parameters: Record<string, number | string | boolean>;
  eligibility: EligibilityConstraints;
  backtestPolicy: BacktestPolicy;
  provenance: StrategyProvenance;
  limitations: string[];
}

export type StrategyDefinitionRejectionReason =
  | "READ_ERROR"
  | "INVALID_JSON"
  | "UNEXPECTED_SHAPE"
  | "MISSING_REQUIRED_FIELD"
  | "SCHEMA_VERSION_TOO_OLD"
  | "INVALID_STRATEGY_ID"
  | "INVALID_STRATEGY_VERSION"
  | "INVALID_STATUS"
  | "INVALID_TIMEFRAME"
  | "INVALID_INDICATOR"
  | "INVALID_RULE_TREE"
  | "PROHIBITED_FIELD"
  | "UNSUPPORTED_INSTRUMENT"
  | "SYMLINK_REJECTED"
  | "CONFLICTING_DUPLICATE_VERSION";

/**
 * Every field name this schema treats as an unambiguous attempt to control something a strategy
 * document must never control — see this module's own top-of-file architectural-boundary note.
 * Matched after normalising away case and non-alphanumeric characters, so `stop_loss`, `StopLoss`,
 * and `STOP-LOSS-PERCENT` are all caught by the same one entry. This is an explicit reject, never a
 * silent strip — see findProhibitedFields's own doc comment.
 */
const PROHIBITED_FIELD_NAMES_NORMALISED = new Set(
  [
    "orderSize",
    "positionSize",
    "quantity",
    "orderQuantity",
    "positionQuantity",
    "qty",
    "notional",
    "leverage",
    "portfolioLimit",
    "portfolioRiskLimit",
    "riskLimit",
    "exposureLimit",
    "maxPortfolioExposure",
    "maxOpenPositions",
    "maxPositions",
    "maximumPositions",
    "positionLimit",
    "openPositionLimit",
    "stopLoss",
    "stopLossPercent",
    "takeProfit",
    "takeProfitPercent",
    "killSwitch",
    "emergencyStop",
    "brokerProvider",
    "broker",
    "brokerId",
    "brokerName",
    "brokerType",
    "accountMode",
    "accountType",
    "approvalMode",
    "executionRouting",
    "executionMode",
    "routingMode",
    "lifecycleTransition",
    "lifecycleState",
    "lifecycleStage",
    "reconciliation",
    "reconciliationMode",
    "liveMode",
    "demoMode",
    "tradingMode",
    "isLive",
    "env",
  ].map(normaliseFieldName),
);

function normaliseFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Defends the two recursive scanners below against pathological input from a PROGRAMMATIC caller
// (this module's functions are exported and pure — nothing stops a caller from passing a
// hand-built, non-JSON-originated object with a genuine reference cycle, or absurd nesting depth).
// JSON.parse itself can never produce a cycle and any real strategy file is nested only a few
// levels deep, so this bound is never reached by the actual file-loading path — it exists purely so
// neither function can be driven into a stack overflow or infinite loop by a caller that bypasses
// JSON.parse entirely.
const MAX_SCAN_DEPTH = 40;

/**
 * Pure. Recursively walks the ENTIRE raw document — not just the top level — since a prohibited
 * field nested under `parameters`/`eligibility`/anywhere else must be caught exactly like a
 * top-level one (requirement: "reject it explicitly rather than ignoring them silently"). Returns
 * every offending path found (e.g. `parameters.stopLossPercent`), never just the first.
 */
export function findProhibitedFields(raw: unknown, pathPrefix = "", depth = 0): string[] {
  if (depth > MAX_SCAN_DEPTH) return [`${pathPrefix || "<root>"}: exceeds maximum nesting depth`];
  const found: string[] = [];
  if (Array.isArray(raw)) {
    raw.forEach((item, index) => found.push(...findProhibitedFields(item, `${pathPrefix}[${index}]`, depth + 1)));
    return found;
  }
  if (!isRecord(raw)) return found;
  for (const [key, value] of Object.entries(raw)) {
    const currentPath = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (PROHIBITED_FIELD_NAMES_NORMALISED.has(normaliseFieldName(key))) {
      found.push(currentPath);
    }
    found.push(...findProhibitedFields(value, currentPath, depth + 1));
  }
  return found;
}

const STRATEGY_ID_PATTERN = /^[A-Z][A-Z0-9_]*$/;
// No leading zeros (standard semver rule) — "01.0.0" and "1.0.0" would otherwise both parse to the
// identical numeric tuple [1,0,0] while remaining DIFFERENT string keys in the registry's own
// duplicate-detection (which groups by the raw strategyVersion string), risking two "different"
// files being accepted as distinct versions that are actually semantically identical, with
// non-deterministic tie-breaking in selectLatestVersions.
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** Strict MAJOR.MINOR.PATCH only (Phase 1 — no prerelease/build metadata). "Latest" for a
 * strategyId is defined as the highest semantic version among its accepted documents, compared
 * numerically component-by-component — never lexicographic string comparison (which would rank
 * "10.0.0" below "9.0.0"), and never "most recently written file" — see
 * strategy-definition-registry.ts's own doc comment for the full precedence rule this backs. */
export function parseSemver(version: string): [number, number, number] | undefined {
  const match = SEMVER_PATTERN.exec(version);
  if (!match) return undefined;
  return version.split(".").map(Number) as [number, number, number];
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return 0;
  if (pa[0] !== pb[0]) return pa[0] - pb[0];
  if (pa[1] !== pb[1]) return pa[1] - pb[1];
  return pa[2] - pb[2];
}

const MAX_RULE_NODES = 64;

function countRuleNodes(node: RuleNode): number {
  if (node.operator === "AND" || node.operator === "OR") {
    return 1 + node.rules.reduce((sum, child) => sum + countRuleNodes(child), 0);
  }
  return 1;
}

function operandErrors(operand: unknown, path: string, declaredAliases: ReadonlySet<string>): string[] {
  if (!isRecord(operand) || typeof operand.kind !== "string") {
    return [`${path}: operand missing or malformed`];
  }
  if (operand.kind === "INDICATOR_ALIAS") {
    if (typeof operand.alias !== "string" || !declaredAliases.has(operand.alias)) {
      return [`${path}: references undeclared indicator alias ${JSON.stringify(operand.alias)}`];
    }
    return [];
  }
  if (operand.kind === "MARKET_FIELD") {
    if (typeof operand.field !== "string" || !SAFE_MARKET_FIELDS.includes(operand.field as SafeMarketField)) {
      return [`${path}: references an undeclared/unsafe market field ${JSON.stringify(operand.field)}`];
    }
    return [];
  }
  if (operand.kind === "CONSTANT") {
    if (typeof operand.value !== "number" || !Number.isFinite(operand.value)) {
      return [`${path}: constant operand must be a finite number`];
    }
    return [];
  }
  return [`${path}: unrecognised operand kind ${JSON.stringify(operand.kind)}`];
}

function isConstantOperand(operand: unknown): operand is { kind: "CONSTANT"; value: number } {
  return isRecord(operand) && operand.kind === "CONSTANT";
}

/**
 * Pure. Recursively validates one rule (sub)tree — never evaluates it, only checks its shape and
 * references. Detects the two "impossible/malformed" shapes explicitly called out in Phase 1's own
 * requirements: a boolean combinator with fewer than two children, and a comparison/BETWEEN/cross
 * rule whose every operand is a literal constant (never references market data, so it can never
 * legitimately fire based on anything the strategy observes).
 */
function ruleNodeErrors(node: unknown, path: string, declaredAliases: ReadonlySet<string>, depth = 0): string[] {
  if (depth > MAX_SCAN_DEPTH) return [`${path}: rule tree exceeds maximum nesting depth`];
  if (!isRecord(node) || typeof node.operator !== "string") {
    return [`${path}: rule node missing or malformed`];
  }

  if (LOGICAL_OPERATORS.includes(node.operator as LogicalOperator)) {
    if (!Array.isArray(node.rules) || node.rules.length < 2) {
      return [`${path}: ${node.operator} requires at least two child rules`];
    }
    return node.rules.flatMap((child, index) => ruleNodeErrors(child, `${path}.rules[${index}]`, declaredAliases, depth + 1));
  }

  if (node.operator === "BETWEEN") {
    const errors = [
      ...operandErrors(node.operand, `${path}.operand`, declaredAliases),
      ...operandErrors(node.lowerBound, `${path}.lowerBound`, declaredAliases),
      ...operandErrors(node.upperBound, `${path}.upperBound`, declaredAliases),
    ];
    if (errors.length === 0) {
      if (isConstantOperand(node.operand)) errors.push(`${path}: BETWEEN's own tested operand must not itself be a constant`);
      if (isConstantOperand(node.lowerBound) && isConstantOperand(node.upperBound) && node.lowerBound.value >= node.upperBound.value) {
        errors.push(`${path}: BETWEEN lowerBound must be less than upperBound — this range can never be true`);
      }
    }
    return errors;
  }

  if (COMPARISON_OPERATORS.includes(node.operator as ComparisonOperator) || CROSS_OPERATORS.includes(node.operator as CrossOperator)) {
    const errors = [...operandErrors(node.left, `${path}.left`, declaredAliases), ...operandErrors(node.right, `${path}.right`, declaredAliases)];
    if (errors.length === 0 && isConstantOperand(node.left) && isConstantOperand(node.right)) {
      errors.push(`${path}: comparing two constants can never depend on market data — malformed rule`);
    }
    return errors;
  }

  return [`${path}: unrecognised operator ${JSON.stringify(node.operator)}`];
}

export interface StrategyValidationResult {
  strategyId: string | undefined;
  strategyVersion: string | undefined;
  valid: boolean;
  usableForBacktest: boolean;
  /** Always false in Phase 1 — see this field's own inline note at the assignment site. */
  usableForDemo: boolean;
  validationErrors: string[];
  validationWarnings: string[];
  supportedCatalogueInstruments: string[];
  unavailableInstruments: string[];
  prohibitedFieldsFound: string[];
  provenance: { filePath: string };
}

export interface ValidatedStrategyRecord {
  filePath: string;
  document: StrategyDefinitionDocument;
  result: StrategyValidationResult;
}

/**
 * Pure. Validates one already-parsed JSON value as a Phase 1 strategy definition, cross-checked
 * against ALREADY-LOADED instrument catalogue entries (never re-fetches or re-derives catalogue
 * state itself — see this module's own top-of-file note on reusing, never duplicating, the
 * instrument catalogue). `catalogueEntries` should be the Phase 0 catalogue's own
 * `InstrumentCatalogueEntry[]` (BTC/ETH/SOL) — an instrument absent from this list is entirely
 * unknown to the platform, never merely "unverified".
 */
export function validateStrategyDefinition(
  raw: unknown,
  filePath: string,
  catalogueEntries: readonly InstrumentCatalogueEntry[],
): { ok: true; record: ValidatedStrategyRecord } | { ok: false; reason: StrategyDefinitionRejectionReason; detail: string } {
  const prohibitedFieldsFound = findProhibitedFields(raw);

  if (!isRecord(raw)) {
    return { ok: false, reason: "UNEXPECTED_SHAPE", detail: "expected a JSON object at the document root" };
  }

  const schemaVersion = raw.schemaVersion;
  if (typeof schemaVersion !== "number") return { ok: false, reason: "MISSING_REQUIRED_FIELD", detail: "schemaVersion missing or not a number" };
  if (schemaVersion < STRATEGY_DEFINITION_SCHEMA_VERSION) {
    return { ok: false, reason: "SCHEMA_VERSION_TOO_OLD", detail: `schemaVersion ${schemaVersion} < ${STRATEGY_DEFINITION_SCHEMA_VERSION}` };
  }

  const strategyId = raw.strategyId;
  if (typeof strategyId !== "string" || !STRATEGY_ID_PATTERN.test(strategyId)) {
    return { ok: false, reason: "INVALID_STRATEGY_ID", detail: `strategyId must match ${STRATEGY_ID_PATTERN} (got ${JSON.stringify(strategyId)})` };
  }
  const strategyVersion = raw.strategyVersion;
  if (typeof strategyVersion !== "string" || !SEMVER_PATTERN.test(strategyVersion)) {
    return { ok: false, reason: "INVALID_STRATEGY_VERSION", detail: `strategyVersion must be strict MAJOR.MINOR.PATCH semver (got ${JSON.stringify(strategyVersion)})` };
  }

  // From here on, errors accumulate into validationErrors rather than causing an early return —
  // this is a "reject with full explanation" model (every problem reported at once), matching
  // requirement 4 ("reject malformed or unsafe strategy definitions") without forcing a strategy
  // author into a fix-one-error-at-a-time loop. Structural prerequisites for further checks
  // (indicators array shape, etc.) still short-circuit locally where a further check would
  // otherwise throw.
  const validationErrors: string[] = [];
  const validationWarnings: string[] = [];
  // Tracks which category of problem was found, in priority order, purely so the CALLER (the
  // registry loader) can report one specific, meaningful StrategyDefinitionRejectionReason instead
  // of a single generic bucket — the full detail always lists every problem regardless.
  let hasIndicatorError = false;
  let hasRuleTreeError = false;
  let hasUnsupportedInstrumentError = false;
  let hasUnexpectedShapeError = false;

  if (prohibitedFieldsFound.length > 0) {
    validationErrors.push(`Document contains prohibited field(s) this schema must never control: ${prohibitedFieldsFound.join(", ")}`);
  }

  const extraRootKeys = Object.keys(raw).filter((k) => !(ROOT_KEYS as readonly string[]).includes(k));
  if (extraRootKeys.length > 0) {
    validationErrors.push(`unsupported top-level field(s): ${extraRootKeys.join(", ")} — never silently ignored`);
    hasUnexpectedShapeError = true;
  }

  if (typeof raw.name !== "string" || raw.name.trim().length === 0) validationErrors.push("name missing or not a non-empty string");
  if (typeof raw.description !== "string") validationErrors.push("description missing or not a string");

  const status = raw.status;
  if (typeof status !== "string" || !KNOWN_STATUSES.includes(status as StrategyStatus)) {
    validationErrors.push(`status missing or unrecognised: ${JSON.stringify(status)}`);
  }

  const strategyFamily = raw.strategyFamily;
  if (typeof strategyFamily !== "string" || !KNOWN_FAMILIES.includes(strategyFamily as StrategyFamily)) {
    validationErrors.push(`strategyFamily missing or unrecognised: ${JSON.stringify(strategyFamily)}`);
  }

  if (typeof raw.assetClass !== "string") validationErrors.push("assetClass missing or not a string");

  const timeframe = raw.timeframe;
  if (typeof timeframe !== "string" || !SUPPORTED_TIMEFRAMES.includes(timeframe as SupportedTimeframe)) {
    validationErrors.push(`timeframe must be one of ${SUPPORTED_TIMEFRAMES.join(", ")} (got ${JSON.stringify(timeframe)})`);
  }

  const supportedInstruments = Array.isArray(raw.supportedInstruments) ? raw.supportedInstruments.filter((i): i is string => typeof i === "string") : [];
  if (!Array.isArray(raw.supportedInstruments) || supportedInstruments.length === 0) {
    validationErrors.push("supportedInstruments must be a non-empty array of strings");
  } else if (new Set(supportedInstruments).size !== supportedInstruments.length) {
    validationErrors.push("supportedInstruments must not contain duplicate entries");
    hasUnsupportedInstrumentError = true;
  }

  const dataRequirements = Array.isArray(raw.dataRequirements) ? raw.dataRequirements : [];
  for (const field of dataRequirements) {
    if (typeof field !== "string" || !SAFE_MARKET_FIELDS.includes(field as SafeMarketField)) {
      validationErrors.push(`dataRequirements contains an unsupported field: ${JSON.stringify(field)}`);
    }
  }

  const declaredAliases = new Set<string>();
  const indicators: unknown[] = Array.isArray(raw.indicators) ? raw.indicators : [];
  const errorsBeforeIndicators = validationErrors.length;
  if (!Array.isArray(raw.indicators) || indicators.length === 0) {
    validationErrors.push("indicators must be a non-empty array");
  }
  const seenAliases = new Set<string>();
  const seenIds = new Set<string>();
  for (const [index, rawIndicator] of indicators.entries()) {
    if (!isRecord(rawIndicator)) {
      validationErrors.push(`indicators[${index}]: not an object`);
      continue;
    }
    const extraKeys = Object.keys(rawIndicator).filter((k) => !(INDICATOR_KEYS as readonly string[]).includes(k));
    if (extraKeys.length > 0) {
      validationErrors.push(`indicators[${index}]: unsupported field(s) ${extraKeys.join(", ")} — no formula/expression fields are ever accepted`);
    }
    if (typeof rawIndicator.id !== "string" || rawIndicator.id.trim().length === 0) {
      validationErrors.push(`indicators[${index}]: id missing or not a non-empty string`);
    } else if (seenIds.has(rawIndicator.id)) {
      validationErrors.push(`indicators[${index}]: duplicate id ${JSON.stringify(rawIndicator.id)} — ids must be unique`);
    } else {
      seenIds.add(rawIndicator.id);
    }
    if (typeof rawIndicator.type !== "string" || !KNOWN_INDICATOR_TYPES.includes(rawIndicator.type as IndicatorType)) {
      validationErrors.push(`indicators[${index}]: type missing or unsupported (${JSON.stringify(rawIndicator.type)})`);
    }
    if (typeof rawIndicator.sourceField !== "string" || !SAFE_MARKET_FIELDS.includes(rawIndicator.sourceField as SafeMarketField)) {
      validationErrors.push(`indicators[${index}]: sourceField missing or unsupported (${JSON.stringify(rawIndicator.sourceField)})`);
    }
    const parameters = rawIndicator.parameters;
    if (!isRecord(parameters) || !Number.isInteger(parameters.period) || (parameters.period as number) <= 0) {
      validationErrors.push(`indicators[${index}]: parameters.period must be a positive integer`);
    }
    const outputAlias = rawIndicator.outputAlias;
    if (typeof outputAlias !== "string" || outputAlias.trim().length === 0) {
      validationErrors.push(`indicators[${index}]: outputAlias missing or not a non-empty string`);
    } else if (seenAliases.has(outputAlias)) {
      validationErrors.push(`indicators[${index}]: duplicate outputAlias ${JSON.stringify(outputAlias)} — aliases must be unique`);
    } else if (SAFE_MARKET_FIELDS.includes(outputAlias.toLowerCase() as SafeMarketField)) {
      validationErrors.push(`indicators[${index}]: outputAlias ${JSON.stringify(outputAlias)} collides with a reserved market-field name`);
    } else {
      seenAliases.add(outputAlias);
      declaredAliases.add(outputAlias);
    }
  }
  if (validationErrors.length > errorsBeforeIndicators) hasIndicatorError = true;

  const errorsBeforeRules = validationErrors.length;
  if (Array.isArray(raw.entryRules) || !isRecord(raw.entryRules)) {
    validationErrors.push("entryRules missing or malformed — expected one rule tree object, not an array");
  } else {
    const entryErrors = ruleNodeErrors(raw.entryRules, "entryRules", declaredAliases);
    validationErrors.push(...entryErrors);
    if (entryErrors.length === 0 && countRuleNodes(raw.entryRules as RuleNode) > MAX_RULE_NODES) {
      validationErrors.push(`entryRules: rule tree exceeds the maximum of ${MAX_RULE_NODES} nodes`);
    }
  }

  const signalExitRules: unknown[] = Array.isArray(raw.signalExitRules) ? raw.signalExitRules : [];
  for (const [index, rawExit] of signalExitRules.entries()) {
    if (!isRecord(rawExit) || typeof rawExit.kind !== "string") {
      validationErrors.push(`signalExitRules[${index}]: missing or malformed`);
      continue;
    }
    if (rawExit.kind === "CONDITION") {
      validationErrors.push(...ruleNodeErrors(rawExit.rule, `signalExitRules[${index}].rule`, declaredAliases));
    } else if (rawExit.kind === "MAX_BARS_HELD") {
      if (!Number.isInteger(rawExit.maxBars) || (rawExit.maxBars as number) <= 0) {
        validationErrors.push(`signalExitRules[${index}]: maxBars must be a positive integer`);
      }
    } else {
      validationErrors.push(`signalExitRules[${index}]: unrecognised kind ${JSON.stringify(rawExit.kind)}`);
    }
  }
  if (validationErrors.length > errorsBeforeRules) hasRuleTreeError = true;

  const parameters = raw.parameters;
  if (parameters !== undefined) {
    if (!isRecord(parameters)) {
      validationErrors.push("parameters must be an object when present");
    } else {
      for (const [key, value] of Object.entries(parameters)) {
        if (typeof value !== "number" && typeof value !== "string" && typeof value !== "boolean") {
          validationErrors.push(`parameters.${key}: only number/string/boolean values are accepted`);
        }
      }
    }
  }

  const eligibility = raw.eligibility;
  if (!isRecord(eligibility) || typeof eligibility.requiresReadOnlyVerified !== "boolean" || typeof eligibility.requiresStage4Verified !== "boolean" || typeof eligibility.requiresConfiguredUniverse !== "boolean") {
    validationErrors.push("eligibility missing or malformed — requires the three boolean fields plus notes");
  } else {
    const extra = Object.keys(eligibility).filter((k) => !(ELIGIBILITY_KEYS as readonly string[]).includes(k));
    if (extra.length > 0) validationErrors.push(`eligibility: unsupported field(s) ${extra.join(", ")}`);
  }

  const backtestPolicy = raw.backtestPolicy;
  if (!isRecord(backtestPolicy) || !Number.isInteger(backtestPolicy.minHistoryBars) || !Number.isInteger(backtestPolicy.warmupBars)) {
    validationErrors.push("backtestPolicy missing or malformed — requires integer minHistoryBars/warmupBars");
  } else {
    const extra = Object.keys(backtestPolicy).filter((k) => !(BACKTEST_POLICY_KEYS as readonly string[]).includes(k));
    if (extra.length > 0) validationErrors.push(`backtestPolicy: unsupported field(s) ${extra.join(", ")}`);
  }

  const provenanceDoc = raw.provenance;
  if (!isRecord(provenanceDoc) || typeof provenanceDoc.author !== "string" || typeof provenanceDoc.createdAt !== "string" || Number.isNaN(Date.parse(provenanceDoc.createdAt))) {
    validationErrors.push("provenance missing or malformed — requires author (string) and a parseable createdAt");
  } else {
    const extra = Object.keys(provenanceDoc).filter((k) => !(PROVENANCE_KEYS as readonly string[]).includes(k));
    if (extra.length > 0) validationErrors.push(`provenance: unsupported field(s) ${extra.join(", ")}`);
  }

  if (raw.limitations !== undefined && (!Array.isArray(raw.limitations) || raw.limitations.some((l) => typeof l !== "string"))) {
    validationErrors.push("limitations must be an array of strings when present");
  }

  // Instrument compatibility — distinguishes "unknown to the platform entirely" (hard error, per
  // requirement: "a strategy referencing an unknown ... instrument must be rejected") from "known,
  // but not yet capability-verified" (a warning only — "or marked unusable with an explicit
  // reason" — the strategy document itself can still be otherwise valid).
  const catalogueBySymbol = new Map(catalogueEntries.map((e) => [e.symbol, e]));
  const supportedCatalogueInstruments: string[] = [];
  const unavailableInstruments: string[] = [];
  for (const instrument of supportedInstruments) {
    const entry = catalogueBySymbol.get(instrument);
    if (!entry) {
      validationErrors.push(`supportedInstruments references "${instrument}", which does not exist in the Phase 0 instrument catalogue`);
      unavailableInstruments.push(instrument);
      hasUnsupportedInstrumentError = true;
      continue;
    }
    supportedCatalogueInstruments.push(instrument);
    if (entry.readOnlyCapabilityStatus !== "READ_ONLY_VERIFIED") {
      validationWarnings.push(`"${instrument}" exists in the catalogue but is not yet READ_ONLY_VERIFIED — not usable for backtesting against real evidence yet`);
      unavailableInstruments.push(instrument);
    }
  }

  const valid = validationErrors.length === 0;
  // Phase 1 has no promotion mechanism at all — usableForDemo is unconditionally false regardless
  // of a document's own declared `status`, exactly per this phase's own requirement ("must remain
  // false in this phase unless there is already a separate trusted promotion mechanism").
  const usableForDemo = false;
  const usableForBacktest =
    valid && (status === "APPROVED_FOR_BACKTEST" || status === "APPROVED_FOR_DEMO") && supportedCatalogueInstruments.length > 0;

  const result: StrategyValidationResult = {
    strategyId,
    strategyVersion,
    valid,
    usableForBacktest,
    usableForDemo,
    validationErrors,
    validationWarnings,
    supportedCatalogueInstruments,
    unavailableInstruments,
    prohibitedFieldsFound,
    provenance: { filePath },
  };

  if (!valid) {
    // Priority order chosen so the single most safety-relevant category wins when several kinds of
    // problem coexist — a prohibited field is reported as such even if the document also happens to
    // have a malformed indicator, since "this document tried to control something it must never
    // control" is the more important fact to surface first.
    const reason: StrategyDefinitionRejectionReason =
      prohibitedFieldsFound.length > 0
        ? "PROHIBITED_FIELD"
        : hasIndicatorError
          ? "INVALID_INDICATOR"
          : hasRuleTreeError
            ? "INVALID_RULE_TREE"
            : hasUnsupportedInstrumentError
              ? "UNSUPPORTED_INSTRUMENT"
              : hasUnexpectedShapeError
                ? "UNEXPECTED_SHAPE"
                : "MISSING_REQUIRED_FIELD";
    return { ok: false, reason, detail: validationErrors.join("; ") };
  }

  return {
    ok: true,
    record: {
      filePath,
      document: raw as unknown as StrategyDefinitionDocument,
      result,
    },
  };
}
