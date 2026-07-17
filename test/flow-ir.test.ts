import { describe, it, expect } from "vitest";
import {
  validateFlow,
  toPodiumSteps,
  interpolate,
  type Flow,
} from "../shared/ir.ts";

/** A minimal, well-formed flow used as a baseline across tests. */
function makeValidFlow(overrides: Partial<Flow> = {}): unknown {
  return {
    schemaVersion: 1,
    name: "Sample Flow",
    app: { bundleId: "com.example.app", platform: "ios-sim" },
    steps: [
      { id: "s1", action: "tap", x: 10, y: 20 },
      { id: "s2", action: "screenshot" },
    ],
    ...overrides,
  };
}

describe("validateFlow", () => {
  it("passes for a well-formed flow", () => {
    const result = validateFlow(makeValidFlow());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.flow?.name).toBe("Sample Flow");
  });

  it("fails when a step uses an unknown action", () => {
    const flow = makeValidFlow({
      steps: [{ id: "s1", action: "doBackflip" } as any],
    });
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("fails when step ids are duplicated", () => {
    const flow = makeValidFlow({
      steps: [
        { id: "dup", action: "screenshot" },
        { id: "dup", action: "screenshot" },
      ],
    });
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toMatch(/Duplicate step ids/);
    expect(result.errors.join(" ")).toMatch(/dup/);
  });

  it("fails when app.bundleId is missing", () => {
    const flow = makeValidFlow({ app: { platform: "ios-sim" } as any });
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("fails when steps is empty", () => {
    const flow = makeValidFlow({ steps: [] });
    const result = validateFlow(flow);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("toPodiumSteps", () => {
  it("strips presentation metadata (id/label/note/disabled)", () => {
    const flow = makeValidFlow({
      steps: [
        {
          id: "s1",
          label: "Tap the button",
          note: "for QA",
          action: "tap",
          x: 5,
          y: 6,
        },
      ],
    }) as Flow;
    const validated = validateFlow(flow);
    expect(validated.ok).toBe(true);
    const podiumSteps = toPodiumSteps(validated.flow!);
    expect(podiumSteps).toEqual([{ action: "tap", x: 5, y: 6 }]);
    expect(podiumSteps[0]).not.toHaveProperty("id");
    expect(podiumSteps[0]).not.toHaveProperty("label");
    expect(podiumSteps[0]).not.toHaveProperty("note");
    expect(podiumSteps[0]).not.toHaveProperty("disabled");
  });

  it("drops disabled steps", () => {
    const flow = makeValidFlow({
      steps: [
        { id: "s1", action: "screenshot" },
        { id: "s2", action: "screenshot", disabled: true },
        { id: "s3", action: "screenshot" },
      ],
    }) as Flow;
    const validated = validateFlow(flow);
    expect(validated.ok).toBe(true);
    const podiumSteps = toPodiumSteps(validated.flow!);
    expect(podiumSteps).toHaveLength(2);
  });

  it("maps tapText.targetId to id", () => {
    const flow = makeValidFlow({
      steps: [{ id: "s1", action: "tapText", targetId: "login-button" }],
    }) as Flow;
    const validated = validateFlow(flow);
    expect(validated.ok).toBe(true);
    const podiumSteps = toPodiumSteps(validated.flow!);
    expect(podiumSteps).toEqual([{ action: "tapText", id: "login-button" }]);
  });

  it("resolves {{fixture}} placeholders via interpolate", () => {
    const flow = makeValidFlow({
      fixtures: { user: { name: "Ada" } },
      steps: [{ id: "s1", action: "type", text: "Hello {{user.name}}" }],
    }) as Flow;
    const validated = validateFlow(flow);
    expect(validated.ok).toBe(true);
    const podiumSteps = toPodiumSteps(validated.flow!);
    expect(podiumSteps).toEqual([{ action: "type", text: "Hello Ada" }]);
  });

  it("resolves fixture placeholders passed in at call time, overriding flow fixtures", () => {
    const flow = makeValidFlow({
      fixtures: { user: { name: "Ada" } },
      steps: [{ id: "s1", action: "type", text: "Hello {{user.name}}" }],
    }) as Flow;
    const validated = validateFlow(flow);
    expect(validated.ok).toBe(true);
    const podiumSteps = toPodiumSteps(validated.flow!, { user: { name: "Grace" } });
    expect(podiumSteps).toEqual([{ action: "type", text: "Hello Grace" }]);
  });
});

describe("interpolate", () => {
  it("resolves a nested path", () => {
    const result = interpolate("Welcome {{user.profile.name}}!", {
      user: { profile: { name: "Ada" } },
    });
    expect(result).toBe("Welcome Ada!");
  });

  it("leaves a missing key placeholder untouched", () => {
    const result = interpolate("Hello {{missing.key}}", { user: { name: "Ada" } });
    expect(result).toBe("Hello {{missing.key}}");
  });
});
