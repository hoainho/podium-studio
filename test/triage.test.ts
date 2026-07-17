import { describe, it, expect } from "vitest";
import { classifyFailure, NEXT_ACTIONS, TRIAGE_CLASSES, type TriageClass, type TriageInput } from "../shared/triage.ts";

/**
 * E22 (Failure-triage panel). AC1: over 50 seeded failure cases (10 per class), the classifier
 * must be correct on >=90% (>=45/50). AC2: each class's next-action matches the fixed lookup
 * table. Since this classifier's rules AND these seeds are both authored here, the bar this test
 * actually enforces is "the rule set is a genuine, non-degenerate discriminator across 5
 * distinct, realistic signal combinations" — not a tautology matching seeds to whatever the
 * classifier already returns.
 */

interface SeededCase {
  expected: TriageClass;
  input: TriageInput;
}

const SELECTOR_ACTIONS = ["tapText", "doubleTap", "longPress", "waitFor", "scrollUntilVisible", "copyText"];
const ASSERTION_ACTIONS = ["assertVisible", "assertNotVisible"];

function pick<T>(arr: T[], i: number): T {
  return arr[i % arr.length];
}

const SEEDS: SeededCase[] = [];

// ── 10 "flake" seeds — passedOnRetry, varying action/attempts/other (irrelevant) signals ──
for (let i = 0; i < 10; i++) {
  SEEDS.push({
    expected: "flake",
    input: {
      action: pick([...SELECTOR_ACTIONS, ...ASSERTION_ACTIONS], i),
      passedOnRetry: true,
      attempts: 2 + (i % 3),
      // Deliberately noisy other fields — flake must win regardless, per the rule's priority.
      selectorMatchCount: i % 2 === 0 ? 0 : 2,
      screenStructureChanged: i % 3 === 0,
    },
  });
}

// ── 10 "bad selector" seeds — selector action, matchCount != 1, screen NOT structurally changed ──
for (let i = 0; i < 10; i++) {
  SEEDS.push({
    expected: "badSelector",
    input: {
      action: pick(SELECTOR_ACTIONS, i),
      attempts: 1,
      selectorMatchCount: i % 2 === 0 ? 0 : 2 + (i % 3), // no-match, or ambiguous
      screenStructureChanged: false,
    },
  });
}

// ── 10 "app changed" seeds — selector action, matchCount != 1, AND structural change ──
for (let i = 0; i < 10; i++) {
  SEEDS.push({
    expected: "appChanged",
    input: {
      action: pick(SELECTOR_ACTIONS, i),
      attempts: 1,
      selectorMatchCount: i % 2 === 0 ? 0 : 3 + (i % 2),
      screenStructureChanged: true,
    },
  });
}

// ── 10 "wrong expected value" seeds — assertion action, clean single match, value mismatch ──
for (let i = 0; i < 10; i++) {
  SEEDS.push({
    expected: "wrongExpectedValue",
    input: {
      action: pick(ASSERTION_ACTIONS, i),
      attempts: 1,
      selectorMatchCount: 1,
      assertionValueMismatch: true,
    },
  });
}

// ── 10 "real app bug" seeds — no flake, no selector problem, no value mismatch: a genuine,
// unexplained failure (e.g. a non-selector action like waitMs/launchApp erroring, or a clean
// selector match with no assertion-value angle at all — a crash/timeout/unexpected exception). ──
for (let i = 0; i < 10; i++) {
  SEEDS.push({
    expected: "realAppBug",
    input: {
      action: pick(["waitMs", "launchApp", "stopApp", "swipe", "tapText"], i),
      attempts: 1,
      selectorMatchCount: i % 2 === 0 ? undefined : 1, // either N/A or a clean match
      assertionValueMismatch: false,
    },
  });
}

describe("classifyFailure — AC1: >=90% (>=45/50) accuracy across 50 seeded cases", () => {
  it("classifies every one of the 50 seeded cases correctly (100%, well above the 90% bar)", () => {
    let correct = 0;
    const mistakes: string[] = [];
    for (const [i, seed] of SEEDS.entries()) {
      const result = classifyFailure(seed.input);
      if (result.triageClass === seed.expected) correct++;
      else mistakes.push(`seed #${i}: expected ${seed.expected}, got ${result.triageClass}`);
    }
    expect(SEEDS).toHaveLength(50);
    if (mistakes.length) console.error(mistakes.join("\n"));
    expect(correct).toBeGreaterThanOrEqual(45);
    expect(correct).toBe(50);
  });

  it("has exactly 10 seeds per class (matches the spec's T2 test matrix)", () => {
    for (const cls of TRIAGE_CLASSES) {
      expect(SEEDS.filter((s) => s.expected === cls)).toHaveLength(10);
    }
  });
});

describe("classifyFailure — per-class spot checks with an explicit reason", () => {
  it("flake: a step that failed then passed on retry, regardless of other noisy signals", () => {
    const result = classifyFailure({ action: "tapText", passedOnRetry: true, attempts: 3, selectorMatchCount: 0 });
    expect(result.triageClass).toBe("flake");
    expect(result.reason).toMatch(/lần thử lại/);
  });

  it("bad selector: no element matched at all, screen otherwise unchanged", () => {
    const result = classifyFailure({ action: "tapText", selectorMatchCount: 0, screenStructureChanged: false });
    expect(result.triageClass).toBe("badSelector");
  });

  it("bad selector: ambiguous match (>1), screen otherwise unchanged", () => {
    const result = classifyFailure({ action: "assertVisible", selectorMatchCount: 3, screenStructureChanged: false });
    expect(result.triageClass).toBe("badSelector");
  });

  it("app changed: no match AND the screen's structure changed", () => {
    const result = classifyFailure({ action: "tapText", selectorMatchCount: 0, screenStructureChanged: true });
    expect(result.triageClass).toBe("appChanged");
  });

  it("wrong expected value: assertion resolved its target fine but the captured value differed", () => {
    const result = classifyFailure({ action: "assertVisible", selectorMatchCount: 1, assertionValueMismatch: true });
    expect(result.triageClass).toBe("wrongExpectedValue");
  });

  it("real app bug: none of the other signals apply — the safe default, not silently dismissed", () => {
    const result = classifyFailure({ action: "waitMs" });
    expect(result.triageClass).toBe("realAppBug");
  });

  it("a clean single selector match with no assertion angle falls through to real app bug, not bad selector", () => {
    const result = classifyFailure({ action: "tapText", selectorMatchCount: 1 });
    expect(result.triageClass).toBe("realAppBug");
  });
});

describe("NEXT_ACTIONS — AC2: fixed next-action per class, exactly one each", () => {
  it("every one of the 5 classes has a distinct, non-empty next-action string", () => {
    const actions = TRIAGE_CLASSES.map((c) => NEXT_ACTIONS[c]);
    expect(actions).toHaveLength(5);
    expect(new Set(actions).size).toBe(5); // all distinct
    for (const a of actions) expect(a.trim().length).toBeGreaterThan(0);
  });

  it("classifyFailure's returned nextAction always matches the fixed lookup table verbatim", () => {
    for (const seed of SEEDS) {
      const result = classifyFailure(seed.input);
      expect(result.nextAction).toBe(NEXT_ACTIONS[result.triageClass]);
    }
  });
});
