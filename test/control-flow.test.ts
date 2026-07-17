import { describe, it, expect } from "vitest";
import {
  validateFlow,
  toPodiumSteps,
  stepToPodium,
  describeStep,
  containerChildren,
  withContainerChildren,
  collectCapturedVariables,
  type Flow,
  type FlowStep,
  type IfStep,
  type RepeatStep,
} from "../shared/ir.ts";
import { flowToMaestroYaml, stepToMaestroLines } from "../shared/maestro.ts";
import { lintFlow, type ScreenElement } from "../shared/lint.ts";
import { parseSteps, stepsToText } from "../shared/parse-steps.ts";

/**
 * E4 (Non-tech control-flow + oracle authoring). Covers everything that's verifiable
 * without a live device/simulator: schema, Maestro export, lint recursion, and the Text
 * DSL round-trip (spec AC2). The moderated-usability ACs (AC1, AC4-AC6, which require a
 * real non-technical Vietnamese QA session) are out of scope for this file — see the
 * epic's own review gate for those.
 */

function baseFlow(steps: FlowStep[]): Flow {
  return {
    schemaVersion: 1,
    name: "Control-flow Fixture Flow",
    app: { bundleId: "com.example.app", platform: "ios-sim" },
    steps,
  };
}

const ifStep = (then: FlowStep[], overrides: Partial<IfStep> = {}): IfStep => ({
  id: "if1",
  action: "if",
  when: { text: "Popup" },
  then,
  ...overrides,
});

const repeatStep = (steps: FlowStep[], overrides: Partial<RepeatStep> = {}): RepeatStep => ({
  id: "repeat1",
  action: "repeat",
  times: 3,
  steps,
  ...overrides,
});

