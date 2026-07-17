import { describe, it, expect } from "vitest";
import type { Flow, FlowStep } from "../shared/ir.ts";
import { expandFlow, hasSubFlowCalls, type ResolveFlowFile } from "../shared/subflow.ts";

/**
 * E13 (Reuse — parameterized sub-flows). Covers `expandFlow()`'s macro-expansion: the
 * `callSubFlow` step is NEVER executed directly (spec AC1) — it's resolved into the referenced
 * flow's own steps, with `params` substituted, before a run/lint ever sees it. AC5's "missing
 * required parameter is blocked at pre-run lint, not at runtime" is exactly what a non-empty
 * `errors` array here represents.
 */

function makeFlow(steps: FlowStep[], over: Partial<Flow> = {}): Flow {
  return {
    schemaVersion: 1,
    name: "Test flow",
    app: { bundleId: "com.example.app", platform: "ios-sim" },
    steps,
    ...over,
  };
}

function callStep(over: Partial<FlowStep> & { flowFile: string }): FlowStep {
  return { id: "c1", action: "callSubFlow", ...over } as FlowStep;
}

const registry = (flows: Record<string, Flow>): ResolveFlowFile => (file) => flows[file];

describe("expandFlow — basic expansion (spec AC1)", () => {
  it("replaces a callSubFlow step with the referenced flow's own steps", async () => {
    const login = makeFlow(
      [
        { id: "s1", action: "type", text: "{{email}}" } as FlowStep,
        { id: "s2", action: "type", text: "{{pw}}" } as FlowStep,
      ],
      { params: [{ name: "email", required: true }, { name: "pw", required: true }] },
    );
    const parent = makeFlow([callStep({ flowFile: "login.flow.json", params: { email: "a@b.com", pw: "hunter2" } })]);

    const { flow, errors } = await expandFlow(parent, registry({ "login.flow.json": login }));
    expect(errors).toEqual([]);
    expect(flow.steps).toHaveLength(2);
    expect(flow.steps.every((s) => s.action === "type")).toBe(true);
  });

  it("substitutes {{param}} references inside the sub-flow's own steps with the caller's supplied values", async () => {
    const login = makeFlow([{ id: "s1", action: "type", text: "{{email}}" } as FlowStep], {
      params: [{ name: "email", required: true }],
    });
    const parent = makeFlow([callStep({ flowFile: "login.flow.json", params: { email: "a@b.com" } })]);

    const { flow } = await expandFlow(parent, registry({ "login.flow.json": login }));
    expect((flow.steps[0] as any).text).toBe("a@b.com");
  });

  it("a supplied param value that's itself a {{capturedVar}} chip (AC5) passes through as literal text, resolved later at run time", async () => {
    const login = makeFlow([{ id: "s1", action: "type", text: "{{email}}" } as FlowStep], {
      params: [{ name: "email", required: true }],
    });
    const parent = makeFlow([callStep({ flowFile: "login.flow.json", params: { email: "{{savedEmail}}" } })]);

    const { flow, errors } = await expandFlow(parent, registry({ "login.flow.json": login }));
    expect(errors).toEqual([]);
    // The expanded step now contains the CALLER's captured-var reference, untouched — the
    // runner resolves {{savedEmail}} at actual run time exactly as it always has.
    expect((flow.steps[0] as any).text).toBe("{{savedEmail}}");
  });

  it("a supplied param value that's a ${secret:...} reference passes through unresolved (E12's seam resolves it at real run time)", async () => {
    const login = makeFlow([{ id: "s1", action: "type", text: "{{pw}}" } as FlowStep], {
      params: [{ name: "pw", required: true }],
    });
    const parent = makeFlow([callStep({ flowFile: "login.flow.json", params: { pw: "${secret:testPassword}" } })]);

    const { flow } = await expandFlow(parent, registry({ "login.flow.json": login }));
    expect((flow.steps[0] as any).text).toBe("${secret:testPassword}");
  });

  it("uses the sub-flow's own default when the caller doesn't supply an optional param", async () => {
    const login = makeFlow([{ id: "s1", action: "type", text: "{{greeting}}" } as FlowStep], {
      params: [{ name: "greeting", default: "Hello" }],
    });
    const parent = makeFlow([callStep({ flowFile: "login.flow.json", params: {} })]);

    const { flow, errors } = await expandFlow(parent, registry({ "login.flow.json": login }));
    expect(errors).toEqual([]);
    expect((flow.steps[0] as any).text).toBe("Hello");
  });

  it("leaves an optional, no-default, unsupplied param's {{ref}} untouched (never errors, never blanks it)", async () => {
    const login = makeFlow([{ id: "s1", action: "type", text: "prefix-{{opt}}" } as FlowStep], {
      params: [{ name: "opt" }],
    });
    const parent = makeFlow([callStep({ flowFile: "login.flow.json", params: {} })]);

    const { flow, errors } = await expandFlow(parent, registry({ "login.flow.json": login }));
    expect(errors).toEqual([]);
    expect((flow.steps[0] as any).text).toBe("prefix-{{opt}}");
  });
});

