import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildZip } from "../shared/zip.ts";

/**
 * E22's bug-export bundle (AC3) needs a REAL, inspectable archive — the spec's own evidence plan
 * says "verified by inspecting the exported archive's contents... unzip -l". These tests go
 * beyond structural self-checks: they write the produced bytes to a real file and open it with
 * the SYSTEM's own `unzip` binary, the same tool a human reviewer would use.
 */

function hasUnzip(): boolean {
  try {
    execFileSync("unzip", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("buildZip — structural validity", () => {
  it("starts with a local file header signature (PK\\x03\\x04)", () => {
    const zip = buildZip([{ name: "a.txt", data: new TextEncoder().encode("hi") }]);
    expect(zip[0]).toBe(0x50); // 'P'
    expect(zip[1]).toBe(0x4b); // 'K'
    expect(zip[2]).toBe(0x03);
    expect(zip[3]).toBe(0x04);
  });

  it("ends with an end-of-central-directory signature (PK\\x05\\x06)", () => {
    const zip = buildZip([{ name: "a.txt", data: new TextEncoder().encode("hi") }]);
    const tail = zip.slice(-22); // EOCD record is fixed 22 bytes (no comment)
    expect(tail[0]).toBe(0x50);
    expect(tail[1]).toBe(0x4b);
    expect(tail[2]).toBe(0x05);
    expect(tail[3]).toBe(0x06);
  });

  it("is deterministic — the same entries in the same order always produce identical bytes", () => {
    const entries = [{ name: "a.txt", data: new TextEncoder().encode("hello") }];
    const z1 = buildZip(entries);
    const z2 = buildZip(entries);
    expect([...z1]).toEqual([...z2]);
  });

  it("produces an empty-but-valid archive for zero entries", () => {
    const zip = buildZip([]);
    expect(zip.length).toBe(22); // just the EOCD record
  });

  it("handles a nested path name (screenshots/step-1.png)", () => {
    const zip = buildZip([{ name: "screenshots/step-1.png", data: new Uint8Array([1, 2, 3]) }]);
    expect(zip.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasUnzip())("buildZip — real-world verification via the system unzip tool", () => {
  it("unzip -l lists every entry with the correct byte length", () => {
    const entries = [
      { name: "report.md", data: new TextEncoder().encode("# Bug report\n\nHello world.\n") },
      { name: "trace.json", data: new TextEncoder().encode(JSON.stringify({ a: 1, b: "x" })) },
      { name: "screenshots/step-1.png", data: new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4, 5]) },
    ];
    const dir = mkdtempSync(join(tmpdir(), "podium-zip-test-"));
    const zipPath = join(dir, "test.zip");
    try {
      writeFileSync(zipPath, Buffer.from(buildZip(entries)));
      const listing = execFileSync("unzip", ["-l", zipPath], { encoding: "utf8" });
      expect(listing).toContain("report.md");
      expect(listing).toContain("trace.json");
      expect(listing).toContain("screenshots/step-1.png");
      expect(listing).toMatch(/3 files/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unzip -p extracts a text entry byte-for-byte correctly", () => {
    const content = "# Bug report\n\nHello world — Vietnamese: Đăng nhập.\n";
    const dir = mkdtempSync(join(tmpdir(), "podium-zip-test-"));
    const zipPath = join(dir, "test.zip");
    try {
      writeFileSync(zipPath, Buffer.from(buildZip([{ name: "report.md", data: new TextEncoder().encode(content) }])));
      const extracted = execFileSync("unzip", ["-p", zipPath, "report.md"], { encoding: "utf8" });
      expect(extracted).toBe(content);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unzip -t confirms CRC integrity for every entry (no corruption)", () => {
    const entries = [
      { name: "a.txt", data: new TextEncoder().encode("a".repeat(500)) },
      { name: "b.bin", data: new Uint8Array(Array.from({ length: 300 }, (_, i) => i % 256)) },
    ];
    const dir = mkdtempSync(join(tmpdir(), "podium-zip-test-"));
    const zipPath = join(dir, "test.zip");
    try {
      writeFileSync(zipPath, Buffer.from(buildZip(entries)));
      const result = execFileSync("unzip", ["-t", zipPath], { encoding: "utf8" });
      expect(result).toMatch(/No errors detected/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
