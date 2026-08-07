import { spawn } from "node:child_process";

// Runtime Processes panel — Operations Centre. THE one place this feature ever spawns a
// subprocess — mirrors hermes-agent/hermes-cli-runner.ts's own established pattern exactly: never
// `shell: true` (so no argument is ever subject to shell interpretation/injection), a bounded
// wall-clock timeout, a bounded stdout buffer, and a typed result union that never throws.
//
// Command/args are constructor-overridable ONLY so tests can substitute a safe binary (the Node
// binary already running the test suite, exactly like hermes-cli-runner.test.ts does) — production
// code always constructs `new ChildProcessPm2Runner()` (the defaults below), so nothing about
// which command runs, or what arguments it receives, is EVER parameterized by a request, a query
// string, or any other caller/browser input. There is no method on this class, or anywhere else in
// this feature, that accepts a process name/command/argument from a caller.

export type Pm2RunResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: "timeout"; stderrExcerpt: string }
  | { ok: false; reason: "non-zero-exit"; exitCode: number; stderrExcerpt: string }
  | { ok: false; reason: "oversized-stdout"; stderrExcerpt: string }
  | { ok: false; reason: "spawn-error"; message: string };

export interface Pm2RunOptions {
  timeoutMs: number;
  maxStdoutBytes: number;
}

export interface Pm2Runner {
  /** Runs the fixed "pm2 jlist" command and returns its outcome. Never throws — every failure
   * mode (timeout, non-zero exit, oversized stdout, a spawn-level error) is a normal, typed return
   * value. */
  jlist(options: Pm2RunOptions): Promise<Pm2RunResult>;
}

const STDERR_EXCERPT_MAX_CHARS = 500;

function excerptStderr(raw: string): string {
  return raw.length > STDERR_EXCERPT_MAX_CHARS ? raw.slice(0, STDERR_EXCERPT_MAX_CHARS) + " (truncated)" : raw;
}

/** Minimal env allow-list PM2's own CLI needs to find its binary and its daemon's home directory —
 * mirrors hermes-agent/build-hermes-cli-isolation.ts's own ALLOWED_ENV_VAR_NAMES convention: an
 * explicit, short list, never `process.env` forwarded wholesale (which would otherwise hand this
 * app's own broker/Supabase/integration-token secrets to a child process that has no legitimate
 * need for any of them). */
const ALLOWED_ENV_VAR_NAMES = ["PATH", "HOME", "PM2_HOME"] as const;

function buildAllowlistedEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ALLOWED_ENV_VAR_NAMES) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export class ChildProcessPm2Runner implements Pm2Runner {
  constructor(
    private readonly command: string = "pm2",
    private readonly args: readonly string[] = ["jlist"],
  ) {}

  async jlist(options: Pm2RunOptions): Promise<Pm2RunResult> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: Pm2RunResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(this.command, [...this.args], {
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
          // NodeJS.ProcessEnv's own ambient type declares extra project-specific keys (e.g.
          // NODE_ENV) as required in this codebase's own type augmentation — buildAllowlistedEnv()
          // is deliberately a plain, minimal Record<string,string> (see hermes-cli-runner.ts's own
          // identical convention), never process.env itself, so a type-level cast is correct here,
          // not a safety compromise.
          env: buildAllowlistedEnv() as NodeJS.ProcessEnv,
        });
      } catch (error) {
        settle({ ok: false, reason: "spawn-error", message: error instanceof Error ? error.message : String(error) });
        return;
      }

      let stdout = "";
      let stderr = "";
      let oversized = false;

      const timer = setTimeout(() => {
        if (settled) return;
        child.kill("SIGKILL");
        settle({ ok: false, reason: "timeout", stderrExcerpt: excerptStderr(stderr) });
      }, options.timeoutMs);

      child.stdout?.on("data", (chunk: Buffer) => {
        if (oversized) return;
        stdout += chunk.toString("utf8");
        if (Buffer.byteLength(stdout, "utf8") > options.maxStdoutBytes) {
          oversized = true;
          child.kill("SIGKILL");
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < STDERR_EXCERPT_MAX_CHARS * 4) stderr += chunk.toString("utf8");
      });

      child.on("error", (error) => {
        clearTimeout(timer);
        settle({ ok: false, reason: "spawn-error", message: error.message });
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (settled) return;
        if (oversized) {
          settle({ ok: false, reason: "oversized-stdout", stderrExcerpt: excerptStderr(stderr) });
          return;
        }
        if (code !== 0) {
          settle({ ok: false, reason: "non-zero-exit", exitCode: code ?? -1, stderrExcerpt: excerptStderr(stderr) });
          return;
        }
        settle({ ok: true, stdout });
      });
    });
  }
}
