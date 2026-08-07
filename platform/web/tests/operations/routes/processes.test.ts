import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Runtime Processes panel — Operations Centre. GET /api/operations/processes — mocked at the
// Pm2Runner boundary (never a real `pm2` call), matching this repo's own established route-test
// convention (see tests/hermes-integration/routes/portfolio.test.ts).

const { jlistMock } = vi.hoisted(() => ({ jlistMock: vi.fn() }));

vi.mock("@/lib/operations/pm2-runner", () => ({
  // A `function` expression, not an arrow function — the route calls `new ChildProcessPm2Runner()`.
  ChildProcessPm2Runner: vi.fn().mockImplementation(function ChildProcessPm2Runner() {
    return { jlist: jlistMock };
  }),
}));

const { loggerWarnMock } = vi.hoisted(() => ({ loggerWarnMock: vi.fn() }));
vi.mock("@/lib/logger/logger", () => ({ logger: { warn: loggerWarnMock, debug: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const { GET } = await import("@/app/api/operations/processes/route");

function makeRequest(search = ""): NextRequest {
  return new NextRequest(`http://127.0.0.1:3000/api/operations/processes${search}`);
}

function rawProcess(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    pm2_env: { status: "online", pm_uptime: Date.now() - 90_000, restart_time: 2, pm_id: 1, env: { SECRET_TOKEN: "should-never-leak" } },
    monit: { cpu: 0.5, memory: 100 * 1024 * 1024 },
    ...overrides,
  };
}

describe("GET /api/operations/processes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns both allow-listed processes on a healthy PM2 response", async () => {
    jlistMock.mockResolvedValue({
      ok: true,
      stdout: JSON.stringify([rawProcess("trading-intelligence-web"), rawProcess("hermes-market-runtime")]),
    });

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.data.processes).toHaveLength(2);
    expect(body.data.processes.map((p: { pm2Name: string }) => p.pm2Name)).toEqual(["trading-intelligence-web", "hermes-market-runtime"]);
    expect(typeof body.data.timestamp).toBe("string");
  });

  it("never returns the legacy worker even when PM2 reports it", async () => {
    jlistMock.mockResolvedValue({
      ok: true,
      stdout: JSON.stringify([rawProcess("trading-intelligence-web"), rawProcess("trading-intelligence-worker"), rawProcess("hermes-market-runtime")]),
    });

    const response = await GET(makeRequest());
    const body = await response.json();
    expect(body.data.processes.map((p: { pm2Name: string }) => p.pm2Name)).not.toContain("trading-intelligence-worker");
  });

  it("still returns ok:true with an explicit 'unavailable' entry when one monitored process is missing", async () => {
    jlistMock.mockResolvedValue({ ok: true, stdout: JSON.stringify([rawProcess("trading-intelligence-web")]) });

    const response = await GET(makeRequest());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    const hermes = body.data.processes.find((p: { pm2Name: string }) => p.pm2Name === "hermes-market-runtime");
    expect(hermes.available).toBe(false);
    expect(hermes.status).toBe("unknown");
  });

  it("degrades gracefully (never a raw 500/uncaught exception) when the pm2 binary itself is unavailable", async () => {
    jlistMock.mockResolvedValue({ ok: false, reason: "spawn-error", message: "spawn pm2 ENOENT" });

    const response = await GET(makeRequest());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.code).toBeDefined();
    // The raw spawn error message is never forwarded verbatim to the browser.
    expect(JSON.stringify(body)).not.toContain("ENOENT");
  });

  it("degrades gracefully when pm2 jlist exits non-zero", async () => {
    jlistMock.mockResolvedValue({ ok: false, reason: "non-zero-exit", exitCode: 1, stderrExcerpt: "some internal pm2 diagnostic" });

    const response = await GET(makeRequest());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.ok).toBe(false);
    // stderr is never forwarded verbatim to the browser either.
    expect(JSON.stringify(body)).not.toContain("some internal pm2 diagnostic");
  });

  it("degrades gracefully on a PM2 timeout", async () => {
    jlistMock.mockResolvedValue({ ok: false, reason: "timeout", stderrExcerpt: "" });

    const response = await GET(makeRequest());
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.ok).toBe(false);
    expect(body.error.message.toLowerCase()).toContain("time");
  });

  it("degrades gracefully when PM2 returns output that is not valid JSON", async () => {
    jlistMock.mockResolvedValue({ ok: true, stdout: "this is not json{{{" });

    const response = await GET(makeRequest());
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  it("degrades gracefully when PM2's JSON is well-formed but not the expected array shape", async () => {
    jlistMock.mockResolvedValue({ ok: true, stdout: JSON.stringify({ unexpected: "shape" }) });

    const response = await GET(makeRequest());
    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body.ok).toBe(false);
  });

  it("ignores a query parameter attempting to select an arbitrary process name — response is unaffected", async () => {
    jlistMock.mockResolvedValue({
      ok: true,
      stdout: JSON.stringify([rawProcess("trading-intelligence-web"), rawProcess("trading-intelligence-worker"), rawProcess("hermes-market-runtime")]),
    });

    const response = await GET(makeRequest("?process=trading-intelligence-worker&pm2Name=anything&name=*"));
    const body = await response.json();
    expect(body.data.processes.map((p: { pm2Name: string }) => p.pm2Name)).toEqual(["trading-intelligence-web", "hermes-market-runtime"]);
    // jlist() itself is called with no arguments derived from the request — proves the query
    // string never reached the command construction at all.
    expect(jlistMock).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: expect.any(Number), maxStdoutBytes: expect.any(Number) }));
  });

  it("never leaks pm2_env, environment variables, or any unmodelled field in the response body", async () => {
    jlistMock.mockResolvedValue({
      ok: true,
      stdout: JSON.stringify([rawProcess("trading-intelligence-web"), rawProcess("hermes-market-runtime")]),
    });

    const response = await GET(makeRequest());
    const raw = await response.text();
    expect(raw).not.toContain("should-never-leak");
    expect(raw).not.toContain("pm2_env");
    expect(raw).not.toContain("SECRET_TOKEN");
  });

  it("each process object in the response contains only the explicitly modelled fields", async () => {
    jlistMock.mockResolvedValue({ ok: true, stdout: JSON.stringify([rawProcess("trading-intelligence-web")]) });

    const response = await GET(makeRequest());
    const body = await response.json();
    const keys = Object.keys(body.data.processes[0]).sort();
    expect(keys).toEqual(["available", "cpuPercent", "key", "memoryBytes", "name", "pm2Id", "pm2Name", "restartCount", "status", "uptimeMs"].sort());
  });
});
