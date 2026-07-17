import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { workspaceRoot } from "./workspace.ts";
import { isNativeAction, isStepIdempotent, stepToPodium, type Flow, type FlowStep } from "../shared/ir.ts";
import { flowYamlForStep, iosBackYaml } from "../shared/maestro.ts";
import type { RunEvent, RunStatus, RunSummary, StepResult } from "../shared/protocol.ts";
import type { ScreenElement } from "../shared/lint.ts";
import type {
  FailureClass,
  HealAttempt,
  HealOutcome,
  HealRung,
  InterstitialEntry,
  Lesson,
  SelectorMemoryEntry,
} from "../shared/selfheal-types.ts";
import { attemptSelfHeal, classifyFailure, computeScreenFingerprint } from "./selfheal.ts";
import { attemptAiRecovery } from "./ai-rung4.ts";
import type { AiProvider, Rung4Attempt } from "../shared/ai-types.ts";
import type { Driver } from "./driver.ts";
import { engine } from "./podium.ts";
import { collectSecretRefs, redactRunEvent, redactSecrets, redactSummary, resolveSecrets } from "./secrets.ts";

export interface StepOutcome {
  ok: boolean;
  detail?: string;
  error?: string;
  backend?: string;
}

/**
 * A run's own, independent cancellation/identity state (E15). This REPLACES the old
 * module-level `cancelRequested` boolean + `runCounter`: those meant this whole module could
 * only ever track ONE in-flight run process-wide — cancelling "the" run was unambiguous only
 * because there was never more than one. E15's orchestrator runs many flows concurrently, so
 * that single shared flag would make cancelling run A also cancel run B (and a shared counter
 * could race across concurrent runs). Every run now gets its OWN `RunContext`; cancelling one
 * only ever mutates THAT object's `cancelled` field — see bridge/orchestrator.ts's `cancelRun()`
 * for the id-keyed registry that owns the "which runs are currently active" bookkeeping (a
 * lookup table, not an ambiguous shared flag).
 */
export interface RunContext {
  readonly runId: string;
  /**
   * Task #44 — stable, per-job attribution id. Defaults to `runId` (so a plain single-flow
   * /api/run call is byte-identical to before this field existed: `jobId === runId`, a "trivial"
   * id per that task's own acceptance criteria). For a `runSuite()` job (bridge/orchestrator.ts),
   * this is instead a DETERMINISTIC id derived from the suite id + the job's own index (never a
   * fresh randomUUID per job) — every artifact this run produces (screenshot dir below, the
   * exported trace, the merged suite report's per-result entry) is tagged with this SAME id, so
   * parallel jobs' results/artifacts can never be cross-attributed by relying on run order or
   * flow-name matching.
   */
  readonly jobId: string;
  cancelled: boolean;
}

/** Create a fresh, independent run context. `runId` defaults to a random UUID — no shared
 * counter needed since uniqueness doesn't depend on call order across concurrent runs. `jobId`
 * (task #44) defaults to the resolved `runId` when omitted, keeping every existing call site
 * (bridge/server.ts's /api/run, every test) behaviorally unchanged. */
export function createRunContext(runId?: string, jobId?: string): RunContext {
  const resolvedRunId = runId ?? randomUUID();
  return { runId: resolvedRunId, jobId: jobId ?? resolvedRunId, cancelled: false };
}

/**
 * Execute ONE step, routing by capability:
 *  • native run_steps actions (tap/type/key/waitFor/…) → engine.runSteps (fast, structured)
 *  • everything else (doubleTap/longPress/scroll/erase/tapIfVisible/raw/…) → a per-step
 *    Maestro flow via engine.runFlowYaml.
 * Shared by the flow runner and the record-mode /api/act endpoint so both behave identically.
 *
 * `env` carries variables captured earlier in the run (E2 AC4 / IR-SPEC.md §4 native<->Maestro
 * boundary) into the compiled Maestro segment's `env:` block, in addition to being available
 * for {{fixture}} interpolation via `fixtures`.
 *
 * `secrets` (E12) is a SEPARATE, already-resolved `${secret:name}` → value map (never merged
 * into `fixtures`/`env` — see bridge/secrets.ts) threaded alongside them into `stepToPodium`/
 * `flowYamlForStep` so a step field can reference a secret on either execution path.
 */
/** Minimal shape of an inspect_screen element the back-button picker needs. */
interface UiElement {
  label?: string;
  type?: string;
  frame?: { x: number; y: number; width: number; height: number };
}

/**
 * C7 (E2E dogfood): pick the iOS navigation-bar Back button from a screen's element list — the
 * left-most Button sitting in the top nav strip. iOS has no system Back and the interactive-pop
 * edge-swipe is unreliable to automate; tapping this button reliably pops the NavigationStack.
 * Returns its tap centre in logical points, or null when there's no nav Back button (e.g. a root
 * screen) so the caller can fall back to the edge-swipe. Pure + exported for unit testing.
 */
export function pickNavBackButtonCenter(
  elements: UiElement[],
  opts: { maxY?: number; maxX?: number } = {},
): { x: number; y: number } | null {
  const maxY = opts.maxY ?? 90; // nav bar sits at the top
  const maxX = opts.maxX ?? 80; // the Back control hugs the left edge
  const candidates = elements.filter(
    (e) => e.frame !== undefined && /button/i.test(e.type ?? "") && e.frame.y < maxY && e.frame.x < maxX,
  );
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.frame!.x - b.frame!.x);
  const f = candidates[0].frame!;
  return { x: Math.round(f.x + f.width / 2), y: Math.round(f.y + f.height / 2) };
}

