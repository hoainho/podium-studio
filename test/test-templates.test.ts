import { describe, it, expect } from "vitest";
import { validateFlow } from "../shared/ir.ts";
import { TEMPLATES, buildTemplateFlow } from "../src/test-templates.ts";

const ASSERTION_ACTIONS = new Set(["assertVisible", "assertNotVisible", "waitFor", "waitForNotVisible"]);

describe("test-templates", () => {
  it("ships at least 5 templates", () => {
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(5);
  });

  for (const tpl of TEMPLATES) {
    describe(tpl.id, () => {
      it("builds a schema-valid Flow with defaults (no fields supplied)", () => {
        const flow = buildTemplateFlow(tpl.id, {});
        const result = validateFlow(flow);
        expect(result.errors).toEqual([]);
        expect(result.ok).toBe(true);
      });

      it("builds a schema-valid Flow when every field is filled in", () => {
        const fields: Record<string, string> = {};
        for (const f of tpl.fields) fields[f.key] = `${f.defaultValue} (custom)`;
        const flow = buildTemplateFlow(tpl.id, fields);
        const result = validateFlow(flow);
        expect(result.errors).toEqual([]);
        expect(result.ok).toBe(true);
      });

      it("has at least one step and one assertion", () => {
        const flow = buildTemplateFlow(tpl.id, {});
        expect(flow.steps.length).toBeGreaterThan(0);
        const hasAssertion = flow.steps.some((s) => ASSERTION_ACTIONS.has(s.action));
        expect(hasAssertion).toBe(true);
      });

      it("prefills a non-empty charter answer", () => {
        const flow = buildTemplateFlow(tpl.id, {});
        expect(typeof flow.fixtures?.charterAnswer).toBe("string");
        expect((flow.fixtures?.charterAnswer as string).length).toBeGreaterThan(0);
      });

      it("falls back to the template default when a field is blank/whitespace", () => {
        const fields: Record<string, string> = {};
        for (const f of tpl.fields) fields[f.key] = "   ";
        const flow = buildTemplateFlow(tpl.id, fields);
        expect(validateFlow(flow).ok).toBe(true);
      });
    });
  }

  it("throws on an unknown template id", () => {
    expect(() => buildTemplateFlow("nope" as unknown as (typeof TEMPLATES)[number]["id"], {})).toThrow();
  });
});
