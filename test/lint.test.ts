import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { lintFlow, dryRunFlow, type ScreenElement } from "../shared/lint.ts";
import type { Flow } from "../shared/ir.ts";

function baseFlow(steps: Flow["steps"]): Flow {
  return {
    schemaVersion: 1,
    name: "Lint Fixture Flow",
    app: { bundleId: "com.example.app", platform: "ios-sim" },
    steps,
  };
}

const oneElement = (text: string): ScreenElement[] => [{ text }];

describe("lintFlow — AC1 no-match", () => {
  it("flags a selector matching 0 elements on the target screen, class no-match", () => {
    const flow = baseFlow([{ id: "s1", action: "assertVisible", text: "Ghost label" }]);
    const result = lintFlow(flow, () => [{ text: "Something else entirely" }]);
    const finding = result.findings.find((f) => f.class === "no-match");
    expect(finding).toBeDefined();
    expect(finding!.stepIndex).toBe(0);
    expect(finding!.stepId).toBe("s1");
    expect(finding!.message).toMatch(/Ghost label/);
    // Vietnamese, not raw English testing jargon
    expect(finding!.message).toMatch(/Không tìm thấy/);
  });

  it("does not flag no-match when no screen resolver is given (unknown, skip rather than guess)", () => {
    const flow = baseFlow([
      { id: "s1", action: "assertVisible", text: "Anything" },
    ]);
    const result = lintFlow(flow); // no resolveScreen
    expect(result.findings.some((f) => f.class === "no-match")).toBe(false);
  });
});

describe("lintFlow — AC2 ambiguous-match", () => {
  it("flags a selector matching >1 elements, class ambiguous-match, with the match count reported", () => {
    const flow = baseFlow([{ id: "s1", action: "tapText", text: "Continue" }]);
    const elements: ScreenElement[] = [{ text: "Continue" }, { text: "Continue" }, { text: "Continue" }];
    const result = lintFlow(flow, () => elements);
    const finding = result.findings.find((f) => f.class === "ambiguous-match");
    expect(finding).toBeDefined();
    expect(finding!.matchCount).toBe(3);
    expect(finding!.message).toMatch(/Khớp 3 phần tử/);
  });

  it("matches by accessibility id (targetId) when given, not just text", () => {
    const flow = baseFlow([{ id: "s1", action: "tapText", targetId: "login_btn" }]);
    const elements: ScreenElement[] = [
      { accessibilityId: "login_btn" },
      { accessibilityId: "login_btn" },
    ];
    const result = lintFlow(flow, () => elements);
    const finding = result.findings.find((f) => f.class === "ambiguous-match");
    expect(finding?.matchCount).toBe(2);
  });
});

describe("lintFlow — AC3 unreachable", () => {
  it("flags a step positioned after an unconditional flow exit (stopApp)", () => {
    const flow = baseFlow([
      { id: "s1", action: "assertVisible", text: "Home" },
      { id: "s2", action: "stopApp" },
      { id: "s3", action: "screenshot" },
      { id: "s4", action: "screenshot" },
    ]);
    const result = lintFlow(flow);
    const unreachable = result.findings.filter((f) => f.class === "unreachable");
    expect(unreachable).toHaveLength(2);
    expect(unreachable[0].stepIndex).toBe(2);
    expect(unreachable[0].stepId).toBe("s3");
    expect(unreachable[1].stepIndex).toBe(3);
    expect(unreachable[1].stepId).toBe("s4");
  });

  it("does not flag anything before the unconditional exit", () => {
    const flow = baseFlow([
      { id: "s1", action: "screenshot" },
      { id: "s2", action: "assertVisible", text: "Home" },
      { id: "s3", action: "stopApp" },
    ]);
    const result = lintFlow(flow);
    expect(result.findings.some((f) => f.class === "unreachable")).toBe(false);
  });
});

describe("lintFlow — AC4 no-assertion", () => {
  it("flags a flow with no assertion anywhere", () => {
    const flow = baseFlow([
      { id: "s1", action: "tap", x: 1, y: 2 },
      { id: "s2", action: "screenshot" },
    ]);
    const result = lintFlow(flow);
    const finding = result.findings.find((f) => f.class === "no-assertion");
    expect(finding).toBeDefined();
    expect(finding!.stepIndex).toBeUndefined(); // flow-level finding
    expect(finding!.message).toMatch(/không có bước xác nhận/);
  });

  it("does not flag no-assertion when assertNotVisible is present (either assertion action counts)", () => {
    const flow = baseFlow([
      { id: "s1", action: "tap", x: 1, y: 2 },
      { id: "s2", action: "assertNotVisible", text: "Error banner" },
    ]);
    const result = lintFlow(flow);
    expect(result.findings.some((f) => f.class === "no-assertion")).toBe(false);
  });
});

describe("lintFlow — AC7 clean flow, no false positives", () => {
  it("produces 0 findings on a defect-free flow", () => {
    const flow = baseFlow([
      { id: "s1", action: "launchApp" },
      { id: "s2", action: "tapText", text: "Login" },
      { id: "s3", action: "type", text: "user@example.com" },
      { id: "s4", action: "assertVisible", text: "Welcome" },
      { id: "s5", action: "screenshot" },
    ]);
    // The fixed on-screen snapshot must satisfy every selector-bearing step in the flow
    // (Login button visible, then the Welcome text after it) — one real screen wouldn't
    // show both at once, but lintFlow checks each step independently against whatever
    // `resolveScreen` returns for it, so this models "each step's own screen looked clean".
    const result = lintFlow(flow, () => [{ text: "Login" }, { text: "Welcome" }]);
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });
});

describe("lintFlow — AC6 performance", () => {
  it("completes on a 14-step reference flow in well under 5 seconds", () => {
    const steps: Flow["steps"] = Array.from({ length: 13 }, (_, i) => ({
      id: `s${i}`,
      action: "screenshot" as const,
    }));
    steps.push({ id: "s13", action: "assertVisible", text: "Done" });
    const flow = baseFlow(steps);
    const result = lintFlow(flow, () => oneElement("Done"));
    expect(result.durationMs).toBeLessThan(5000);
    expect(result.ok).toBe(true);
  });
});

describe("dryRunFlow — AC5 zero side effects", () => {
  it("validates a well-formed flow with ok:true and no errors", () => {
    const flow = baseFlow([{ id: "s1", action: "assertVisible", text: "Home" }]);
    const result = dryRunFlow(flow);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("reports schema errors for a malformed flow without throwing", () => {
    const result = dryRunFlow({ steps: [{ id: "s1", action: "doBackflip" }] });
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("never imports the device engine — structurally guaranteed zero device/app side effects", () => {
    const src = readFileSync(fileURLToPath(new URL("../shared/lint.ts", import.meta.url)), "utf8");
    // Check actual import statements, not prose in doc comments that merely explains why
    // there isn't one.
    const importLines = src.split("\n").filter((l) => /^\s*import\b/.test(l));
    expect(importLines.some((l) => /podium\.ts|bridge\/podium/.test(l))).toBe(false);
    expect(src).not.toMatch(/\bengine\.\w+\(/); // no engine.* call anywhere in the module
  });
});
