import type { RunSummary } from "../shared/protocol.ts";
import { buildZip, type ZipEntry } from "../shared/zip.ts";
import type { TriageResult } from "../shared/triage.ts";
import { artifactUrl } from "./api.ts";
import { downloadBytes } from "./bundle-io.ts";
import type { Trace } from "./trace.ts";
import { traceToJson } from "./trace.ts";

/**
 * bug-export.ts — one-click bug export (E22, janus-specs/R4-selfheal-collab/E22-triage-
 * bugexport.md, AC3/AC4).
 *
 * AC3: the export bundle must contain failure screenshot(s), the execution trace, step-by-step
 * history, and environment metadata — all four gathered here from data the app already produces
 * (E18's Trace, E2's RunSummary) via the existing `/api/artifact` endpoint, zero new bridge/
 * surface. AC4: the export TARGET (generic zip+markdown vs. a Jira adapter) is config-driven —
 * `getExportTarget()` is the ONLY place that branches on target type; every caller just builds a
 * bundle and calls `.export()` on whatever target the config resolves to, so switching targets is
 * genuinely a config change, never a code change.
 */

export interface BugEnvironmentMetadata {
  runId: string;
  platform: string;
  bundleId: string;
  udid: string;
  /** Not tracked anywhere in this app today (grepped — no "app version" concept exists yet) —
   * honestly omitted rather than fabricated; a real integration would need the driver to surface
   * it (out of this epic's bridge/-free scope). */
  appVersion?: string;
  /** stg/qa/prod (E11) when known. */
  environment?: string;
}

export interface BugBundleInput {
  summary: RunSummary;
  trace: Trace;
  triage: TriageResult;
  environment: BugEnvironmentMetadata;
}

