import { spawn } from "node:child_process";

// Prototype 1.0 - official Hermes Agent decision integration. THE one place this app ever spawns
// the installed Hermes CLI as a subprocess - a narrow, duck-typed interface so every other module
// (the adapter, tests) depends on "something that runs a bounded command and returns stdout/
// failure," never on node:child_process directly. Tests always inject a fake implementing this
// interface; the real ChildProcessHermesCliRunner below is never exercised by the test suite.

export type HermesCliRunResult =
  | { ok: true; stdout: string }
  | { ok: false; reason: "timeout"; stderrExcerpt: string }
  | { ok: false; reason: "non-zero-exit"; exitCode: number; stderrExcerpt: string }
  | { ok: false; reason: "oversized-stdout"; stderrExcerpt: string }
  | { ok: false; reason: "spawn-error"; message: string };

export interface HermesCliRunOptions {
  timeoutMs: number;
  maxStdoutBytes: number;
  /** Prototype 1.0 — Hermes subprocess isolation hardening. The working directory the CLI is
   * spawned in — MUST be a neutral directory, never this application's own repository checkout
   * (the official Hermes CLI's own `-z/--oneshot` documentation states plainly: "Tools, memory,
   * rules, and AGENTS.md in the CWD are loaded as normal" — a repository AGENTS.md/rules file
   * sitting in this app's own working directory must never be picked up for a trading-decision
   * call). See build-hermes-cli-env.ts's own doc comment for why `--safe-mode` is the primary
   * control and this is defence-in-depth, not the only line of defence. */
  cwd: string;
  /** Prototype 1.0 — Hermes subprocess isolation hardening. The COMPLETE environment passed to the
   * child process — never `process.env` itself, and never merged with it. Callers must pass an
   * explicit, minimal allow-list (see build-hermes-cli-env.ts) so this application's own broker/
   * Supabase/Telegram/integration-token secrets can never reach the Hermes subprocess, regardless
   * of what environment variables this process happens to be running with. */
  env: Record<string, string>;
}

export interface HermesCliRunner {
  /** Runs the Hermes CLI with `args` and returns its outcome. Never throws - every failure mode
   * (timeout, non-zero exit, oversized stdout, a spawn-level error) is a normal, typed return
   * value, never a raw subprocess exception escaping to the caller. */
  run(cliPath: string, args: string[], options: HermesCliRunOptions): Promise<HermesCliRunResult>;
}

const STDERR_EXCERPT_MAX_CHARS = 500;

/** Bounds the stderr text captured for diagnostics - this is logged/returned for troubleshooting
 * only, never assumed to be free of secrets, but IS length-bounded so a misbehaving process can
 * never spam an unbounded amount of text into this app's own logs or audit trail. */
function excerptStderr(raw: string): string {
  return raw.length > STDERR_EXCERPT_MAX_CHARS ? raw.slice(0, STDERR_EXCERPT_MAX_CHARS) + " (truncated)" : raw;
}

/** The real implementation - spawns the installed Hermes CLI binary directly (never through a
 * shell, so no argument is ever subject to shell interpretation/injection), bounded by both a
 * wall-clock timeout and a maximum stdout byte count. Used only by the live runtime/orchestrator;
 * every test injects a fake HermesCliRunner instead (see hermes-agent-adapter.test.ts). */
export class ChildProcessHermesCliRunner implements HermesCliRunner {
  async run(cliPath: string, args: string[], options: HermesCliRunOptions): Promise<HermesCliRunResult> {
    return new Promise((resolve) => {
      let settled = false;
      const settle = (result: HermesCliRunResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      let child: ReturnType<typeof spawn>;
      try {
        // Never `shell: true` (the default is already false — stated explicitly here so this
        // never silently regresses) — `args` is passed as a real argv array, never concatenated
        // into a shell command line, so no argument is ever subject to shell interpretation.
        // `cwd`/`env` are always the caller's own explicit, minimal values — never this process's
        // own `process.cwd()`/`process.env` (see HermesCliRunOptions's own doc comments).
        child = spawn(cliPath, args, {
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
          cwd: options.cwd,
          // NodeJS.ProcessEnv's own ambient type declares extra project-specific keys (e.g.
          // NODE_ENV) as required in this codebase's own type augmentation — options.env is
          // deliberately a plain, minimal Record<string,string> (see HermesCliRunOptions's own
          // doc comment), never process.env itself, so a type-level cast is correct here, not a
          // safety compromise.
          env: options.env as NodeJS.ProcessEnv,
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
        // Bounded independently of the oversized-stdout guard above - stderr is never the reason
        // this call is aborted, only ever captured (truncated) for diagnostics.
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
