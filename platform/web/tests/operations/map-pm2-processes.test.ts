import { describe, expect, it } from "vitest";
import { mapPm2ProcessesToOperationsView, MONITORED_PROCESSES } from "@/lib/operations/map-pm2-processes";

// Runtime Processes panel — Operations Centre. mapPm2ProcessesToOperationsView is the ONE place
// raw `pm2 jlist` output is turned into the narrow, allow-listed DTO this app ever returns to the
// browser — pure, no I/O, exhaustively tested here rather than only through the route/integration
// layer. Every raw fixture below is written by hand to mirror real `pm2 jlist` shape (an array of
// process objects, each with pm2_env.status/pm_uptime/restart_time/pm_id and monit.memory/cpu) —
// never captured from a real PM2 instance.

const NOW = new Date("2026-01-01T12:00:00.000Z");

function rawProcess(overrides: Record<string, unknown> = {}) {
  return {
    name: "trading-intelligence-web",
    pm2_env: {
      status: "online",
      pm_uptime: NOW.getTime() - 2 * 60 * 60_000 - 14 * 60_000, // 2h14m ago
      restart_time: 5,
      pm_id: 2,
      // Deliberately included on every fixture, unless a test overrides pm2_env itself — proves
      // the mapper never forwards this regardless of what's present.
      env: { SUPABASE_SERVICE_ROLE_KEY: "sk-should-never-leak", HERMES_INTEGRATION_TOKEN: "token-should-never-leak" },
      exec_path: "/home/deploy/should-never-leak/node",
      pm_cwd: "/home/deploy/should-never-leak",
      pm_exec_path: "/home/deploy/should-never-leak/app.js",
      node_args: ["--should-never-leak"],
      ...(overrides.pm2_env as Record<string, unknown> | undefined),
    },
    monit: { memory: 118 * 1024 * 1024, cpu: 0.4, ...(overrides.monit as Record<string, unknown> | undefined) },
    pid: 99999,
    unknown_top_level_field_should_never_leak: "leaked-value",
    ...overrides,
  };
}

describe("MONITORED_PROCESSES — the hard allow-list", () => {
  it("contains exactly the two approved processes, never the legacy worker", () => {
    const pm2Names = MONITORED_PROCESSES.map((p) => p.pm2Name);
    expect(pm2Names).toEqual(["trading-intelligence-web", "hermes-market-runtime"]);
    expect(pm2Names).not.toContain("trading-intelligence-worker");
  });
});

describe("mapPm2ProcessesToOperationsView — allow-listing", () => {
  it("returns only the two allow-listed processes, in a stable order, even when PM2 reports more", () => {
    const raw = [
      rawProcess({ name: "trading-intelligence-web" }),
      rawProcess({ name: "trading-intelligence-worker" }), // the legacy worker — must never appear
      rawProcess({ name: "hermes-market-runtime" }),
      rawProcess({ name: "some-other-unrelated-process" }),
    ];

    const result = mapPm2ProcessesToOperationsView(raw, NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.processes.map((p) => p.pm2Name)).toEqual(["trading-intelligence-web", "hermes-market-runtime"]);
  });

  it("never returns the legacy worker even if PM2 reports it with a healthy 'online' status", () => {
    const raw = [rawProcess({ name: "trading-intelligence-worker", pm2_env: { status: "online" } })];
    const result = mapPm2ProcessesToOperationsView(raw, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.processes.find((p) => p.pm2Name === "trading-intelligence-worker")).toBeUndefined();
    expect(result.processes.map((p) => p.pm2Name)).not.toContain("trading-intelligence-worker");
  });
});

describe("mapPm2ProcessesToOperationsView — status mapping", () => {
  it.each([
    ["online", "online"],
    ["stopped", "stopped"],
    ["errored", "errored"],
    ["launching", "launching"],
    ["stopping", "unknown"], // a real PM2 status this app doesn't have a dedicated display for
    ["one-launch-status", "unknown"],
    ["something-unexpected", "unknown"],
  ])("maps PM2 status %s to %s", (pm2Status, expected) => {
    const raw = [rawProcess({ pm2_env: { status: pm2Status } })];
    const result = mapPm2ProcessesToOperationsView(raw, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.processes[0]?.status).toBe(expected);
  });

  it("falls back to 'unknown' when pm2_env.status itself is missing or not a string", () => {
    const raw = [rawProcess({ pm2_env: { status: undefined } })];
    const result = mapPm2ProcessesToOperationsView(raw, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.processes[0]?.status).toBe("unknown");
  });
});