function buildMarkdownReport(input: BugBundleInput): string {
  const { summary, trace, triage, environment } = input;
  const lines: string[] = [
    `# Báo cáo lỗi — ${summary.flowName}`,
    "",
    `- Phân loại: **${triage.triageClass}** — ${triage.reason}`,
    `- Hành động tiếp theo: **${triage.nextAction}**`,
    `- Run ID: ${environment.runId}`,
    `- Nền tảng: ${environment.platform}`,
    `- Bundle ID: ${environment.bundleId}`,
    `- Thiết bị: ${environment.udid}`,
  ];
  if (environment.appVersion) lines.push(`- Phiên bản ứng dụng: ${environment.appVersion}`);
  if (environment.environment) lines.push(`- Môi trường: ${environment.environment}`);
  lines.push("", "## Lịch sử từng bước", "", "| # | Hành động | Trạng thái | Thời gian (ms) | Số lần thử | Chi tiết |", "|---|---|---|---|---|---|");
  for (const s of trace.steps) {
    const detail = (s.error ?? s.detail ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
    lines.push(`| ${s.index + 1} | ${s.label} | ${s.status} | ${s.durationMs ?? "-"} | ${s.attempts ?? 1} | ${detail} |`);
  }
  return lines.join("\n");
}

async function fetchScreenshotBytes(path: string): Promise<Uint8Array> {
  const res = await fetch(artifactUrl(path));
  if (!res.ok) throw new Error(`Không tải được ảnh chụp màn hình: ${path}`);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Assemble the bug bundle's contents (AC3's checklist): the markdown report (step history +
 * environment metadata + classification), the raw trace JSON, and every distinct screenshot
 * referenced by the trace. A screenshot that can't be fetched (already garbage-collected, e.g.
 * E9's derived-cache GC) is skipped rather than failing the whole export — one missing artifact
 * should never block a QA from getting everything else that's still available.
 */
export async function buildBugBundleEntries(input: BugBundleInput): Promise<ZipEntry[]> {
  const entries: ZipEntry[] = [
    { name: "report.md", data: new TextEncoder().encode(buildMarkdownReport(input)) },
    { name: "trace.json", data: new TextEncoder().encode(traceToJson(input.trace)) },
    { name: "environment.json", data: new TextEncoder().encode(JSON.stringify(input.environment, null, 2)) },
  ];

  const seen = new Set<string>();
  for (const step of input.trace.steps) {
    for (const path of [step.beforeScreenshot, step.afterScreenshot]) {
      if (!path || seen.has(path)) continue;
      seen.add(path);
      try {
        entries.push({ name: `screenshots/${path.split("/").pop()}`, data: await fetchScreenshotBytes(path) });
      } catch {
        // Missing/unreadable screenshot — degrade gracefully, see doc comment above.
      }
    }
  }
  return entries;
}

// ─── AC4: config-driven export target ───────────────────────────────────────

export interface BugExportResult {
  ok: boolean;
  detail: string;
}

export interface BugExportTarget {
  name: "generic-zip" | "jira";
  export(entries: ZipEntry[], input: BugBundleInput): Promise<BugExportResult>;
}

export interface JiraAdapterConfig {
  baseUrl: string;
  projectKey: string;
  /** ALWAYS an unresolved `${secret:...}` reference — never a raw API token embedded in config,
   * same non-negotiable E12's secrets seam already enforces everywhere else in this app. */
  apiTokenRef: string;
}

export interface BugExportConfig {
  target: "generic-zip" | "jira";
  jira?: JiraAdapterConfig;
}

export interface JiraIssuePayload {
  summary: string;
  description: string;
  attachments: ZipEntry[];
}

export interface PostJiraIssueResult {
  ok: boolean;
  issueKey?: string;
  error?: string;
}

/** Injectable — same DI pattern as bridge/doctor.ts's `ExecFn`/bridge/webview-driver.ts's
 * `ConnectWebViewFn` — so the Jira adapter's SEAM is genuinely unit-testable without a live Jira
 * instance or a real API token. */
export type PostJiraIssueFn = (config: JiraAdapterConfig, payload: JiraIssuePayload) => Promise<PostJiraIssueResult>;

async function defaultPostJiraIssue(config: JiraAdapterConfig): Promise<PostJiraIssueResult> {
  // A real integration would resolve `config.apiTokenRef` via the SAME secrets seam (E12)
  // already used for every other credential in this app, then POST to
  // `${config.baseUrl}/rest/api/2/issue`. This dev environment has no real Jira instance/token to
  // integrate against — honest, non-fatal failure (never fakes success), the same pattern
  // bridge/webview-driver.ts's `defaultConnect` already uses for its own runtime-gated case.
  return {
    ok: false,
    error: `Chưa cấu hình kết nối Jira thật cho "${config.baseUrl}" — cần một máy chủ Jira thật và secret API token đã cấu hình.`,
  };
}

export function genericZipTarget(): BugExportTarget {
  return {
    name: "generic-zip",
    async export(entries) {
      downloadBytes(buildZip(entries), `bug-report-${Date.now()}.zip`, "application/zip");
      return { ok: true, detail: "Đã tải xuống gói lỗi (zip)." };
    },
  };
}

export function jiraAdapterTarget(config: JiraAdapterConfig, postIssue: PostJiraIssueFn = defaultPostJiraIssue): BugExportTarget {
  return {
    name: "jira",
    async export(entries, input) {
      const result = await postIssue(config, {
        summary: `[${input.triage.triageClass}] ${input.summary.flowName}`,
        description: buildMarkdownReport(input),
        attachments: entries,
      });
      return result.ok
        ? { ok: true, detail: `Đã tạo issue Jira: ${result.issueKey}` }
        : { ok: false, detail: result.error ?? "Xuất sang Jira thất bại." };
    },
  };
}

/**
 * The ONLY place that branches on export-target type (AC4) — every call site just builds a
 * `BugExportConfig` (a plain settings object, e.g. persisted in localStorage or a settings
 * panel — not shown here, out of this pass's UI scope) and calls this. Switching from
 * `{ target: "generic-zip" }` to `{ target: "jira", jira: {...} }` (or back) is a config-value
 * change; nothing downstream of `getExportTarget` needs to know or care which target it got.
 */
export function getExportTarget(config: BugExportConfig, deps: { postIssue?: PostJiraIssueFn } = {}): BugExportTarget {
  if (config.target === "jira") {
    if (!config.jira) throw new Error("Thiếu cấu hình Jira (jira.baseUrl / projectKey / apiTokenRef).");
    return jiraAdapterTarget(config.jira, deps.postIssue);
  }
  return genericZipTarget();
}
