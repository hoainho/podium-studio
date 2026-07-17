import type { Flow } from "./ir.ts";
import type { ProposedPatch } from "./selfheal-types.ts";
import type { AiCallLogEntry, CoPilotSuggestion, ProviderRegistryConfig } from "./ai-types.ts";

/** REST + WebSocket contract between the React UI and the Node engine-bridge. */

export interface Device {
  udid: string;
  name: string;
  state: string; // "Booted" | "Shutdown" | ...
  runtime: string;
  platform: string;
}

export interface InstalledApp {
  bundleId: string;
  name: string;
  type: string;
}

export interface HealthReport {
  ok: boolean;
  podium?: {
    name: string;
    version: string;
    toolCount: number;
    toolchain: Record<string, boolean | string>;
    gestureBackend?: string;
  };
  error?: string;
}

// "failed-soft" = a `soft`-flagged step failed (E2 AC5): recorded distinctly from a hard
// "failed" step, and does NOT halt the run.
export type StepStatus = "pending" | "running" | "passed" | "failed" | "failed-soft" | "skipped";

/** Terminal run outcome, distinct from the boolean `passed` (E2 AC6: cancel is its own status). */
export type RunStatus = "passed" | "failed" | "cancelled";

export interface StepResult {
  index: number;
  stepId: string;
  action: string;
  status: StepStatus;
  ok: boolean;
  detail?: string;
  error?: string;
  backend?: string;
  screenshot?: string; // path under artifacts/, served at /api/artifact?path=
  startedAt?: number;
  finishedAt?: number;
  /** Total attempts made for this step (1 = no retry needed). >1 marks the run as "flaky". */
  attempts?: number;
  /** E19/E24 — which self-heal rung (1-4) recovered this step, if any. Rung 0 (plain retry) does
   * NOT set this — it's already fully captured by `attempts > 1`; this field is specifically for
   * "rungs 1-4 actually changed something" (re-resolved a locator, dismissed a popup, replayed a
   * pinned lesson, or — rung 4, E24, Adaptive-mode only — an AI-proposed, IR-validated action),
   * which the trace/time-travel viewer (E18) and the R4 triage panel (E22) need to show distinctly
   * from an ordinary retry. Absent when self-heal wasn't enabled for this run, or wasn't needed. */
  healedRung?: 1 | 2 | 3 | 4;
  /** E19 gap-fix — the actual "save this fix?" patch data for a healed step (undefined for an
   * assertion heal, which never produces one — AC5; also undefined when self-heal never healed
   * this step). Populated only when `healedRung` is also set. `pendingHeal.lessonId` is present
   * when the backend already has a persisted (unpinned) lesson row to pin — see
   * `bridge/runner.ts`'s self-heal wiring and `shared/selfheal-types.ts`'s `ProposedPatch` for
   * why a brand-new rung 1/2 heal may still lack one if persistence raced/failed. This is the
   * field the "save this fix?" UI (src/heal-approval.ts) reads directly off each StepResult. */
  pendingHeal?: ProposedPatch;
}

export interface RunSummary {
  runId: string;
  /** Task #44 — stable, per-suite-job attribution id (bridge/runner.ts's RunContext.jobId,
   * copied straight through). For a suite job (bridge/orchestrator.ts's runSuite) this is a
   * DETERMINISTIC id derived from the suite + job index, never a fresh randomUUID, so a merged
   * suite report's results can always be mapped back to the job (and its artifacts/trace) that
   * produced them — even though `report.results`' order doesn't guarantee it matches submission
   * order once jobs are sharded across workers. For a plain single-flow /api/run call it equals
   * `runId`. Optional only because bridge/browser-driver.ts's runBrowserFlow (a separate driver,
   * out of this task's scope) doesn't populate it yet. */
  jobId?: string;
  flowName: string;
  udid: string;
  bundleId: string;
  passed: boolean;
  /** Terminal status; "cancelled" is distinct from pass/fail (E2 AC6). */
  status: RunStatus;
  total: number;
  passedCount: number;
  failedCount: number;
  /** Count of `soft`-flagged steps that failed (E2 AC5) — recorded separately from failedCount. */
  softFailedCount: number;
  durationMs: number;
  startedAt: number;
  results: StepResult[];
}

/** Server → client events streamed over the WebSocket during a run. */
export type RunEvent =
  | { type: "run:start"; runId: string; total: number; flowName: string }
  | { type: "step:start"; runId: string; index: number; stepId: string; action: string }
  | { type: "step:result"; runId: string; result: StepResult }
  | { type: "run:end"; runId: string; summary: RunSummary }
  | { type: "log"; runId?: string; level: "info" | "warn" | "error"; message: string };

