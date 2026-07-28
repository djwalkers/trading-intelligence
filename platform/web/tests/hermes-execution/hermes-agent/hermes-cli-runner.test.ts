import { describe, expect, it } from "vitest";
import * as os from "node:os";
import { ChildProcessHermesCliRunner } from "@/lib/hermes-execution/hermes-agent/hermes-cli-runner";

// Prototype 1.0 — official Hermes Agent decision integration. Exercises the REAL subprocess runner
// against harmless local `node -e` one-liners only — never the actual Hermes CLI, never a network
// call. This is the one file in this suite that spawns a real child process at all, and it never
// spawns anything except the Node binary already running this test suite.

const NODE = process.execPath;
const BASE_OPTIONS = { timeoutMs: 5000, maxStdoutBytes: 1024, cwd: os.tmpdir(), env: { PATH: process.env.PATH ?? "" } };

describe("ChildProcessHermesCliRunner", () => {
  it("returns stdout on a clean, zero-exit run", async () => {
    const runner = new ChildProcessHermesCliRunner();
    const result = await runner.run(NODE, ["-e", "process.stdout.write('hello')"], BASE_OPTIONS);
    expect(result).toEqual({ ok: true, stdout: "hello" });
  });

  it("reports a non-zero exit code with a stderr excerpt", async () => {
    const runner = new ChildProcessHermesCliRunner();
    const result = await runner.run(NODE, ["-e", "process.stderr.write('boom'); process.exit(3)"], BASE_OPTIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("non-zero-exit");
      if (result.reason === "non-zero-exit") {
        expect(result.exitCode).toBe(3);
        expect(result.stderrExcerpt).toContain("boom");
      }
    }
  });

  it("times out a process that never exits, and kills it", async () => {
    const runner = new ChildProcessHermesCliRunner();
    const result = await runner.run(NODE, ["-e", "setInterval(() => {}, 1000)"], { ...BASE_OPTIONS, timeoutMs: 200 });
    expect(result).toEqual({ ok: false, reason: "timeout", stderrExcerpt: "" });
  });

  it("aborts and reports oversized-stdout once the configured byte limit is exceeded", async () => {
    const runner = new ChildProcessHermesCliRunner();
    const result = await runner.run(NODE, ["-e", "process.stdout.write('x'.repeat(10000))"], { ...BASE_OPTIONS, maxStdoutBytes: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("oversized-stdout");
  });

  it("reports a spawn-error for a nonexistent binary path", async () => {
    const runner = new ChildProcessHermesCliRunner();
    const result = await runner.run("/nonexistent/path/to/hermes", [], BASE_OPTIONS);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("spawn-error");
  });

  describe("subprocess isolation — cwd and env are the caller's own explicit values, never this process's own", () => {
    it("spawns the child in the configured cwd, not this test process's own working directory", async () => {
      const runner = new ChildProcessHermesCliRunner();
      const neutralDir = os.tmpdir();
      const result = await runner.run(NODE, ["-e", "process.stdout.write(process.cwd())"], { ...BASE_OPTIONS, cwd: neutralDir });
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Resolve both sides through realpath — on macOS, os.tmpdir() is itself a symlink
        // (/tmp -> /private/tmp), which process.cwd() reports fully resolved.
        const fsPromises = await import("node:fs/promises");
        expect(await fsPromises.realpath(result.stdout)).toBe(await fsPromises.realpath(neutralDir));
        expect(result.stdout).not.toBe(process.cwd());
      }
    });

    it("passes ONLY the explicit env object — no ambient process.env variable (e.g. a real secret) leaks through unless included", async () => {
      const runner = new ChildProcessHermesCliRunner();
      // A deliberately fake, obviously-not-a-real-PATH value — keeps the child's dumped env small
      // (the real PATH can be several KB, irrelevant to what this test checks) and, since it's
      // fake, also proves the child process's OWN environment is being observed here, not some
      // ambient inherited value coincidentally matching.
      const explicitEnv = { PATH: "/fake-isolated-path-for-this-test-only", HERMES_TEST_MARKER: "only-this-should-appear" };
      const result = await runner.run(NODE, ["-e", "process.stdout.write(JSON.stringify(process.env))"], {
        ...BASE_OPTIONS,
        env: explicitEnv,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const childEnv = JSON.parse(result.stdout) as Record<string, string>;
        expect(childEnv.HERMES_TEST_MARKER).toBe("only-this-should-appear");
        expect(childEnv.PATH).toBe("/fake-isolated-path-for-this-test-only");
        // This test process's own real environment (e.g. a real credential, or its real PATH)
        // never appears in the child's environment — only what was explicitly passed (plus
        // whatever macOS/Node itself always injects regardless of the env object supplied, e.g.
        // __CF_USER_TEXT_ENCODING — never a variable this test itself is responsible for).
        expect(childEnv.HOME).toBeUndefined();
        expect(childEnv.PATH).not.toBe(process.env.PATH);
      }
    });
  });
});
