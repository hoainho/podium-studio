import { describe, it, expect } from "vitest";
import { stepToMaestroLines, flowYamlForStep, iosBackYaml } from "../shared/maestro.ts";
import type { FlowStep } from "../shared/ir.ts";

const s = (step: Partial<FlowStep> & { action: FlowStep["action"] }): FlowStep =>
  ({ id: "abcdef12", ...step } as FlowStep);

describe("stepToMaestroLines", () => {
  it("launchApp emits appId when bundleId is set, bare otherwise", () => {
    expect(stepToMaestroLines(s({ action: "launchApp" }))).toEqual([`- launchApp`]);
    expect(stepToMaestroLines(s({ action: "launchApp", bundleId: "com.foo.bar" } as FlowStep)))
      .toEqual([`- launchApp:`, `    appId: "com.foo.bar"`]);
  });

  it("stopApp emits appId when bundleId is set, bare otherwise", () => {
    expect(stepToMaestroLines(s({ action: "stopApp" }))).toEqual([`- stopApp`]);
    expect(stepToMaestroLines(s({ action: "stopApp", bundleId: "com.foo.bar" } as FlowStep)))
      .toEqual([`- stopApp:`, `    appId: "com.foo.bar"`]);
  });

  it("multi-word pressKey title-cases every word", () => {
    expect(stepToMaestroLines(s({ action: "key", key: "volume up" } as FlowStep)))
      .toEqual([`- pressKey: "Volume Up"`]);
    expect(stepToMaestroLines(s({ action: "key", key: "enter" } as FlowStep)))
      .toEqual([`- pressKey: "Enter"`]);
  });

  // C2: a TIMED assert compiles to extendedWaitUntil (wait-then-assert), NOT `assertVisible` +
  // a `timeout:` property — the bundled Maestro rejects the latter ("Unknown Property: timeout"),
  // which broke every if/repeat container and the export.
  it("assertVisible: short form without timeout, extendedWaitUntil with timeout", () => {
    expect(stepToMaestroLines(s({ action: "assertVisible", text: "Welcome" } as FlowStep)))
      .toEqual([`- assertVisible: "Welcome"`]);
    expect(stepToMaestroLines(s({ action: "assertVisible", text: "Welcome", timeoutMs: 8000 } as FlowStep)))
      .toEqual([`- extendedWaitUntil:`, `    visible: "Welcome"`, `    timeout: 8000`]);
  });

  it("assertNotVisible: short form without timeout, extendedWaitUntil with timeout", () => {
    expect(stepToMaestroLines(s({ action: "assertNotVisible", text: "Error" } as FlowStep)))
      .toEqual([`- assertNotVisible: "Error"`]);
    expect(stepToMaestroLines(s({ action: "assertNotVisible", text: "Error", timeoutMs: 3000 } as FlowStep)))
      .toEqual([`- extendedWaitUntil:`, `    notVisible: "Error"`, `    timeout: 3000`]);
  });

  it("never emits a bare `timeout:` under assertVisible/assertNotVisible (Maestro rejects it)", () => {
    for (const action of ["assertVisible", "assertNotVisible"] as const) {
      const lines = stepToMaestroLines(s({ action, text: "X", timeoutMs: 5000 } as FlowStep));
      const idx = lines.findIndex((l) => l.trim().startsWith(`- ${action}`));
      // If an assertVisible/assertNotVisible line is emitted at all, no timeout line follows it.
      if (idx !== -1) expect(lines.some((l) => l.includes("timeout:"))).toBe(false);
    }
  });

  it("safely escapes quotes, colons and newlines in text via JSON.stringify", () => {
    const text = `He said "hi": line1\nline2`;
    const lines = stepToMaestroLines(s({ action: "assertVisible", text } as FlowStep));
    expect(lines).toEqual([`- assertVisible: ${JSON.stringify(text)}`]);
    expect(lines[0]).toContain(`\\"hi\\"`);
    expect(lines[0]).toContain(`\\n`);
    expect(lines[0]).not.toContain("\n");
  });
});

describe("flowYamlForStep", () => {
  const bundle = "com.example.app";

  it("prefixes a normal step with the launchApp attach header", () => {
    const yaml = flowYamlForStep(s({ action: "tapText", text: "OK" } as FlowStep), bundle);
    expect(yaml).toBe(
      [`appId: ${bundle}`, `---`, `- launchApp:`, `    stopApp: false`, `- tapOn:`, `    text: "OK"`].join("\n"),
    );
  });

  it("raw steps now get the launchApp attach header (attach to running app)", () => {
    const yaml = flowYamlForStep(s({ action: "raw", maestro: "- tapOn: Anything" } as FlowStep), bundle);
    expect(yaml).toContain(`- launchApp:\n    stopApp: false`);
    expect(yaml).toContain(`- tapOn: Anything`);
  });

  it("openLink and stopApp do NOT get the launchApp attach header", () => {
    const openYaml = flowYamlForStep(s({ action: "openLink", url: "app://home" } as FlowStep), bundle);
    expect(openYaml).not.toContain(`stopApp: false`);
    expect(openYaml).toBe([`appId: ${bundle}`, `---`, `- openLink: "app://home"`].join("\n"));

    const stopYaml = flowYamlForStep(s({ action: "stopApp" }), bundle);
    expect(stopYaml).not.toContain(`stopApp: false`);
    expect(stopYaml).toBe([`appId: ${bundle}`, `---`, `- stopApp`].join("\n"));
  });
});

describe("iosBackYaml (C7 — iOS interactive-pop back)", () => {
  it("emits a left-edge swipe (not Maestro `- back`, which no-ops on iOS)", () => {
    const yaml = iosBackYaml("com.foo.bar");
    expect(yaml).not.toMatch(/^- back$/m);          // never the ineffective iOS `- back`
    expect(yaml).toContain("appId: com.foo.bar");
    expect(yaml).toContain("- launchApp:");          // attach to the foreground app
    expect(yaml).toContain("stopApp: false");
    expect(yaml).toContain("- swipe:");
    expect(yaml).toMatch(/start: "2%, 50%"/);        // STARTS inside the left edge → triggers pop
    expect(yaml).toMatch(/end: "92%, 50%"/);
  });

  it("includes an env: block when env vars are provided", () => {
    const yaml = iosBackYaml("com.foo.bar", { TOKEN: "abc" });
    expect(yaml).toContain("env:");
    expect(yaml).toContain('TOKEN: "abc"');
  });
});