export interface RunRequest {
  udid: string;
  flow: Flow;
  fixtures?: Record<string, unknown>;
  /** Per-run override of the bridge's current environment (E11) — omit to use whatever
   * environment is currently selected server-side. Never read from the flow file itself. */
  environment?: EnvironmentName;
  /** E19, opt-in (default false/omitted = OFF, identical to every call before this epic
   * existed): when true, a failed step climbs the rule-based rungs 1-3 (re-resolve locator /
   * dismiss known interstitial / replay a pinned lesson) before giving up. Rungs 1-3 only ever
   * replay a PINNED, human-approved lesson (AC6) — nothing here is AI, and nothing auto-pins. */
  selfHeal?: boolean;
  /** E24, opt-in (default false/omitted = OFF — AC1's own framing: the product is fully
   * deterministic and unchanged with this omitted, identical to every call before this epic
   * existed). When true AND `selfHeal` is also true AND rungs 0-3 all failed, a failed step gets
   * ONE bounded AI-proposed candidate action (rung 4) — validated against the closed IR before
   * ever executing (AC2), logged regardless of outcome (AC3), never auto-persisted (AC3/AC4).
   * Ignored (never invoked) when `selfHeal` is false/omitted — rung 4 only ever runs AFTER rungs
   * 1-3 have already been tried and failed, never in place of them. Strict mode is simply "this
   * omitted" — there is no separate server-side mode enum; the UI's Strict/Adaptive toggle (E24)
   * is exactly this flag (plus `selfHeal`), never a different code path. */
  aiRecovery?: boolean;
}

// ─── Self-heal rungs 0-3 + learning store (E19) ─────────────────────────────
// "Save this fix?" is always a SEPARATE, explicit human action (AC2/AC6) — pinning a lesson is
// the ONLY thing that makes it eligible for rung 1-3 replay. Nothing in the run path ever pins.

/** Approve ("pin") a recorded, unpinned lesson — the "save this fix?" patch flow's persistence
 * half. Never auto-called by a run itself; always a deliberate human action. */
export interface PinLessonRequest {
  lessonId: string;
}

// ─── AI rung-4 + provider registry + authoring co-pilot (E24) ──────────────
// AI is OFF by default (RunRequest.aiRecovery above) and fully absent from Strict mode — this
// section only adds config CRUD + the co-pilot draft request/response shapes; the run-path
// wiring itself lives on RunRequest. `ProviderRegistryConfig`/`CoPilotSuggestion` are defined in
// shared/ai-types.ts (reused here, not redefined) — see that file's own doc comment for why its
// field names are kept identical to src/ai-provider.ts's and src/copilot-diff.ts's local types.

/** GET /api/ai/providers response, and the shape POST /api/ai/providers expects as its body —
 * the WHOLE registry is read/replaced atomically (never a per-row PATCH) so validation (AC5: an
 * agent-cli provider under `routing.recovery` is config-rejected) always sees providers+routing
 * together, never a transiently-inconsistent partial update. */
export type ProviderRegistryResponse = ProviderRegistryConfig;
export type SaveProviderRegistryRequest = ProviderRegistryConfig;

/** GET /api/ai/call-log response — every rung-4/co-pilot call logged locally (AC3), newest
 * first. Treated sensitive-at-rest (AC9: real logged-in screen content may appear in `prompt`) —
 * `POST /api/ai/call-log/purge` (no request/response body beyond `{ok:true}`) is the "opt-in +
 * purgeable" half of that guardrail: it deletes EVERY entry, never a selective per-row purge. */
export interface AiCallLogResponse {
  entries: AiCallLogEntry[];
}

/** POST /api/ai/copilot/draft request — `flow` present means "suggest assertions/edits for this
 * EXISTING flow"; absent means "draft a brand-new flow from this prose description" (spec: "draft-
 * a-flow / suggest-assertions using either adapter kind"). Always routed through the `authoring`
 * role's provider chain — co-pilot never uses the `recovery` role. */
export interface CoPilotDraftRequest {
  prompt: string;
  flow?: Flow;
}

/** Always a review diff (AC7) — `shared/ai-types.ts`'s `CoPilotSuggestion`, never a flow file
 * written server-side; applying accepted hunks is a client-side, explicit, per-hunk decision
 * (src/copilot-diff.ts's `applyAcceptedHunks`). */
export type CoPilotDraftResponse = CoPilotSuggestion;

// ─── Run orchestrator (E15) ─────────────────────────────────────────────────

/** One job in a POST /api/suite request body. */
export interface SuiteJobRequest {
  udid: string;
  flow: Flow;
  fixtures?: Record<string, unknown>;
  /** Optional grouping label for `shard: "by-tag"` and report readability. */
  tag?: string;
}

