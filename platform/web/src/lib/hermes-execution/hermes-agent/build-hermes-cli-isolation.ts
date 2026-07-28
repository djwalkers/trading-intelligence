import * as os from "node:os";

// Prototype 1.0 — Hermes subprocess isolation hardening. The confirmed official Hermes CLI help
// output states plainly (verified live against the installed CLI, read-only, no inference call):
//
//   -z PROMPT, --oneshot PROMPT
//       One-shot mode: send a single prompt and print ONLY the final response text to stdout.
//       ... Tools, memory, rules, and AGENTS.md in the CWD are loaded as normal; approvals are
//       auto-bypassed. Intended for scripts / pipes.
//
//   --safe-mode
//       Troubleshooting mode: disable ALL customizations — user config, AGENTS.md/memory
//       injection, plugins, and MCP servers (implies --ignore-user-config and --ignore-rules)
//
// A one-shot trading-decision call must never run as an unrestricted operational agent — it must
// never load this repository's own AGENTS.md/rules/memory, never execute a tool, never reach an
// MCP server. `--safe-mode` is the officially-supported, documented control for exactly this;
// combining it with a neutral cwd and a minimal environment allow-list is defence-in-depth on top
// of it, not a substitute for it.

/** THE two flags every Hermes one-shot invocation this app ever makes must carry, in this exact
 * order (confirmed against the installed CLI's own usage line: both are top-level optional
 * arguments, order-independent to argparse, but always placed identically here for a stable,
 * auditable invocation). The prompt itself is passed as `--oneshot=<prompt>` (the long-form
 * `--flag=value` join), never as a bare `-z <prompt>` two-token pair — this is what makes prompt
 * content structurally incapable of being parsed as a SEPARATE CLI flag, even if the prompt text
 * itself starts with a dash or looks option-like: argparse always treats `--oneshot=...` as one
 * single, complete token, splitting only on the first `=`, never re-examining what follows it. */
export function buildHermesOneshotArgs(prompt: string): string[] {
  return ["--safe-mode", `--oneshot=${prompt}`];
}

/** Environment variable names that MUST reach the Hermes CLI subprocess for it to run at all
 * (locate its own binary, home directory, locale). Deliberately short — every name NOT on this
 * list is dropped, regardless of what this process's own `process.env` happens to contain.
 *
 * HERMES_HOME (Prototype 1.0 — runtime ordering/isolation hardening): `get_hermes_home()` in the
 * installed CLI's own `hermes_constants.py` reads this env var first, falling back to `$HOME/.hermes`
 * only when it is unset (confirmed via read-only source inspection, no inference call made) — every
 * credential file (.env/config.yaml/auth) is resolved relative to whichever directory that resolves
 * to. If this process's own environment has a non-default HERMES_HOME (an operator running a
 * non-default Hermes profile), dropping it here would silently redirect the subprocess to the
 * DEFAULT profile's own credentials instead — a functional/auth mismatch, not a leak, but still
 * wrong. Forwarded only when already present in this process's own env (buildHermesCliEnv below
 * never invents a value) — every other credential-shaped var remains excluded exactly as before. */
const ALLOWED_ENV_VAR_NAMES = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "HERMES_HOME"] as const;

/** Builds the COMPLETE (never merged with `process.env`) environment for a Hermes CLI subprocess
 * call — an explicit allow-list, not a deny-list, so a newly-added secret (a future
 * `ETORO_API_KEY`-shaped or `SUPABASE_SERVICE_ROLE_KEY`-shaped env var) is safe by default rather
 * than requiring this list to be kept in sync with every credential this app ever adds. Hermes's
 * own provider/model credentials are never read from here at all — they live entirely in
 * `~/.hermes/.env`/`config.yaml`, which the CLI reads for itself once it starts, independent of
 * whatever this process passes it. */
export function buildHermesCliEnv(processEnv: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ALLOWED_ENV_VAR_NAMES) {
    const value = processEnv[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

/** A neutral, non-repository working directory for the Hermes subprocess — never this
 * application's own `process.cwd()` (which is exactly the directory whose AGENTS.md/rules the
 * official CLI's own documentation says get loaded, absent `--safe-mode`). `--safe-mode` already
 * disables that loading regardless (see this file's own top-of-file comment) — this is
 * defence-in-depth, not the only control, and also keeps any session/checkpoint bookkeeping the
 * CLI records about "where it ran" pointed away from this app's own repository path. */
export function buildHermesNeutralCwd(): string {
  return os.tmpdir();
}
