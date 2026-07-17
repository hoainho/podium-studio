import type { Flow, FlowParam, FlowStep } from "../shared/ir.ts";
import type { DryRunResult, LintResult } from "../shared/lint.ts";
import type { AiMode, CoPilotSuggestion, ProviderRegistryConfig } from "../shared/ai-types.ts";
import type {
  Device,
  DoctorReport,
  EnvironmentName,
  EnvironmentSummary,
  HealthReport,
  InstalledApp,
  PinLessonRequest,
  RunEvent,
  RunRequest,
  RunSummary,
  SeedResetResult,
  SuiteReport,
  SuiteRequest,
  TestAccountSummary,
} from "../shared/protocol.ts";

/** Typed REST + WebSocket client for the Podium Studio bridge (see bridge/server.ts). */

// Task #45 fix — packaged-app networking. This client used to call `fetch("/api/...")` (a
// relative URL) and build the WS URL from `location.host`. That only resolves correctly when the
// page is served BEHIND Vite's dev proxy (vite.config.ts forwards /api and /ws to :8787) — true
// for both plain browser dev (`npm run dev`) and `tauri dev` (its devUrl is that same Vite
// server). It breaks in the PACKAGED app: there the frontend is loaded from Tauri's own asset
// origin (no dev server, no proxy), so the relative fetch never reaches the bridge ("Not
// connected" everywhere), and `location.host` isn't a normal "host:port" under that origin, so
// `ws://${location.host}/ws` becomes a malformed URL — confirmed as the exact WKWebView
// DOMException ("The string did not match the expected pattern") reported in the Simulators/
// Flows/Flakiness panels of the real packaged build.
//
// The fix: always talk to the bridge via its real, fixed local address instead of a
// origin-relative one. This is safe in EVERY mode, not just packaged, because:
//  - bridge/server.ts's `app.use(cors())` allows any origin, so a cross-origin fetch from the
//    Vite dev server (http://localhost:5178) to http://localhost:8787 works exactly like the
//    proxied one did.
//  - the bridge's WebSocketServer is created with no `verifyClient`/Origin check, so a direct
//    `ws://localhost:8787/ws` connection is accepted the same as a proxied one.
// `8787` mirrors bridge/server.ts's own `BRIDGE_PORT` default and vite.config.ts's existing proxy
// target — this is the same fixed port the bridge always binds to (BRIDGE_PORT is never set to
// anything else by src-tauri/src/lib.rs when it spawns the packaged sidecar).
const BRIDGE_HTTP_ORIGIN = "http://localhost:8787";
const BRIDGE_WS_URL = "ws://localhost:8787/ws";

export interface FlowListItem {
  file: string;
  name: string;
  steps: number;
  bundleId: string;
  /** Free-form suite-by-tag labels (E18) — empty array for a flow with none, never omitted, so
   * the UI never needs an `?? []` fallback at every call site. */
  tags: string[];
  /** This flow's own sub-flow call-parameter signature (E13) — empty array for an ordinary,
   * non-reusable flow; a non-empty array marks it as browsable/insertable in the component
   * gallery as a callable sub-flow. */
  params: FlowParam[];
}

export interface ExportResult {
  yaml: string;
  warnings: string[];
}

/**
 * Thrown by `request()` instead of a plain `Error` so callers can tell "the bridge answered
 * with a non-2xx status" (a real HTTP status, e.g. 404 for a not-yet-wired endpoint like
 * /api/ai/registry — see the E24 doc comment below) apart from "fetch() itself never reached
 * the bridge" (status 0 — bridge not running / network down). Components use this via
 * src/friendly.ts's `friendlyApiError` to show a calm, localized sentence instead of a raw
 * "404 Not Found"/status line, which is always in English regardless of the active locale.
 */
