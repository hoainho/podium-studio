import { describe, it, expect, beforeAll } from "vitest";
import { runFixture, getCheck, type FixtureResult } from "./child-runner.ts";

// See child-runner.ts for why this runs in a real child `node` process rather than importing
// bridge/db/primary-store.ts (which pulls in `node:sqlite`) directly into this vitest file.

const EXPECTED_CHECKS = [
  "empty-registry-providers",
  "empty-registry-routing",
  "registry-provider-count",
  "openai-compatible-fields-roundtrip",
  "agent-cli-fields-roundtrip",
  "disabled-flag-roundtrips",
  "apiKeyRef-roundtrips-as-unresolved-reference",
  "routing-roundtrips",
  "save-replaces-not-appends",
  "call-log-count",
  "call-log-newest-first",
  "call-log-tokens-roundtrip",
  "call-log-screen-fingerprint-present-for-recovery",
  "call-log-screen-fingerprint-absent-for-authoring",
  "purge-clears-everything",
] as const;

describe("PrimaryStore — E24 AI provider registry + call log", () => {
  let result: FixtureResult;
  beforeAll(() => {
    result = runFixture("ai-registry-store.fixture.ts");
  });

  it("the fixture process completed without crashing", () => {
    expect(result.error).toBeUndefined();
  });

  it.each(EXPECTED_CHECKS)("%s", (name) => {
    const c = getCheck(result, name);
    expect(c.pass, c.detail).toBe(true);
  });
});