export interface SuiteRequest {
  jobs: SuiteJobRequest[];
  /** Desired parallelism; the bridge computes the actual concurrency as
   * `min(requested, CPU count - 2)` (AC2) — omit to default to `jobs.length`. */
  concurrency?: number;
  shard?: "round-robin" | "by-tag";
}

export interface SuiteWorkerReport {
  workerId: number;
  port: number;
  profileDir: string;
  artifactsDir: string;
  results: RunSummary[];
}

/** The merged report a suite run produces — one report across every worker (AC1/AC6), not one
 * per flow. */
export interface SuiteReport {
  suiteId: string;
  startedAt: number;
  durationMs: number;
  concurrency: number;
  workers: SuiteWorkerReport[];
  results: RunSummary[];
}

// ─── Browser E2E driver (E16) ───────────────────────────────────────────────
// Consumes E15's orchestrator (bridge/orchestrator.ts) exactly like /api/suite above, via a
// browser-specific SuiteJob callback (bridge/browser-driver.ts's `runBrowserSuite`) — no
// orchestrator changes. Shape mirrors SuiteJobRequest/SuiteRequest, minus `udid`: a browser
// worker has no device id (RunSummary.udid is a synthesized "browser-worker-N" label instead,
// see bridge/browser-driver.ts's `runBrowserFlow`).

/** One job in a POST /api/browser-suite request body. */
export interface BrowserSuiteJobRequest {
  flow: Flow;
  fixtures?: Record<string, unknown>;
  /** Optional grouping label for `shard: "by-tag"` and report readability. */
  tag?: string;
}

export interface BrowserSuiteRequest {
  jobs: BrowserSuiteJobRequest[];
  /** Desired parallelism; the bridge computes the actual concurrency as
   * `min(requested, CPU count - 2)` — omit to default to `jobs.length`. */
  concurrency?: number;
  shard?: "round-robin" | "by-tag";
}

// ─── WebView-aware inspector + demo app target profile (E17) ────────────────
// Wire-format counterparts of bridge/target-profile.ts / bridge/webview-driver.ts's own types —
// same convention as SuiteReport/BrowserSuiteRequest above (a wire type per concept, not a
// re-export of the bridge-internal one).

export type DriveMode = "native" | "webview" | "hybrid";

export interface TargetProfileSummary {
  name: string;
  driveMode: DriveMode;
  bundleId: string;
}

export interface WebViewTargetRequest {
  /** The simulator/device the app is running on. */
  udid: string;
  bundleId: string;
}

export interface WebViewElementNode {
  tag: string;
  /** Only set on a leaf node (no children). */
  text?: string;
  testId?: string;
  children: WebViewElementNode[];
}

export interface WebViewLocatorRequest extends WebViewTargetRequest {
  x: number;
  y: number;
}

export interface WebViewLocator {
  text?: string;
  targetId?: string;
}

// ─── Test-data & environment layer (E11) ───────────────────────────────────

/** stg/qa/prod is a bridge-side config selector (spec AC2) — it never lives inside a flow
 * file. A flow only ever references a test-account *role* (a plain string in its `fixtures`,
 * e.g. `fixtures.testAccountRole`), never an environment name or a raw credential. */
export type EnvironmentName = "stg" | "qa" | "prod";

export interface EnvironmentSummary {
  name: EnvironmentName;
  baseUrl: string;
  /** Test-account role names defined for this environment (no credentials). */
  accountRoles: string[];
}

export interface TestAccountSummary {
  role: string;
  username: string;
  /** ALWAYS the still-unresolved `${secret:...}` reference — never a resolved credential
   * (E12's seam resolves it later, at run time, never here). */
  passwordRef: string;
}

/** Stable error code for a degraded SeedResetResult (task #48) — bridge/test-data.ts's
 * runSeedResetHook used to bake a full English sentence into `error`; the client now localizes
 * this code + `errorParams` instead (see src/components/EnvironmentPanel.tsx's
 * localizedSeedResetError), same "never a hardcoded human sentence on the wire" pattern as
 * DoctorCheck.fixCode / LintFinding.class / TriageClass. */
export type SeedResetErrorCode = "resetApiUnreachable";

export interface SeedResetResult {
  ok: boolean;
  hook: string;
  role: string;
  /** True when the real reset API couldn't be reached — a documented manual-reset fallback
   * is needed, this is NOT a silent no-op (E11 risk flag). */
  degraded: boolean;
  preState?: Record<string, unknown>;
  postState?: Record<string, unknown>;
  /** Stable code the client localizes — set together with `errorParams`, never a raw sentence. */
  errorCode?: SeedResetErrorCode;
  /** Data to interpolate into the localized message (never a phrase to translate). */
  errorParams?: { hook: string; role: string; env: string; username: string; baseUrl: string; message: string };
}

// ─── Environment Doctor (E5) ────────────────────────────────────────────────

