import { describe, it, expect, beforeAll } from "vitest";
import { runFixture, getCheck, type FixtureResult } from "./child-runner.ts";

// See child-runner.ts for why this runs in a real child `node` process rather than importing
// bridge/db/schema.ts (which pulls in `node:sqlite`) directly into this vitest file.

const EXPECTED_CHECKS = [
  "applies-in-order",
  "schema-version-after-apply",
  "v2-column-usable",
  "first-run-applies",
  "second-run-applies-nothing",
  "schema-version-stable",
  "v2-only-new-migration-applied",
  "row-count-preserved",
  "spot-check-content-unchanged",
  "broken-migration-throws",
  "schema-version-not-advanced",
  "rolled-back-ddl-not-committed",
  "upgrade-v1-schema-version",
  "upgrade-only-new-migrations-applied",
  "upgrade-schema-version-after",
  "upgrade-runs-row-preserved",
  "upgrade-run_results-rows-preserved",
  "upgrade-runs-row-count",
  "upgrade-run_results-row-count",
  "primary-schema-version",
  "primary-table-runs-empty",
  "primary-table-run_results-empty",
  "primary-table-artifacts_index-empty",
  "primary-table-learning_store-empty",
  "primary-table-lessons-empty",
  "primary-table-selector_memory-empty",
  "primary-table-interstitial_catalog-empty",
  "primary-table-heal_outcomes-empty",
  "primary-table-ai_providers-empty",
  "primary-table-ai_routing-empty",
  "primary-table-ai_call_log-empty",
  "cache-schema-version",
  "cache-table-flow_index-empty",
] as const;

describe("runMigrations — versioned migration framework (E9 AC4)", () => {
  let result: FixtureResult;
  beforeAll(() => {
    result = runFixture("migrations.fixture.ts");
  });

  it("the fixture process completed without crashing", () => {
    expect(result.error).toBeUndefined();
  });

  it.each(EXPECTED_CHECKS)("%s", (name) => {
    const c = getCheck(result, name);
    expect(c.pass, c.detail).toBe(true);
  });
});
