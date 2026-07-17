import { describe, it, expect, beforeAll } from "vitest";
import { runFixture, getCheck, type FixtureResult } from "./child-runner.ts";

const EXPECTED_CHECKS = [
  "ac2-run-present-before-delete",
  "ac2-run-history-genuinely-gone",
  "ac2-not-flagged-as-recovered",
  "ac3-seeded-10-runs",
  "ac3-backup-file-exists",
  "ac3-row-counts-identical",
  "ac3-checksum-matches",
  "ac3-runs-queryable-after-restore",
  "checksum-order-independent",
  "primary-file-chmod-0600",
  "backup-file-chmod-0600",
  "retention-prunes-old-backups",
  "ac6-open-does-not-crash",
  "ac6-flagged-as-recovered",
  "ac6-pre-corruption-data-survived",
  "quarantine-recovered-flag",
  "quarantine-dir-created",
  "quarantine-file-present",
  "quarantine-bytes-match-pre-restore-file",
  "ac6-no-backup-throws-typed-error",
  "ac6-error-is-PrimaryStoreCorruptedError",
  "run-row-fields",
  "run-results-count",
  "run-results-step2-screenshot",
] as const;

describe("PrimaryStore — Tier 2, NOT rebuildable (E9 AC2/AC3/AC6)", () => {
  let result: FixtureResult;
  beforeAll(() => {
    result = runFixture("primary-store.fixture.ts");
  });

  it("the fixture process completed without crashing", () => {
    expect(result.error).toBeUndefined();
  });

  it.each(EXPECTED_CHECKS)("%s", (name) => {
    const c = getCheck(result, name);
    expect(c.pass, c.detail).toBe(true);
  });
});