export type DoctorCheckId =
  | "xcodeClt"
  | "idb"
  | "jre"
  | "simulatorBoot"
  | "podiumEngine"
  // Android toolchain (E10 AC5) — analogous to the iOS-sim checks above.
  | "androidSdk"
  | "adb"
  | "androidEmulatorBoot"
  // E20 — real, USB-connected Android device preflight (AC2). Informational/non-gating: never
  // required for Android usability (an emulator-only setup is already fully usable per E10's own
  // gate) — see doctor.ts's NON_GATING_CHECKS for why this never drags `platforms.android` down.
  | "androidRealDevice";

/**
 * Which platform toolchain a check belongs to (R2 follow-up — platform-awareness, raised
 * during E10 AC5): "shared" infra (currently just the JRE, needed by Maestro on both
 * platforms) always gates overall usability; "ios"/"android" checks only gate THAT platform's
 * usability, so an iOS-only machine missing the Android SDK isn't reported as broken.
 */
export type DoctorPlatform = "shared" | "ios" | "android";

export interface DoctorCheck {
  id: DoctorCheckId;
  label: string;
  ok: boolean;
  detail: string;
  /** Actionable Vietnamese fix — always present when ok === false (spec AC6). */
  fixVi?: string;
  /** Stable sub-code for this check's fix hint, when one `id` has more than one possible fixVi
   * depending on sub-state (task #48 follow-up to #47 — today only checkAndroidRealDevice sets
   * this: "noDevice" | "unauthorized" | "notReady" | "execFailed"). The client (DoctorPanel.tsx)
   * looks up `doctorPanel.checks.<id>.fix.<fixCode>` instead of rendering `fixVi`'s raw
   * Vietnamese text when this is set. */
  fixCode?: string;
  durationMs: number;
  /** Which platform toolchain this check belongs to (R2 follow-up). */
  platform: DoctorPlatform;
  /** True when this check is red BUT doesn't block overall usability — i.e. it belongs to a
   * platform the machine isn't relying on because the OTHER platform's toolchain is fully
   * green. Never set on a "shared" check (shared infra always matters) or on a passing check. */
  optional?: boolean;
}

export interface DoctorReport {
  /** True iff every "shared" check passed AND at least one of ios/android is fully green
   * (R2 follow-up) — NOT "every single check passed". A machine only needs ONE platform's
   * toolchain working to be usable; requiring both was the bug this follow-up fixes. */
  ok: boolean;
  checks: DoctorCheck[];
  durationMs: number;
  /** Per-platform rollup: is EVERY check for that platform green? Independent of the other
   * platform (R2 follow-up). */
  platforms: { ios: boolean; android: boolean };
}

// ─── SQLite two-tier storage (E9) ───────────────────────────────────────────

export interface DbTierHealth {
  ok: boolean;
  path: string;
  /** Present for the primary store only — the cache has no versioned schema meaning to a user. */
  schemaVersion?: number;
  /** True when open() had to restore the primary store from backup after detecting corruption. */
  recoveredFromBackup?: boolean;
  error?: string;
}

export interface DbHealthReport {
  /** Tier 1 — derived cache: search/tags/index, fully rebuildable, never backed up. */
  cache: DbTierHealth;
  /** Tier 2 — primary store: run history / JUnit results / artifacts index — NOT rebuildable. */
  primary: DbTierHealth;
}

export const API = {
  health: "/api/health",
  devices: "/api/devices",
  boot: "/api/boot",
  apps: "/api/apps",
  launch: "/api/launch",
  inspect: "/api/inspect",
  screenshot: "/api/screenshot",
  run: "/api/run",
  flows: "/api/flows",
  export: "/api/export",
  artifact: "/api/artifact",
  doctor: "/api/doctor",
  lint: "/api/lint",
  dbHealth: "/api/db/health",
  dbRuns: "/api/db/runs",
  dbBackup: "/api/db/backup",
  dbRestore: "/api/db/restore",
  dbRebuildCache: "/api/db/rebuild-cache",
  dbGcPlan: "/api/db/gc-plan",
  dbGc: "/api/db/gc",
  environment: "/api/environment",
  testAccounts: "/api/test-accounts",
  seedReset: "/api/test-data/seed-reset",
  cancel: "/api/cancel",
  suite: "/api/suite",
  browserSuite: "/api/browser-suite",
  targetProfiles: "/api/target-profiles",
  selfHealPin: "/api/selfheal/pin",
  webviewInspect: "/api/webview/inspect",
  webviewPick: "/api/webview/pick",
  aiProviders: "/api/ai/providers",
  aiCallLog: "/api/ai/call-log",
  aiCallLogPurge: "/api/ai/call-log/purge",
  copilotDraft: "/api/ai/copilot/draft",
} as const;
