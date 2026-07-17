import type { Flow, FlowStep, StepAction } from "../shared/ir.ts";

/** Default bundle id used across the app when nothing else is known. */
export const DEFAULT_BUNDLE_ID = "com.example.demoapp";

function freshId(): string {
  return crypto.randomUUID();
}

/**
 * Build a valid, minimal FlowStep for a given action, with sensible defaults so it
 * satisfies `stepSchema` the instant it's added to the editor.
 */
export function newStep(action: StepAction): FlowStep {
  const id = freshId();
  switch (action) {
    case "tap": return { id, action: "tap", x: 100, y: 100 };
    case "tapText": return { id, action: "tapText", text: "" };
    case "type": return { id, action: "type", text: "" };
    case "key": return { id, action: "key", key: "enter" };
    case "swipe": return { id, action: "swipe", direction: "up" };
    case "waitFor": return { id, action: "waitFor", text: "", timeoutMs: 10_000 };
    case "waitMs": return { id, action: "waitMs", ms: 1000 };
    case "screenshot": return { id, action: "screenshot" };
    case "assertVisible": return { id, action: "assertVisible", text: "", timeoutMs: 10_000 };
    case "doubleTap": return { id, action: "doubleTap", text: "" };
    case "longPress": return { id, action: "longPress", text: "" };
    case "tapIfVisible": return { id, action: "tapIfVisible", text: "", timeoutMs: 5_000 };
    case "clearText": return { id, action: "clearText" };
    case "deleteText": return { id, action: "deleteText", count: 1 };
    case "hideKeyboard": return { id, action: "hideKeyboard" };
    case "scroll": return { id, action: "scroll", direction: "down" };
    case "scrollUntilVisible": return { id, action: "scrollUntilVisible", text: "" };
    case "back": return { id, action: "back" };
    case "assertNotVisible": return { id, action: "assertNotVisible", text: "", timeoutMs: 5_000 };
    case "waitForNotVisible": return { id, action: "waitForNotVisible", text: "", timeoutMs: 10_000 };
    case "openLink": return { id, action: "openLink", url: "" };
    case "launchApp": return { id, action: "launchApp" };
    case "stopApp": return { id, action: "stopApp" };
    case "copyText": return { id, action: "copyText", text: "" };
    case "pasteText": return { id, action: "pasteText" };
    case "raw": return { id, action: "raw", maestro: "- tapOn: \"...\"" };
    // Control-flow containers (E4) — the schema requires >= 1 child (`.min(1)`), so a
    // freshly-added container starts with one default step, never an empty, unrunnable shell.
    case "if": return { id, action: "if", when: { text: "" }, then: [newStep("screenshot")] };
    case "repeat": return { id, action: "repeat", times: 2, steps: [newStep("screenshot")] };
    // Sub-flow call (E13) — empty flowFile/params are valid per the schema; the gallery/editor
    // UI is what actually fills in a real reference, same as a fresh tapText starts with "".
    case "callSubFlow": return { id, action: "callSubFlow", flowFile: "", params: {} };
  }
}

/** All actions in the closed vocabulary, in the order the palette should show them. */
export const ALL_ACTIONS: StepAction[] = [
  "tapText", "tap", "doubleTap", "longPress", "tapIfVisible",
  "type", "clearText", "deleteText", "pasteText", "copyText", "hideKeyboard",
  "key", "swipe", "scroll", "scrollUntilVisible", "back",
  "waitFor", "waitForNotVisible", "waitMs",
  "assertVisible", "assertNotVisible",
  "screenshot", "openLink", "launchApp", "stopApp", "raw",
  "if", "repeat",
];

/** A brand-new, valid, empty-ish flow to start authoring from. */
export function emptyFlow(): Flow {
  return {
    schemaVersion: 1,
    name: "New flow",
    app: {
      bundleId: DEFAULT_BUNDLE_ID,
      platform: "ios-sim",
    },
    steps: [newStep("screenshot")],
  };
}
