import { describe, expect, it } from "vitest";
import { formatUptime, formatMemoryBytes, formatCpuPercent } from "@/lib/operations/format";

// Runtime Processes panel — Operations Centre. Pure, deterministic formatters for PM2 process
// metrics. No I/O, no clock dependency (uptime is always passed as an already-computed duration in
// milliseconds, never derived from Date.now() in here) — every case below is exact and repeatable.

describe("formatUptime", () => {
  it("shows '< 1m' for a duration under one minute", () => {
    expect(formatUptime(0)).toBe("< 1m");
    expect(formatUptime(45_000)).toBe("< 1m");
  });

  it("shows minutes only when under an hour", () => {
    expect(formatUptime(60_000)).toBe("1m");
    expect(formatUptime(14 * 60_000)).toBe("14m");
    expect(formatUptime(59 * 60_000)).toBe("59m");
  });

  it("shows hours and minutes when under a day", () => {
    expect(formatUptime(2 * 60 * 60_000 + 14 * 60_000)).toBe("2h 14m");
    expect(formatUptime(60 * 60_000)).toBe("1h 0m");
    expect(formatUptime(23 * 60 * 60_000 + 59 * 60_000)).toBe("23h 59m");
  });

  it("shows days and hours once a full day has elapsed", () => {
    expect(formatUptime(24 * 60 * 60_000)).toBe("1d 0h");
    expect(formatUptime(3 * 24 * 60 * 60_000 + 5 * 60 * 60_000)).toBe("3d 5h");
  });

  it("never shows a negative duration — clamps to '< 1m' for a bad/negative input", () => {
    expect(formatUptime(-500)).toBe("< 1m");
  });
});

describe("formatMemoryBytes", () => {
  it("formats a typical process memory figure in whole megabytes", () => {
    expect(formatMemoryBytes(118 * 1024 * 1024)).toBe("118 MB");
  });

  it("rounds to the nearest whole megabyte", () => {
    expect(formatMemoryBytes(50.6 * 1024 * 1024)).toBe("51 MB");
  });

  it("shows 0 MB for zero bytes, never blank or NaN", () => {
    expect(formatMemoryBytes(0)).toBe("0 MB");
  });

  it("switches to GB (one decimal place) once memory reaches 1024 MB", () => {
    expect(formatMemoryBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
    expect(formatMemoryBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.5 GB");
  });
});

describe("formatCpuPercent", () => {
  it("formats to one decimal place", () => {
    expect(formatCpuPercent(0.4)).toBe("0.4%");
    expect(formatCpuPercent(0)).toBe("0.0%");
    expect(formatCpuPercent(12)).toBe("12.0%");
  });

  it("rounds to one decimal place rather than truncating", () => {
    expect(formatCpuPercent(0.449)).toBe("0.4%"); // rounds down
    expect(formatCpuPercent(0.451)).toBe("0.5%"); // rounds up
  });
});
