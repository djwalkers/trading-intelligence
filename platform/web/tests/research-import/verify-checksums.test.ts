import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { verifyChecksums } from "@/lib/research-import/verify-checksums";
import { ResearchRunImportError } from "@/lib/research-import/types";
import type { RunChecksums, RunFiles } from "@/lib/research-import/types";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

const FILES: RunFiles = {
  runJson: "{}",
  hypothesisMarkdown: "# Hypothesis",
  comparisonMarkdown: "# Comparison",
  strategyV1: "print('v1')",
  strategyV2: "print('v2')",
  resultsV1Json: '{"sharpe":1.1}',
  resultsV2Json: '{"sharpe":1.4}',
};

function validChecksums(): RunChecksums {
  return {
    "hypothesis.md": sha256(FILES.hypothesisMarkdown),
    "comparison.md": sha256(FILES.comparisonMarkdown),
    "strategy-v1.py": sha256(FILES.strategyV1),
    "strategy-v2.py": sha256(FILES.strategyV2),
    "results-v1.json": sha256(FILES.resultsV1Json),
    "results-v2.json": sha256(FILES.resultsV2Json),
  };
}

describe("verifyChecksums", () => {
  it("passes when every declared checksum matches the actual file content", () => {
    expect(() => verifyChecksums(FILES, validChecksums())).not.toThrow();
  });

  it("accepts a declared checksum regardless of case or surrounding whitespace", () => {
    const checksums = validChecksums();
    checksums["hypothesis.md"] = `  ${checksums["hypothesis.md"]!.toUpperCase()}  `;
    expect(() => verifyChecksums(FILES, checksums)).not.toThrow();
  });

  it("rejects with checksum_mismatch when a declared digest doesn't match the actual content", () => {
    const checksums = validChecksums();
    checksums["comparison.md"] = "0".repeat(64);
    try {
      verifyChecksums(FILES, checksums);
      throw new Error("expected verifyChecksums to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ResearchRunImportError);
      expect((error as ResearchRunImportError).reason).toBe("checksum_mismatch");
      expect((error as ResearchRunImportError).message).toContain("comparison.md");
    }
  });

  it("rejects with checksum_mismatch when run.json omits a checksum for a required file", () => {
    const checksums = validChecksums();
    delete checksums["strategy-v2.py"];
    try {
      verifyChecksums(FILES, checksums);
      throw new Error("expected verifyChecksums to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ResearchRunImportError);
      expect((error as ResearchRunImportError).reason).toBe("checksum_mismatch");
      expect((error as ResearchRunImportError).message).toContain("strategy-v2.py");
    }
  });
});