export class ApiError extends Error {
  status: number;
  /** The specific `{ error }` message the bridge returned in its JSON body, when it did — as
   * opposed to a bare HTTP status line ("500 Internal Server Error"). Set ONLY when the server
   * gave a real, human-meaningful reason, so `friendlyApiError` can surface that actionable text
   * (e.g. "AI provider key ... not found") instead of a fully generic sentence (QA audit AI-3). */
  serverMessage?: string;
  constructor(status: number, message: string, serverMessage?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.serverMessage = serverMessage;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BRIDGE_HTTP_ORIGIN}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
  } catch (err) {
    // fetch() itself threw — no HTTP response at all (bridge not running / network down).
    // Status 0 is the "unreachable" signal friendlyApiError keys off of.
    throw new ApiError(0, err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    let serverMessage: string | undefined;
    try {
      const body = await res.json();
      if (body?.error) {
        message = body.error;
        serverMessage = body.error;
      }
    } catch {
      // ignore — keep the status line as the message (no server-provided reason)
    }
    throw new ApiError(res.status, message, serverMessage);
  }
  return (await res.json()) as T;
}

export function getHealth(): Promise<HealthReport> {
  return request<HealthReport>("/api/health");
}

export function getDevices(): Promise<{ ios: Device[]; android: unknown }> {
  return request<{ ios: Device[]; android: unknown }>("/api/devices");
}

/** Run the Environment Doctor preflight (Xcode CLT, idb, JRE, simulator, Podium engine). */
export function getDoctor(): Promise<DoctorReport> {
  return request<DoctorReport>("/api/doctor");
}

export async function bootDevice(udid: string): Promise<void> {
  await request("/api/boot", { method: "POST", body: JSON.stringify({ udid }) });
}

export async function getApps(udid: string): Promise<InstalledApp[]> {
  const { apps } = await request<{ apps: InstalledApp[] }>(
    `/api/apps?udid=${encodeURIComponent(udid)}`,
  );
  return apps;
}

export function getAppState(udid: string, bundleId: string): Promise<{ installed: boolean; running: boolean }> {
  return request<{ installed: boolean; running: boolean }>(
    `/api/app-state?udid=${encodeURIComponent(udid)}&bundleId=${encodeURIComponent(bundleId)}`,
  );
}

export async function launchApp(udid: string, bundleId: string): Promise<void> {
  await request("/api/launch", { method: "POST", body: JSON.stringify({ udid, bundleId }) });
}

export async function listFlows(): Promise<FlowListItem[]> {
  const { flows } = await request<{ flows: FlowListItem[] }>("/api/flows");
  return flows;
}

export function loadFlow(file: string): Promise<Flow> {
  return request<Flow>(`/api/flows/${encodeURIComponent(file)}`);
}

/**
 * Save a flow. Pass `opts.fileName` (the file the flow was loaded from) when saving an EXISTING
 * flow so the bridge writes back to that same file — renaming a flow then updates it in place
 * instead of creating a slug-of-new-name duplicate and orphaning the original (QA audit AUTH-2).
 * Omit `fileName` for a brand-new flow.
 */
export async function saveFlow(flow: Flow, opts?: { fileName?: string }): Promise<{ file: string; flow: Flow }> {
  return request<{ file: string; flow: Flow }>("/api/flows", {
    method: "POST",
    body: JSON.stringify({ flow, fileName: opts?.fileName }),
  });
}

export function exportFlow(flow: Flow): Promise<ExportResult> {
  return request<ExportResult>("/api/export", {
    method: "POST",
    body: JSON.stringify(flow),
  });
}

export interface LintResponse {
  dryRun: DryRunResult;
  lint: LintResult;
}

/**
 * Pre-run lint / dry-run (E3), also the data source for E4's selector-ambiguity UI
 * (AC5): when `udid` names a booted simulator, the bridge reads its CURRENT screen
 * (read-only — never taps/types) and lint's no-match/ambiguous-match findings become
 * "khớp N phần tử" against that live screen; without `udid`, only the structural checks
 * (unreachable / no-assertion) run.
 */
export function lintFlow(flow: Flow, udid?: string): Promise<LintResponse> {
  return request<LintResponse>("/api/lint", {
    method: "POST",
    body: JSON.stringify({ flow, udid }),
  });
}