describe("mapPm2ProcessesToOperationsView — metric mapping", () => {
  it("computes uptimeMs from pm_uptime (an absolute epoch-ms start time) for an online process", () => {
    const raw = [rawProcess({ pm2_env: { status: "online", pm_uptime: NOW.getTime() - 90_000 } })];
    const result = mapPm2ProcessesToOperationsView(raw, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.processes[0]?.uptimeMs).toBe(90_000);
  });

  it("reports uptimeMs as null for a stopped process — an uptime figure would be misleading", () => {
    const raw = [rawProcess({ pm2_env: { status: "stopped", pm_uptime: NOW.getTime() - 90_000 } })];
    const result = mapPm2ProcessesToOperationsView(raw, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.processes[0]?.uptimeMs).toBeNull();
  });

  it("maps restart_time to restartCount", () => {
    const raw = [rawProcess({ pm2_env: { status: "online", restart_time: 17 } })];
    const result = mapPm2ProcessesToOperationsView(raw, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.processes[0]?.restartCount).toBe(17);
  });

  it("maps pm_id to pm2Id", () => {
    const raw = [rawProcess({ pm2_env: { pm_id: 4 } })];
    const result = mapPm2ProcessesToOperationsView(raw, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.processes[0]?.pm2Id).toBe(4);
  });

  it("maps monit.cpu and monit.memory to cpuPercent/memoryBytes", () => {
    const raw = [rawProcess({ monit: { cpu: 1.2, memory: 200 * 1024 * 1024 } })];
    const result = mapPm2ProcessesToOperationsView(raw, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.processes[0]?.cpuPercent).toBe(1.2);
    expect(result.processes[0]?.memoryBytes).toBe(200 * 1024 * 1024);
  });

  it("reports null (never 0, never NaN) for missing/non-numeric metrics fields", () => {
    const raw = [rawProcess({ monit: { cpu: "not-a-number", memory: undefined }, pm2_env: { restart_time: undefined, pm_id: null } })];
    const result = mapPm2ProcessesToOperationsView(raw, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const process = result.processes[0]!;
    expect(process.cpuPercent).toBeNull();
    expect(process.memoryBytes).toBeNull();
    expect(process.restartCount).toBeNull();
    expect(process.pm2Id).toBeNull();
  });
});

describe("mapPm2ProcessesToOperationsView — missing expected process", () => {
  it("represents a monitored process PM2 does not report at all as an explicit unavailable state, never a crash", () => {
    const raw = [rawProcess({ name: "trading-intelligence-web" })]; // hermes-market-runtime absent entirely
    const result = mapPm2ProcessesToOperationsView(raw, NOW);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.processes).toHaveLength(2); // both allow-listed slots always present

    const hermes = result.processes.find((p) => p.pm2Name === "hermes-market-runtime");
    expect(hermes).toBeDefined();
    expect(hermes?.available).toBe(false);
    expect(hermes?.status).toBe("unknown");
    expect(hermes?.pm2Id).toBeNull();
    expect(hermes?.uptimeMs).toBeNull();
    expect(hermes?.cpuPercent).toBeNull();
    expect(hermes?.memoryBytes).toBeNull();
    expect(hermes?.restartCount).toBeNull();
  });

  it("marks a process 'available' when PM2 genuinely reports it, even mid-way through startup", () => {
    const raw = [rawProcess({ name: "trading-intelligence-web", pm2_env: { status: "launching" } })];
    const result = mapPm2ProcessesToOperationsView(raw, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.processes.find((p) => p.pm2Name === "trading-intelligence-web")?.available).toBe(true);
  });
});

describe("mapPm2ProcessesToOperationsView — malformed top-level JSON", () => {
  it("fails closed (ok:false) when the top-level value is not an array at all", () => {
    const result = mapPm2ProcessesToOperationsView({ not: "an array" }, NOW);
    expect(result.ok).toBe(false);
  });

  it("fails closed for a bare string, number, null, or undefined", () => {
    expect(mapPm2ProcessesToOperationsView("not json" as unknown, NOW).ok).toBe(false);
    expect(mapPm2ProcessesToOperationsView(42 as unknown, NOW).ok).toBe(false);
    expect(mapPm2ProcessesToOperationsView(null, NOW).ok).toBe(false);
    expect(mapPm2ProcessesToOperationsView(undefined, NOW).ok).toBe(false);
  });

  it("tolerates an array containing a non-object entry — skips it, never crashes", () => {
    const raw = ["not-an-object", rawProcess({ name: "trading-intelligence-web" })];
    const result = mapPm2ProcessesToOperationsView(raw, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.processes.find((p) => p.pm2Name === "trading-intelligence-web")?.available).toBe(true);
  });

  it("treats an empty array as 'both monitored processes unavailable', not malformed", () => {
    const result = mapPm2ProcessesToOperationsView([], NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.processes.every((p) => !p.available)).toBe(true);
  });
});

describe("mapPm2ProcessesToOperationsView — security: no leakage, no unexpected fields", () => {
  it("never includes pm2_env, env, exec paths, args, or any raw/unmodelled field anywhere in the output", () => {
    const raw = [rawProcess({ name: "trading-intelligence-web" }), rawProcess({ name: "hermes-market-runtime" })];
    const result = mapPm2ProcessesToOperationsView(raw, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const serialized = JSON.stringify(result.processes);
    expect(serialized).not.toContain("should-never-leak");
    expect(serialized).not.toContain("leaked-value");
    expect(serialized).not.toContain("pm2_env");
    expect(serialized).not.toContain("SUPABASE_SERVICE_ROLE_KEY");
    expect(serialized).not.toContain("HERMES_INTEGRATION_TOKEN");
  });

  it("every returned process object contains ONLY the explicitly modelled fields", () => {
    const raw = [rawProcess({ name: "trading-intelligence-web" })];
    const result = mapPm2ProcessesToOperationsView(raw, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    const keys = Object.keys(result.processes[0]!).sort();
    expect(keys).toEqual(["available", "cpuPercent", "key", "memoryBytes", "name", "pm2Id", "pm2Name", "restartCount", "status", "uptimeMs"].sort());
  });
});
