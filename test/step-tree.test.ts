import { describe, it, expect } from "vitest";
import type { FlowStep } from "../shared/ir.ts";
import {
  getAtPath,
  setAtPath,
  deleteAtPath,
  moveAtPath,
  insertAtPath,
  duplicateAtPath,
  toggleDisabledAtPath,
} from "../src/step-tree.ts";

/** [ s0, if1 { then: [ s1a, s1b ] }, s2 ] — a 2-level fixture reused across tests. */
function fixture(): FlowStep[] {
  return [
    { id: "s0", action: "screenshot" },
    {
      id: "if1",
      action: "if",
      when: { text: "Popup" },
      then: [
        { id: "s1a", action: "tapText", text: "Close" },
        { id: "s1b", action: "screenshot" },
      ],
    },
    { id: "s2", action: "assertVisible", text: "Home" },
  ];
}

let idCounter = 0;
const freshId = () => `fresh-${++idCounter}`;

describe("step-tree — path-based editing (E4)", () => {
  it("getAtPath resolves a top-level and a nested step", () => {
    const steps = fixture();
    expect(getAtPath(steps, [0])).toMatchObject({ id: "s0" });
    expect(getAtPath(steps, [1, 1])).toMatchObject({ id: "s1b" });
    expect(getAtPath(steps, [1, 5])).toBeUndefined(); // out of range
    expect(getAtPath(steps, [0, 0])).toBeUndefined(); // s0 isn't a container — no children to descend into
  });

  it("setAtPath replaces only the targeted step, preserving everything else by reference", () => {
    const steps = fixture();
    const next = setAtPath(steps, [1, 0], { id: "s1a", action: "tapText", text: "Dismiss" });
    expect(getAtPath(next, [1, 0])).toMatchObject({ text: "Dismiss" });
    expect(next[0]).toBe(steps[0]); // untouched sibling is the SAME object (structural sharing)
    expect(next[2]).toBe(steps[2]);
  });

  it("deleteAtPath removes a nested step without touching its siblings", () => {
    const steps = fixture();
    const next = deleteAtPath(steps, [1, 0]);
    const container = getAtPath(next, [1]) as any;
    expect(container.then).toHaveLength(1);
    expect(container.then[0].id).toBe("s1b");
  });

  it("deleteAtPath removes a whole top-level container (and its children go with it)", () => {
    const steps = fixture();
    const next = deleteAtPath(steps, [1]);
    expect(next.map((s) => s.id)).toEqual(["s0", "s2"]);
  });

  it("moveAtPath swaps adjacent nested siblings and is a no-op at a list edge", () => {
    const steps = fixture();
    const moved = moveAtPath(steps, [1, 1], -1);
    const container = getAtPath(moved, [1]) as any;
    expect(container.then.map((s: FlowStep) => s.id)).toEqual(["s1b", "s1a"]);

    const noop = moveAtPath(steps, [0], -1); // already first at top level
    expect(noop).toBe(steps);
  });

  it("insertAtPath appends into a container's own children list, not the top level", () => {
    const steps = fixture();
    const next = insertAtPath(steps, [1], { id: "new", action: "screenshot" });
    const container = getAtPath(next, [1]) as any;
    expect(container.then.map((s: FlowStep) => s.id)).toEqual(["s1a", "s1b", "new"]);
    expect(next).toHaveLength(3); // top level unchanged in length
  });

  it("insertAtPath at the top level (empty parent path) inserts at the given index", () => {
    const steps = fixture();
    const next = insertAtPath(steps, [], { id: "new", action: "screenshot" }, 1);
    expect(next.map((s) => s.id)).toEqual(["s0", "new", "if1", "s2"]);
  });

  it("duplicateAtPath deep-clones a container with ALL descendants getting fresh ids", () => {
    idCounter = 0;
    const steps = fixture();
    const next = duplicateAtPath(steps, [1], freshId);
    expect(next).toHaveLength(4);
    const original = next[1] as any;
    const clone = next[2] as any;
    expect(original.id).toBe("if1"); // original untouched
    expect(clone.id).not.toBe("if1");
    expect(clone.then).toHaveLength(2);
    expect(clone.then[0].id).not.toBe("s1a");
    expect(clone.then[0].text).toBe("Close"); // content copied correctly
    expect(clone.then[1].id).not.toBe("s1b");
  });

  it("duplicateAtPath on a nested leaf inserts right after it, inside the same container", () => {
    idCounter = 0;
    const steps = fixture();
    const next = duplicateAtPath(steps, [1, 0], freshId);
    const container = getAtPath(next, [1]) as any;
    expect(container.then).toHaveLength(3);
    expect(container.then[0].id).toBe("s1a");
    expect(container.then[1].text).toBe("Close");
    expect(container.then[1].id).not.toBe("s1a");
  });

  it("toggleDisabledAtPath flips disabled on a container as a single unit", () => {
    const steps = fixture();
    const next = toggleDisabledAtPath(steps, [1]);
    expect(getAtPath(next, [1])).toMatchObject({ disabled: true });
    const back = toggleDisabledAtPath(next, [1]);
    expect(getAtPath(back, [1])).toMatchObject({ disabled: false });
  });
});