describe("expandFlow — pre-run lint errors (spec AC5: blocked before a run, not at runtime)", () => {
  it("errors when a required param is missing", async () => {
    const login = makeFlow([{ id: "s1", action: "type", text: "{{pw}}" } as FlowStep], {
      params: [{ name: "pw", required: true }],
    });
    const parent = makeFlow([callStep({ flowFile: "login.flow.json", params: {} })]);

    const { errors } = await expandFlow(parent, registry({ "login.flow.json": login }));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/pw/);
    expect(errors[0].stepId).toBe("c1");
  });

  it("errors on an unknown param the sub-flow never declared", async () => {
    const login = makeFlow([{ id: "s1", action: "screenshot" } as FlowStep], { params: [] });
    const parent = makeFlow([callStep({ flowFile: "login.flow.json", params: { bogus: "x" } })]);

    const { errors } = await expandFlow(parent, registry({ "login.flow.json": login }));
    expect(errors.some((e) => e.message.includes("bogus"))).toBe(true);
  });

  it("errors when the referenced sub-flow file can't be found", async () => {
    const parent = makeFlow([callStep({ flowFile: "does-not-exist.flow.json", params: {} })]);
    const { errors } = await expandFlow(parent, registry({}));
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/does-not-exist\.flow\.json/);
  });

  it("errors on a call cycle instead of infinite-looping", async () => {
    const a = makeFlow([callStep({ id: "a1", flowFile: "b.flow.json" })]);
    const b = makeFlow([callStep({ id: "b1", flowFile: "a.flow.json" })]);
    const { errors } = await expandFlow(a, registry({ "a.flow.json": a, "b.flow.json": b }));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /vòng lặp/i.test(e.message))).toBe(true);
  });

  it("collects MULTIPLE independent errors in one pass rather than stopping at the first", async () => {
    const parent = makeFlow([
      callStep({ id: "c1", flowFile: "missing-a.flow.json" }),
      callStep({ id: "c2", flowFile: "missing-b.flow.json" }),
    ]);
    const { errors } = await expandFlow(parent, registry({}));
    expect(errors).toHaveLength(2);
  });
});

describe("expandFlow — structural correctness", () => {
  it("renames expanded step ids to guarantee uniqueness across multiple call sites of the same sub-flow", async () => {
    const login = makeFlow([{ id: "s1", action: "screenshot" } as FlowStep]);
    const parent = makeFlow([
      callStep({ id: "call-a", flowFile: "login.flow.json" }),
      callStep({ id: "call-b", flowFile: "login.flow.json" }),
    ]);
    const { flow, errors } = await expandFlow(parent, registry({ "login.flow.json": login }));
    expect(errors).toEqual([]);
    const ids = flow.steps.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
    expect(ids).toEqual(["call-a::s1", "call-b::s1"]);
  });

  it("recurses into if/repeat containers to find and expand a nested callSubFlow", async () => {
    const login = makeFlow([{ id: "s1", action: "screenshot" } as FlowStep]);
    const parent = makeFlow([
      {
        id: "r1", action: "repeat", times: 1,
        steps: [callStep({ id: "nested-call", flowFile: "login.flow.json" })],
      } as FlowStep,
    ]);
    const { flow, errors } = await expandFlow(parent, registry({ "login.flow.json": login }));
    expect(errors).toEqual([]);
    const repeatStep = flow.steps[0] as any;
    expect(repeatStep.action).toBe("repeat");
    expect(repeatStep.steps).toHaveLength(1);
    expect(repeatStep.steps[0].id).toBe("nested-call::s1");
  });

  it("recursively expands a sub-flow that itself calls another sub-flow", async () => {
    const inner = makeFlow([{ id: "i1", action: "screenshot" } as FlowStep]);
    const middle = makeFlow([callStep({ id: "m1", flowFile: "inner.flow.json" })]);
    const parent = makeFlow([callStep({ id: "p1", flowFile: "middle.flow.json" })]);

    const { flow, errors } = await expandFlow(
      parent,
      registry({ "inner.flow.json": inner, "middle.flow.json": middle }),
    );
    expect(errors).toEqual([]);
    expect(flow.steps).toHaveLength(1);
    expect(flow.steps[0].id).toBe("p1::m1::i1");
  });

  it("never mutates the original flow objects passed in", async () => {
    const login = makeFlow([{ id: "s1", action: "type", text: "{{email}}" } as FlowStep], {
      params: [{ name: "email" }],
    });
    const parent = makeFlow([callStep({ flowFile: "login.flow.json", params: { email: "x" } })]);
    const beforeParent = JSON.stringify(parent);
    const beforeLogin = JSON.stringify(login);

    await expandFlow(parent, registry({ "login.flow.json": login }));

    expect(JSON.stringify(parent)).toBe(beforeParent);
    expect(JSON.stringify(login)).toBe(beforeLogin);
  });

  it("a flow with no callSubFlow steps anywhere expands to an unchanged step list", async () => {
    const flow = makeFlow([{ id: "s1", action: "screenshot" } as FlowStep]);
    const { flow: expanded, errors } = await expandFlow(flow, registry({}));
    expect(errors).toEqual([]);
    expect(expanded.steps).toEqual(flow.steps);
  });
});

describe("hasSubFlowCalls", () => {
  it("returns false for a flow with no callSubFlow steps", () => {
    expect(hasSubFlowCalls(makeFlow([{ id: "s1", action: "screenshot" } as FlowStep]))).toBe(false);
  });

  it("returns true for a top-level callSubFlow", () => {
    expect(hasSubFlowCalls(makeFlow([callStep({ flowFile: "x.flow.json" })]))).toBe(true);
  });

  it("returns true for a callSubFlow nested inside a container", () => {
    const flow = makeFlow([{ id: "r1", action: "repeat", times: 1, steps: [callStep({ flowFile: "x.flow.json" })] } as FlowStep]);
    expect(hasSubFlowCalls(flow)).toBe(true);
  });
});
