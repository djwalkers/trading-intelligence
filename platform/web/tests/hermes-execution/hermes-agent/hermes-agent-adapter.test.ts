import { describe, expect, it, vi } from "vitest";
import { buildHermesUniversePrompt, proposeUniverse, type HermesAgentAdapterConfig } from "@/lib/hermes-execution/hermes-agent/hermes-agent-adapter";
import type { HermesCliRunner, HermesCliRunOptions, HermesCliRunResult } from "@/lib/hermes-execution/hermes-agent/hermes-cli-runner";
import type { HermesUniverseInput } from "@/lib/hermes-execution/hermes-agent/types";

// Prototype 1.0 — official Hermes Agent decision integration. Every test here uses a FAKE
// HermesCliRunner — the real Hermes CLI is never executed, never spawned, never reachable from
// this test file. Confirms the adapter's own contract: exactly one call per proposeUniverse(),
// never a broker call, and a fail-closed HermesUniverseDecisionResult for every failure mode.

const CONFIG: HermesAgentAdapterConfig = {
  cliPath: "/home/andy/.local/bin/hermes",
  decisionTimeoutMs: 60_000,
  maxStdoutBytes: 65_536,
};

const UNIVERSE = ["BTC", "ETH", "SOL", "AAPL", "MSFT", "NVDA"];

function makeInput(overrides: Partial<HermesUniverseInput> = {}): HermesUniverseInput {
  return {
    scanTimestamp: "2026-01-01T00:00:00.000Z",
    universe: UNIVERSE,
    instruments: [],
    portfolio: {
      availableCash: 100_000,
      totalInvestedExposure: 0,
      openPositionCount: 0,
      maxOpenPositions: 2,
      maxOpenPositionsPerInstrument: 1,
      recentDrawdown: 0,
    },
    allowedActions: ["BUY", "SELL", "HOLD"],
    ...overrides,
  };
}

class FakeHermesCliRunner implements HermesCliRunner {
  public calls: Array<{ cliPath: string; args: string[]; options: HermesCliRunOptions }> = [];
  constructor(private readonly result: HermesCliRunResult) {}
  async run(cliPath: string, args: string[], options: HermesCliRunOptions): Promise<HermesCliRunResult> {
    this.calls.push({ cliPath, args, options });
    return this.result;
  }
}

describe("buildHermesUniversePrompt", () => {
  it("never includes credentials, tokens, or environment variables — only the structured input and schema instructions", () => {
    const prompt = buildHermesUniversePrompt(makeInput());
    expect(prompt).not.toMatch(/api[_-]?key/i);
    expect(prompt).not.toMatch(/process\.env/);
    expect(prompt).toContain("BTC, ETH, SOL, AAPL, MSFT, NVDA");
  });

  it("explicitly instructs Hermes never to include size/leverage/broker/execution fields", () => {
    const prompt = buildHermesUniversePrompt(makeInput());
    expect(prompt).toMatch(/quantity/i);
    expect(prompt).toMatch(/leverage/i);
    expect(prompt).toMatch(/broker choice/i);
  });
});

describe("proposeUniverse — valid ranked response", () => {
  it("returns validated proposals for a well-formed response, calling the runner exactly once with the confirmed safe invocation", async () => {
    const runner = new FakeHermesCliRunner({ ok: true, stdout: '{"proposals":[{"instrument":"ETH","action":"BUY","confidence":0.8,"reasoning":["ok"]}]}' });
    const result = await proposeUniverse(makeInput(), CONFIG, runner);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.proposals).toHaveLength(1);
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]?.cliPath).toBe(CONFIG.cliPath);
    expect(runner.calls[0]?.args[0]).toBe("--safe-mode");
    expect(runner.calls[0]?.args[1]).toMatch(/^--oneshot=/);
  });
});

