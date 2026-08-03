import { deflateRawSync } from "node:zlib";

// Phase 4 — Historical Dataset Intake. Test-only fixture builders — never imported by production
// code. Builds a minimal, valid single-entry ZIP buffer in memory (no filesystem, no network) so
// binance-zip.test.ts / binance-downloader.test.ts / dataset-binance-download-cli.test.ts can all
// exercise the real extraction path without ever needing a real Binance archive. CRC-32 is written as
// 0 throughout — binance-zip.ts deliberately never checks it (see its own doc comment), so a fixture
// with a placeholder CRC is exactly as valid an input as a byte-perfect one for this pipeline's needs.

function writeUInt32LE(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value >>> 0, 0);
  return buf;
}
function writeUInt16LE(value: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value, 0);
  return buf;
}

export interface BuildZipOptions {
  /** General-purpose bit flag written to both the local and central directory headers — bit 0 set
   * marks the entry encrypted. Defaults to 0 (not encrypted). */
  flags?: number;
  /** Overrides the DECLARED uncompressed size in both headers, independent of `content`'s own actual
   * length — lets a test construct an archive whose central directory lies about its own size
   * (truncated/corrupt-archive, or "zip bomb" declared-size-too-large simulation). */
  declaredUncompressedSize?: number;
}

export function buildZipBuffer(fileName: string, content: Buffer, method: "store" | "deflate" = "deflate", options: BuildZipOptions = {}): Buffer {
  const compressionMethod = method === "store" ? 0 : 8;
  const compressedData = method === "store" ? content : deflateRawSync(content);
  const fileNameBuf = Buffer.from(fileName, "utf-8");
  const flags = options.flags ?? 0;
  const declaredUncompressedSize = options.declaredUncompressedSize ?? content.length;

  const localHeader = Buffer.concat([
    writeUInt32LE(0x04034b50),
    writeUInt16LE(20), // version needed
    writeUInt16LE(flags),
    writeUInt16LE(compressionMethod),
    writeUInt16LE(0), // mod time
    writeUInt16LE(0), // mod date
    writeUInt32LE(0), // crc-32 (never checked by binance-zip.ts)
    writeUInt32LE(compressedData.length),
    writeUInt32LE(declaredUncompressedSize),
    writeUInt16LE(fileNameBuf.length),
    writeUInt16LE(0), // extra length
    fileNameBuf,
  ]);
  const localHeaderOffset = 0;

  const centralDirectory = Buffer.concat([
    writeUInt32LE(0x02014b50),
    writeUInt16LE(20), // version made by
    writeUInt16LE(20), // version needed
    writeUInt16LE(flags),
    writeUInt16LE(compressionMethod),
    writeUInt16LE(0),
    writeUInt16LE(0),
    writeUInt32LE(0), // crc-32
    writeUInt32LE(compressedData.length),
    writeUInt32LE(declaredUncompressedSize),
    writeUInt16LE(fileNameBuf.length),
    writeUInt16LE(0), // extra length
    writeUInt16LE(0), // comment length
    writeUInt16LE(0), // disk number start
    writeUInt16LE(0), // internal attributes
    writeUInt32LE(0), // external attributes
    writeUInt32LE(localHeaderOffset),
    fileNameBuf,
  ]);
  const centralDirectoryOffset = localHeader.length + compressedData.length;

  const eocd = Buffer.concat([
    writeUInt32LE(0x06054b50),
    writeUInt16LE(0), // disk number
    writeUInt16LE(0), // disk with CD start
    writeUInt16LE(1), // entries on this disk
    writeUInt16LE(1), // total entries
    writeUInt32LE(centralDirectory.length),
    writeUInt32LE(centralDirectoryOffset),
    writeUInt16LE(0), // comment length
  ]);

  return Buffer.concat([localHeader, compressedData, centralDirectory, eocd]);
}

/** Deterministic, valid Binance monthly kline CSV text (no header row) for exactly one calendar
 * month — every hour present, strictly ascending, in the requested timestamp unit. */
export function buildBinanceMonthCsv(year: number, month: number, unit: "MILLISECONDS" | "MICROSECONDS" = "MILLISECONDS"): string {
  const hours = new Date(Date.UTC(year, month, 0)).getUTCDate() * 24;
  const lines: string[] = [];
  for (let i = 0; i < hours; i++) {
    const ms = Date.UTC(year, month - 1, 1, 0, 0, 0) + i * 3_600_000;
    const openTime = unit === "MILLISECONDS" ? ms : ms * 1000;
    const closeTime = unit === "MILLISECONDS" ? ms + 3_599_999 : ms * 1000 + 3_599_999_000;
    const open = 100 + i * 0.01;
    const close = 100.5 + i * 0.01;
    lines.push(`${openTime},${open.toFixed(2)},${(open + 1).toFixed(2)},${(open - 1).toFixed(2)},${close.toFixed(2)},10,${closeTime},1005,50,5,502.5,0`);
  }
  return lines.join("\n");
}

export function monthDays(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}
