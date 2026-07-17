import { describe, it, expect } from "vitest";
import type { FlowStep } from "../shared/ir.ts";
import type { WebViewInspectorNode } from "../src/api.ts";
import {
  applyLocatorToStep,
  nodeLocator,
  nodeMatchesQuery,
  SELECTOR_ACTIONS,
  subtreeMatchesQuery,
} from "../src/webview-tree.ts";

/**
 * E17 (WebView-aware inspector, src/ half). Covers the pure helpers `src/components/
 * WebViewInspector.tsx` is a thin renderer over — no JSX, no fetch, no live device needed.
 */

function node(over: Partial<WebViewInspectorNode> = {}): WebViewInspectorNode {
  return { tag: "div", children: [], ...over };
}

describe("nodeLocator — targetId preferred over text (spec AC1: click-to-select)", () => {
  it("prefers testId, but returns both when a node has both", () => {
    const n = node({ tag: "button", testId: "spin_button", text: "Spin" });
    expect(nodeLocator(n)).toEqual({ targetId: "spin_button", text: "Spin" });
  });

  it("falls back to text-only when there's no testId", () => {
    const n = node({ tag: "span", text: "Số dư" });
    expect(nodeLocator(n)).toEqual({ targetId: undefined, text: "Số dư" });
  });

  it("returns undefined for a bare layout node with neither text nor testId", () => {
    const n = node({ tag: "div" });
    expect(nodeLocator(n)).toBeUndefined();
  });
});

describe("applyLocatorToStep — fills a step's OWN selector field(s) (spec AC1)", () => {
  it("sets both text and targetId on a tapText-like step (has both fields)", () => {
    const step = { id: "s1", action: "tapText" } as FlowStep;
    const next = applyLocatorToStep(step, { targetId: "login-submit-button", text: "Đăng nhập" });
    expect(next).toMatchObject({ targetId: "login-submit-button", text: "Đăng nhập" });
  });

  it("never introduces a targetId key on a TEXT-ONLY action (assertVisible schema quirk)", () => {
    const step = { id: "s1", action: "assertVisible", text: "placeholder" } as FlowStep;
    const next = applyLocatorToStep(step, { targetId: "balance-label", text: "Số dư" });
    expect(next).toMatchObject({ text: "Số dư" });
    expect(next).not.toHaveProperty("targetId");
  });

  it("leaves a text-only action's step UNCHANGED when the picked locator has no text at all", () => {
    const step = { id: "s1", action: "tapIfVisible", text: "Đóng" } as FlowStep;
    const next = applyLocatorToStep(step, { targetId: "close-button" });
    expect(next).toBe(step);
  });

  it("leaves a non-selector-bearing action's step completely UNCHANGED", () => {
    const step = { id: "s1", action: "waitMs", ms: 500 } as FlowStep;
    const next = applyLocatorToStep(step, { targetId: "x", text: "y" });
    expect(next).toBe(step);
  });

  it("leaves a step unchanged when the locator is empty (no text, no targetId)", () => {
    const step = { id: "s1", action: "tapText" } as FlowStep;
    const next = applyLocatorToStep(step, {});
    expect(next).toBe(step);
  });

  it("SELECTOR_ACTIONS matches the action set applyLocatorToStep actually honors", () => {
    for (const action of SELECTOR_ACTIONS) {
      const step = { id: "s1", action, text: "x" } as FlowStep;
      const next = applyLocatorToStep(step, { targetId: "y", text: "z" });
      expect(next).not.toBe(step); // every selector-bearing action IS affected by a real pick
    }
  });
});

describe("nodeMatchesQuery / subtreeMatchesQuery — inspector search filter", () => {
  it("an empty/whitespace query matches everything", () => {
    expect(nodeMatchesQuery(node({ tag: "div" }), "")).toBe(true);
    expect(nodeMatchesQuery(node({ tag: "div" }), "   ")).toBe(true);
  });

  it("matches case-insensitively against tag, text, or testId", () => {
    const n = node({ tag: "button", text: "Nhận thưởng", testId: "claim-reward-button" });
    expect(nodeMatchesQuery(n, "BUTTON")).toBe(true);
    expect(nodeMatchesQuery(n, "nhận")).toBe(true);
    expect(nodeMatchesQuery(n, "CLAIM-REWARD")).toBe(true);
    expect(nodeMatchesQuery(n, "nope")).toBe(false);
  });

  it("subtreeMatchesQuery finds a match on a deeply nested descendant", () => {
    const tree = node({
      tag: "div",
      children: [node({ tag: "section", children: [node({ tag: "button", testId: "spin_button" })] })],
    });
    expect(subtreeMatchesQuery(tree, "spin_button")).toBe(true);
    expect(subtreeMatchesQuery(tree, "does-not-exist")).toBe(false);
  });

  it("subtreeMatchesQuery is true for the node itself even with no children", () => {
    expect(subtreeMatchesQuery(node({ tag: "span", text: "Số dư" }), "số dư")).toBe(true);
  });
});
