/**
 * zip.ts — a minimal, dependency-free ZIP (store-only, no compression) writer.
 *
 * E22's bug-export bundle (AC3) needs a REAL, inspectable archive (the spec's own evidence plan
 * says "verified by inspecting the exported archive's contents against this checklist" via
 * `unzip -l`) — not a JSON envelope wearing a `.zip` extension. Rather than pull in a new npm
 * dependency (a packaging-footprint/Tauri-bundle-size concern the E8 desktop-packaging epic
 * already cares about, and out of this epic's own scope to decide), this implements the ZIP
 * local-file-header + central-directory + end-of-central-directory format directly — "stored"
 * (uncompressed) entries only, which is a fully valid, standard ZIP variant that every real
 * unzip tool opens correctly. Pure and isomorphic: works from plain byte arrays, no Node
 * Buffer/browser Blob API dependency, so both `src/bug-export.ts` (browser) and any future
 * bridge/CLI reuse can call it unchanged.
 */

export interface ZipEntry {
  /** Path inside the archive, e.g. "trace.json" or "screenshots/step-3-after.png". */
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** MS-DOS date/time packed fields ZIP requires — a fixed, arbitrary-but-valid timestamp (the
 * exact value has zero bearing on archive validity or content, only on the file manager's
 * displayed "modified" column). */
const DOS_TIME = 0;
const DOS_DATE = 0x21; // 1980-01-01, the DOS epoch — the earliest representable date

function writeUint32LE(out: number[], value: number) {
  out.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
}
function writeUint16LE(out: number[], value: number) {
  out.push(value & 0xff, (value >>> 8) & 0xff);
}

/**
 * Build a valid ZIP archive (store/uncompressed entries) from a list of named byte buffers.
 * Deterministic: the same entries in the same order always produce byte-identical output (no
 * wall-clock timestamp embedded), which makes this straightforward to test.
 */
export function buildZip(entries: ZipEntry[]): Uint8Array {
  const localParts: number[] = [];
  const centralParts: number[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = utf8Bytes(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const localHeaderStart = offset;
    // Local file header (30 bytes fixed + name).
    writeUint32LE(localParts, 0x04034b50);
    writeUint16LE(localParts, 20); // version needed to extract
    writeUint16LE(localParts, 0); // general purpose flag
    writeUint16LE(localParts, 0); // compression method: 0 = stored
    writeUint16LE(localParts, DOS_TIME);
    writeUint16LE(localParts, DOS_DATE);
    writeUint32LE(localParts, crc);
    writeUint32LE(localParts, size); // compressed size == size (stored)
    writeUint32LE(localParts, size); // uncompressed size
    writeUint16LE(localParts, nameBytes.length);
    writeUint16LE(localParts, 0); // extra field length
    for (const b of nameBytes) localParts.push(b);
    for (const b of entry.data) localParts.push(b);
    offset = localHeaderStart + 30 + nameBytes.length + size;

    // Central directory file header (46 bytes fixed + name).
    writeUint32LE(centralParts, 0x02014b50);
    writeUint16LE(centralParts, 20); // version made by
    writeUint16LE(centralParts, 20); // version needed to extract
    writeUint16LE(centralParts, 0); // general purpose flag
    writeUint16LE(centralParts, 0); // compression method: stored
    writeUint16LE(centralParts, DOS_TIME);
    writeUint16LE(centralParts, DOS_DATE);
    writeUint32LE(centralParts, crc);
    writeUint32LE(centralParts, size);
    writeUint32LE(centralParts, size);
    writeUint16LE(centralParts, nameBytes.length);
    writeUint16LE(centralParts, 0); // extra field length
    writeUint16LE(centralParts, 0); // file comment length
    writeUint16LE(centralParts, 0); // disk number start
    writeUint16LE(centralParts, 0); // internal file attributes
    writeUint32LE(centralParts, 0); // external file attributes
    writeUint32LE(centralParts, localHeaderStart);
    for (const b of nameBytes) centralParts.push(b);
  }

  const centralDirectoryOffset = offset;
  const centralDirectorySize = centralParts.length;

  const endParts: number[] = [];
  writeUint32LE(endParts, 0x06054b50);
  writeUint16LE(endParts, 0); // disk number
  writeUint16LE(endParts, 0); // disk with central directory start
  writeUint16LE(endParts, entries.length); // entries on this disk
  writeUint16LE(endParts, entries.length); // total entries
  writeUint32LE(endParts, centralDirectorySize);
  writeUint32LE(endParts, centralDirectoryOffset);
  writeUint16LE(endParts, 0); // comment length

  return new Uint8Array([...localParts, ...centralParts, ...endParts]);
}
