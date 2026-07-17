import { describe, it, expect, beforeAll } from "vitest";
import { runFixture, getCheck, type FixtureResult } from "./child-runner.ts";

const EXPECTED_CHECKS = [
  "under-quota-overBy-zero",
  "under-quota-no-candidates",
  "plan-total-bytes",
  "plan-overBy",
  "plan-oldest-first-candidates",
  "refuse-plan-has-candidates",
  "refuses-without-export-or-force",
  "refuse-nothing-touched",
  "export-pruned-count",
  "export-freed-bytes",
  "export-dir-contents",
  "originals-deleted",
  "quota-restored",
  "force-pruned-something",
  "force-no-exports",
  "force-no-export-dir-created",
  "failed-export-plan-has-candidates",
  "failed-export-nothing-deleted",
  "failed-export-all-reported",
  "failed-export-pruned-count-zero",
  "failed-export-freed-bytes-zero",
] as const;

describe("planGc / runGc — retention/GC with export-before-delete (E9 AC7)", () => {
  let result: FixtureResult;
  beforeAll(() => {
    result = runFixture("gc.fixture.ts");
  });

  it("the fixture process completed without crashing", () => {
    expect(result.error).toBeUndefined();
  });

  it.each(EXPECTED_CHECKS)("%s", (name) => {
    const c = getCheck(result, name);
    expect(c.pass, c.detail).toBe(true);
  });
});
