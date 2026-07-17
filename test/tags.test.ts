import { describe, it, expect } from "vitest";
import { validateFlow } from "../shared/ir.ts";
import { collectAllTags, filterFlowsByTags, type Taggable } from "../shared/tags.ts";

/**
 * E18 (Tags/suites + trace/time-travel viewer). Covers the tag-filter helper (spec AC1: "the
 * executed count equals the exact tag-membership count — no extra, no missing") and the
 * additive `tags` schema field's round-trip through validateFlow.
 */

function item(tags?: string[]): Taggable & { file: string } {
  return { file: Math.random().toString(36).slice(2), tags };
}

describe("filterFlowsByTags — exact tag-membership filtering (spec AC1)", () => {
  it("include: keeps only items with at least one matching tag (OR semantics)", () => {
    const items = [item(["smoke"]), item(["checkout"]), item(["smoke", "checkout"]), item(["flaky"])];
    const result = filterFlowsByTags(items, ["smoke"]);
    expect(result).toHaveLength(2);
    expect(result).toContain(items[0]);
    expect(result).toContain(items[2]);
  });

  it("include with multiple tags matches ANY of them, not all", () => {
    const items = [item(["smoke"]), item(["checkout"]), item(["flaky"])];
    const result = filterFlowsByTags(items, ["smoke", "checkout"]);
    expect(result).toHaveLength(2);
  });

  it("exclude: drops any item carrying an excluded tag", () => {
    const items = [item(["smoke"]), item(["flaky"]), item(["smoke", "flaky"])];
    const result = filterFlowsByTags(items, undefined, ["flaky"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(items[0]);
  });

  it("include AND exclude combine: matches an included tag but not an excluded one", () => {
    const items = [item(["smoke"]), item(["smoke", "flaky"]), item(["checkout"])];
    const result = filterFlowsByTags(items, ["smoke"], ["flaky"]);
    expect(result).toEqual([items[0]]);
  });

  it("empty/omitted include+exclude returns everything untouched", () => {
    const items = [item(["a"]), item(undefined), item([])];
    expect(filterFlowsByTags(items)).toEqual(items);
    expect(filterFlowsByTags(items, [], [])).toEqual(items);
  });

  it("an item with no tags never matches a non-empty include filter", () => {
    const items = [item(undefined), item([]), item(["smoke"])];
    const result = filterFlowsByTags(items, ["smoke"]);
    expect(result).toEqual([items[2]]);
  });

  it("the exact-count guarantee: 3 of 10 tagged items produce exactly 3, never more or fewer", () => {
    const items = Array.from({ length: 10 }, (_, i) => item(i < 3 ? ["smoke"] : ["other"]));
    expect(filterFlowsByTags(items, ["smoke"])).toHaveLength(3);
  });
});

describe("collectAllTags", () => {
  it("returns every distinct tag across the list, sorted", () => {
    const items = [item(["b", "a"]), item(["c"]), item(["a"])];
    expect(collectAllTags(items)).toEqual(["a", "b", "c"]);
  });

  it("returns an empty array when nothing has tags", () => {
    expect(collectAllTags([item(undefined), item([])])).toEqual([]);
  });
});

describe("Flow.tags — additive schema round-trip (E18)", () => {
  function makeRawFlow(tags?: string[]): Record<string, unknown> {
    return {
      schemaVersion: 1,
      name: "Tagged flow",
      app: { bundleId: "com.example.app", platform: "ios-sim" },
      steps: [{ id: "s1", action: "screenshot" }],
      ...(tags !== undefined ? { tags } : {}),
    };
  }

  it("a flow with tags validates and round-trips them exactly", () => {
    const v = validateFlow(makeRawFlow(["smoke", "checkout"]));
    expect(v.ok).toBe(true);
    expect(v.flow?.tags).toEqual(["smoke", "checkout"]);
  });

  it("a pre-E18 flow with no tags field at all still validates (backward compatible)", () => {
    const v = validateFlow(makeRawFlow(undefined));
    expect(v.ok).toBe(true);
    expect(v.flow?.tags).toBeUndefined();
  });

  it("an empty tags array validates too", () => {
    const v = validateFlow(makeRawFlow([]));
    expect(v.ok).toBe(true);
    expect(v.flow?.tags).toEqual([]);
  });
});