/**
 * iOS "go back": tap the nav-bar Back button (reliable pop) resolved from the live a11y tree;
 * fall back to the interactive-pop edge-swipe (iosBackYaml) when no nav Back button is present.
 */
async function iosBack(udid: string, bundleId: string, env?: Record<string, string>): Promise<StepOutcome> {
  try {
    const scr = (await engine.inspectScreen(udid)) as { elements?: UiElement[] };
    const pt = pickNavBackButtonCenter(Array.isArray(scr?.elements) ? scr.elements : []);
    if (pt) {
      const payload = await engine.runSteps(udid, [{ action: "tap", x: pt.x, y: pt.y }], { bundleId, stopOnError: true });
      const r = payload?.results?.[0] ?? {};
      if (r.ok) return { ok: true, backend: r.backend ?? payload?.backend, detail: `back via nav button (${pt.x}, ${pt.y})` };
    }
  } catch {
    /* fall through to the edge-swipe */
  }
  const m = await engine.runFlowYaml(udid, iosBackYaml(bundleId, env));
  return { ok: m.ok, backend: "maestro", error: m.ok ? undefined : (m.detail ?? "back failed") };
}

/**
 * RUN-3 (QA-3 / FIX-W2) — confirmed root cause, external to this repo: Podium's native
 * `run_steps` text matching (`pollVisible` → `findElements`, ~/podium/src/lib/native.ts) builds
 * an ANCHORED regex `^(?:text)$` (case-insensitive) — i.e. `text` must equal the WHOLE accessible
 * label, not merely appear inside it. The bundled Maestro binary's own `visible:`/`tapOn.text:`
 * selectors have the identical anchored-full-match convention (verified live against the failing
 * screen: `extendedWaitUntil: {visible: "chọn thủ công"}` failed on BOTH the native and Maestro
 * paths even though the text was plainly on screen, while `.*chọn thủ công.*` passed on both).
 * This is NOT a WebView node-splitting issue and NOT a Unicode NFC/NFD mismatch — a direct
 * `inspect_screen` dump at the failing screen showed a single element whose label was already
 * NFC-normalized identically to the flow's search string. It's simply that "chọn thủ công" is
 * only a SUBSTRING of the real full label ("Tôi muốn chọn thủ công thay vì rút bài"), and neither
 * engine does substring matching for this call shape (Podium's own standalone `assert_visible`
 * tool DOES expose an opt-in `contains` flag for exactly this — see ~/podium/src/tools/assert.ts
 * — but `run_steps`'s `waitFor`/`assertVisible`/`tapText` have no such option).
 *
 * There is no safe way to silently rewrite `text` here: bridge/runner.ts's own test suite
 * (test/runner.test.ts) asserts the EXACT dispatched text and EXACT engine.runSteps call count
 * for these actions in several self-heal/AI-recovery scenarios, so this only ever ENRICHES the
 * error message with an actionable hint — it never changes what's sent to Podium or the pass/fail
 * outcome. The real fix is at the flow-authoring level: use the element's complete label, or a
 * contains-style pattern (`.*your text.*`) which both engines' regex-based matchers already honor.
 */
const TEXT_SELECTOR_NATIVE_ACTIONS = new Set(["waitFor", "assertVisible", "tapText"]);

/** No regex metacharacters → this is almost certainly literal text a flow author typed/recorded,
 * not an already-authored regex pattern — safe to suggest wrapping it. */
function looksLikePlainLiteralText(text: string): boolean {
  return !/[.*+?^${}()|[\]\\]/.test(text);
}

/** The shape of error `pollVisible`/`findElements`/Maestro's own selectors produce on a genuine
 * "couldn't find this text" miss (as opposed to a connection error, crash, etc.). */
function looksLikeVisibilityMiss(error: string): boolean {
  return /not visible/i.test(error) || /not found/i.test(error);
}

function withContainsMatchHint(error: string, text: string): string {
  return (
    `${error} — hint: Podium's native matcher and the bundled Maestro both require an EXACT ` +
    `match against the element's WHOLE accessible label, not a substring. If "${text}" is only ` +
    `part of a longer on-screen label, use the complete label text, or wrap it as a contains-` +
    `pattern regex (both engines already treat "text" as a regex source): ".*${text}.*"`
  );
}

