import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuditTrailCorruptionError, AuditTrailPersistenceError, JsonFileAuditTrail } from "@/lib/hermes-execution/json-file-audit-trail";
import type { AuditEvent } from "@/lib/hermes-execution/types";

// Restart-Resilient Autonomy Phase — Phase 7 (Audit durability).
//
// Covers required scenario 20: audit history survives restart. market-runtime.ts now calls
// loadExisting() instead of createFresh() (see that file's own doc comment) — this test proves
// loadExisting() itself is the right primitive for that: it retains prior history instead of
// destructively truncating it, exactly what a PM2 restart needs. Uses a real temp file (this
// class's own contract is file-based), never touches the repo's own .data/ directory.

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    timestamp: "2026-01-01T00:00:00.000Z",
    eventType: "TRADING_CYCLE_STARTED",
    executionRunId: "run-1",
    details: {},
    ...overrides,
  };
}

describe("JsonFileAuditTrail — audit history survives a simulated restart (scenario 20)", () => {
  let tempFile: string;

  afterEach(async () => {
    if (tempFile) await fs.rm(tempFile, { force: true });
  });

  it("loadExisting() retains events written by a PRIOR process instance, never truncating them", async () => {
    tempFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "hermes-audit-")), "audit-log.json");

    // "Process A" — writes some history, then (simulating a PM2 restart) is discarded.
    const processA = await JsonFileAuditTrail.createFresh(tempFile);
    await processA.record(makeEvent({ eventType: "TRADING_RUNTIME_STARTED" }));
    await processA.record(makeEvent({ eventType: "TRADING_CYCLE_COMPLETED" }));
    expect(await processA.getEvents()).toHaveLength(2);

    // "Process B" — a fresh instance after a restart, pointed at the SAME file.
    const processB = await JsonFileAuditTrail.loadExisting(tempFile);
    const restoredEvents = await processB.getEvents();

    expect(restoredEvents).toHaveLength(2);
    expect(restoredEvents.map((e) => e.eventType)).toEqual(["TRADING_RUNTIME_STARTED", "TRADING_CYCLE_COMPLETED"]);

    // New events recorded by process B are appended, not replacing the restored history.
    await processB.record(makeEvent({ eventType: "TRADING_CYCLE_STARTED" }));
    expect(await processB.getEvents()).toHaveLength(3);

    // Confirms the restored history was genuinely persisted to disk, not just held in memory.
    const onDisk = JSON.parse(await fs.readFile(tempFile, "utf-8")) as AuditEvent[];
    expect(onDisk).toHaveLength(3);
  });

  it("createFresh() DOES destructively truncate — the exact behaviour market-runtime.ts no longer uses for its production log", async () => {
    tempFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "hermes-audit-")), "audit-log.json");

    const processA = await JsonFileAuditTrail.createFresh(tempFile);
    await processA.record(makeEvent());
    expect(await processA.getEvents()).toHaveLength(1);

    const processB = await JsonFileAuditTrail.createFresh(tempFile);
    expect(await processB.getEvents()).toHaveLength(0); // prior history is gone
  });

  it("loadExisting() falls back to an empty log when the file does not exist yet (first-ever run)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-audit-"));
    tempFile = path.join(dir, "does-not-exist-yet.json");

    const trail = await JsonFileAuditTrail.loadExisting(tempFile);
    expect(await trail.getEvents()).toEqual([]);
  });
});

// Restart-Resilient Autonomy Phase — audit-durability hardening (safety-review pass). Covers the
// required scenarios: write failures observable by callers, malformed existing file raises a clear
// error (never silently treated as empty), and concurrent writers never corrupt the file.
describe("JsonFileAuditTrail — durability hardening", () => {
  let tempFile: string;

  afterEach(async () => {
    if (tempFile) await fs.rm(tempFile, { force: true });
  });

  it("loadExisting() raises AuditTrailCorruptionError for a malformed existing file — never silently treated as empty", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-audit-"));
    tempFile = path.join(dir, "audit-log.json");
    await fs.writeFile(tempFile, "{ this is not valid JSON at all", "utf-8");

    await expect(JsonFileAuditTrail.loadExisting(tempFile)).rejects.toThrow(AuditTrailCorruptionError);
  });

  it("loadExisting() raises AuditTrailCorruptionError when the file holds valid JSON that isn't an array", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-audit-"));
    tempFile = path.join(dir, "audit-log.json");
    await fs.writeFile(tempFile, JSON.stringify({ not: "an array" }), "utf-8");

    await expect(JsonFileAuditTrail.loadExisting(tempFile)).rejects.toThrow(AuditTrailCorruptionError);
  });

  it("record() rejects with AuditTrailPersistenceError when the write genuinely fails — observable to the caller, not just logged", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-audit-"));
    tempFile = path.join(dir, "audit-log.json");
    const trail = await JsonFileAuditTrail.createFresh(tempFile);

    // Sabotage the parent directory AFTER successful construction: replace it with a plain file,
    // so every subsequent write's fs.mkdir(dirname, { recursive: true }) fails (ENOTDIR) instead
    // of silently succeeding.
    await fs.rm(dir, { recursive: true, force: true });
    await fs.writeFile(dir, "no longer a directory", "utf-8");

    await expect(trail.record(makeEvent())).rejects.toThrow(AuditTrailPersistenceError);

    // Cleanup: dir is now a file, not the directory afterEach expects to remove via tempFile alone.
    await fs.rm(dir, { force: true });
    tempFile = "";
  });

  it("concurrent record() calls from the same process never corrupt the file — every event survives, valid JSON throughout", async () => {
    tempFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "hermes-audit-")), "audit-log.json");
    const trail = await JsonFileAuditTrail.createFresh(tempFile);

    await Promise.all(
      Array.from({ length: 20 }, (_, i) => trail.record(makeEvent({ eventType: "TRADING_CYCLE_STARTED", details: { i } }))),
    );

    expect(await trail.getEvents()).toHaveLength(20);
    const onDisk = JSON.parse(await fs.readFile(tempFile, "utf-8")) as AuditEvent[];
    expect(onDisk).toHaveLength(20);
    expect(new Set(onDisk.map((e) => e.details.i))).toEqual(new Set(Array.from({ length: 20 }, (_, i) => i)));
  });

  it("a second independent writer never corrupts the file — the destination is always valid JSON, worst case one writer's events are overwritten", async () => {
    tempFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "hermes-audit-")), "audit-log.json");
    const writerA = await JsonFileAuditTrail.createFresh(tempFile);
    const writerB = await JsonFileAuditTrail.loadExisting(tempFile);

    await Promise.all([
      writerA.record(makeEvent({ eventType: "TRADING_CYCLE_STARTED" })),
      writerB.record(makeEvent({ eventType: "TRADING_CYCLE_COMPLETED" })),
    ]);

    // Never corrupted/truncated — always parses, always an array — regardless of which writer's
    // rename won the race.
    const onDisk = JSON.parse(await fs.readFile(tempFile, "utf-8")) as AuditEvent[];
    expect(Array.isArray(onDisk)).toBe(true);
    expect(onDisk.length).toBeGreaterThan(0);
  });
});
