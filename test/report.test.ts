import { describe, it, expect, afterEach } from "vitest";
import { readFile, rm } from "node:fs/promises";
import type { Flow } from "../shared/ir.ts";
import type { RunSummary } from "../shared/protocol.ts";
import { writeRunReport } from "../bridge/report.ts";
import { ARTIFACTS_DIR } from "../bridge/runner.ts";

/**
 * E18 AC4 — trace exported as an artifact alongside the run's other artifacts, referenced from
 * an HTML report. Real fs operations (no mocking node:fs) under a clearly test-scoped runId,
 * cleaned up afterward — same isolation style test/orchestrator.test.ts's ProfilePool tests use.
 */

const createdDirs: string[] = [];

afterEach(async () => {
  for (const dir of createdDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

function makeFlow(overrides: Partial<Flow> = {}): Flow {
  return {
    schemaVersion: 1,
    name: "Login Flow",
    app: { bundleId: "com.example.app", platform: "ios-sim" },
    steps: [
      { id: "s1", action: "tapText", text: "Sign in" } as any,
      { id: "s2", action: "assertVisible", text: "Welcome" } as any,
    ],
    ...overrides,
  };
}

function makeSummary(runId: string, overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId,
    flowName: "Login Flow",
    udid: "udid-1",
    bundleId: "com.example.app",
    passed: true,
    status: "passed",
    total: 2,
    passedCount: 2,
    failedCount: 0,
    softFailedCount: 0,
    durationMs: 1234,
    startedAt: Date.now(),
    results: [
      { index: 0, stepId: "s1", action: "tapText", status: "passed", ok: true, startedAt: 1, finishedAt: 2 },
      { index: 1, stepId: "s2", action: "assertVisible", status: "passed", ok: true, startedAt: 2, finishedAt: 3 },
    ],
    ...overrides,
  };
}

describe("writeRunReport — E18 AC4: trace.json + a minimal HTML report, alongside the run's own artifacts", () => {
  it("writes trace.json and report.html into the SAME per-run artifacts directory runner.ts already uses for screenshots", async () => {
    const runId = `test-report-${Date.now()}-a`;
    const { dir, tracePath, reportPath } = await writeRunReport(makeFlow(), makeSummary(runId));
    createdDirs.push(dir);

    expect(dir).toBe(`${ARTIFACTS_DIR}/${runId}`);
    expect(tracePath).toBe(`${dir}/trace.json`);
    expect(reportPath).toBe(`${dir}/report.html`);

    const traceRaw = await readFile(tracePath, "utf8");
    const trace = JSON.parse(traceRaw);
    expect(trace.runId).toBe(runId);
    expect(trace.flowName).toBe("Login Flow");
    expect(trace.steps).toHaveLength(2);
    expect(trace.steps[0].label).toBeTruthy(); // uses describeStep, not just the raw action name

    const html = await readFile(reportPath, "utf8");
    expect(html).toContain(runId);
    expect(html).toContain("Login Flow");
    expect(html).toContain("PASSED");
    // AC4's "referenced from the HTML report" — the trace file must actually be linked.
    expect(html).toContain('href="trace.json"');
  });

  it("a failed run's report says FAILED and includes the error text", async () => {
    const runId = `test-report-${Date.now()}-b`;
    const summary = makeSummary(runId, {
      passed: false,
      status: "failed",
      passedCount: 1,
      failedCount: 1,
      results: [
        { index: 0, stepId: "s1", action: "tapText", status: "passed", ok: true },
        { index: 1, stepId: "s2", action: "assertVisible", status: "failed", ok: false, error: "Welcome not visible" },
      ],
    });
    const { dir, reportPath } = await writeRunReport(makeFlow(), summary);
    createdDirs.push(dir);

    const html = await readFile(reportPath, "utf8");
    expect(html).toContain("FAILED");
    expect(html).toContain("Welcome not visible");
  });

  it("escapes HTML-special characters in the flow name / step error so a malformed page can't result", async () => {
    const runId = `test-report-${Date.now()}-c`;
    const flow = makeFlow({ name: `<script>alert("x")</script> & "quotes"` });
    const summary = makeSummary(runId, {
      flowName: flow.name,
      passed: false,
      status: "failed",
      results: [{ index: 0, stepId: "s1", action: "tapText", status: "failed", ok: false, error: `<b>boom</b> & "ouch"` }],
    });
    const { dir, reportPath } = await writeRunReport(flow, summary);
    createdDirs.push(dir);

    const html = await readFile(reportPath, "utf8");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<b>boom</b>");
    expect(html).toContain("&lt;b&gt;boom&lt;/b&gt;");
  });
});
