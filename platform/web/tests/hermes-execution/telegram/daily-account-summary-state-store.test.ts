import { describe, expect, it, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  InMemoryDailyAccountSummaryStateStore,
  JsonFileDailyAccountSummaryStateStore,
} from "@/lib/hermes-execution/telegram/daily-account-summary-state-store";

describe("InMemoryDailyAccountSummaryStateStore", () => {
  it("returns null before anything has been saved", async () => {
    const store = new InMemoryDailyAccountSummaryStateStore();
    expect(await store.load()).toBeNull();
  });

  it("round-trips a saved state", async () => {
    const store = new InMemoryDailyAccountSummaryStateStore();
    await store.save({ lastSentDate: "2026-07-29" });
    expect(await store.load()).toEqual({ lastSentDate: "2026-07-29" });
  });
});

describe("JsonFileDailyAccountSummaryStateStore", () => {
  const tmpDir = path.join(os.tmpdir(), `daily-summary-state-test-${Date.now()}`);
  const filePath = path.join(tmpDir, "state.json");

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns null when the file doesn't exist yet — never throws", async () => {
    const store = new JsonFileDailyAccountSummaryStateStore(filePath);
    expect(await store.load()).toBeNull();
  });

  it("persists across a fresh store instance, simulating a process restart", async () => {
    const first = new JsonFileDailyAccountSummaryStateStore(filePath);
    await first.save({ lastSentDate: "2026-07-29" });

    const second = new JsonFileDailyAccountSummaryStateStore(filePath);
    expect(await second.load()).toEqual({ lastSentDate: "2026-07-29" });
  });

  it("creates the parent directory if it doesn't exist yet", async () => {
    const store = new JsonFileDailyAccountSummaryStateStore(filePath);
    await store.save({ lastSentDate: "2026-07-29" });
    const raw = await fs.readFile(filePath, "utf-8");
    expect(JSON.parse(raw)).toEqual({ lastSentDate: "2026-07-29" });
  });
});
