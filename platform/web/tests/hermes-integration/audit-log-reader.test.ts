import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { readHermesRuntimeAuditLog } from "@/lib/hermes-integration/audit-log-reader";

const tempDirs: string[] = [];

async function makeTempFile(content: string | undefined): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-integration-test-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "audit-log.json");
  if (content !== undefined) await fs.writeFile(filePath, content, "utf-8");
  return filePath;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("readHermesRuntimeAuditLog", () => {
  it("returns available: true with an empty array when the file does not exist yet", async () => {
    const filePath = await makeTempFile(undefined);
    const result = await readHermesRuntimeAuditLog(filePath);
    expect(result).toEqual({ events: [], available: true });
  });

  it("reads and parses a valid audit log file", async () => {
    const events = [{ timestamp: "2026-01-01T00:00:00.000Z", eventType: "TRADING_RUNTIME_STARTED", executionRunId: "run-1", details: {} }];
    const filePath = await makeTempFile(JSON.stringify(events));
    const result = await readHermesRuntimeAuditLog(filePath);
    expect(result).toEqual({ events, available: true });
  });

  it("returns available: false for corrupted (non-JSON) file contents", async () => {
    const filePath = await makeTempFile("{ not valid json ][");
    const result = await readHermesRuntimeAuditLog(filePath);
    expect(result).toEqual({ events: [], available: false });
  });

  it("returns available: false when the parsed JSON root is not an array", async () => {
    const filePath = await makeTempFile(JSON.stringify({ not: "an array" }));
    const result = await readHermesRuntimeAuditLog(filePath);
    expect(result).toEqual({ events: [], available: false });
  });

  it("returns available: false (not a crash) for a directory path that can never be read as a file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hermes-integration-test-dir-"));
    tempDirs.push(dir);
    const result = await readHermesRuntimeAuditLog(dir);
    expect(result.available).toBe(false);
    expect(result.events).toEqual([]);
  });
});
