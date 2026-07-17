import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RunSummary } from "../shared/protocol.ts";
import type { Trace } from "../src/trace.ts";
import {
  buildBugBundleEntries,
  genericZipTarget,
  getExportTarget,
  jiraAdapterTarget,
  type BugBundleInput,
  type PostJiraIssueFn,
} from "../src/bug-export.ts";
import { classifyFailure } from "../shared/triage.ts";

/**
 * E22 — bug-export bundle assembly (AC3) and config-driven export target (AC4). Mocks `fetch`
 * (screenshot retrieval) and injects a fake Jira poster (same DI pattern used throughout this
 * codebase) — no live artifact server or Jira instance needed.
 */

function trace(over: Partial<Trace> = {}): Trace {
  return {
    runId: "run-1",
    flowName: "Login flow",
    passed: false,
    startedAt: Date.now(),
    durationMs: 1234,
    steps: [
      { index: 0, stepId: "s1", action: "tapText", label: "Nhấn Email", status: "passed", beforeScreenshot: undefined, afterScreenshot: "artifacts/run-1/s1-after.png" },
      { index: 1, stepId: "s2", action: "assertVisible", label: "Kiểm tra Số dư", status: "failed", beforeScreenshot: "artifacts/run-1/s1-after.png", afterScreenshot: "artifacts/run-1/s2-after.png", error: "Expected 120 but found 100" },
    ],
    ...over,
  };
}

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "run-1",
    flowName: "Login flow",
    udid: "sim-udid-1",
    bundleId: "com.example.demoapp",
    passed: false,
    status: "failed",
    total: 2,
    passedCount: 1,
    failedCount: 1,
    softFailedCount: 0,
    durationMs: 1234,
    startedAt: Date.now(),
    results: [],
    ...over,
  };
}

function bundleInput(over: Partial<BugBundleInput> = {}): BugBundleInput {
  const t = trace();
  const s = summary();
  const triage = classifyFailure({ action: "assertVisible", selectorMatchCount: 1, assertionValueMismatch: true });
  return {
    summary: s,
    trace: t,
    triage,
    environment: { runId: s.runId, platform: "ios-sim", bundleId: s.bundleId, udid: s.udid },
    ...over,
  };
}

describe("buildBugBundleEntries — AC3: screenshot(s) + trace + step history + environment metadata", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) as unknown as Response),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("includes report.md, trace.json, and environment.json", async () => {
    const entries = await buildBugBundleEntries(bundleInput());
    const names = entries.map((e) => e.name);
    expect(names).toContain("report.md");
    expect(names).toContain("trace.json");
    expect(names).toContain("environment.json");
  });

  it("includes every DISTINCT screenshot referenced by the trace, deduped", async () => {
    const entries = await buildBugBundleEntries(bundleInput());
    const screenshotNames = entries.map((e) => e.name).filter((n) => n.startsWith("screenshots/"));
    // s1-after.png appears as both step 1's afterScreenshot AND step 2's beforeScreenshot —
    // must be included exactly once.
    expect(screenshotNames.sort()).toEqual(["screenshots/s1-after.png", "screenshots/s2-after.png"]);
  });

  it("report.md contains the classification, next-action, and a step-by-step table", async () => {
    const entries = await buildBugBundleEntries(bundleInput());
    const report = new TextDecoder().decode(entries.find((e) => e.name === "report.md")!.data);
    expect(report).toContain("wrongExpectedValue");
    expect(report).toContain("Xem lại giá trị mong đợi");
    expect(report).toContain("Nhấn Email");
    expect(report).toContain("Kiểm tra Số dư");
  });

  it("environment.json round-trips the environment metadata verbatim", async () => {
    const input = bundleInput({ environment: { runId: "run-9", platform: "android", bundleId: "com.x", udid: "u-9", appVersion: "1.2.3" } });
    const entries = await buildBugBundleEntries(input);
    const env = JSON.parse(new TextDecoder().decode(entries.find((e) => e.name === "environment.json")!.data));
    expect(env).toEqual({ runId: "run-9", platform: "android", bundleId: "com.x", udid: "u-9", appVersion: "1.2.3" });
  });

  it("degrades gracefully when a screenshot fetch fails (doesn't block the rest of the export)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false }) as unknown as Response));
    const entries = await buildBugBundleEntries(bundleInput());
    const names = entries.map((e) => e.name);
    expect(names).toContain("report.md"); // still produced
    expect(names.some((n) => n.startsWith("screenshots/"))).toBe(false); // just skipped
  });

  it("never contains a ${secret:...} token or fixture data (spot-check, non-negotiable §3.5)", async () => {
    const entries = await buildBugBundleEntries(bundleInput());
    for (const entry of entries) {
      if (entry.name.startsWith("screenshots/")) continue; // binary, not text
      const text = new TextDecoder().decode(entry.data);
      expect(text).not.toMatch(/\$\{secret:/i);
    }
  });
});

describe("getExportTarget — AC4: config-driven, no code branch at the call site", () => {
  it("returns a working generic-zip target for { target: 'generic-zip' }", async () => {
    const target = getExportTarget({ target: "generic-zip" });
    expect(target.name).toBe("generic-zip");
  });

  it("returns a working jira target for { target: 'jira', jira: {...} }, with zero code changes at this call site", async () => {
    const fakePostIssue: PostJiraIssueFn = vi.fn(async () => ({ ok: true, issueKey: "BUG-123" }));
    const target = getExportTarget(
      { target: "jira", jira: { baseUrl: "https://example.atlassian.net", projectKey: "BUG", apiTokenRef: "${secret:jiraToken}" } },
      { postIssue: fakePostIssue },
    );
    expect(target.name).toBe("jira");
    const result = await target.export([{ name: "report.md", data: new Uint8Array() }], bundleInput());
    expect(result.ok).toBe(true);
    expect(fakePostIssue).toHaveBeenCalledOnce();
  });

  it("throws a clear error when target is 'jira' but no jira config is supplied", () => {
    expect(() => getExportTarget({ target: "jira" })).toThrow(/Jira/);
  });

  it("jiraAdapterTarget calls the injected postIssue with a summary tagged by triage class", async () => {
    const fakePostIssue: PostJiraIssueFn = vi.fn(async () => ({ ok: true, issueKey: "BUG-1" }));
    const target = jiraAdapterTarget({ baseUrl: "https://x.atlassian.net", projectKey: "P", apiTokenRef: "${secret:x}" }, fakePostIssue);
    await target.export([], bundleInput());
    const [, payload] = (fakePostIssue as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload.summary).toContain("wrongExpectedValue");
  });

  it("jiraAdapterTarget surfaces a real failure (no live Jira available) honestly, never fakes success", async () => {
    const target = jiraAdapterTarget({ baseUrl: "https://no-such-jira.example", projectKey: "P", apiTokenRef: "${secret:x}" });
    const result = await target.export([], bundleInput());
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/Jira/);
  });

  it("genericZipTarget's own factory produces the same target shape independent of getExportTarget", () => {
    expect(genericZipTarget().name).toBe("generic-zip");
  });
});
