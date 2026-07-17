import { describe, it, expect } from "vitest";
import type { Flow, FlowStep } from "../shared/ir.ts";
import {
  buildBundle,
  collectSubFlowFiles,
  collectSubFlowFilesTransitive,
  findUnsafeSteps,
  parseBundle,
  serializeBundle,
  stripUnsafeSteps,
  type FlowBundle,
} from "../shared/bundle.ts";

/**
 * E21 (In-app collaboration — flow bundles). Covers shared/bundle.ts's pure export/import
 * plumbing: round-trip fidelity (AC2) and the raw-step import warning/opt-in gate (AC3).
 */

function flow(steps: FlowStep[], over: Partial<Flow> = {}): Flow {
  return { schemaVersion: 1, name: "Test", app: { bundleId: "com.example.app", platform: "ios-sim" }, steps, ...over };
}

function tap(id: string, text: string): FlowStep {
  return { id, action: "tapText", text } as FlowStep;
}

function callSubFlow(id: string, flowFile: string): FlowStep {
  return { id, action: "callSubFlow", flowFile } as FlowStep;
}

describe("collectSubFlowFiles / collectSubFlowFilesTransitive", () => {
  it("finds a callSubFlow reference at the top level", () => {
    const f = flow([callSubFlow("c1", "login.flow.json")]);
    expect([...collectSubFlowFiles(f)]).toEqual(["login.flow.json"]);
  });

  it("finds a callSubFlow reference nested inside a repeat container", () => {
    const f = flow([{ id: "r1", action: "repeat", times: 1, steps: [callSubFlow("c1", "login.flow.json")] } as FlowStep]);
    expect([...collectSubFlowFiles(f)]).toEqual(["login.flow.json"]);
  });

  it("dedupes multiple calls to the same sub-flow", () => {
    const f = flow([callSubFlow("c1", "login.flow.json"), callSubFlow("c2", "login.flow.json")]);
    expect([...collectSubFlowFiles(f)]).toEqual(["login.flow.json"]);
  });

  it("returns an empty set for a flow with no sub-flow calls", () => {
    const f = flow([tap("s1", "Login")]);
    expect([...collectSubFlowFiles(f)]).toEqual([]);
  });

  it("transitively follows a sub-flow that itself calls another sub-flow", () => {
    const login = flow([tap("s1", "Login")]);
    const middle = flow([callSubFlow("m1", "login.flow.json")]);
    const top = flow([callSubFlow("c1", "middle.flow.json")]);
    const registry: Record<string, Flow> = { "middle.flow.json": middle, "login.flow.json": login };

    const files = collectSubFlowFilesTransitive(top, (file) => registry[file]);
    expect([...files].sort()).toEqual(["login.flow.json", "middle.flow.json"]);
  });

  it("stops gracefully when a referenced file can't be resolved (doesn't throw)", () => {
    const top = flow([callSubFlow("c1", "missing.flow.json")]);
    const files = collectSubFlowFilesTransitive(top, () => undefined);
    expect([...files]).toEqual(["missing.flow.json"]);
  });
});

describe("buildBundle / serializeBundle / parseBundle — round-trip fidelity (AC2)", () => {
  it("round-trips a flow with a sub-flow and fixtures with ZERO unexpected deltas", () => {
    const login = flow([tap("s1", "Email"), tap("s2", "Password")], { fixtures: { email: "a@b.com" } });
    const main = flow([callSubFlow("c1", "login.flow.json"), tap("s3", "Spin")], { fixtures: { pw: "${secret:x}" } });

    const bundle = buildBundle("spin.flow.json", main, { "login.flow.json": login });
    const raw = serializeBundle(bundle);
    const result = parseBundle(raw);

    expect(result.ok).toBe(true);
    expect(result.bundle!.flow.steps).toHaveLength(2);
    expect(result.bundle!.flow.fixtures).toEqual({ pw: "${secret:x}" });
    expect(result.bundle!.subFlows["login.flow.json"].steps).toHaveLength(2);
    expect(result.bundle!.subFlows["login.flow.json"].fixtures).toEqual({ email: "a@b.com" });
    // Same assertions/locators preserved verbatim.
    expect(result.bundle!.flow.steps.map((s) => s.id)).toEqual(["c1", "s3"]);
  });

  it("carries an optional baseFlow through the round-trip", () => {
    const base = flow([tap("s1", "Original")]);
    const current = flow([tap("s1", "Edited")]);
    const bundle = buildBundle("f.flow.json", current, {}, base);
    const result = parseBundle(serializeBundle(bundle));
    expect(result.ok).toBe(true);
    expect((result.bundle!.baseFlow!.steps[0] as any).text).toBe("Original");
  });

  it("omits baseFlow entirely when none was supplied (not present as an undefined key)", () => {
    const bundle = buildBundle("f.flow.json", flow([tap("s1", "x")]), {});
    expect(bundle).not.toHaveProperty("baseFlow");
  });
});

