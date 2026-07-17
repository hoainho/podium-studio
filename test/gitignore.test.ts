import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

/**
 * R2 review fix — security MAJOR: `data/` (E9's SQLite two-tier storage — real run history +
 * artifacts index) was missing from .gitignore entirely, so `git add -A`/a broad `git add .`
 * could stage a live database file straight into the repo. This is a cheap, permanent regression
 * guard: it fails the moment anyone removes the `data/` line, long before a real `git add` mistake
 * would.
 */
describe(".gitignore", () => {
  const gitignore = readFileSync(join(process.cwd(), ".gitignore"), "utf8");
  const lines = gitignore.split("\n").map((l) => l.trim());

  it("ignores data/ (E9 SQLite two-tier storage — never commit a live database file)", () => {
    expect(lines).toContain("data/");
  });

  it("still ignores the other pre-existing sensitive/generated paths (no regression)", () => {
    for (const entry of [".env", ".env.*", "artifacts/", "node_modules/"]) {
      expect(lines).toContain(entry);
    }
  });
});
