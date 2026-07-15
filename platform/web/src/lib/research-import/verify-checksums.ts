import "server-only";
import { createHash } from "node:crypto";
import { ResearchRunImportError, type RunChecksums, type RunFiles } from "./types";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

// Verifies every non-run.json required file's actual sha256 against run.json's own declared
// checksums map. A file present in RunFiles but with no declared checksum is itself treated as a
// failure — an incomplete manifest cannot be partially trusted. First use of node:crypto for
// hashing anywhere in this codebase; no new dependency, it's built into Node.
export function verifyChecksums(files: RunFiles, checksums: RunChecksums): void {
  const actualByFileName: Record<keyof RunChecksums, string> = {
    "hypothesis.md": sha256(files.hypothesisMarkdown),
    "comparison.md": sha256(files.comparisonMarkdown),
    "strategy-v1.py": sha256(files.strategyV1),
    "strategy-v2.py": sha256(files.strategyV2),
    "results-v1.json": sha256(files.resultsV1Json),
    "results-v2.json": sha256(files.resultsV2Json),
  };

  for (const [fileName, actualDigest] of Object.entries(actualByFileName)) {
    const expectedDigest = checksums[fileName as keyof RunChecksums];
    if (!expectedDigest) {
      throw new ResearchRunImportError(
        `run.json does not declare a checksum for "${fileName}" — an incomplete manifest cannot be trusted.`,
        "checksum_mismatch",
      );
    }
    if (expectedDigest.trim().toLowerCase() !== actualDigest) {
      throw new ResearchRunImportError(
        `Checksum mismatch for "${fileName}": run.json declares ${expectedDigest}, computed ${actualDigest}.`,
        "checksum_mismatch",
      );
    }
  }
}