describe("parseBundle — rejects malformed input without throwing", () => {
  it("rejects non-JSON text", () => {
    const result = parseBundle("not json {{{");
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects an unsupported schema version", () => {
    const result = parseBundle(JSON.stringify({ schemaVersion: 999, sourceFile: "f.json", flow: {} }));
    expect(result.ok).toBe(false);
  });

  it("rejects a bundle with a schema-invalid flow", () => {
    const result = parseBundle(
      JSON.stringify({ schemaVersion: 1, sourceFile: "f.json", flow: { steps: [] }, subFlows: {} }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("Luồng chính"))).toBe(true);
  });

  it("collects a per-sub-flow error without crashing on the rest", () => {
    const good = flow([tap("s1", "ok")]);
    const result = parseBundle(
      JSON.stringify({
        schemaVersion: 1,
        sourceFile: "f.json",
        flow: good,
        subFlows: { "broken.flow.json": { steps: [] } },
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("broken.flow.json"))).toBe(true);
  });

  it("degrades an invalid baseFlow to 'no base' rather than failing the whole import", () => {
    const good = flow([tap("s1", "ok")]);
    const result = parseBundle(
      JSON.stringify({ schemaVersion: 1, sourceFile: "f.json", flow: good, subFlows: {}, baseFlow: { garbage: true } }),
    );
    expect(result.ok).toBe(true);
    expect(result.bundle!.baseFlow).toBeUndefined();
  });
});

describe("findUnsafeSteps / stripUnsafeSteps — raw/${expr} import gate (AC3)", () => {
  function bundleWithRaw(): FlowBundle {
    const login = flow([tap("s1", "Email"), { id: "r1", action: "raw", maestro: "- tapOn: Anything" } as FlowStep]);
    const main = flow([tap("s2", "Spin"), { id: "r2", action: "raw", maestro: "- inputText: hi" } as FlowStep]);
    return buildBundle("main.flow.json", main, { "login.flow.json": login });
  }

  it("finds every raw step across the main flow AND sub-flows", () => {
    const refs = findUnsafeSteps(bundleWithRaw());
    expect(refs).toHaveLength(2);
    expect(refs.find((r) => r.flowFile === "")?.stepId).toBe("r2");
    expect(refs.find((r) => r.flowFile === "login.flow.json")?.stepId).toBe("r1");
  });

  it("finds a raw step nested inside a container", () => {
    const f = flow([{ id: "if1", action: "if", when: { text: "Popup" }, then: [{ id: "r1", action: "raw", maestro: "x" } as FlowStep] } as FlowStep]);
    const bundle = buildBundle("f.flow.json", f, {});
    expect(findUnsafeSteps(bundle)).toHaveLength(1);
  });

  it("returns an empty array for a bundle with no raw steps", () => {
    const bundle = buildBundle("f.flow.json", flow([tap("s1", "x")]), {});
    expect(findUnsafeSteps(bundle)).toEqual([]);
  });

  it("stripUnsafeSteps removes every raw step but keeps everything else, without mutating the input", () => {
    const f = flow([tap("s1", "Keep"), { id: "r1", action: "raw", maestro: "x" } as FlowStep, tap("s2", "Keep too")]);
    const before = JSON.stringify(f);
    const stripped = stripUnsafeSteps(f);
    expect(stripped.steps.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(JSON.stringify(f)).toBe(before);
  });

  it("stripUnsafeSteps removes a raw step nested inside a repeat container", () => {
    const f = flow([
      { id: "rep1", action: "repeat", times: 2, steps: [tap("s1", "Keep"), { id: "r1", action: "raw", maestro: "x" } as FlowStep] } as FlowStep,
    ]);
    const stripped = stripUnsafeSteps(f);
    const rep = stripped.steps[0] as any;
    expect(rep.steps.map((s: FlowStep) => s.id)).toEqual(["s1"]);
  });

  it("stripUnsafeSteps is a no-op (returns the same reference) for a flow with no raw steps", () => {
    const f = flow([tap("s1", "x")]);
    expect(stripUnsafeSteps(f)).toBe(f);
  });
});
