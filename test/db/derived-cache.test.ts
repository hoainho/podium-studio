import { describe, it, expect, beforeAll } from "vitest";
import { runFixture, getCheck, type FixtureResult } from "./child-runner.ts";

const EXPECTED_CHECKS = [
  "count-after-rebuild",
  "search-by-name",
  "search-by-bundleId",
  "search-no-match",
  "first-rebuild-count",
  "second-rebuild-count",
  "second-rebuild-contents",
  "pre-delete-count",
  "file-actually-deleted",
  "file-recreated",
  "rebuilt-count",
  "rebuilt-search-works",
  "rebuilt-step-count-preserved",
  "corrupt-cache-open-does-not-throw",
  "corrupt-cache-self-healed-empty",
  "corrupt-cache-usable-after-heal",
] as const;

describe("DerivedCache — Tier 1, fully rebuildable from JSON (E9 AC1)", () => {
  let result: FixtureResult;
  beforeAll(() => {
    result = runFixture("derived-cache.fixture.ts");
  });

  it("the fixture process completed without crashing", () => {
    expect(result.error).toBeUndefined();
  });

  it.each(EXPECTED_CHECKS)("%s", (name) => {
    const c = getCheck(result, name);
    expect(c.pass, c.detail).toBe(true);
  });
});
