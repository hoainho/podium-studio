import { describe, it, expect, beforeAll } from "vitest";
import { runFixture, getCheck, type FixtureResult } from "./child-runner.ts";

// See child-runner.ts for why this runs in a real child `node` process rather than importing
// bridge/db/primary-store.ts (which pulls in `node:sqlite`) directly into this vitest file.

const EXPECTED_CHECKS = [
  "lesson-id-returned",
  "lesson-starts-unpinned",
  "lesson-recovery-roundtrips",
  "lesson-top-labels-roundtrip",
  "lesson-pinned-after-pinLesson",
  "findLessons-pinnedOnly-finds-it",
  "findLessons-pinnedOnly-excludes-unpinned",
  "selector-memory-idempotent-increments",
  "selector-memory-times-resolved",
  "interstitial-found",
  "interstitial-dismiss-action-roundtrips",
  "interstitial-times-seen-increments",
  "heal-outcome-ranks-net-positive-first",
  "heal-outcome-no-net-positive-returns-undefined",
  "ac7-seeded-5-lessons",
  "ac7-seeded-5-selector-memory",
  "ac7-seeded-5-interstitials",
  "ac7-seeded-5-heal-outcomes",
  "ac7-backup-file-exists",
  "ac7-row-counts-identical",
  "ac7-checksum-matches",
  "ac7-pinned-flag-survived-restore",
] as const;

describe("PrimaryStore — E19 learning store (lessons/selector-memory/interstitial-catalog/heal-outcomes)", () => {
  let result: FixtureResult;
  beforeAll(() => {
    result = runFixture("learning-store.fixture.ts");
  });

  it("the fixture process completed without crashing", () => {
    expect(result.error).toBeUndefined();
  });

  it.each(EXPECTED_CHECKS)("%s", (name) => {
    const c = getCheck(result, name);
    expect(c.pass, c.detail).toBe(true);
  });
});