export async function executeStep(
  udid: string,
  step: FlowStep,
  bundleId: string | undefined,
  fixtures: Record<string, unknown> = {},
  env?: Record<string, string>,
  secrets?: Record<string, string>,
): Promise<StepOutcome> {
  try {
    // C7: on iOS, `back` is an interactive-pop edge-swipe, NOT Maestro's `- back` (a no-op against
    // a SwiftUI NavigationStack). This is the iOS/Podium driver, so intercept here; Android's own
    // driver keeps the real `- back` keyevent via its flowYamlForStep path.
    if (step.action === "back") {
      if (!bundleId) return { ok: false, error: "The Back action needs the flow's app bundle id (open a flow with an app set)." };
      return iosBack(udid, bundleId, env);
    }
    if (isNativeAction(step.action)) {
      const payload = await engine.runSteps(udid, [stepToPodium(step, fixtures, secrets)], { bundleId, stopOnError: true });
      const r = payload?.results?.[0] ?? {};
      let error = r.ok ? undefined : (r.error ?? payload?.next?.join(" ") ?? "step failed");
      // RUN-3 mitigation (see doc comment above `TEXT_SELECTOR_NATIVE_ACTIONS`): diagnostic-only,
      // never changes `ok`/dispatched text/attempt count — just makes the anchored-full-match
      // footgun immediately actionable instead of a mysterious "not visible" timeout.
      const stepText = (step as { text?: string }).text;
      if (error && stepText && TEXT_SELECTOR_NATIVE_ACTIONS.has(step.action) && looksLikeVisibilityMiss(error) && looksLikePlainLiteralText(stepText)) {
        error = withContainsMatchHint(error, stepText);
      }
      return {
        ok: !!r.ok,
        backend: r.backend ?? payload?.backend,
        detail: r.detail ? (typeof r.detail === "string" ? r.detail : JSON.stringify(r.detail)) : undefined,
        error,
      };
    }
    if (!bundleId) return { ok: false, error: "This action needs the flow's app bundle id (open a flow with an app set)." };
    const m = await engine.runFlowYaml(udid, flowYamlForStep(step, bundleId, fixtures, env, secrets));
    return { ok: m.ok, backend: "maestro", error: m.ok ? undefined : (m.detail ?? "maestro step failed") };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/**
 * The mobile/Maestro path (E7 Driver interface, bridge/driver.ts), adapted from the existing
 * `executeStep` above with the smallest possible change: it's a thin wrapper, not a rewrite —
 * `runFlow` below still calls `executeStep`/`runStepWithRetry` directly, completely unchanged.
 * This adapter exists so a caller that only knows about the `Driver` seam (e.g. a future
 * mixed-platform orchestrator) can address the mobile path the same way it addresses
 * `browserDriver` (bridge/browser-driver.ts), per Pillar J: "Browser is a new Driver behind
 * the existing Driver interface, not a fork of the product."
 */
export const mobileDriver: Driver = {
  platform: "mobile",
  name: "podium-maestro",
  async isAvailable() {
    try {
      const health = await engine.health();
      // engine.health() returns the raw podium_health tool payload — its exact shape is a
      // property of the Podium engine, not fixed here. Treat "the call didn't throw" as
      // healthy by default (same criterion bridge/server.ts's /api/health uses), but respect
      // an explicit `ok: false` if the payload provides one.
      if (health && typeof health === "object" && (health as any).ok === false) {
        return { ok: false, reason: (health as any).error ?? "Podium engine reported unhealthy" };
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, reason: err?.message ?? String(err) };
    }
  },
  async executeStep(step, ctx) {
    if (!ctx.udid) return { ok: false, error: "mobileDriver.executeStep requires ctx.udid" };
    return executeStep(ctx.udid, step, ctx.bundleId, ctx.fixtures ?? {}, ctx.env, ctx.secrets);
  },
};

export const ARTIFACTS_DIR = join(workspaceRoot(), "artifacts");

// ── Robust execution (E2) ───────────────────────────────────────────────────────

/** One extra attempt on top of the first (E2 AC3: "recovers via per-action retry"). */
export const MAX_RETRIES = 1;

/**
 * Heuristic: does this failure message look like a transient hiccup (worth retrying) rather
 * than a genuine/deterministic failure (an assertion that's actually false, a real app bug)?
 * Only transient + idempotent failures are ever retried — see runStepWithRetry.
 */
const TRANSIENT_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /econnreset/i,
  /epipe/i,
  /not connected/i,
  /connection closed/i,
  /\bclosed\b/i,
  /terminated/i,
  /network/i,
  /socket hang up/i,
];

export function isTransientError(message: string | undefined): boolean {
  if (!message) return false;
  return TRANSIENT_PATTERNS.some((re) => re.test(message));
}

/**
 * Run one step, retrying it at most `MAX_RETRIES` more times, but ONLY when all three hold:
 * the step failed, the failure looks transient (isTransientError), and the step resolves as
 * idempotent (its own `idempotent` field, else `defaultIdempotent(action)`). This is the
 * concrete mechanism behind non-negotiable #4 / Pillar A's "never blindly re-fire a completed
 * tap/type" — a non-idempotent step gets exactly one attempt, full stop.
 */
export async function runStepWithRetry(
  udid: string,
  step: FlowStep,
  bundleId: string | undefined,
  fixtures: Record<string, unknown>,
  env: Record<string, string> | undefined,
  emit: (e: RunEvent) => void,
  runId: string,
  secrets?: Record<string, string>,
): Promise<{ outcome: StepOutcome; attempts: number }> {
  const canRetry = isStepIdempotent(step);
  let attempts = 0;
  let outcome: StepOutcome;
  for (;;) {
    attempts += 1;
    outcome = await executeStep(udid, step, bundleId, fixtures, env, secrets);
    if (outcome.ok) return { outcome, attempts };
    if (!canRetry || attempts > MAX_RETRIES || !isTransientError(outcome.error)) return { outcome, attempts };
    emit({
      type: "log",
      runId,
      level: "warn",
      message: `Transient failure on step "${step.id}" (${step.action}): ${outcome.error} — retrying (idempotent step, attempt ${attempts + 1})`,
    });
  }
}

// ── Self-heal rungs 1-3 (E19) — fully OPT-IN, zero behavior change when omitted ─────────────────
// Rung 0 (above) already ran and failed by the time any of this is ever consulted. Every data
// dependency (selector memory / interstitial catalog / pinned lessons / heal outcomes) is
// INJECTED by the caller (bridge/server.ts, reading bridge/db/primary-store.ts) — this file
// itself still never imports node:sqlite or a driver directly, keeping runner.ts's existing
// dependency shape unchanged. `onHealAttempt` is the caller's ONLY hook for persisting anything —
// nothing here writes to the learning store itself, and nothing here auto-pins a lesson (spec
// AC2/AC6: "save this fix?" is always a separate, explicit human action).
export interface SelfHealHooks {
  /** A FRESH live read of what's on screen right now — never a cached/stale snapshot, so a heal
   * decision always reflects the actual current state. */
  getScreenElements: () => Promise<ScreenElement[]>;
  getSelectorCandidates: (screenFingerprint: string, elementKey: string) => SelectorMemoryEntry[];
  getInterstitial: (screenFingerprint: string) => InterstitialEntry | undefined;
  /** MUST already be filtered to pinned-only by the caller (AC6) — this module has no way to
   * tell "no lessons" apart from "lessons exist but aren't pinned", by design. */
  getPinnedLessons: (screenFingerprint: string, errorClass: FailureClass) => Lesson[];
  getBestOutcome: (screenFingerprint: string, errorClass: FailureClass) => HealOutcome | undefined;
  /** Fires after EVERY heal attempt (successful or not) — the caller's chance to persist a
   * lesson / record a heal outcome for future rung-3 ranking. Called AFTER the healed retry has
   * actually run (code-review finding, R4 gate, MAJOR): `succeeded` is the REAL, VERIFIED result
   * of that retry, not merely "a candidate/known recovery was found" — a candidate that resolved
   * but whose retry still failed must be recorded as a FAILURE (ranking stats) and must NEVER
   * insert a fresh, unpinned lesson for a fix that didn't actually work. AWAITED by the run loop
   * (unlike the rest of this interface's write-adjacent surface) purely so a brand-new lesson's
   * freshly-generated id can be correlated back onto the step's `StepResult.pendingHeal.lessonId`
   * — the "save this fix?" UI has nothing to pin otherwise (E19 gap-fix). This is still never
   * allowed to FAIL or THROW the run: an implementation must catch its own persistence errors
   * internally and resolve to `undefined` (a real, in-process SQLite insert is sub-millisecond,
   * so awaiting it isn't the stall risk the un-awaited original design was guarding against; see
   * bridge/selfheal-live-hooks.ts's implementation). May return nothing (a bare side effect,
   * matching every hooks object before this gap-fix) or the id of a lesson it just inserted. */
  onHealAttempt?: (info: {
    step: FlowStep;
    fingerprint: string;
    errorClass: FailureClass;
    elements: ScreenElement[];
    attempt: HealAttempt;
    /** Did the healed retry ACTUALLY pass? `false` whenever `attempt.healed` was false too (no
     * retry was even attempted) — never inferred from `attempt.healed` alone. */
    succeeded: boolean;
  }) => void | string | undefined | Promise<void | string | undefined>;
}

// ── AI rung 4 (E24) — fully OPT-IN, only ever consulted AFTER rungs 0-3 (above) have already
// failed, and only when the caller supplies this SEPARATE hooks object (Strict mode simply never
// supplies it — RunRequest.aiRecovery is omitted, so this whole branch never runs, byte-identical
// to every call before this epic existed, AC1). Reuses the SAME screen elements/fingerprint/error-
// class rungs 1-3 already computed for this failed step — no second live inspect call, and the
// rule-based and AI rungs judge the exact same observed screen state.
export interface AiRecoveryHooks {
  /** The `recovery` role's current fallback chain + the real, built providers for it — read
   * fresh on every failed step (not cached once at run start) so a registry change takes effect
   * on the very next failure, not just the next process restart. NEVER an agent-cli-routed
   * chain — bridge/ai-registry.ts's `validateProviderRegistry` statically rejects that at
   * config-load time (AC5); this hook has no way to bypass that, it only reads whatever the
   * caller already validated and built. */
  getRecoveryProviders: () => { chain: readonly string[]; providers: ReadonlyMap<string, AiProvider> };
  /** Per-call time budget (ms) — defaults inside bridge/ai-registry.ts's `completeWithFallback`
   * (AC8) when omitted. */
  timeoutMs?: number;
  /** Fires after EVERY rung-4 attempt, healed or not (AC3: every call is logged locally,
   * regardless of outcome) — the caller's chance to persist the call log and, if healed, insert a
   * fresh unpinned lesson (exactly the same "gate on the REAL retry result, never on 'a candidate
   * was found'" discipline as `SelfHealHooks.onHealAttempt` — see that field's own doc comment).
   * Awaited so a freshly-inserted lesson's id can be correlated onto
   * `StepResult.pendingHeal.lessonId`. Never allowed to fail/throw the run — an implementation
   * must catch its own persistence errors and resolve to `undefined`. */
  onAiAttempt?: (info: {
    step: FlowStep;
    /** The SAME failure classification rungs 1-3 already computed for this step — passed through
     * so a persisted lesson's `errorClass` reflects the REAL failure, never a guessed/hardcoded
     * value. */
    errorClass: FailureClass;
    attempt: Rung4Attempt;
    /** Did the AI-proposed action ACTUALLY pass when executed? `false` whenever `attempt.healed`
     * was false too (nothing legal was even produced) — never inferred from `attempt.healed`
     * alone, same reasoning as `SelfHealHooks.onHealAttempt`'s `succeeded` field. */
    succeeded: boolean;
  }) => void | string | undefined | Promise<void | string | undefined>;
}

/** A "x,y" pair — the only encoding a `position`-kind locator memory entry can carry (there is no
 * dedicated coordinate field on `SelectorMemoryEntry`/`CandidateLocator` — both just have a single
 * string `value`). */
const POSITION_VALUE = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/;

/** Turn a successful heal's recovery into an actual retry. A `{kind, value}`-shaped recovery
 * (rung 1, and any rung 3 replay of a rung-1 lesson) swaps that locator into a COPY of the
 * original step and retries IT — only for a `LocatorKind` the IR actually has a field for
 * (`targetId`/`text`/`position` -> `x`,`y`). Code-review finding (R4 gate, MINOR): `role` and
 * `nearbyLabel` have NO corresponding FlowStep field (IR-SPEC.md's step vocabulary only expresses
 * a target via text/targetId/x,y) — the original code silently coerced them into `.text` anyway,
 * which would search for an element whose literal text equals a role name or a DIFFERENT
 * element's label, never the step's real target. Reported as an unresolvable recovery instead of
 * guessing — heal-type safety extends to "never fabricate a locator this IR can't express".
 * Any other recovery shape (rung 2's interstitial dismiss, and any rung 3 replay of a rung-2
 * lesson) is treated as its own executable pre-step: run it first, and only retry the ORIGINAL,
 * unmodified step if the dismiss itself succeeded — a failed dismiss is reported as-is, never
 * silently swallowed into "still broken, try anyway". */
async function applyRecoveryAndRetry(
  udid: string,
  step: FlowStep,
  bundleId: string | undefined,
  fixtures: Record<string, unknown>,
  env: Record<string, string> | undefined,
  secrets: Record<string, string> | undefined,
  recovery: Record<string, unknown>,
): Promise<StepOutcome> {
  if (typeof recovery.kind === "string" && typeof recovery.value === "string") {
    if (recovery.kind === "targetId") {
      const healedStep = { ...step, targetId: recovery.value, text: undefined } as FlowStep;
      return executeStep(udid, healedStep, bundleId, fixtures, env, secrets);
    }
    if (recovery.kind === "text") {
      const healedStep = { ...step, text: recovery.value, targetId: undefined } as FlowStep;
      return executeStep(udid, healedStep, bundleId, fixtures, env, secrets);
    }
    if (recovery.kind === "position") {
      const match = POSITION_VALUE.exec(recovery.value.trim());
      if (match) {
        const healedStep = { ...step, x: Number(match[1]), y: Number(match[2]), text: undefined, targetId: undefined } as FlowStep;
        return executeStep(udid, healedStep, bundleId, fixtures, env, secrets);
      }
      return { ok: false, backend: "self-heal", error: `self-heal: "position" recovery value "${recovery.value}" is not a valid "x,y" pair` };
    }
    if (recovery.kind === "role" || recovery.kind === "nearbyLabel") {
      return { ok: false, backend: "self-heal", error: `self-heal: locator kind "${recovery.kind}" has no applicable step field yet` };
    }
  }
  const dismissStep = { id: `${step.id}-heal-dismiss`, ...recovery } as FlowStep;
  const dismissOutcome = await executeStep(udid, dismissStep, bundleId, fixtures, env, secrets);
  if (!dismissOutcome.ok) return dismissOutcome; // the dismiss itself failed — surface that, don't mask it
  return executeStep(udid, step, bundleId, fixtures, env, secrets);
}

export type RunOutcomeBucket = "pass" | "flaky" | "fail";

/**
 * Classify one completed run into the 3-bucket flaky taxonomy (E2 AC2). A run is "flaky"
 * only when it ultimately PASSED but at least one step needed a retry to get there — that's
 * the signal of nondeterministic behavior, as distinct from a deterministic hard failure.
 * A cancelled run is bucketed as "fail" — a scheduled stability run-set is never intentionally
 * cancelled mid-way, so there's no meaningful "flaky cancel" concept to preserve.
 */
export function classifyRunOutcome(summary: RunSummary): RunOutcomeBucket {
  if (summary.status === "cancelled" || !summary.passed) return "fail";
  const neededRetry = summary.results.some((r) => (r.attempts ?? 1) > 1);
  return neededRetry ? "flaky" : "pass";
}

export interface RunSetBuckets {
  pass: number;
  flaky: number;
  fail: number;
  total: number;
}

/** Bucket a run-set (e.g. 20 back-to-back runs of the same flow) into pass/flaky/fail counts. */
export function bucketRunSet(summaries: RunSummary[]): RunSetBuckets {
  const buckets: RunSetBuckets = { pass: 0, flaky: 0, fail: 0, total: summaries.length };
  for (const s of summaries) buckets[classifyRunOutcome(s)] += 1;
  return buckets;
}

/**
 * Execute a Flow deterministically, one step at a time, capturing a screenshot after
 * every step for evidence. Emits RunEvents through `emit` for live UI streaming.
 *
 * Why step-by-step (not one big run_steps): it lets us stream per-step verdicts and
 * attach a screenshot to each, which is what makes the run auditable for a non-tech QA.
 * Each run_steps call foregrounds the app WITHOUT restarting it (Podium ephemeral flow
 * with stopApp:false), so focus and state persist across steps — identical semantics to
 * one batched call, but observable. Stops at the first HARD failed step (fail-closed);
 * a `soft`-flagged step's failure is recorded but does not halt the run (E2 AC5).
 */
/**
 * C6 (E2E dogfood): after launching the flow's app, wait until it has actually RENDERED before
 * running step 1 — poll the view hierarchy until it reports elements, bounded by `timeoutMs`.
 * A first-step assert/tap otherwise races a still-launching app (the cold/scripted-launch
 * flakiness the dogfood surfaced: a flow passes in isolation but a rapid relaunch loses the
 * first step). Best-effort — on timeout we proceed anyway, since the step's own retry/timeout
 * still applies and a genuinely stuck launch should surface as that step's failure, not hang here.
 */
export async function waitForAppReady(udid: string, timeoutMs = 4000, intervalMs = 300): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    try {
      const scr = (await engine.inspectScreen(udid)) as { count?: number; elements?: unknown[] };
      const count = typeof scr?.count === "number" ? scr.count : Array.isArray(scr?.elements) ? scr.elements.length : 0;
      if (count > 0) return true;
    } catch {
      /* inspect can transiently fail while the app is still coming up — keep polling */
    }
    if (Date.now() - start >= timeoutMs) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function runFlow(
  udid: string,
  flow: Flow,
  fixtures: Record<string, unknown>,
  emitRaw: (e: RunEvent) => void,
  ctx: RunContext = createRunContext(),
  /** E19, fully optional — omitting this parameter is IDENTICAL to every call site before this
   * epic existed: only rung 0 (the retry loop above) ever runs. */
  selfHeal?: SelfHealHooks,
  /** E24, fully optional and ADDITIVE to `selfHeal` — rung 4 is only ever reached when BOTH
   * `selfHeal` and this are supplied AND rungs 1-3 already failed. Omitting this parameter (every
   * call site before this epic existed, and every Strict-mode run) means rung 4 never runs at
   * all — AC1's own framing, enforced structurally here, not via a separate mode flag this
   * function would have to branch on. */
  aiRecovery?: AiRecoveryHooks,
): Promise<RunSummary> {
  const { runId, jobId } = ctx;
  const startedAt = Date.now();
  // Task #44: keyed by jobId (not runId) so a suite job's screenshots always land under its
  // OWN stable, deterministic directory — for a single /api/run call jobId === runId, so this
  // is byte-identical to the pre-existing path.
  const outDir = join(ARTIFACTS_DIR, jobId);
  await mkdir(outDir, { recursive: true });

  // Resolved `${secret:name}` → value map for this run (E12). Declared before `emit` so the
  // wrapper below closes over the SAME object the preflight populates — every event emitted
  // for the rest of this run, including ones from steps that ran before any secret was
  // referenced, gets redacted against whatever has been resolved so far.
  const secrets: Record<string, string> = {};
  const emit = (e: RunEvent) => emitRaw(redactRunEvent(e, secrets));

  const enabled = flow.steps.filter((s) => !s.disabled);
  const baseFixtures = { ...(flow.fixtures ?? {}), ...fixtures };
  // Variables captured mid-run (`captureAs`) — merged into fixtures for {{}} interpolation
  // AND passed as a Maestro `env:` block, so a value captured on either side of the
  // native<->Maestro boundary is readable on the other side (E2 AC4).
  const captured: Record<string, string> = {};
  const total = enabled.length;

  emit({ type: "run:start", runId, total, flowName: flow.name });

  // ── Secrets preflight (E12): resolve every ${secret:name} the flow references, once, up
  // front — fail fast with a clear MissingSecretError message rather than deep into a run.
  // Never persisted anywhere; kept in the `secrets` object above, threaded to each step below.
  const secretNames = collectSecretRefs(flow);
  if (secretNames.length > 0) {
    try {
      Object.assign(secrets, await resolveSecrets(secretNames));
    } catch (err: any) {
      // Redact defensively even here: a MissingSecretError's own message never carries a
      // value, but any secret ALREADY resolved earlier in this loop (a prior name in
      // secretNames that succeeded before a later one failed) must never leak through this
      // error path either.
      const message = redactSecrets(err?.message ?? String(err), secrets);
      emit({ type: "log", runId, level: "error", message });
      const summary: RunSummary = {
        runId, jobId, flowName: flow.name, udid, bundleId: flow.app.bundleId, passed: false, status: "failed",
        total, passedCount: 0, failedCount: 0, softFailedCount: 0, durationMs: Date.now() - startedAt,
        startedAt, results: [],
      };
      emit({ type: "run:end", runId, summary });
      throw new Error(message);
    }
  }

  // ── Preflight: guarantee the target app is up before any step runs (RC1/RC4). ──
  // A regression run must start from the app, not from whatever happens to be on screen.
  const bundleId = flow.app.bundleId;
  if (bundleId) {
    try {
      const state = await engine.appState(udid, bundleId);
      if (!state.installed) {
        const msg = `App "${bundleId}" is not installed on this device. Install it first, or pick a device that has it.`;
        emit({ type: "log", runId, level: "error", message: msg });
        throw new Error(msg);
      }
      // Optional preconditions declared on the flow.
      if (flow.requires?.location) {
        emit({ type: "log", runId, level: "info", message: `Setting location ${flow.requires.location.latitude}, ${flow.requires.location.longitude}` });
        await engine.setLocation(udid, flow.requires.location.latitude, flow.requires.location.longitude);
      }
      if (flow.requires?.resetState) {
        emit({ type: "log", runId, level: "info", message: `Reset state: terminating ${bundleId}` });
        try { await engine.terminateApp(udid, bundleId); } catch { /* not running is fine */ }
      }
      emit({ type: "log", runId, level: "info", message: `Launching ${flow.app.displayName ?? bundleId}` });
      await engine.launchApp(udid, bundleId);
      // C6: don't start step 1 until the app has rendered, so a first-step assert/tap can't race
      // a still-launching app. Best-effort and bounded — proceed on timeout.
      if (!(await waitForAppReady(udid))) {
        emit({ type: "log", runId, level: "warn", message: `${flow.app.displayName ?? bundleId} did not report a rendered screen within 4s — continuing anyway` });
      }
      if (flow.requires?.deepLink) {
        emit({ type: "log", runId, level: "info", message: `Opening deep link ${flow.requires.deepLink}` });
        await engine.openUrl(udid, flow.requires.deepLink);
      }
    } catch (err: any) {
      // Emit a decidable end so the UI shows a clear reason instead of opaque step failures.
      // Redacted defensively (see the secrets-preflight catch above) even though this path's
      // messages are normally about app-install/launch state, not step text.
      const message = redactSecrets(err?.message ?? String(err), secrets);
      const summary: RunSummary = {
        runId, jobId, flowName: flow.name, udid, bundleId, passed: false, status: "failed",
        total, passedCount: 0, failedCount: 0, softFailedCount: 0, durationMs: Date.now() - startedAt,
        startedAt, results: [],
      };
      emit({ type: "run:end", runId, summary });
      throw new Error(message);
    }
  }

  const results: StepResult[] = [];
  let passed = true;
  let cancelled = false;

  for (let i = 0; i < enabled.length; i++) {
    const step: FlowStep = enabled[i];

    // Honor a Stop request between steps: mark this + remaining as skipped and end. Checked
    // against THIS run's own context, not a shared flag — a concurrent run's cancel never
    // affects this one (E15 AC3).
    if (ctx.cancelled) {
      emit({ type: "log", runId, level: "warn", message: "Run stopped by user" });
      for (let j = i; j < enabled.length; j++) {
        const skipped: StepResult = { index: j, stepId: enabled[j].id, action: enabled[j].action, status: "skipped", ok: false };
        results.push(skipped);
        emit({ type: "step:result", runId, result: skipped });
      }
      passed = false;
      cancelled = true;
      break;
    }

    emit({ type: "step:start", runId, index: i, stepId: step.id, action: step.action });

    const stepStart = Date.now();
    const result: StepResult = {
      index: i,
      stepId: step.id,
      action: step.action,
      status: "running",
      ok: false,
      startedAt: stepStart,
    };

    const stepFixtures = { ...baseFixtures, ...captured };
    let { outcome, attempts } = await runStepWithRetry(udid, step, bundleId, stepFixtures, captured, emit, runId, secrets);

    // E19 — rungs 1-3, only when the caller opted in AND rung 0 (just above) still failed.
    // Heal-type safety (assertion actions never healed) is enforced inside `attemptSelfHeal`
    // itself, not duplicated here — this call site stays a thin, uniform pass-through.
    let healedRung: HealRung | undefined;
    if (!outcome.ok && selfHeal) {
      const elements = await selfHeal.getScreenElements();
      const fingerprint = computeScreenFingerprint(elements);
      const errorClass = classifyFailure(outcome.error);
      const elementKey = (step as { text?: string; targetId?: string }).text ?? (step as { targetId?: string }).targetId ?? step.id;
      const attempt = attemptSelfHeal({
        step,
        errorClass,
        elements,
        selectorCandidates: selfHeal.getSelectorCandidates(fingerprint, elementKey),
        interstitial: selfHeal.getInterstitial(fingerprint),
        pinnedLessons: selfHeal.getPinnedLessons(fingerprint, errorClass),
        bestOutcome: selfHeal.getBestOutcome(fingerprint, errorClass),
      });
      // Code-review finding (R4 gate, MAJOR): `onHealAttempt` must fire AFTER the healed retry
      // has actually run, carrying its REAL, verified result — not before, when all that's known
      // is "a candidate was found". Recording a heal-outcome success (or inserting a fresh,
      // unpinned lesson) for a candidate whose retry then failed would corrupt rung 3's own
      // ranking data and persist a "fix" that doesn't actually work.
      let healedOutcome: StepOutcome | undefined;
      if (attempt.healed && attempt.appliedRecovery) {
        healedOutcome = await applyRecoveryAndRetry(udid, step, bundleId, stepFixtures, captured, secrets, attempt.appliedRecovery);
        attempts += 1;
      }
      const succeeded = !!healedOutcome?.ok;
      const insertedLessonId = await selfHeal.onHealAttempt?.({ step, fingerprint, errorClass, elements, attempt, succeeded });
      if (healedOutcome) {
        if (succeeded) {
          outcome = healedOutcome;
          healedRung = attempt.rung;
          if (attempt.proposedPatch) {
            // Surface the actual "save this fix?" patch on the StepResult (E19 gap-fix) —
            // prefer a lessonId the patch already carries (a rung-3 replay of an already-pinned
            // lesson), otherwise use the id `onHealAttempt` just handed back for a brand-new
            // rung 1/2 lesson it inserted. Either way, the UI never has to re-derive this.
            result.pendingHeal = { ...attempt.proposedPatch, lessonId: attempt.proposedPatch.lessonId ?? insertedLessonId ?? undefined };
          }
          emit({
            type: "log", runId, level: "warn",
            message: `Step "${step.id}" (${step.action}) recovered via self-heal rung ${attempt.rung}: ${attempt.proposedPatch?.summary ?? "known recovery replayed"}`,
          });
        }
        // If the healed retry ALSO failed, `outcome` deliberately keeps the ORIGINAL rung-0
        // failure — a failed heal attempt must never mask what actually went wrong.
      }

      // E24 — rung 4 (AI), only when the caller ALSO opted in via `aiRecovery` AND rungs 1-3
      // (just above) still didn't heal it. Reuses the SAME `elements`/`fingerprint`/`errorClass`
      // rungs 1-3 already computed for this exact failure — no second live inspect call.
      if (!succeeded && aiRecovery) {
        const { chain, providers } = aiRecovery.getRecoveryProviders();
        const rung4Attempt = await attemptAiRecovery({
          step, errorClass, elements, screenFingerprint: fingerprint,
          recoveryChain: chain, providers, timeoutMs: aiRecovery.timeoutMs,
        });

        let rung4Outcome: StepOutcome | undefined;
        if (rung4Attempt.healed && rung4Attempt.appliedRecovery) {
          // The AI candidate is already a full, IR-validated leaf step (not a `{kind,value}`
          // locator patch like rungs 1/3) — it IS the retry, executed directly, never merged
          // into a copy of the original step and never treated as a pre-step-then-retry-original
          // (unlike applyRecoveryAndRetry's rung 2/3-dismiss shape, which doesn't apply here).
          rung4Outcome = await executeStep(udid, rung4Attempt.appliedRecovery, bundleId, stepFixtures, captured, secrets);
          attempts += 1;
        }
        const rung4Succeeded = !!rung4Outcome?.ok;
        // AC9 guardrail — best-effort mitigation, NOT a solved guarantee (reliably redacting
        // arbitrary a11y-tree/DOM text is unsolved, per PILLAR-9-adaptive-ai.md §5.4): strip any
        // of THIS run's own already-resolved `${secret:...}` values out of the prompt/response
        // before it's ever logged. Reuses bridge/secrets.ts's existing, already-audited
        // `redactSecrets` helper (the same one every run-event/summary already goes through) —
        // does NOT reuse bridge/secrets.ts's KEY-RESOLUTION machinery, only this one generic
        // string-scrubbing utility, so the "architecturally separate credential seams" rule
        // (bridge/secrets.ts's own doc comment) still holds.
        const redactedLogEntry = {
          ...rung4Attempt.logEntry,
          prompt: redactSecrets(rung4Attempt.logEntry.prompt, secrets),
          response: redactSecrets(rung4Attempt.logEntry.response, secrets),
        };
        const rung4LessonId = await aiRecovery.onAiAttempt?.({
          step, errorClass, succeeded: rung4Succeeded,
          attempt: { ...rung4Attempt, logEntry: redactedLogEntry },
        });
        if (rung4Outcome && rung4Succeeded) {
          outcome = rung4Outcome;
          healedRung = 4;
          if (rung4Attempt.proposedPatch) {
            result.pendingHeal = { ...rung4Attempt.proposedPatch, lessonId: rung4Attempt.proposedPatch.lessonId ?? rung4LessonId ?? undefined };
          }
          emit({
            type: "log", runId, level: "warn",
            message: `Step "${step.id}" (${step.action}) recovered via AI rung 4: ${rung4Attempt.proposedPatch?.summary ?? "AI-proposed action"}`,
          });
        }
        // A failed or refused (illegal/out-of-bounds) AI attempt deliberately keeps the ORIGINAL
        // rung-0 failure in `outcome` — same "never mask the real failure" rule as rungs 1-3.
      }
    }

    result.ok = outcome.ok;
    result.backend = outcome.backend;
    result.attempts = attempts;
    if (healedRung) result.healedRung = healedRung;
    if (outcome.detail) result.detail = outcome.detail;
    if (!outcome.ok) result.error = outcome.error;

    // Capture this step's result text into a named run variable, if requested — it's
    // immediately visible to every later step regardless of which engine runs them next
    // (native run_steps or a compiled Maestro run_flow), see IR-SPEC.md §4.
    if (outcome.ok && step.captureAs) {
      captured[step.captureAs] = outcome.detail ?? "";
    }

    // Evidence: capture a screenshot after the step regardless of outcome.
    try {
      const shotPath = join(outDir, `step-${String(i).padStart(3, "0")}-${step.action}.png`);
      await engine.screenshot(udid, shotPath);
      result.screenshot = shotPath;
    } catch {
      // screenshot is best-effort evidence; never fail the step because of it
    }

    if (outcome.ok) {
      result.status = "passed";
    } else if (step.soft) {
      // Soft assertion: record the failure distinctly, but keep the run going (E2 AC5).
      result.status = "failed-soft";
    } else {
      result.status = "failed";
    }
    result.finishedAt = Date.now();
    results.push(result);
    emit({ type: "step:result", runId, result });

    if (!outcome.ok && !step.soft) {
      passed = false;
      // Mark the remaining steps skipped for a complete, decidable timeline.
      for (let j = i + 1; j < enabled.length; j++) {
        const skipped: StepResult = {
          index: j,
          stepId: enabled[j].id,
          action: enabled[j].action,
          status: "skipped",
          ok: false,
        };
        results.push(skipped);
        emit({ type: "step:result", runId, result: skipped });
      }
      break;
    }
  }

  const softFailedCount = results.filter((r) => r.status === "failed-soft").length;
  const status: RunStatus = cancelled ? "cancelled" : passed ? "passed" : "failed";

  const summary: RunSummary = {
    runId,
    jobId,
    flowName: flow.name,
    udid,
    bundleId: flow.app.bundleId,
    passed,
    status,
    total,
    passedCount: results.filter((r) => r.status === "passed").length,
    failedCount: results.filter((r) => r.status === "failed").length,
    softFailedCount,
    durationMs: Date.now() - startedAt,
    startedAt,
    results,
  };
  // R2 review fix — security BLOCKER: redact BEFORE returning, not just before emitting. The
  // `emit()` wrapper above only ever redacted the copy handed to WS clients; the raw `summary`
  // this function returns is what bridge/server.ts's /api/run handler both sends back as the
  // HTTP response AND persists via primaryStore.insertRun() — either of those receiving the
  // UNREDACTED object would defeat the whole secrets seam (a resolved credential landing in the
  // SQLite run history, or in the HTTP response body, forever). Redacting once here and reusing
  // the SAME object for both the emitted event and the return value keeps the two paths
  // consistent by construction.
  const redactedSummary = redactSummary(summary, secrets);
  emit({ type: "run:end", runId, summary: redactedSummary });
  return redactedSummary;
}