export function runFlow(req: RunRequest): Promise<RunSummary> {
  return request<RunSummary>("/api/run", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

/** Run the open flow in a real browser instead of on the iOS simulator (Web target — a RUN-TIME
 * choice, not a flow field; `flow.app.platform` is untouched). Mirrors runFlow's shape: same
 * RunSummary, same WS event stream, just POSTed to /api/run-web (bridge/browser-driver.ts's
 * runBrowserSuite under the hood). `url` is optional metadata only for now — the flow itself
 * carries whatever openLink step navigates the browser. */
export function runWebFlow(flow: Flow, url?: string): Promise<RunSummary> {
  return request<RunSummary>("/api/run-web", {
    method: "POST",
    body: JSON.stringify({ flow, url }),
  });
}

/** Run a tag-filtered suite of flows through the EXISTING /api/suite endpoint (E15) — E18 only
 * adds the client-side tag filtering (shared/tags.ts's filterFlowsByTags) that decides which
 * flows become `jobs` before this call; the endpoint itself needed no changes. */
export function runSuite(req: SuiteRequest): Promise<SuiteReport> {
  return request<SuiteReport>("/api/suite", {
    method: "POST",
    body: JSON.stringify(req),
  });
}

/** Ask the bridge to stop the in-flight run (cooperative — no further steps start). Requires the
 * `runId` the client learned from the "run:start" WS event — the bridge targets that specific run
 * (QA audit P0-1: this used to POST an empty body, so /api/cancel always 500'd with "runId
 * required" and Stop did nothing). */
export async function cancelRun(runId: string): Promise<void> {
  await request("/api/cancel", { method: "POST", body: JSON.stringify({ runId }) });
}

/** Absolute (never origin-relative) — this is used directly as `<img src>` in several
 * components (RunPanel/TriagePanel/TraceViewer/RecordPanel), not just via `request()`, so it
 * needs the same task #45 fix independently: a relative `/api/artifact?...` `<img src>` resolves
 * against the PAGE's own origin exactly like a relative `fetch()` does, and breaks the same way
 * in the packaged app. */
export function artifactUrl(path: string, cacheBust?: number): string {
  const base = `${BRIDGE_HTTP_ORIGIN}/api/artifact?path=${encodeURIComponent(path)}`;
  return cacheBust ? `${base}&t=${cacheBust}` : base;
}

// ─── Record mode ────────────────────────────────────────────────────────────
export interface ScreenFrame {
  path: string;
  scale: number;
  ts: number;
}

export interface ActResult {
  ok: boolean;
  detail: string | null;
  error: string | null;
  screen: string;
  scale: number;
  ts: number;
}

/** Capture a fresh mirror frame of the device screen. */
export function captureScreen(udid: string): Promise<ScreenFrame> {
  return request<ScreenFrame>(`/api/screen?udid=${encodeURIComponent(udid)}`);
}

/** Execute a single step live on the device (record-by-doing) and get the new frame. */
export function actStep(udid: string, step: FlowStep, bundleId?: string): Promise<ActResult> {
  return request<ActResult>("/api/act", {
    method: "POST",
    body: JSON.stringify({ udid, step, bundleId }),
  });
}

/** Raw accessibility-tree snapshot of the device's CURRENT screen (read-only — never taps/types),
 * for the E14 oracle suggester (test-design.ts's `flattenInspectTree`/`suggestOracleFromScreen`),
 * which proposes an expected value from what's ACTUALLY on screen rather than a static guess. */
export function inspectScreen(udid: string): Promise<unknown> {
  return request<unknown>("/api/inspect", {
    method: "POST",
    body: JSON.stringify({ udid }),
  });
}

// ─── Test-data & environment layer (E11) ────────────────────────────────────
export interface EnvironmentState {
  current: EnvironmentName;
  available: EnvironmentSummary[];
}

/** Current bridge-side environment selector (stg/qa/prod) — config-only, never a flow edit. */
export function getEnvironment(): Promise<EnvironmentState> {
  return request<EnvironmentState>("/api/environment");
}

export function setEnvironment(name: EnvironmentName): Promise<EnvironmentState> {
  return request<EnvironmentState>("/api/environment", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

/** Test-account roles for an environment. `passwordRef` is always the unresolved `${secret:...}`
 * token — this call never returns (or needs) a real credential. */
export function getTestAccounts(env?: EnvironmentName): Promise<{ env: EnvironmentName; accounts: TestAccountSummary[] }> {
  const qs = env ? `?env=${encodeURIComponent(env)}` : "";
  return request(`/api/test-accounts${qs}`);
}

export function runSeedReset(
  role: string,
  hooks: string[],
  env?: EnvironmentName,
): Promise<{ results: SeedResetResult[] }> {
  return request("/api/test-data/seed-reset", {
    method: "POST",
    body: JSON.stringify({ role, hooks, env }),
  });
}

// ─── WebView-aware inspector (E17) ──────────────────────────────────────────

/**
 * One node of a WebView's live DOM tree (E17 — janus-specs/R3-reuse-browser/E17-webview-
 * inspector.md, AC1: "element tree renders with correct node hierarchy"). Mirrors
 * bridge/webview-driver.ts's `WebViewInspectorNode` shape — declared locally rather than
 * imported, since this epic's src/ half doesn't touch bridge/; a teammate is wiring the actual
 * endpoint on a separate task, reconciled here at verify if the wire shape ends up differing.
 */
export interface WebViewInspectorNode {
  tag: string;
  /** Only set on a leaf node (no children) — same "only the innermost element carries text"
   * convention the backend's `inspectWebViewTree` already documents. */
  text?: string;
  testId?: string;
  children: WebViewInspectorNode[];
}

/**
 * Live element tree of the target app's currently-attached WebView (read-only — never taps/
 * types), for the inspector UI's browse-and-click-to-select flow (AC1). `POST /api/webview/
 * inspect` (bridge/server.ts) attaches to the app's WebView, walks it, and closes the attach —
 * stateless per call, same "no server-side session" design `/api/inspect`'s mobile a11y path
 * already has.
 */
export async function inspectWebView(udid: string, bundleId: string): Promise<WebViewInspectorNode> {
  const { tree } = await request<{ tree: WebViewInspectorNode }>("/api/webview/inspect", {
    method: "POST",
    body: JSON.stringify({ udid, bundleId }),
  });
  return tree;
}

// ─── Run history (E9 primary store) — read path for E23's flakiness trend ──

/** One past run, as recorded by E9's primary SQLite store (`runs` table) — flow-level only
 * (bridge/db's `run_results` table holds per-step rows too, but has no read path exposed yet;
 * this epic's scope keeps bridge/ untouched, so step-level history isn't available from this
 * client — see E23's own completion notes for that disclosed gap). */
export interface RunHistoryEntry {
  runId: string;
  flowName: string;
  udid: string;
  bundleId: string;
  passed: boolean;
  status: string;
  total: number;
  passedCount: number;
  failedCount: number;
  softFailedCount: number;
  durationMs: number;
  startedAt: number;
}

function toRunHistoryEntry(row: Record<string, unknown>): RunHistoryEntry {
  return {
    runId: String(row.run_id),
    flowName: String(row.flow_name),
    udid: String(row.udid),
    bundleId: String(row.bundle_id),
    passed: Number(row.passed) === 1,
    status: String(row.status),
    total: Number(row.total),
    passedCount: Number(row.passed_count),
    failedCount: Number(row.failed_count),
    softFailedCount: Number(row.soft_failed_count),
    durationMs: Number(row.duration_ms),
    startedAt: Number(row.started_at),
  };
}

/** Past runs (newest first), for E23's flow-level flakiness trend — reuses the EXISTING
 * `GET /api/db/runs` endpoint (E9) verbatim, just typed/normalized on this side; no bridge/
 * change needed. */
export async function getRunHistory(limit = 100): Promise<RunHistoryEntry[]> {
  const { runs } = await request<{ runs: Array<Record<string, unknown>> }>(`/api/db/runs?limit=${limit}`);
  return runs.map(toRunHistoryEntry);
}

// ─── Self-heal "save this fix?" approval (E19 UI) ───────────────────────────

/** Approve ("pin") a recorded, unpinned lesson — the ONLY thing that makes it eligible for rung
 * 1-3 replay (shared/protocol.ts's own doc comment). Always a deliberate human action from the
 * "save this fix?" prompt; never called automatically by a run itself. */
export async function pinLesson(lessonId: string): Promise<void> {
  const body: PinLessonRequest = { lessonId };
  await request("/api/selfheal/pin", { method: "POST", body: JSON.stringify(body) });
}

// ─── E24: provider registry + Strict/Adaptive mode + authoring co-pilot ─────
// Wired to bridge/server.ts's live routes: GET/POST /api/ai/providers (the whole registry),
// GET/POST /api/ai/mode, POST /api/ai/copilot/draft + /suggest-assertions. Shapes match
// shared/ai-types.ts (`ProviderRegistryConfig`/`CoPilotSuggestion`). (These paths were previously
// mismatched — the client used /api/ai/registry + /copilot/draft-flow, which 404'd on save.)

export async function getAiRegistry(): Promise<ProviderRegistryConfig> {
  return request<ProviderRegistryConfig>("/api/ai/providers");
}

/** Save the whole provider list + routing config in one call — validated server-side against
 * AC5's agent-cli/recovery ban (this is NOT a substitute for that; src/ai-provider.ts's own
 * `validateRouting` just gives the UI an earlier, clearer rejection). */
export async function saveAiRegistry(config: ProviderRegistryConfig): Promise<ProviderRegistryConfig> {
  return request<ProviderRegistryConfig>("/api/ai/providers", {
    method: "POST",
    body: JSON.stringify(config),
  });
}

/** Store a pasted API key in the macOS Keychain (the in-app, no-terminal path for a non-technical
 * QA). Returns the `keychain:<name>` reference to persist as the provider's `apiKeyRef`. The raw
 * key is sent once to the bridge, written straight to the Keychain, and never persisted in the
 * registry JSON or logged. `name` is the provider's id. */
export async function storeProviderKey(name: string, key: string): Promise<{ ok: boolean; apiKeyRef: string }> {
  return request<{ ok: boolean; apiKeyRef: string }>("/api/ai/provider-key", {
    method: "POST",
    body: JSON.stringify({ name, key }),
  });
}

/** Verify an AI provider works end-to-end (key resolves + a real minimal call succeeds). Pass a
 * provider `id`, or omit to test the primary authoring provider. Returns a clear ok/fail result
 * with the model + latency, or a secret-scrubbed error — the "is my AI set up?" one-click check. */
export async function testAiProvider(id?: string): Promise<{ ok: boolean; provider: string; model?: string; latencyMs?: number; error?: string }> {
  return request("/api/ai/test-provider", { method: "POST", body: JSON.stringify({ id }) });
}

export async function getAiMode(): Promise<{ mode: AiMode }> {
  return request<{ mode: AiMode }>("/api/ai/mode");
}

export async function setAiMode(mode: AiMode): Promise<{ mode: AiMode }> {
  return request<{ mode: AiMode }>("/api/ai/mode", {
    method: "POST",
    body: JSON.stringify({ mode }),
  });
}

/** Draft a whole flow from a prose prompt (AC7) — ALWAYS returns a review diff, never writes the
 * canonical flow file itself; applying any of it is a separate, explicit client-side action
 * (src/copilot-diff.ts's `applyAcceptedHunks` + the normal `saveFlow` call, same as every other
 * edit in this app). */
export async function copilotDraftFlow(prompt: string, baseFlow?: Flow): Promise<CoPilotSuggestion> {
  return request<CoPilotSuggestion>("/api/ai/copilot/draft", {
    method: "POST",
    body: JSON.stringify({ prompt, flow: baseFlow }),
  });
}

/** Suggest additional/improved assertions for an existing flow (AC7) — same review-diff
 * contract as `copilotDraftFlow`. */
export async function copilotSuggestAssertions(flow: Flow): Promise<CoPilotSuggestion> {
  return request<CoPilotSuggestion>("/api/ai/copilot/suggest-assertions", {
    method: "POST",
    body: JSON.stringify({ flow }),
  });
}

/** Open the run-event WebSocket. Returns a disconnect function. */
export function connectRunEvents(onEvent: (e: RunEvent) => void): () => void {
  const ws = new WebSocket(BRIDGE_WS_URL);
  ws.onmessage = (msg) => {
    try {
      const event = JSON.parse(msg.data as string) as RunEvent;
      onEvent(event);
    } catch {
      // ignore malformed frames
    }
  };
  return () => {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
  };
}