describe("IR schema — if/repeat containers (E4)", () => {
  it("validates a flow with a top-level if container", () => {
    const flow = baseFlow([
      { id: "s1", action: "screenshot" },
      ifStep([{ id: "s2", action: "tapText", text: "Close" }]),
      { id: "s3", action: "assertVisible", text: "Home" },
    ]);
    const result = validateFlow(flow);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("validates a flow with a top-level repeat container", () => {
    const flow = baseFlow([
      repeatStep([{ id: "s2", action: "tapText", text: "Retry" }]),
      { id: "s3", action: "assertVisible", text: "Done" },
    ]);
    expect(validateFlow(flow).ok).toBe(true);
  });

  it("validates nested containers (if inside repeat, arbitrary depth)", () => {
    const flow = baseFlow([
      repeatStep([
        ifStep([{ id: "s3", action: "tapText", text: "Close" }], { id: "if-nested" }),
      ], { id: "repeat-outer" }),
      { id: "s4", action: "assertVisible", text: "Done" },
    ]);
    expect(validateFlow(flow).ok).toBe(true);
  });

  it("rejects an if/repeat with 0 children (schema requires min 1)", () => {
    const flow = baseFlow([ifStep([]), { id: "s2", action: "assertVisible", text: "X" }]);
    // Zod's .min(1) on `then` fails schema validation for an empty array.
    (flow.steps[0] as any).then = [];
    expect(validateFlow(flow).ok).toBe(false);
  });

  it("rejects an unknown action even nested inside a container", () => {
    const flow = baseFlow([
      ifStep([{ id: "bad", action: "doBackflip" } as any]),
      { id: "s2", action: "assertVisible", text: "X" },
    ]);
    expect(validateFlow(flow).ok).toBe(false);
  });

  it("detects duplicate step ids even when one copy is nested inside a container", () => {
    const flow = baseFlow([
      { id: "dup", action: "screenshot" },
      ifStep([{ id: "dup", action: "tapText", text: "Close" }]),
    ]);
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/Duplicate step ids/);
    expect(result.errors.join(" ")).toMatch(/dup/);
  });

  it("describeStep summarizes if/repeat with child counts", () => {
    expect(describeStep(ifStep([{ id: "s1", action: "screenshot" }]))).toMatch(/If "Popup" is visible/);
    expect(describeStep(ifStep([{ id: "s1", action: "screenshot" }], { when: { text: "Popup", visible: false } })))
      .toMatch(/If "Popup" is NOT visible/);
    expect(describeStep(repeatStep([{ id: "s1", action: "screenshot" }]))).toMatch(/Repeat 3x/);
    expect(describeStep(repeatStep([{ id: "s1", action: "screenshot" }], { times: undefined, whileVisible: "Loading" })))
      .toMatch(/Repeat while "Loading"/);
  });

  it("toPodiumSteps skips containers (they're never native)", () => {
    const flow = baseFlow([
      { id: "s1", action: "screenshot" },
      ifStep([{ id: "s2", action: "tapText", text: "Close" }]),
    ]);
    const v = validateFlow(flow);
    expect(v.ok).toBe(true);
    const podiumSteps = toPodiumSteps(v.flow!);
    expect(podiumSteps).toEqual([{ action: "screenshot" }]);
  });

  it("stepToPodium throws if handed a container directly (defensive — should never happen upstream)", () => {
    expect(() => stepToPodium(ifStep([{ id: "s1", action: "screenshot" }]))).toThrow(/control-flow container/);
  });

  it("containerChildren / withContainerChildren round-trip", () => {
    const step = repeatStep([{ id: "s1", action: "screenshot" }]);
    expect(containerChildren(step)).toEqual([{ id: "s1", action: "screenshot" }]);
    const replaced = withContainerChildren(step, [{ id: "s2", action: "screenshot" }]) as RepeatStep;
    expect(replaced.steps).toEqual([{ id: "s2", action: "screenshot" }]);
    expect(containerChildren({ id: "leaf", action: "screenshot" })).toBeUndefined();
  });

  it("collectCapturedVariables finds captureAs at every nesting depth, deduped", () => {
    const flow = baseFlow([
      { id: "s1", action: "copyText", text: "OTP", captureAs: "otp_code" },
      ifStep([
        { id: "s2", action: "copyText", text: "Ref", captureAs: "ref_code" },
        { id: "s3", action: "copyText", text: "OTP again", captureAs: "otp_code" }, // dup name
      ]),
    ]);
    expect(collectCapturedVariables(flow.steps)).toEqual(["otp_code", "ref_code"]);
  });
});

describe("Maestro export — if/repeat compile to nested blocks (E4)", () => {
  it("compiles an `if` container to a runFlow/when block with indented nested commands", () => {
    const lines = stepToMaestroLines(ifStep([{ id: "s1", action: "tapText", text: "Close" }]));
    expect(lines[0]).toBe("- runFlow:");
    expect(lines).toContain("    when:");
    expect(lines.some((l) => l.includes('visible: "Popup"'))).toBe(true);
    expect(lines).toContain("    commands:");
    // nested command is indented one level deeper than `commands:` and matches the leaf's own rendering
    expect(lines.some((l) => l.trim() === '- tapOn:')).toBe(true);
  });

  it("compiles `if not <text>` to a notVisible condition", () => {
    const lines = stepToMaestroLines(ifStep([{ id: "s1", action: "screenshot" }], { when: { text: "Popup", visible: false } }));
    expect(lines.some((l) => l.includes('notVisible: "Popup"'))).toBe(true);
  });

  it("compiles a fixed-count `repeat` to times/commands", () => {
    const lines = stepToMaestroLines(repeatStep([{ id: "s1", action: "screenshot" }], { times: 5 }));
    expect(lines[0]).toBe("- repeat:");
    expect(lines).toContain("    times: 5");
    expect(lines).toContain("    commands:");
  });

  it("compiles a `whileVisible` repeat to a while/visible block", () => {
    const lines = stepToMaestroLines(repeatStep([{ id: "s1", action: "screenshot" }], { times: undefined, whileVisible: "Loading" }));
    expect(lines).toContain("    while:");
    expect(lines.some((l) => l.includes('visible: "Loading"'))).toBe(true);
  });

  it("recurses through nested containers when compiling a whole flow", () => {
    const flow = baseFlow([
      repeatStep([ifStep([{ id: "s3", action: "screenshot" }], { id: "if-nested" })], { id: "repeat-outer" }),
    ]);
    const yaml = flowToMaestroYaml(flow);
    expect(yaml).toMatch(/- repeat:/);
    expect(yaml).toMatch(/- runFlow:/);
    expect(yaml).toMatch(/takeScreenshot/);
  });
});

describe("lintFlow — recurses into containers (E4)", () => {
  it("counts an assertion INSIDE an if container toward the no-assertion rule", () => {
    const flow = baseFlow([
      { id: "s1", action: "tap", x: 1, y: 2 },
      ifStep([{ id: "s2", action: "assertVisible", text: "Home" }]),
    ]);
    const result = lintFlow(flow);
    expect(result.findings.some((f) => f.class === "no-assertion")).toBe(false);
  });

  it("still flags no-assertion when no assertion exists anywhere, including inside containers", () => {
    const flow = baseFlow([
      ifStep([{ id: "s1", action: "tapText", text: "Close" }]),
      repeatStep([{ id: "s2", action: "screenshot" }]),
    ]);
    const result = lintFlow(flow);
    expect(result.findings.some((f) => f.class === "no-assertion")).toBe(true);
  });

  it("flags ambiguous-match for a step nested inside a repeat container", () => {
    const flow = baseFlow([
      repeatStep([{ id: "s1", action: "tapText", text: "Continue" }]),
      { id: "s2", action: "assertVisible", text: "Done" },
    ]);
    const elements: ScreenElement[] = [{ text: "Continue" }, { text: "Continue" }];
    const result = lintFlow(flow, () => elements);
    const finding = result.findings.find((f) => f.class === "ambiguous-match" && f.stepId === "s1");
    expect(finding?.matchCount).toBe(2);
  });

  it("flags a mistyped `if` condition itself as no-match (the condition is a selector too)", () => {
    const flow = baseFlow([
      ifStep([{ id: "s1", action: "tapText", text: "Close" }], { when: { text: "Ghost popup" } }),
      { id: "s2", action: "assertVisible", text: "Done" },
    ]);
    const result = lintFlow(flow, () => [{ text: "Something else" }]);
    const finding = result.findings.find((f) => f.class === "no-match" && f.stepId === "if1");
    expect(finding).toBeDefined();
  });

  it("an unconditional exit INSIDE an if body does not mark steps AFTER the container (at the parent level) unreachable", () => {
    const flow = baseFlow([
      ifStep([
        { id: "s1", action: "stopApp" },
        { id: "s2", action: "screenshot" }, // unreachable — same scope, after the exit
      ]),
      { id: "s3", action: "assertVisible", text: "Done" }, // NOT unreachable — parent scope, container was conditional
    ]);
    const result = lintFlow(flow);
    const unreachableIds = result.findings.filter((f) => f.class === "unreachable").map((f) => f.stepId);
    expect(unreachableIds).toEqual(["s2"]);
  });
});

describe("Text DSL — if/repeat block syntax + round-trip (E4 AC2)", () => {
  it("parses an if/end block", () => {
    const { steps, issues } = parseSteps(`
if Popup:
  tap Close
end
assert Home
    `);
    expect(issues).toEqual([]);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ action: "if", when: { text: "Popup" } });
    expect((steps[0] as IfStep).then).toMatchObject([{ action: "tapText", text: "Close" }]);
    expect(steps[1]).toMatchObject({ action: "assertVisible", text: "Home" });
  });

  it("parses 'if not <text>:' as a NOT-visible condition", () => {
    const { steps } = parseSteps(`if not Popup:\n  screenshot\nend`);
    expect(steps[0]).toMatchObject({ action: "if", when: { text: "Popup", visible: false } });
  });

  it("parses a fixed-count repeat block", () => {
    const { steps, issues } = parseSteps(`repeat 3:\n  tap Retry\nend`);
    expect(issues).toEqual([]);
    expect(steps[0]).toMatchObject({ action: "repeat", times: 3 });
    expect((steps[0] as RepeatStep).steps).toMatchObject([{ action: "tapText", text: "Retry" }]);
  });

  it("parses a 'repeat while <text>:' block", () => {
    const { steps } = parseSteps(`repeat while Loading:\n  screenshot\nend`);
    expect(steps[0]).toMatchObject({ action: "repeat", whileVisible: "Loading" });
  });

  it("supports nested blocks (if inside repeat)", () => {
    const { steps, issues } = parseSteps(`
repeat 2:
  if Popup:
    tap Close
  end
  tap Continue
end
    `);
    expect(issues).toEqual([]);
    const outer = steps[0] as RepeatStep;
    expect(outer.action).toBe("repeat");
    expect(outer.steps).toHaveLength(2);
    expect(outer.steps[0].action).toBe("if");
    expect(outer.steps[1]).toMatchObject({ action: "tapText", text: "Continue" });
  });

  it("reports an issue for an unclosed block instead of silently dropping it", () => {
    const { issues } = parseSteps(`if Popup:\n  tap Close`);
    expect(issues.some((i) => /unclosed block/i.test(i.error))).toBe(true);
  });

  it("reports an issue for a stray 'end' with nothing open", () => {
    const { issues } = parseSteps(`tap Login\nend`);
    expect(issues.some((i) => /no matching/i.test(i.error))).toBe(true);
  });

  it("reports an issue for an empty block (0 steps before end)", () => {
    const { issues } = parseSteps(`if Popup:\nend`);
    expect(issues.some((i) => /no steps/i.test(i.error))).toBe(true);
  });

  // A container freshly added via the visual editor starts with an EMPTY condition
  // (step-defaults.ts's newStep("if")/newStep("repeat")) — round-tripping that
  // mid-edit state through stepsToText produces a header-shaped-but-empty line like
  // "if :", caught live in a real browser session. It must report the SAME targeted
  // "needs a condition" error as a manually-typed empty header, not a confusing
  // "unknown command" (the generic fallback every other malformed line gets).
  it("gives a targeted error (not 'unknown command') for a header-shaped line with an empty condition", () => {
    // "if :" fails to open a block at all (no valid condition to key on), so the
    // `screenshot` line underneath becomes an ordinary top-level step and the trailing
    // `end` is a legitimate stray-end issue — both expected, alongside the targeted error.
    const ifResult = parseSteps(`if :\n  screenshot\nend`);
    expect(ifResult.issues.some((i) => /"if" needs a condition/.test(i.error))).toBe(true);
    expect(ifResult.issues.some((i) => /unknown command/i.test(i.error))).toBe(false);
    expect(ifResult.issues.some((i) => /no matching/i.test(i.error))).toBe(true);

    const repeatResult = parseSteps(`repeat while :\n  screenshot\nend`);
    expect(repeatResult.issues.some((i) => /needs a count or condition/.test(i.error))).toBe(true);
    expect(repeatResult.issues.some((i) => /unknown command/i.test(i.error))).toBe(false);
  });

  it("round-trips a flow with if/repeat containers through stepsToText -> parseSteps with 0 diff (AC2)", () => {
    const original = parseSteps(`
tap Login
if Popup:
  tap Close
  assert Welcome
end
repeat 3:
  tap Retry
end
screenshot
    `).steps;
    const text = stepsToText(original);
    const reparsed = parseSteps(text);
    expect(reparsed.issues).toEqual([]);
    // ids are ephemeral bookkeeping (freshly generated on every parse), so compare
    // everything else — action shape, nesting, and field values — for byte-identical content.
    const strip = (s: FlowStep): unknown => {
      const { id, ...rest } = s as any;
      if (rest.then) rest.then = rest.then.map(strip);
      if (rest.steps) rest.steps = rest.steps.map(strip);
      return rest;
    };
    expect(reparsed.steps.map(strip)).toEqual(original.map(strip));
  });
});
