import { describe, it, expect } from "vitest";
import type { Flow, FlowStep } from "../shared/ir.ts";
import { acceptedCount, allHunksDecided, applyAcceptedHunks, type CoPilotSuggestion } from "../src/copilot-diff.ts";

/**
 * E24-ui — co-pilot review-diff apply logic (AC7: "0 writes land... before an explicit per-hunk
 * accept"). The core property under test throughout: nothing is ever applied without an explicit
 * "accept" decision recorded for that exact hunk — an undecided or rejected hunk is a no-op.
 */

function flow(steps: FlowStep[]): Flow {
  return { schemaVersion: 1, name: "Test", app: { bundleId: "com.example.app", platform: "ios-sim" }, steps };
}

function tap(id: string, text: string): FlowStep {
  return { id, action: "tapText", text } as FlowStep;
}

function suggestion(hunks: CoPilotSuggestion["hunks"]): CoPilotSuggestion {
  return { requestSummary: "test request", hunks };
}

describe("applyAcceptedHunks — AC7: only explicitly accepted hunks are ever applied", () => {
  it("applies an 'add' hunk when accepted", () => {
    const f = flow([tap("s1", "Login")]);
    const s = suggestion([{ id: "h1", kind: "add", description: "add a spin tap", step: tap("s2", "Spin") }]);
    const result = applyAcceptedHunks(f, s, { h1: "accept" });
    expect(result.steps.map((st) => st.id)).toEqual(["s1", "s2"]);
  });

  it("does NOT apply an 'add' hunk left undecided", () => {
    const f = flow([tap("s1", "Login")]);
    const s = suggestion([{ id: "h1", kind: "add", description: "add a spin tap", step: tap("s2", "Spin") }]);
    const result = applyAcceptedHunks(f, s, {});
    expect(result.steps.map((st) => st.id)).toEqual(["s1"]);
  });

  it("does NOT apply an 'add' hunk explicitly rejected", () => {
    const f = flow([tap("s1", "Login")]);
    const s = suggestion([{ id: "h1", kind: "add", description: "add a spin tap", step: tap("s2", "Spin") }]);
    const result = applyAcceptedHunks(f, s, { h1: "reject" });
    expect(result.steps.map((st) => st.id)).toEqual(["s1"]);
  });

  it("applies a 'change' hunk to the correct target step, leaving others untouched", () => {
    const f = flow([tap("s1", "Login"), tap("s2", "Old text")]);
    const s = suggestion([{ id: "h1", kind: "change", description: "reword s2", targetStepId: "s2", step: tap("s2", "New text") }]);
    const result = applyAcceptedHunks(f, s, { h1: "accept" });
    expect((result.steps[1] as any).text).toBe("New text");
    expect((result.steps[0] as any).text).toBe("Login");
  });

  it("applies a 'remove' hunk, deleting only the targeted step", () => {
    const f = flow([tap("s1", "Login"), tap("s2", "ToRemove")]);
    const s = suggestion([{ id: "h1", kind: "remove", description: "drop s2", targetStepId: "s2" }]);
    const result = applyAcceptedHunks(f, s, { h1: "accept" });
    expect(result.steps.map((st) => st.id)).toEqual(["s1"]);
  });

  it("applies multiple accepted hunks together, skipping the rejected/undecided ones", () => {
    const f = flow([tap("s1", "Login"), tap("s2", "Old")]);
    const s = suggestion([
      { id: "h1", kind: "add", description: "add", step: tap("s3", "New step") },
      { id: "h2", kind: "change", description: "change", targetStepId: "s2", step: tap("s2", "Changed") },
      { id: "h3", kind: "remove", description: "remove", targetStepId: "s1" },
    ]);
    const result = applyAcceptedHunks(f, s, { h1: "accept", h2: "reject" }); // h3 undecided
    expect(result.steps.map((st) => st.id)).toEqual(["s1", "s2", "s3"]);
    expect((result.steps[1] as any).text).toBe("Old"); // h2 rejected, unchanged
  });

  it("a suggestion with zero accepted hunks leaves the flow byte-for-byte the same (same reference)", () => {
    const f = flow([tap("s1", "Login")]);
    const s = suggestion([{ id: "h1", kind: "add", description: "x", step: tap("s2", "y") }]);
    const result = applyAcceptedHunks(f, s, {});
    expect(result).toBe(f); // reference identity preserved when nothing changed
  });

  it("never mutates the original flow object", () => {
    const f = flow([tap("s1", "Login")]);
    const before = JSON.stringify(f);
    const s = suggestion([{ id: "h1", kind: "add", description: "x", step: tap("s2", "y") }]);
    applyAcceptedHunks(f, s, { h1: "accept" });
    expect(JSON.stringify(f)).toBe(before);
  });
});

describe("acceptedCount / allHunksDecided", () => {
  it("acceptedCount counts only accepted hunks", () => {
    const s = suggestion([
      { id: "h1", kind: "add", description: "x" },
      { id: "h2", kind: "add", description: "y" },
      { id: "h3", kind: "add", description: "z" },
    ]);
    expect(acceptedCount(s, { h1: "accept", h2: "reject", h3: "accept" })).toBe(2);
  });

  it("acceptedCount is 0 for an empty decisions map", () => {
    const s = suggestion([{ id: "h1", kind: "add", description: "x" }]);
    expect(acceptedCount(s, {})).toBe(0);
  });

  it("allHunksDecided is false until every hunk has a decision", () => {
    const s = suggestion([
      { id: "h1", kind: "add", description: "x" },
      { id: "h2", kind: "add", description: "y" },
    ]);
    expect(allHunksDecided(s, { h1: "accept" })).toBe(false);
    expect(allHunksDecided(s, { h1: "accept", h2: "reject" })).toBe(true);
  });

  it("allHunksDecided is vacuously true for a suggestion with no hunks", () => {
    expect(allHunksDecided(suggestion([]), {})).toBe(true);
  });
});
