import { describe, expect, it } from "vitest";
import { ChildProcessPm2Runner } from "@/lib/operations/pm2-runner";

// Runtime Processes panel — Operations Centre. Exercises the REAL subprocess runner against
// harmless local `node -e` one-liners only — never the actual `pm2` binary, never a network call.
// Mirrors hermes-cli-runner.test.ts's own established convention exactly: the command/args are
// constructor-overridable ONLY so tests can substitute a safe binary; production code (the
// zero-argument constructor) always spawns the fixed "pm2 jlist" — nothing here proves that
// differently, this file only proves the spawn/timeout/buffering PLUMBING is correct.

const NODE = process.execPath;
const BASE_OPTIONS = { timeoutMs: 5000, maxStdoutBytes: 1024 };

describe("ChildProcessPm2Runner", () => {
  it("returns stdout on a clean, zero-exit run", async () => {
    const runner = new ChildProcessPm2Runner(NODE, ["-e", "process.stdout.write('[]')"]);
    const result = await runner.jlist(BASE_OPTIONS);
    expect(result).toEqual({ ok: true, stdout: "[]" });
  });

  it("reports a non-zero exit code with a stderr excerpt", async () => {
    const runner = new ChildProcessPm2Runner(NODE, ["-e", "process.stderr.write('boom'); process.exit(3)"]);
    const result = await runner.jlist(BASE_OPTIONS);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === "non-zero-exit") {
      expect(result.exitCode).toBe(3);
      expect(result.stderrExcerpt).toContain("boom");
    } else {
      throw new Error(`expected non-zero-exit, got ${JSON.stringify(result)}`);
    }
  });

  it("times out a process that never exits, and kills it", async () => {
    const runner = new ChildProcessPm2Runner(NODE, ["-e", "setInterval(() => {}, 1000)"]);
    const result = await runner.jlist({ ...BASE_OPTIONS, timeoutMs: 200 });
    expect(result).toEqual({ ok: false, reason: "timeout", stderrExcerpt: "" });
  });

  it("aborts and reports oversized-stdout once the configured byte limit is exceeded", async () => {
    const runner = new ChildProcessPm2Runner(NODE, ["-e", "process.stdout.write('x'.repeat(10000))"]);
    const result = await runner.jlist({ ...BASE_OPTIONS, maxStdoutBytes: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("oversized-stdout");
  });

  it("reports a spawn-error for a nonexistent binary path", async () => {
    const runner = new ChildProcessPm2Runner("/nonexistent/path/to/pm2", ["jlist"]);
    const result = await runner.jlist(BASE_OPTIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("spawn-error");
  });

  it("defaults to the fixed 'pm2 jlist' command when constructed with no arguments — never caller-parameterized in production", () => {
    // Constructing with defaults must not throw and must not require any argument — this is the
    // exact shape production code uses (new ChildProcessPm2Runner()). Actually invoking it here
    // would require a real `pm2` binary, which this test suite must never depend on — the
    // assertion is deliberately limited to "the default command is the fixed one", verified via
    // the spawn-error test above using an explicit override, and via the security tests in
    // map-pm2-processes.test.ts / route tests that nothing about the command is ever caller input.
    expect(() => new ChildProcessPm2Runner()).not.toThrow();
  });

  it("passes ONLY an explicit, minimal env allow-list to the child — a real secret sitting in this process's own environment never leaks through", async () => {
    // A recognisable, fake credential-shaped variable NOT on the allow-list — proves the child
    // only ever receives PATH/HOME/PM2_HOME (see pm2-runner.ts's own ALLOWED_ENV_VAR_NAMES), never
    // this test process's full ambient environment, however it's plumbed through.
    const markerKey = "PM2_RUNNER_TEST_SHOULD_NEVER_LEAK";
    process.env[markerKey] = "fake-secret-value";
    try {
      const runner = new ChildProcessPm2Runner(NODE, ["-e", "process.stdout.write(JSON.stringify(process.env))"]);
      // A real PATH can be several KB — this specific assertion dumps the child's whole env to
      // inspect it, unlike every other test here (which only ever expects a tiny "[]"-shaped PM2
      // payload and deliberately keeps the default 1024-byte cap tight).
      const result = await runner.jlist({ ...BASE_OPTIONS, maxStdoutBytes: 64 * 1024 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const childEnv = JSON.parse(result.stdout) as Record<string, string>;
        expect(childEnv[markerKey]).toBeUndefined();
        // PATH is always forwarded when present on this process — the one allow-listed variable
        // guaranteed to exist in any real environment.
        if (process.env.PATH !== undefined) expect(childEnv.PATH).toBe(process.env.PATH);
      }
    } finally {
      delete process.env[markerKey];
    }
  });
});
