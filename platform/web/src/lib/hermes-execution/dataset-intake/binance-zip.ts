import { inflateRawSync } from "node:zlib";

// Phase 4 — Historical Dataset Intake. A deliberately minimal ZIP reader for the ONE shape Binance's
// own monthly archives actually use: a single, non-encrypted CSV entry, stored or deflate-compressed,
// no ZIP64, no multi-disk, no data descriptors. Never a general-purpose ZIP library — pure buffer-in,
// buffer-out, no filesystem/network I/O. CRC-32 is deliberately NOT verified here: the archive's own
// SHA-256 (checked before extraction ever runs — see binance-downloader.ts) is the authoritative
// integrity check for this pipeline; re-deriving CRC-32 on top of that would be redundant, not safer.
//
// Pre-commit review fix. The single entry's own filename is now REQUIRED to exactly equal the
// caller's `expectedFileName` (the CSV name implied by the archive's own URL — see
// binance-archive.ts's own `ArchiveLocation.csvFileName`) — an exact-match requirement that, as a
// side effect, also rejects a directory entry (conventionally trailing "/"), a symlink, an absolute
// path, or a `../` path-traversal name, none of which can ever equal that one fixed expected string.
// The entry is also rejected outright if its general-purpose flag bit 0 (encryption) is set, and its
// declared uncompressed size is bounded (both before AND after decompression) so a maliciously small
// compressed buffer cannot expand into an unbounded "zip bomb."

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const EOCD_FIXED_SIZE = 22;
const ENCRYPTED_FLAG_BIT = 0x1;
// Binance's own monthly kline CSV is at most a few hundred KB uncompressed even for a 31-day month —
// 64 MiB is generously far above that while still bounding a maliciously-crafted archive claiming a
// huge uncompressed size to a fixed, safe amount of memory.
const MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;

export type ZipExtractionResult = { ok: true; fileName: string; content: Buffer } | { ok: false; reason: string; detail: string };

function findEndOfCentralDirectory(buffer: Buffer): number | undefined {
  const searchFloor = Math.max(0, buffer.length - EOCD_FIXED_SIZE - 0xffff); // EOCD comment is at most 65535 bytes
  for (let i = buffer.length - EOCD_FIXED_SIZE; i >= searchFloor; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  return undefined;
}

/**
 * Extracts the SINGLE file entry from a ZIP archive. Rejects outright (never guesses or picks "the
 * first one it can read") if the archive contains zero or more than one entry — a Binance monthly
 * archive is always exactly one CSV file; anything else is an unexpected archive shape. `expectedFileName`
 * must exactly match the entry's own name — never trusted merely because it was the archive's one entry.
 */
export function extractSingleFileFromZip(buffer: Buffer, expectedFileName: string): ZipExtractionResult {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset === undefined) {
    return { ok: false, reason: "INVALID_ZIP", detail: "no End Of Central Directory record found — not a valid ZIP archive" };
  }
  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (entryCount !== 1) {
    return { ok: false, reason: "UNEXPECTED_ENTRY_COUNT", detail: `archive contains ${entryCount} entr(y/ies), expected exactly 1` };
  }
  if (centralDirectoryOffset + centralDirectorySize > buffer.length) {
    return { ok: false, reason: "INVALID_ZIP", detail: "central directory extends past the end of the archive buffer" };
  }

  const cdOffset = centralDirectoryOffset;
  if (buffer.readUInt32LE(cdOffset) !== CENTRAL_DIRECTORY_SIGNATURE) {
    return { ok: false, reason: "INVALID_ZIP", detail: "central directory entry has an unexpected signature" };
  }
  const flags = buffer.readUInt16LE(cdOffset + 8);
  if ((flags & ENCRYPTED_FLAG_BIT) !== 0) {
    return { ok: false, reason: "ENCRYPTED_ENTRY", detail: "archive's single entry is encrypted — never supported" };
  }
  const compressionMethod = buffer.readUInt16LE(cdOffset + 10);
  const compressedSize = buffer.readUInt32LE(cdOffset + 20);
  const uncompressedSize = buffer.readUInt32LE(cdOffset + 24);
  const fileNameLength = buffer.readUInt16LE(cdOffset + 28);
  const extraLength = buffer.readUInt16LE(cdOffset + 30);
  const commentLength = buffer.readUInt16LE(cdOffset + 32);
  const localHeaderOffset = buffer.readUInt32LE(cdOffset + 42);
  const fileName = buffer.toString("utf-8", cdOffset + 46, cdOffset + 46 + fileNameLength);
  void extraLength;
  void commentLength;

  if (fileName !== expectedFileName) {
    return {
      ok: false,
      reason: "UNEXPECTED_FILENAME",
      detail: `archive's single entry is named ${JSON.stringify(fileName)}, not the expected ${JSON.stringify(expectedFileName)} — refusing to trust an unexpected entry name`,
    };
  }
  if (uncompressedSize > MAX_UNCOMPRESSED_BYTES) {
    return { ok: false, reason: "UNCOMPRESSED_SIZE_TOO_LARGE", detail: `declared uncompressed size ${uncompressedSize} exceeds the ${MAX_UNCOMPRESSED_BYTES}-byte maximum for a single Binance monthly archive entry` };
  }

  if (buffer.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_HEADER_SIGNATURE) {
    return { ok: false, reason: "INVALID_ZIP", detail: "local file header has an unexpected signature" };
  }
  const localFileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
  const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
  const dataStart = localHeaderOffset + 30 + localFileNameLength + localExtraLength;
  const dataEnd = dataStart + compressedSize;
  if (dataEnd > buffer.length) {
    return { ok: false, reason: "INVALID_ZIP", detail: "compressed data extends past the end of the archive buffer" };
  }
  const compressedData = buffer.subarray(dataStart, dataEnd);

  let content: Buffer;
  if (compressionMethod === 0) {
    content = Buffer.from(compressedData);
  } else if (compressionMethod === 8) {
    try {
      content = inflateRawSync(compressedData, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
    } catch (error) {
      return { ok: false, reason: "DECOMPRESSION_FAILED", detail: error instanceof Error ? error.message : String(error) };
    }
  } else {
    return { ok: false, reason: "UNSUPPORTED_COMPRESSION", detail: `compression method ${compressionMethod} is not supported (only store=0 and deflate=8 are)` };
  }

  if (content.length !== uncompressedSize) {
    return {
      ok: false,
      reason: "SIZE_MISMATCH",
      detail: `decompressed content is ${content.length} byte(s), expected exactly ${uncompressedSize} declared in the central directory — archive is truncated or corrupt`,
    };
  }

  return { ok: true, fileName, content };
}
