import { describe, expect, it } from "vitest";
import { buildHermesCliEnv, buildHermesNeutralCwd, buildHermesOneshotArgs } from "@/lib/hermes-execution/hermes-agent/build-hermes-cli-isolation";

// Prototype 1.0 — Hermes subprocess isolation hardening. buildHermesCliEnv is an explicit
// allow-list, never a deny-list (see the module's own doc comment) — these tests confirm both
// directions: every allow-listed name (including the newly added HERMES_HOME) is forwarded ONLY
// when present in the source environment, and every credential-shaped name is dropped regardless
// of what the source environment contains.

describe("buildHermesCliEnv — default (HOME-based) Hermes configuration", () => {
  it("forwards PATH/HOME/LANG/LC_ALL/TERM/TMPDIR when present, and omits HERMES_HOME when unset", () => {
    const source = {
      PATH: "/usr/bin",
      HOME: "/Users/andy",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TERM: "xterm-256color",
      TMPDIR: "/tmp",
    };
    const env = buildHermesCliEnv(source as unknown as NodeJS.ProcessEnv);
    expect(env).toEqual(source);
    expect(env.HERMES_HOME).toBeUndefined();
  });
});

describe("buildHermesCliEnv — explicit HERMES_HOME (non-default Hermes profile)", () => {
  it("forwards HERMES_HOME verbatim when present in the source environment", () => {
    const source = { PATH: "/usr/bin", HOME: "/Users/andy", HERMES_HOME: "/Users/andy/.hermes-alt-profile" };
    const env = buildHermesCliEnv(source as unknown as NodeJS.ProcessEnv);
    expect(env.HERMES_HOME).toBe("/Users/andy/.hermes-alt-profile");
  });

  it("never invents a HERMES_HOME value that wasn't already present in the source environment", () => {
    const env = buildHermesCliEnv({ PATH: "/usr/bin" } as unknown as NodeJS.ProcessEnv);
    expect("HERMES_HOME" in env).toBe(false);
  });
});

describe("buildHermesCliEnv — never forwards credential-shaped variables", () => {
  it("drops ETORO_*/SUPABASE_*/TELEGRAM_*/HERMES_INTEGRATION_TOKEN regardless of what the source environment contains", () => {
    const source = {
      PATH: "/usr/bin",
      HOME: "/Users/andy",
      HERMES_HOME: "/Users/andy/.hermes",
      ETORO_API_KEY: "secret-etoro-key",
      ETORO_USER_KEY: "secret-etoro-user-key",
      SUPABASE_SERVICE_ROLE_KEY: "secret-supabase-key",
      HERMES_TELEGRAM_BOT_TOKEN: "secret-telegram-token",
      HERMES_INTEGRATION_TOKEN: "secret-integration-token",
      TRADING212_API_KEY: "secret-t212-key",
      HYPERLIQUID_TESTNET_PRIVATE_KEY: "secret-private-key",
    };
    const env = buildHermesCliEnv(source as unknown as NodeJS.ProcessEnv);
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/Users/andy", HERMES_HOME: "/Users/andy/.hermes" });
  });
});

describe("buildHermesOneshotArgs / buildHermesNeutralCwd — unchanged by the HERMES_HOME addition", () => {
  it("still returns exactly --safe-mode and a single --oneshot=<prompt> token", () => {
    const args = buildHermesOneshotArgs("hello world");
    expect(args).toEqual(["--safe-mode", "--oneshot=hello world"]);
  });

  it("still returns a neutral, non-repository cwd", () => {
    expect(buildHermesNeutralCwd()).not.toBe(process.cwd());
  });
});
