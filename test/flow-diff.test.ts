import { describe, it, expect } from "vitest";
import type { Flow, FlowStep } from "../shared/ir.ts";
import { diffFlows, mergeFlow, type FlowDiffResult } from "../shared/flow-diff.ts";

/**
 * E21 (In-app collaboration — flow bundles + visual diff/merge). Covers the core 3-way
 * diff/merge algorithm `shared/flow-diff.ts` implements: AC1 (non-overlapping edits merge
 * cleanly, zero Git) and AC4 (a true same-step conflict blocks completion until resolved).
 */

function flow(steps: FlowStep[]): Flow {
  return { schemaVersion: 1, name: "Test", app: { bundleId: "com.example.app", platform: "ios-sim" }, steps };
}

function tap(id: string, text: string): FlowStep {
  return { id, action: "tapText", text } as FlowStep;
}

describe("diffFlows — 3-way, with a common base (AC1 vs AC4)", () => {
  it("AC1: non-overlapping edits by two QAs both auto-merge with zero conflicts", () => {
    const base = flow([tap("s1", "Login"), tap("s2", "Middle"), tap("s3", "Submit")]);
    const mine = flow([tap("s1", "Login (changed by A)"), tap("s2", "Middle"), tap("s3", "Submit")]);
    const theirs = flow([tap("s1", "Login"), tap("s2", "Middle"), tap("s3", "Submit (changed by B)")]);

    const diff = diffFlows(base, mine, theirs);
    expect(diff.hasConflicts).toBe(false);
    expect(diff.usedFallback).toBe(false);
    const s1 = diff.entries.find((e) => e.id === "s1")!;
    const s2 = diff.entries.find((e) => e.id === "s2")!;
    const s3 = diff.entries.find((e) => e.id === "s3")!;
    expect(s1).toMatchObject({ kind: "changed", conflict: false });
    expect(s2).toMatchObject({ kind: "unchanged", conflict: false });
    expect(s3).toMatchObject({ kind: "changed", conflict: false });
  });

  it("AC4: both QAs edit the SAME step differently -> a real conflict, not silently resolved", () => {
    const base = flow([tap("s1", "Login")]);
    const mine = flow([tap("s1", "Login (A's edit)")]);
    const theirs = flow([tap("s1", "Login (B's edit)")]);

    const diff = diffFlows(base, mine, theirs);
    expect(diff.hasConflicts).toBe(true);
    expect(diff.entries[0]).toMatchObject({ id: "s1", kind: "changed", conflict: true });
  });

  it("both sides making the IDENTICAL edit is not a conflict", () => {
    const base = flow([tap("s1", "Login")]);
    const mine = flow([tap("s1", "Login (same edit)")]);
    const theirs = flow([tap("s1", "Login (same edit)")]);

    const diff = diffFlows(base, mine, theirs);
    expect(diff.hasConflicts).toBe(false);
    expect(diff.entries[0]).toMatchObject({ kind: "changed", conflict: false });
  });

  it("a step added only by mine, or only by theirs, is included without conflict", () => {
    const base = flow([tap("s1", "Login")]);
    const mine = flow([tap("s1", "Login"), tap("s2-mine", "Added by A")]);
    const theirs = flow([tap("s1", "Login"), tap("s3-theirs", "Added by B")]);

    const diff = diffFlows(base, mine, theirs);
    expect(diff.hasConflicts).toBe(false);
    expect(diff.entries.map((e) => e.id).sort()).toEqual(["s1", "s2-mine", "s3-theirs"]);
    expect(diff.entries.find((e) => e.id === "s2-mine")).toMatchObject({ kind: "added", conflict: false });
    expect(diff.entries.find((e) => e.id === "s3-theirs")).toMatchObject({ kind: "added", conflict: false });
  });

  it("removed by one side, untouched by the other -> auto-removed, no conflict", () => {
    const base = flow([tap("s1", "Login"), tap("s2", "ToRemove")]);
    const mine = flow([tap("s1", "Login"), tap("s2", "ToRemove")]);
    const theirs = flow([tap("s1", "Login")]); // theirs deleted s2

    const diff = diffFlows(base, mine, theirs);
    expect(diff.hasConflicts).toBe(false);
    expect(diff.entries.find((e) => e.id === "s2")).toMatchObject({ kind: "removed", conflict: false });
  });

  it("removed by one side but CHANGED by the other -> a real conflict (edit-vs-delete)", () => {
    const base = flow([tap("s1", "Login"), tap("s2", "Original")]);
    const mine = flow([tap("s1", "Login"), tap("s2", "A changed this")]);
    const theirs = flow([tap("s1", "Login")]); // theirs deleted s2

    const diff = diffFlows(base, mine, theirs);
    expect(diff.hasConflicts).toBe(true);
    expect(diff.entries.find((e) => e.id === "s2")).toMatchObject({ kind: "removed", conflict: true });
  });

  it("an id added independently on both sides with DIFFERENT content is a conflict", () => {
    const base = flow([tap("s1", "Login")]);
    const mine = flow([tap("s1", "Login"), tap("new-id", "A's new step")]);
    const theirs = flow([tap("s1", "Login"), tap("new-id", "B's new step (different)")]);

    const diff = diffFlows(base, mine, theirs);
    expect(diff.entries.find((e) => e.id === "new-id")).toMatchObject({ kind: "added", conflict: true });
  });

  it("never mutates any input flow", () => {
    const base = flow([tap("s1", "Login")]);
    const mine = flow([tap("s1", "A")]);
    const theirs = flow([tap("s1", "B")]);
    const [beforeBase, beforeMine, beforeTheirs] = [JSON.stringify(base), JSON.stringify(mine), JSON.stringify(theirs)];
    diffFlows(base, mine, theirs);
    expect(JSON.stringify(base)).toBe(beforeBase);
    expect(JSON.stringify(mine)).toBe(beforeMine);
    expect(JSON.stringify(theirs)).toBe(beforeTheirs);
  });
});

