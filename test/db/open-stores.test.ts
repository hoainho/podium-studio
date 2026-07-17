import { describe, it, expect, beforeAll } from "vitest";
import { runFixture, getCheck, type FixtureResult } from "./child-runner.ts";

const EXPECTED_CHECKS = [
  "primary-error-still-propagates",
  "cache-opened-despite-primary-failure",
  "cache-usable-despite-primary-failure",
] as const;

describe("openStores — cache opened independently of primary (E9 review-fix D5)", () => {
  let result: FixtureResult;
  beforeAll(() => {
    result = runFixture("open-stores.fixture.ts");
  });

  it("the fixture process completed without crashing", () => {
    expect(result.error).toBeUndefined();
  });

  it.each(EXPECTED_CHECKS)("%s", (name) => {
    const c = getCheck(result, name);
    expect(c.pass, c.detail).toBe(true);
  });
});
