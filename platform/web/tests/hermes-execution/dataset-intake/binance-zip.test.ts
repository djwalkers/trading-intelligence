import { describe, expect, it } from "vitest";
import { extractSingleFileFromZip } from "@/lib/hermes-execution/dataset-intake/binance-zip";
import { buildZipBuffer } from "./binance-fixtures";

// Phase 4 — Historical Dataset Intake. Pure ZIP extraction — no filesystem, no network.

describe("extractSingleFileFromZip", () => {
  it("extracts a deflate-compressed single entry", () => {
    const content = Buffer.from("1704067200000,100,101,99,100.5,10\n");
    const zip = buildZipBuffer("BTCUSDT-1h-2024-01.csv", content, "deflate");
    const result = extractSingleFileFromZip(zip, "BTCUSDT-1h-2024-01.csv");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.fileName).toBe("BTCUSDT-1h-2024-01.csv");
      expect(result.content.toString("utf-8")).toBe(content.toString("utf-8"));
    }
  });

  it("extracts a stored (uncompressed) single entry", () => {
    const content = Buffer.from("hello world");
    const zip = buildZipBuffer("data.csv", content, "store");
    const result = extractSingleFileFromZip(zip, "data.csv");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content.toString("utf-8")).toBe("hello world");
  });

  it("rejects a buffer with no valid End Of Central Directory record", () => {
    const result = extractSingleFileFromZip(Buffer.from("not a zip file at all"), "data.csv");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("INVALID_ZIP");
  });

  it("round-trips larger, realistic CSV content correctly", () => {
    const lines = Array.from({ length: 744 }, (_, i) => `${1704067200000 + i * 3_600_000},100,101,99,100.5,10,${1704070799999 + i * 3_600_000},1005,50,5,502.5,0`);
    const content = Buffer.from(lines.join("\n"));
    const zip = buildZipBuffer("BTCUSDT-1h-2024-01.csv", content);
    const result = extractSingleFileFromZip(zip, "BTCUSDT-1h-2024-01.csv");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.content.equals(content)).toBe(true);
  });

  it("rejects an entry whose internal filename does not match the expected archive filename", () => {
    const content = Buffer.from("hello world");
    const zip = buildZipBuffer("../../etc/passwd", content, "store");
    const result = extractSingleFileFromZip(zip, "BTCUSDT-1h-2024-01.csv");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("UNEXPECTED_FILENAME");
  });

  it("rejects an encrypted entry (general-purpose flag bit 0 set)", () => {
    const content = Buffer.from("hello world");
    const zip = buildZipBuffer("data.csv", content, "store", { flags: 0x1 });
    const result = extractSingleFileFromZip(zip, "data.csv");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("ENCRYPTED_ENTRY");
  });

  it("rejects a declared uncompressed size above the fixed maximum (zip-bomb guard)", () => {
    const content = Buffer.from("hello world");
    const zip = buildZipBuffer("data.csv", content, "store", { declaredUncompressedSize: 100 * 1024 * 1024 });
    const result = extractSingleFileFromZip(zip, "data.csv");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("UNCOMPRESSED_SIZE_TOO_LARGE");
  });

  it("rejects a decompressed entry whose actual size does not match the declared uncompressed size (truncated/corrupt)", () => {
    const content = Buffer.from("hello world, this is more than eleven bytes of content");
    const zip = buildZipBuffer("data.csv", content, "deflate", { declaredUncompressedSize: content.length - 5 });
    const result = extractSingleFileFromZip(zip, "data.csv");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("SIZE_MISMATCH");
  });
});