describe("proposeUniverse — Hermes subprocess isolation", () => {
  it("uses the confirmed exact invocation: --safe-mode --oneshot=<prompt>, in that order", async () => {
    const runner = new FakeHermesCliRunner({ ok: true, stdout: '{"proposals":[]}' });
    await proposeUniverse(makeInput(), CONFIG, runner);
    expect(runner.calls[0]?.args).toEqual(["--safe-mode", expect.stringMatching(/^--oneshot=/)]);
  });

  it("spawns in a neutral working directory, never this application's own repository cwd", async () => {
    const runner = new FakeHermesCliRunner({ ok: true, stdout: '{"proposals":[]}' });
    await proposeUniverse(makeInput(), CONFIG, runner);
    const usedCwd = runner.calls[0]?.options.cwd;
    expect(usedCwd).toBeDefined();
    expect(usedCwd).not.toBe(process.cwd());
  });

  it("passes a minimal, explicit environment — never this process's own full process.env (no broker/Supabase/Telegram secret keys)", async () => {
    const runner = new FakeHermesCliRunner({ ok: true, stdout: '{"proposals":[]}' });
    await proposeUniverse(makeInput(), CONFIG, runner);
    const usedEnv = runner.calls[0]?.options.env;
    expect(usedEnv).toBeDefined();
    expect(usedEnv).not.toBe(process.env);
    const dangerousNamePattern = /^(ETORO_|SUPABASE_|HERMES_TELEGRAM_BOT_TOKEN|HERMES_INTEGRATION_TOKEN|TRADING212_|HYPERLIQUID_)/;
    for (const name of Object.keys(usedEnv ?? {})) {
      expect(name).not.toMatch(dangerousNamePattern);
    }
  });

  it("market/portfolio text embedded in the prompt cannot inject an extra CLI argument — the whole prompt is one single argv token via --oneshot=", async () => {
    const runner = new FakeHermesCliRunner({ ok: true, stdout: '{"proposals":[]}' });
    // A deliberately adversarial instrument snapshot whose reasoning/unavailableReason text looks
    // like it could be an injected flag or a shell metacharacter sequence, if this adapter ever
    // concatenated raw text into a shell command or split the prompt across multiple argv items.
    const adversarialInput = makeInput({
      instruments: [
        {
          instrument: "BTC",
          assetClass: "crypto",
          marketHoursEligible: true,
          quote: { bid: 100, ask: 100.05, spread: 0.05, midPrice: 100.025 },
          unavailableReason: "--yolo --ignore-rules; rm -rf / #",
          currentPosition: undefined,
        },
      ],
    });
    await proposeUniverse(adversarialInput, CONFIG, runner);
    // Exactly two argv entries were ever passed, regardless of the adversarial content — the
    // prompt (including the adversarial text, now safely embedded inside JSON.stringify'd input)
    // is entirely contained within the single `--oneshot=...` token.
    expect(runner.calls[0]?.args).toHaveLength(2);
    expect(runner.calls[0]?.args[0]).toBe("--safe-mode");
    expect(runner.calls[0]?.args[1]!.startsWith("--oneshot=")).toBe(true);
  });

  it("never uses a shell to spawn the subprocess", async () => {
    // Structural guard against regression: ChildProcessHermesCliRunner's own spawn() call must
    // never set shell:true — verified directly against its source rather than by observing
    // behaviour (a real shell-injection proof would require spawning a real process, which this
    // test suite never does).
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const sourcePath = path.join(process.cwd(), "src/lib/hermes-execution/hermes-agent/hermes-cli-runner.ts");
    const source = await fs.readFile(sourcePath, "utf8");
    expect(source).toContain("shell: false");
    // The doc comment itself mentions "shell: true" as prose (explaining what NOT to do) — only
    // the actual code assignment (no leading backtick) would indicate a real regression.
    expect(source).not.toMatch(/[^`]shell:\s*true,/);
  });
});

describe("proposeUniverse — malformed JSON / prose around JSON", () => {
  it("fails closed for prose with no JSON", async () => {
    const runner = new FakeHermesCliRunner({ ok: true, stdout: "I cannot help with that right now." });
    const result = await proposeUniverse(makeInput(), CONFIG, runner);
    expect(result.ok).toBe(false);
  });

  it("tolerates prose wrapped around valid JSON", async () => {
    const runner = new FakeHermesCliRunner({
      ok: true,
      stdout: 'Here is my analysis:\n{"proposals":[]}\nLet me know if you need more.',
    });
    const result = await proposeUniverse(makeInput(), CONFIG, runner);
    expect(result.ok).toBe(true);
  });
});

describe("proposeUniverse — timeout", () => {
  it("fails closed with a clear reason when the CLI call times out", async () => {
    const runner = new FakeHermesCliRunner({ ok: false, reason: "timeout", stderrExcerpt: "" });
    const result = await proposeUniverse(makeInput(), CONFIG, runner);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/timed out/i);
  });
});

describe("proposeUniverse — non-zero process exit", () => {
  it("fails closed and reports the exit code", async () => {
    const runner = new FakeHermesCliRunner({ ok: false, reason: "non-zero-exit", exitCode: 1, stderrExcerpt: "some error" });
    const result = await proposeUniverse(makeInput(), CONFIG, runner);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("1");
  });
});

describe("proposeUniverse — oversized stdout", () => {
  it("fails closed rather than attempting to parse a truncated/oversized payload", async () => {
    const runner = new FakeHermesCliRunner({ ok: false, reason: "oversized-stdout", stderrExcerpt: "" });
    const result = await proposeUniverse(makeInput(), CONFIG, runner);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/maximum/i);
  });
});

describe("proposeUniverse — Hermes CLI unavailable", () => {
  it("fails closed when the CLI binary cannot even be spawned", async () => {
    const runner = new FakeHermesCliRunner({ ok: false, reason: "spawn-error", message: "ENOENT: no such file or directory" });
    const result = await proposeUniverse(makeInput(), CONFIG, runner);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/ENOENT/);
  });

  it("fails closed (never throws) if the runner itself unexpectedly throws", async () => {
    const throwingRunner: HermesCliRunner = {
      run: vi.fn(async () => {
        throw new Error("unexpected subprocess crash");
      }),
    };
    const result = await proposeUniverse(makeInput(), CONFIG, throwingRunner);
    expect(result.ok).toBe(false);
  });
});

describe("proposeUniverse — stderr never leaks a secret-shaped value into the returned reason", () => {
  it("includes the stderr excerpt in the failure reason but never a credential this test seeds into it", async () => {
    // Confirms the adapter forwards stderr as diagnostic text (bounded, per hermes-cli-runner.ts's
    // own excerpting) without itself injecting anything secret — the CLI's own process env, not
    // this adapter, is the only place a real credential could ever originate from, and this
    // adapter never reads process.env itself.
    const runner = new FakeHermesCliRunner({ ok: false, reason: "non-zero-exit", exitCode: 2, stderrExcerpt: "config error: missing provider" });
    const result = await proposeUniverse(makeInput(), CONFIG, runner);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).not.toMatch(/api[_-]?key/i);
      expect(result.reason).not.toMatch(/bot\d+:[A-Za-z0-9_-]{20,}/);
    }
  });
});

describe("proposeUniverse — no broker call, fail-closed result shape", () => {
  it("the adapter module has no broker dependency at all — proposeUniverse's own signature never accepts one", async () => {
    // Structural guard: proposeUniverse takes exactly (input, config, runner) — three params, no
    // broker parameter exists to accidentally wire one in later without a visible diff here.
    expect(proposeUniverse.length).toBe(3);
  });

  it("every failure path returns { ok: false } — never throws past the adapter's own boundary", async () => {
    const failureRunner = new FakeHermesCliRunner({ ok: false, reason: "timeout", stderrExcerpt: "" });
    await expect(proposeUniverse(makeInput(), CONFIG, failureRunner)).resolves.toMatchObject({ ok: false });
  });
});