describe("diffFlows — conservative 2-way fallback when no base is available", () => {
  it("flags ANY differing shared step as a conflict, never guessing who changed it", () => {
    const mine = flow([tap("s1", "A's version")]);
    const theirs = flow([tap("s1", "B's version")]);

    const diff = diffFlows(undefined, mine, theirs);
    expect(diff.usedFallback).toBe(true);
    expect(diff.hasConflicts).toBe(true);
    expect(diff.entries[0]).toMatchObject({ kind: "changed", conflict: true });
  });

  it("identical content on both sides is still unchanged, not a conflict", () => {
    const mine = flow([tap("s1", "Same")]);
    const theirs = flow([tap("s1", "Same")]);
    const diff = diffFlows(undefined, mine, theirs);
    expect(diff.hasConflicts).toBe(false);
    expect(diff.entries[0]).toMatchObject({ kind: "unchanged" });
  });

  it("one-sided-only ids are still added without conflict even in fallback mode", () => {
    const mine = flow([tap("s1", "A"), tap("only-mine", "x")]);
    const theirs = flow([tap("s1", "A"), tap("only-theirs", "y")]);
    const diff = diffFlows(undefined, mine, theirs);
    expect(diff.hasConflicts).toBe(false);
  });
});

describe("mergeFlow — completes only once every conflict is resolved (AC4)", () => {
  function buildConflictDiff(): FlowDiffResult {
    const base = flow([tap("s1", "Login")]);
    const mine = flow([tap("s1", "A's edit")]);
    const theirs = flow([tap("s1", "B's edit")]);
    return diffFlows(base, mine, theirs);
  }

  it("refuses to complete (returns unresolvedConflicts) when a conflict has no resolution", () => {
    const diff = buildConflictDiff();
    const mine = flow([tap("s1", "A's edit")]);
    const result = mergeFlow(mine, diff, {});
    expect(result.unresolvedConflicts).toEqual(["s1"]);
    expect(result.flow).toBe(mine); // unchanged — merge did NOT silently proceed
  });

  it("completes once the conflict is resolved to 'mine'", () => {
    const diff = buildConflictDiff();
    const mine = flow([tap("s1", "A's edit")]);
    const result = mergeFlow(mine, diff, { s1: "mine" });
    expect(result.unresolvedConflicts).toEqual([]);
    expect(result.flow.steps.map((s) => (s as any).text)).toEqual(["A's edit"]);
  });

  it("completes once the conflict is resolved to 'theirs'", () => {
    const diff = buildConflictDiff();
    const mine = flow([tap("s1", "A's edit")]);
    const result = mergeFlow(mine, diff, { s1: "theirs" });
    expect(result.unresolvedConflicts).toEqual([]);
    expect(result.flow.steps.map((s) => (s as any).text)).toEqual(["B's edit"]);
  });

  it("completes with a fully custom edited step as the resolution", () => {
    const diff = buildConflictDiff();
    const mine = flow([tap("s1", "A's edit")]);
    const custom = tap("s1", "Reconciled by hand");
    const result = mergeFlow(mine, diff, { s1: custom });
    expect(result.unresolvedConflicts).toEqual([]);
    expect((result.flow.steps[0] as any).text).toBe("Reconciled by hand");
  });

  it("AC1 scenario: non-conflicting diff merges with ZERO resolutions supplied", () => {
    const base = flow([tap("s1", "Login"), tap("s2", "Middle"), tap("s3", "Submit")]);
    const mine = flow([tap("s1", "A's edit"), tap("s2", "Middle"), tap("s3", "Submit")]);
    const theirs = flow([tap("s1", "Login"), tap("s2", "Middle"), tap("s3", "B's edit")]);
    const diff = diffFlows(base, mine, theirs);

    const result = mergeFlow(mine, diff, {});
    expect(result.unresolvedConflicts).toEqual([]);
    expect(result.flow.steps.map((s) => (s as any).text)).toEqual(["A's edit", "Middle", "B's edit"]);
  });

  it("a removed step stays removed in the merged flow", () => {
    const base = flow([tap("s1", "Login"), tap("s2", "ToRemove")]);
    const mine = flow([tap("s1", "Login"), tap("s2", "ToRemove")]);
    const theirs = flow([tap("s1", "Login")]);
    const diff = diffFlows(base, mine, theirs);

    const result = mergeFlow(mine, diff, {});
    expect(result.flow.steps.map((s) => s.id)).toEqual(["s1"]);
  });

  it("never mutates `mine`", () => {
    const diff = buildConflictDiff();
    const mine = flow([tap("s1", "A's edit")]);
    const before = JSON.stringify(mine);
    mergeFlow(mine, diff, { s1: "theirs" });
    expect(JSON.stringify(mine)).toBe(before);
  });
});
