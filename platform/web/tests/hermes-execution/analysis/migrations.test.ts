import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

// Phase 2B — Decision Intelligence: Historical Analysis Persistence. No live Supabase project is
// linked to this repo (matching every other migration/store file's own established caveat) — these
// are structural assertions against the migration SQL text itself: RLS is enabled, every policy is
// scoped by auth.uid(), no permissive "allow all" placeholder exists, and the columns/indexes this
// phase's own schema calls for are actually present. A real RLS *enforcement* test would need a
// live Postgres instance; this is the practical substitute available in this environment, and a
// genuine regression check (it fails if a future edit accidentally drops a policy or the RLS flag).

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");

function readMigration(filename: string): string {
  return readFileSync(path.join(MIGRATIONS_DIR, filename), "utf-8");
}

describe("0022_market_analysis_runs.sql", () => {
  const sql = readMigration("0022_market_analysis_runs.sql");

  it("creates the market_analysis_runs table", () => {
    expect(sql).toMatch(/create table if not exists market_analysis_runs/);
  });

  it("declares every column this phase's own schema calls for", () => {
    const requiredColumns = [
      "id uuid primary key",
      "user_id uuid not null references auth.users",
      "created_at timestamptz",
      "runtime_mode text",
      "broker_provider text",
      "market_provider text",
      "instrument text",
      "timeframe text",
      "strategy_id text",
      "strategy_version integer",
      "current_bid numeric",
      "current_ask numeric",
      "current_mid numeric",
      "last_close numeric",
      "ema20 numeric",
      "ema50 numeric",
      "rsi14 numeric",
      "atr14 numeric",
      "trend text",
      "confidence numeric",
      "decision text",
      "decision_reason text",
      "executed_trade boolean",
      "trade_id text",
      "validation_ok boolean",
      "fallback_used boolean",
      "candle_count integer",
      "data_age_seconds numeric",
      "runtime_duration_ms numeric",
      "error_code text",
      "error_message text",
      "metadata jsonb",
    ];
    for (const column of requiredColumns) {
      expect(sql, `expected column definition "${column}"`).toContain(column);
    }
  });

  it("enables row level security", () => {
    expect(sql).toMatch(/alter table market_analysis_runs enable row level security/);
  });

  it("every policy scopes by auth.uid() = user_id — no permissive 'allow all' placeholder", () => {
    expect(sql).not.toMatch(/using \s*\(\s*true\s*\)/i);
    expect(sql).not.toMatch(/allow all/i);
    const policyBlocks = sql.match(/create policy[\s\S]*?;/g) ?? [];
    expect(policyBlocks.length).toBeGreaterThanOrEqual(3); // select, insert, update
    for (const block of policyBlocks) {
      expect(block).toMatch(/auth\.uid\(\)\s*=\s*user_id/);
    }
  });

  it("creates the 5 indexes this phase's own schema calls for (created_at, instrument, strategy_id, decision, executed_trade)", () => {
    expect(sql).toMatch(/create index if not exists market_analysis_runs_created_at_idx\s+on market_analysis_runs \(created_at/);
    expect(sql).toMatch(/create index if not exists market_analysis_runs_instrument_idx\s+on market_analysis_runs \(instrument\)/);
    expect(sql).toMatch(/create index if not exists market_analysis_runs_strategy_id_idx\s+on market_analysis_runs \(strategy_id\)/);
    expect(sql).toMatch(/create index if not exists market_analysis_runs_decision_idx\s+on market_analysis_runs \(decision\)/);
    expect(sql).toMatch(
      /create index if not exists market_analysis_runs_executed_trade_idx\s+on market_analysis_runs \(executed_trade\)/,
    );
  });

  it("is idempotent — every DDL statement uses IF NOT EXISTS / DROP POLICY IF EXISTS", () => {
    expect(sql).not.toMatch(/create table market_analysis_runs\s*\(/); // must be "create table if not exists"
    const createPolicyLines = sql.split("\n").filter((line) => /^create policy/.test(line.trim()));
    for (const line of createPolicyLines) {
      const policyName = line.match(/create policy "([^"]+)"/)?.[1];
      expect(sql, `expected a matching "drop policy if exists ... ${policyName}"`).toContain(`drop policy if exists "${policyName}"`);
    }
  });
});

describe("0023_market_analysis_events.sql", () => {
  const sql = readMigration("0023_market_analysis_events.sql");

  it("creates the market_analysis_events table with a cascading FK to market_analysis_runs", () => {
    expect(sql).toMatch(/create table if not exists market_analysis_events/);
    expect(sql).toMatch(/analysis_run_id uuid not null references market_analysis_runs \(id\) on delete cascade/);
  });

  it("declares timestamp/event_type/severity/message/payload", () => {
    expect(sql).toContain('"timestamp" timestamptz');
    expect(sql).toContain("event_type text not null");
    expect(sql).toMatch(/severity text not null default 'info' check/);
    expect(sql).toContain("message text not null");
    expect(sql).toContain("payload jsonb");
  });

  it("does NOT constrain event_type to a closed check-constraint enum (deliberately open vocabulary)", () => {
    const eventTypeLine = sql.split("\n").find((line) => line.trim().startsWith("event_type"));
    expect(eventTypeLine).toBeDefined();
    expect(eventTypeLine).not.toMatch(/check/i);
  });

  it("enables row level security, scoped via a join back to market_analysis_runs.user_id (no own user_id column)", () => {
    expect(sql).toMatch(/alter table market_analysis_events enable row level security/);
    expect(sql).not.toMatch(/^\s*user_id uuid/m);
    const policyBlocks = sql.match(/create policy[\s\S]*?;/g) ?? [];
    expect(policyBlocks.length).toBeGreaterThanOrEqual(2); // select, insert
    for (const block of policyBlocks) {
      expect(block).toMatch(/market_analysis_runs\.user_id\s*=\s*auth\.uid\(\)/);
    }
  });

  it("no permissive 'allow all' placeholder", () => {
    expect(sql).not.toMatch(/using \s*\(\s*true\s*\)/i);
    expect(sql).not.toMatch(/allow all/i);
  });
});

// Restart-Resilient Autonomy Phase — pre-deployment hardening pass on 0026. These assertions cover
// the 8 requirements from that review: two partial unique indexes, five CHECK-constraint groups,
// status-consistency constraints, the composite (candidate_id, user_id) ownership FK, user-scoped
// composite indexes, and RLS/grant parity with 0024/0025. This migration has never been applied
// anywhere, so — same caveat as every describe block above — these are structural assertions
// against the SQL text, not a live-Postgres enforcement test.
describe("0026_trade_lifecycle_records.sql", () => {
  const sql = readMigration("0026_trade_lifecycle_records.sql");

  it("creates the trade_lifecycle_records table", () => {
    expect(sql).toMatch(/create table if not exists trade_lifecycle_records/);
  });

  it("adds a supporting unique constraint on trade_candidates (id, user_id), guarded idempotently", () => {
    expect(sql).toMatch(/add constraint trade_candidates_id_user_id_key unique \(id, user_id\)/);
    expect(sql).toMatch(/if not exists \(\s*select 1 from pg_constraint where conname = 'trade_candidates_id_user_id_key'/);
  });

  it("enforces candidate_id ownership via a composite foreign key, not a single-column one", () => {
    expect(sql).not.toMatch(/candidate_id uuid references trade_candidates/);
    expect(sql).toMatch(
      /constraint trade_lifecycle_records_candidate_user_fk\s+foreign key \(candidate_id, user_id\) references trade_candidates \(id, user_id\)/,
    );
  });

  it("requirement 1: partial unique index — one active record per user_id/broker_provider/broker_position_id", () => {
    expect(sql).toMatch(
      /create unique index if not exists trade_lifecycle_records_active_broker_position_uidx\s+on trade_lifecycle_records \(user_id, broker_provider, broker_position_id\)\s+where status in \('OPEN', 'CLOSE_REQUESTED', 'CLOSE_FAILED', 'EXECUTION_RECONCILIATION_REQUIRED'\)/,
    );
  });

  it("requirement 2: partial unique index — one active record per user_id/strategy_id/instrument", () => {
    expect(sql).toMatch(
      /create unique index if not exists trade_lifecycle_records_active_strategy_instrument_uidx\s+on trade_lifecycle_records \(user_id, strategy_id, instrument\)\s+where status in \(\s*'DECISION_CREATED', 'APPROVED', 'EXECUTION_SUBMITTED', 'OPEN', 'CLOSE_REQUESTED', 'CLOSE_FAILED',\s*'EXECUTION_RECONCILIATION_REQUIRED'/,
    );
  });

  it("requirement 3: quantity/strategy_version/price/detail/closed_at checks", () => {
    expect(sql).toContain("quantity numeric not null check (quantity > 0)");
    expect(sql).toContain("strategy_version integer not null check (strategy_version > 0)");
    expect(sql).toContain("entry_price numeric check (entry_price is null or entry_price > 0)");
    expect(sql).toContain("stop_loss numeric check (stop_loss is null or stop_loss > 0)");
    expect(sql).toContain("take_profit numeric check (take_profit is null or take_profit > 0)");
    expect(sql).toContain("exit_price numeric check (exit_price is null or exit_price > 0)");
    expect(sql).toMatch(/constraint trade_lifecycle_records_detail_is_object\s+check \(jsonb_typeof\(detail\) = 'object'\)/);
    expect(sql).toMatch(
      /constraint trade_lifecycle_records_closed_not_before_opened\s+check \(closed_at is null or opened_at is null or closed_at >= opened_at\)/,
    );
  });

  it("requirement 4: status consistency constraints, including realised_pnl in the CLOSED-requires check", () => {
    expect(sql).toMatch(
      /constraint trade_lifecycle_records_open_status_requires_broker_fields\s+check \(\s*status not in \('OPEN', 'CLOSE_REQUESTED', 'CLOSE_FAILED', 'CLOSED', 'CLOSED_UNRECONCILED'\)\s*or \(broker_position_id is not null and entry_price is not null and opened_at is not null\)/,
    );
    expect(sql).toMatch(
      /constraint trade_lifecycle_records_closed_requires_exit_fields\s+check \(\s*status <> 'CLOSED'\s*or \(closed_at is not null and exit_price is not null and exit_reason is not null and realised_pnl is not null\)/,
    );
  });

  // Restart-Resilient Autonomy Phase — reconciliation/state-machine hardening pass.
  it("declares the CLOSED_UNRECONCILED status and its own status-consistency constraint (never requiring exit_price/realised_pnl)", () => {
    expect(sql).toContain("'CLOSE_FAILED', 'CLOSED_UNRECONCILED'");
    expect(sql).toMatch(
      /constraint trade_lifecycle_records_closed_unreconciled_requires_fields\s+check \(\s*status <> 'CLOSED_UNRECONCILED'\s*or \(closed_at is not null and exit_reason is not null\)/,
    );
  });

  // Restart-Resilient Autonomy Phase — crash-window recovery pass.
  it("declares EXECUTION_ABANDONED and EXECUTION_RECONCILIATION_REQUIRED, with EXECUTION_ABANDONED requiring closed_at/exit_reason only", () => {
    expect(sql).toContain("'EXECUTION_ABANDONED', 'EXECUTION_RECONCILIATION_REQUIRED'");
    expect(sql).toMatch(
      /constraint trade_lifecycle_records_execution_abandoned_requires_fields\s+check \(\s*status <> 'EXECUTION_ABANDONED'\s*or \(closed_at is not null and exit_reason is not null\)/,
    );
    // EXECUTION_ABANDONED/EXECUTION_RECONCILIATION_REQUIRED must NOT be added to the broker-fields
    // requirement — a record can reach either status having never had a broker_position_id/
    // entry_price/opened_at at all (e.g. abandoned straight from DECISION_CREATED).
    const openStatusConstraint = sql.match(/constraint trade_lifecycle_records_open_status_requires_broker_fields[\s\S]*?\),/)?.[0];
    expect(openStatusConstraint).toBeDefined();
    expect(openStatusConstraint).not.toContain("EXECUTION_ABANDONED");
    expect(openStatusConstraint).not.toContain("EXECUTION_RECONCILIATION_REQUIRED");
  });

  it("requirement 7: every non-partial index is user-scoped (user_id leads every composite index)", () => {
    const indexLines = sql.match(/create (?:unique )?index if not exists [\s\S]*?;/g) ?? [];
    expect(indexLines.length).toBeGreaterThanOrEqual(6);
    for (const line of indexLines) {
      expect(line, `expected index to lead with user_id: ${line}`).toMatch(/on trade_lifecycle_records \(user_id,/);
    }
  });

  it("enables row level security and matches 0024/0025's policy shape (auth.uid() = user_id, no allow-all)", () => {
    expect(sql).toMatch(/alter table trade_lifecycle_records enable row level security/);
    expect(sql).not.toMatch(/using \s*\(\s*true\s*\)/i);
    expect(sql).not.toMatch(/allow all/i);
    const policyBlocks = sql.match(/create policy[\s\S]*?;/g) ?? [];
    expect(policyBlocks.length).toBeGreaterThanOrEqual(3); // select, insert, update
    for (const block of policyBlocks) {
      expect(block).toMatch(/auth\.uid\(\)\s*=\s*user_id/);
    }
  });

  it("declares no GRANT statements, matching 0024/0025 (RLS-only access control)", () => {
    expect(sql).not.toMatch(/\bgrant\b/i);
  });

  it("is idempotent — every DDL statement uses IF NOT EXISTS / DROP POLICY IF EXISTS", () => {
    expect(sql).not.toMatch(/create table trade_lifecycle_records\s*\(/); // must be "create table if not exists"
    const createPolicyLines = sql.split("\n").filter((line) => /^create policy/.test(line.trim()));
    for (const line of createPolicyLines) {
      const policyName = line.match(/create policy "([^"]+)"/)?.[1];
      expect(sql, `expected a matching "drop policy if exists ... ${policyName}"`).toContain(`drop policy if exists "${policyName}"`);
    }
  });
});

// AUTO_DEMO approval-persistence defect fix. approved_by_user_id (uuid, already nullable) must
// remain untouched — genuinely fixing the production bug means the uuid column type is never
// weakened and the fabricated "system:auto-demo" string is never written there. This migration only
// adds the new approval_source discriminator column plus a replacement provenance constraint. Same
// caveat as every describe block above: no live Supabase project is linked to this repo, so these
// are structural assertions against the migration SQL text.
describe("0027_trade_candidates_approval_source.sql", () => {
  const sql = readMigration("0027_trade_candidates_approval_source.sql");

  it("adds approval_source as a new, nullable column — never redefines approved_by_user_id's own uuid type", () => {
    expect(sql).toMatch(/add column if not exists approval_source text/);
    // The column is only ever referenced inside comments/constraints below — never "alter column
    // approved_by_user_id type ..." or any other redefinition of the column itself.
    expect(sql).not.toMatch(/alter column approved_by_user_id/);
    expect(sql).not.toMatch(/approved_by_user_id\s+text/i); // never weakened from uuid to text
  });

  it("constrains approval_source to a closed, known vocabulary", () => {
    expect(sql).toMatch(/check \(approval_source is null or approval_source in \('AUTO_DEMO'\)\)/);
  });

  it("replaces the old paired-null constraint with a three-way provenance constraint (not-approved / human / AUTO_DEMO)", () => {
    expect(sql).toMatch(/drop constraint if exists trade_candidates_approved_fields_together/);
    expect(sql).toMatch(/add constraint trade_candidates_approval_provenance/);
    const constraintBlock = sql.match(/add constraint trade_candidates_approval_provenance[\s\S]*?;/)?.[0];
    expect(constraintBlock).toBeDefined();
    // Not-yet-approved: everything null.
    expect(constraintBlock).toMatch(/approved_at is null and approved_by_user_id is null and approval_source is null/);
    // Human approval: a real approved_by_user_id, no approval_source tag.
    expect(constraintBlock).toMatch(/approved_at is not null and approved_by_user_id is not null and approval_source is null/);
    // System approval: approved_by_user_id stays null, approval_source carries the provenance.
    expect(constraintBlock).toMatch(/approved_at is not null and approved_by_user_id is null and approval_source = 'AUTO_DEMO'/);
  });

  it("is idempotent — uses IF NOT EXISTS / IF EXISTS for every DDL statement", () => {
    expect(sql).toMatch(/add column if not exists/);
    expect(sql).toMatch(/drop constraint if exists/);
  });
});
