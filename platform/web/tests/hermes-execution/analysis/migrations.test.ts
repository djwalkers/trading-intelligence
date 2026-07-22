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
