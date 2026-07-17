import { z } from "zod";

/**
 * Podium Studio Flow IR
 * ---------------------
 * The canonical, human-diffable representation of a QA flow. It is a strict
 * superset of Podium's `run_steps` action vocabulary (see podium `src/tools/steps.ts`),
 * adding only *presentation* metadata (`id`, `label`, `note`) that the visual editor
 * needs. The runner strips that metadata back down to Podium's step shape before
 * execution via `toPodiumSteps()`, so there is exactly one source of truth for what
 * an action does — Podium — and zero divergence.
 *
 * The action set is CLOSED. The editor can never emit an action outside this union,
 * which is what keeps every run decidable (a fixed vocabulary + Podium's
 * deterministic resolver = same result every run, no AI in the loop).
 */

export const KEY_VALUES = [
  "enter", "home", "lock", "backspace",
  "volume up", "volume down", "back", "power", "tab",
] as const;

// Presentation + runner metadata attached to every step (never sent to Podium).
const meta = {
  id: z.string().describe("Stable step id (for reorder/evidence correlation)"),
  label: z.string().optional().describe("Plain-language description shown to QA"),
  note: z.string().optional().describe("Optional QA note"),
  disabled: z.boolean().optional().describe("Skip this step without deleting it"),
  // ── E2 robust-execution fields (additive, MINOR per IR-SPEC.md §6 versioning rule) ──
  idempotent: z
    .boolean()
    .optional()
    .describe(
      "Override: is retrying this exact step after a transient failure safe (never fires a duplicate " +
        "side effect)? When unset, the runner falls back to defaultIdempotent(action). A step is only " +
        "ever auto-retried when this resolves to true — never a blind re-fire of a completed action.",
    ),
  soft: z
    .boolean()
    .optional()
    .describe(
      "Soft assertion: if this step fails, record it distinctly (status \"failed-soft\") and keep " +
        "running the rest of the flow instead of halting. Intended for assertion-like actions.",
    ),
  captureAs: z
    .string()
    .optional()
    .describe(
      "Capture this step's result text into a named run variable. The captured value is merged into " +
        "the fixtures context for every later step, crossing the native<->Maestro run_flow boundary at " +
        "segment-compile time (see IR-SPEC.md §4).",
    ),
  // ── E13 reuse (additive-MINOR, IR-SPEC.md §6) ──
  libraryRef: z
    .string()
    .optional()
    .describe(
      "Reference to a shared/library.ts selector-library entry (E13) — resolved into this step's own " +
        "text/targetId, per platform (mobile a11y vs browser DOM), at expansion time via " +
        "shared/subflow.ts's expandFlow(), BEFORE a run or lint ever sees the step. Only meaningful on a " +
        "selector-bearing action (ignored otherwise); when set, it takes priority over any literal " +
        "text/targetId also present on the step.",
    ),
};

/** The 26 R0/E1-E2 baseline (leaf, non-container) action schemas — unchanged from before E4. */
const leafStepSchemas = [
  z.object({
    ...meta,
    action: z.literal("tap"),
    x: z.number().describe("X in logical points"),
    y: z.number().describe("Y in logical points"),
  }),
  z.object({
    ...meta,
    action: z.literal("tapText"),
    text: z.string().optional().describe("Element text (full, case-insensitive)"),
    targetId: z.string().optional().describe("Accessibility id / semantic id"),
    index: z.number().int().min(0).optional(),
  }),
  z.object({
    ...meta,
    action: z.literal("type"),
    text: z.string().describe("Text to type into the focused field"),
    submit: z.boolean().optional().describe("Press Enter after typing"),
  }),
  z.object({
    ...meta,
    action: z.literal("key"),
    key: z.enum(KEY_VALUES),
  }),
  z.object({
    ...meta,
    action: z.literal("swipe"),
    direction: z.enum(["up", "down", "left", "right"]).optional(),
    startX: z.number().optional(),
    startY: z.number().optional(),
    endX: z.number().optional(),
    endY: z.number().optional(),
  }),
  z.object({
    ...meta,
    action: z.literal("waitFor"),
    text: z.string().describe("Wait until an element with this text is visible"),
    timeoutMs: z.number().int().min(0).max(120_000).optional(),
  }),
  z.object({
    ...meta,
    action: z.literal("waitMs"),
    ms: z.number().int().min(0).max(30_000),
  }),
  z.object({
    ...meta,
    action: z.literal("screenshot"),
  }),
  z.object({
    ...meta,
    action: z.literal("assertVisible"),
    text: z.string().describe("Assert an element with this text is visible"),
    timeoutMs: z.number().int().min(0).max(120_000).optional(),
  }),
  // ── Extended vocabulary (executed via Maestro run_flow per-step) ──────────────
  z.object({
    ...meta,
    action: z.literal("doubleTap"),
    text: z.string().optional(),
    targetId: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    index: z.number().int().min(0).optional(),
  }).describe("Double-tap an element (by text/id) or a coordinate."),
  z.object({
    ...meta,
    action: z.literal("longPress"),
    text: z.string().optional(),
    targetId: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    index: z.number().int().min(0).optional(),
  }).describe("Long-press an element (by text/id) or a coordinate."),
  z.object({
    ...meta,
    action: z.literal("tapIfVisible"),
    text: z.string().describe("Tap this element only if it's visible; never fails the run if absent."),
    timeoutMs: z.number().int().min(0).max(120_000).optional(),
  }).describe("Optional tap — dismiss a popup / conditional tap without failing when it's not there."),
  z.object({
    ...meta,
    action: z.literal("clearText"),
  }).describe("Erase all text in the focused field."),
  z.object({
    ...meta,
    action: z.literal("deleteText"),
    count: z.number().int().min(1).max(200).describe("How many characters to erase"),
  }).describe("Erase N characters from the focused field."),
  z.object({
    ...meta,
    action: z.literal("hideKeyboard"),
  }).describe("Dismiss the on-screen keyboard."),
  z.object({
    ...meta,
    action: z.literal("scroll"),
    direction: z.enum(["up", "down", "left", "right"]).optional().describe("Default down"),
  }).describe("Scroll the screen one page in a direction."),
  z.object({
    ...meta,
    action: z.literal("scrollUntilVisible"),
    text: z.string().describe("Scroll until an element with this text appears"),
  }).describe("Keep scrolling until the target text is visible."),
  z.object({
    ...meta,
    action: z.literal("back"),
  }).describe("Navigate back (Android back / iOS edge-swipe)."),
  z.object({
    ...meta,
    action: z.literal("assertNotVisible"),
    text: z.string().describe("Assert this text is NOT visible"),
    timeoutMs: z.number().int().min(0).max(120_000).optional(),
  }).describe("Assert an element is absent."),
  z.object({
    ...meta,
    action: z.literal("waitForNotVisible"),
    text: z.string().describe("Wait until this text disappears"),
    timeoutMs: z.number().int().min(0).max(120_000).optional(),
  }).describe("Wait until an element disappears (e.g. a loading spinner)."),
  z.object({
    ...meta,
    action: z.literal("openLink"),
    url: z.string().describe("Deep link or URL to open"),
  }).describe("Open a URL / deep link."),
  z.object({
    ...meta,
    action: z.literal("launchApp"),
    bundleId: z.string().optional().describe("Defaults to the flow's app"),
  }).describe("Launch (foreground) an app."),
  z.object({
    ...meta,
    action: z.literal("stopApp"),
    bundleId: z.string().optional().describe("Defaults to the flow's app"),
  }).describe("Terminate an app."),
  z.object({
    ...meta,
    action: z.literal("copyText"),
    text: z.string().describe("Copy text from the element matching this text"),
  }).describe("Copy text from an element into the clipboard."),
  z.object({
    ...meta,
    action: z.literal("pasteText"),
  }).describe("Paste the clipboard into the focused field."),
  z.object({
    ...meta,
    action: z.literal("raw"),
    maestro: z.string().min(1).describe("Raw Maestro command(s) — the escape hatch for anything not covered."),
  }).describe("Run a raw Maestro command (advanced escape hatch)."),
] as const;

/** The 26-member leaf-only union — no `if`/`repeat`/`callSubFlow` container. Exported (E24,
 * janus-specs/R5-R6-ai-cloud/E24-ai-providers.md AC2) so bridge/ai-rung4.ts can validate an
 * AI-proposed recovery action against the closed IR at RUNTIME, not just infer its type: rung 4's
 * "exactly one candidate action" is a single leaf step by definition (a container would violate
 * the spec's own "one step" bound, and could never be a legal single-turn recovery anyway). */
export const leafStepSchema = z.discriminatedUnion("action", leafStepSchemas);
export type LeafStep = z.infer<typeof leafStepSchema>;
type StepMeta = z.infer<typeof metaSchema>;
const metaSchema = z.object(meta);

/**
 * Control-flow containers (E4, IR-SPEC.md §6.2 additive-MINOR pattern — no `schemaVersion`
 * bump, nothing removed from the 26 R0/E1 leaf actions above). Both are extended-only
 * (never in `NATIVE_ACTIONS`): Podium's `run_steps` has no conditional/loop concept, so a
 * container always compiles to a nested Maestro `run_flow` block (`shared/maestro.ts`),
 * the same way a single `tapIfVisible` already does today for one-off conditional taps.
 */
export interface IfStep extends StepMeta {
  action: "if";
  /** Condition: an element with `when.text` is visible (default) or NOT visible (`visible: false`). */
  when: { text: string; visible?: boolean };
  /** Steps to run only when the condition holds — never DSL/code, just nested visual steps. */
  then: FlowStep[];
}

export interface RepeatStep extends StepMeta {
  action: "repeat";
  /** Fixed repeat count. Mutually exclusive with `whileVisible` (fixed count wins if both are set). */
  times?: number;
  /** Repeat while an element with this text remains visible, capped by `maxIterations`. */
  whileVisible?: string;
  /** Safety cap on `whileVisible` iterations (default 20) so an author can never author an infinite loop. */
  maxIterations?: number;
  steps: FlowStep[];
}

/**
 * Call a parameterized sub-flow (E13, janus-specs/R3-reuse-browser/E13-reuse.md). NEVER executed
 * directly — `shared/subflow.ts`'s `expandFlow()` resolves it into the referenced flow's own
 * steps (with `params` substituted) before a run OR a lint pass ever sees it, so the runner
 * itself needs zero changes: by the time it receives a flow, every `callSubFlow` step is already
 * gone, replaced by ordinary closed-IR steps it already knows how to execute.
 */
export interface CallSubFlowStep extends StepMeta {
  action: "callSubFlow";
  /** The sub-flow's file name (qa/flows/*.flow.json) — same identifier `loadFlow()` already uses. */
  flowFile: string;
  /** paramName -> a literal value or a `{{capturedVar}}` reference (spec AC5) — matched against
   * the referenced flow's own declared `params` at expansion time. */
  params?: Record<string, string>;
}

export type FlowStep = LeafStep | IfStep | RepeatStep | CallSubFlowStep;

/** Every action name currently in the closed vocabulary, leaf + container + sub-flow call (29 total). */
export type StepAction = FlowStep["action"];

/** A flow's own declared call-parameter signature (E13) — present only on a flow meant to be
 * invoked as a sub-flow; an ordinary, non-reusable flow simply omits it. */
export interface FlowParam {
  name: string;
  required?: boolean;
  /** Used when the caller's `params` doesn't supply this one AND it isn't required. */
  default?: string;
}

/** The full closed vocabulary: 26 leaf actions (E1) + 2 control-flow containers (E4) + 1
 * sub-flow call (E13). */
export const stepSchema: z.ZodType<FlowStep> = z.discriminatedUnion("action", [
  ...leafStepSchemas,
  z.object({
    ...meta,
    action: z.literal("if"),
    when: z.object({
      text: z.string().min(1).describe("Condition: an element with this text"),
      visible: z
        .boolean()
        .optional()
        .describe("true (default) = run `then` when visible; false = run `then` when NOT visible"),
    }),
    then: z.array(z.lazy(() => stepSchema)).min(1).describe("Steps to run when the condition holds"),
  }).describe("Conditional container — run nested steps only if an element is (or isn't) visible."),
  z.object({
    ...meta,
    action: z.literal("repeat"),
    times: z.number().int().min(1).max(100).optional().describe("Fixed repeat count"),
    whileVisible: z.string().optional().describe("Repeat while an element with this text remains visible"),
    maxIterations: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Safety cap when using whileVisible (default 20) — an author can never author an infinite loop"),
    steps: z.array(z.lazy(() => stepSchema)).min(1).describe("Steps to repeat"),
  }).describe("Repeat container — loop nested steps a fixed number of times, or while a condition holds."),
  z.object({
    ...meta,
    action: z.literal("callSubFlow"),
    // No .min(1) — same convention as tapText's text / openLink's url: a freshly-added step
    // starts empty and satisfies the schema instantly; "no sub-flow actually chosen yet" is a
    // pre-run LINT concern (shared/subflow.ts), not a schema-validity one (matches AC5's own
    // framing: missing/invalid references are blocked at lint, never a runtime surprise).
    flowFile: z.string().describe("The sub-flow's file name (qa/flows/*.flow.json)"),
    params: z
      .record(z.string())
      .optional()
      .describe("paramName -> literal value or {{capturedVar}} reference, matched against the sub-flow's own declared `params`"),
  }).describe("Call a parameterized sub-flow — expanded into its steps before a run/lint, never executed directly."),
]);

/** Actions handled directly by Podium's run_steps (fast, structured per-step results). */
export const NATIVE_ACTIONS = [
  "tap", "tapText", "type", "key", "swipe", "waitFor", "waitMs", "screenshot", "assertVisible",
] as const;

export function isNativeAction(action: StepAction): boolean {
  return (NATIVE_ACTIONS as readonly string[]).includes(action);
}

/**
 * Actions that are safe to auto-retry after a transient failure because re-running them
 * cannot fire a duplicate side effect: reads (asserts/waits), evidence capture, and
 * navigation/state-reset actions whose end state is the same no matter how many times
 * they run. Everything NOT listed here defaults to non-idempotent (never blindly re-fired
 * by the runner) — a step's explicit `idempotent` field always overrides this default.
 */
const IDEMPOTENT_BY_DEFAULT: ReadonlySet<StepAction> = new Set<StepAction>([
  "waitFor", "waitMs", "waitForNotVisible", "assertVisible", "assertNotVisible",
  "screenshot", "scroll", "scrollUntilVisible", "hideKeyboard", "back",
  "clearText", "deleteText",
]);

/** Is this action safe to auto-retry with no explicit `idempotent` override on the step? */
export function defaultIdempotent(action: StepAction): boolean {
  return IDEMPOTENT_BY_DEFAULT.has(action);
}

/** Resolve whether a step may be auto-retried: its own `idempotent` flag wins, else the default. */
export function isStepIdempotent(step: FlowStep): boolean {
  return step.idempotent ?? defaultIdempotent(step.action);
}

export const flowSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  name: z.string().min(1),
  description: z.string().optional(),
  app: z.object({
    bundleId: z.string().min(1),
    platform: z.literal("ios-sim").default("ios-sim"),
    displayName: z.string().optional(),
  }),
  requires: z
    .object({
      resetState: z.boolean().optional(),
      deepLink: z.string().optional(),
      location: z.object({ latitude: z.number(), longitude: z.number() }).optional(),
    })
    .optional(),
  fixtures: z.record(z.any()).optional(),
  /** Free-form labels for suite-by-tag execution (E18, IR-SPEC.md §6 additive-MINOR pattern —
   * no schemaVersion bump, every pre-E18 flow file is still valid with `tags` simply absent). */
  tags: z.array(z.string()).optional(),
  /** This flow's own call-parameter signature (E13) — present only when the flow is meant to be
   * invoked as a sub-flow via a `callSubFlow` step elsewhere; an ordinary flow omits it entirely. */
  params: z
    .array(
      z.object({
        name: z.string().min(1),
        required: z.boolean().optional(),
        default: z.string().optional(),
      }),
    )
    .optional(),
  steps: z.array(stepSchema).min(1),
});

export type Flow = z.infer<typeof flowSchema>;

export interface ValidationResult {
  ok: boolean;
  flow?: Flow;
  errors: string[];
}

/** Validate an unknown value as a Flow. Never throws. */
export function validateFlow(input: unknown): ValidationResult {
  const parsed = flowSchema.safeParse(input);
  if (parsed.success) {
    const dupIds = findDuplicateStepIds(parsed.data.steps);
    if (dupIds.length > 0) {
      return { ok: false, errors: [`Duplicate step ids: ${dupIds.join(", ")}`] };
    }
    return { ok: true, flow: parsed.data, errors: [] };
  }
  return {
    ok: false,
    errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  };
}

/** Recurses into control-flow containers (E4) — an id must be unique across the WHOLE tree. */
function findDuplicateStepIds(steps: FlowStep[]): string[] {
  const seen = new Set<string>();
  const dups = new Set<string>();
  function walk(list: FlowStep[]) {
    for (const s of list) {
      if (seen.has(s.id)) dups.add(s.id);
      seen.add(s.id);
      const children = containerChildren(s);
      if (children) walk(children);
    }
  }
  walk(steps);
  return [...dups];
}

/**
 * Strip presentation metadata and resolve fixture placeholders, producing the exact
 * `steps[]` payload Podium's `run_steps` expects. Disabled steps are dropped.
 *
 * Podium step field names differ slightly from the IR: IR `tapText.targetId` maps to
 * Podium `tapText.id`. Everything else is a 1:1 passthrough of the action's params.
 */
export function toPodiumSteps(
  flow: Flow,
  fixtures: Record<string, unknown> = {},
  secrets?: Record<string, string>,
): Array<Record<string, unknown>> {
  const merged = { ...(flow.fixtures ?? {}), ...fixtures };
  const out: Array<Record<string, unknown>> = [];
  for (const step of flow.steps) {
    if (step.disabled) continue;
    // Control-flow containers (E4) are never native — Podium's run_steps has no
    // conditional/loop concept, so they always compile via the Maestro extended path
    // (shared/maestro.ts) instead. A caller that reaches here with a container on a
    // supposedly-native segment has a segment-splitting bug upstream; skipping (rather
    // than emitting a garbage `{action:"if",...}` payload) is the safe failure mode.
    // callSubFlow (E13) is likewise never native — it must be expanded away by
    // shared/subflow.ts's expandFlow() before a flow ever reaches here.
    if (step.action === "if" || step.action === "repeat" || step.action === "callSubFlow") continue;
    const { id, label, note, disabled, idempotent, soft, captureAs, libraryRef, ...rest } = step as Record<string, unknown>;
    const podiumStep: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rest)) {
      if (v === undefined) continue;
      const key = k === "targetId" ? "id" : k;
      podiumStep[key] = typeof v === "string" ? interpolate(v, merged, secrets) : v;
    }
    out.push(podiumStep);
  }
  return out;
}

/** Map ONE native step to its run_steps arg (strips presentation meta, targetId→id, interpolates). */
export function stepToPodium(
  step: FlowStep,
  fixtures: Record<string, unknown> = {},
  secrets?: Record<string, string>,
): Record<string, unknown> {
  if (step.action === "if" || step.action === "repeat" || step.action === "callSubFlow") {
    // Never a legal single native step — containers must route through the Maestro extended
    // path, and callSubFlow (E13) must be expanded away first (shared/subflow.ts's
    // expandFlow()) — isNativeAction() already returns false for all three.
    throw new Error(`stepToPodium: "${step.action}" is not a native step (control-flow container or unexpanded sub-flow call)`);
  }
  const { id, label, note, disabled, idempotent, soft, captureAs, libraryRef, ...rest } = step as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v === undefined) continue;
    const key = k === "targetId" ? "id" : k;
    out[key] = typeof v === "string" ? interpolate(v, fixtures, secrets) : v;
  }
  return out;
}

/**
 * Replace `{{path.to.value}}` placeholders from a fixtures object, and — when `secrets` is
 * given — `${secret:name}` references from a SEPARATE, already-resolved secrets map (E12,
 * shared/secrets.ts). `secrets` is deliberately its own parameter, never merged into
 * `fixtures`: `fixtures` can originate from `flow.fixtures`, which flows-store.ts persists to
 * disk, so a resolved secret value must never be able to travel through that same object.
 * A `${secret:x}` reference with no matching entry in `secrets` is left untouched (same
 * graceful-degradation behavior as a missing `{{fixture}}`) — the actual "fail loudly, don't
 * hang" enforcement for a genuinely missing secret happens earlier, at resolution time
 * (shared/secrets.ts's `resolveSecret`/`MissingSecretError`), which is the right layer for a
 * clear, actionable error (spec AC3) rather than a silent no-op deep in string substitution.
 */
export function interpolate(
  text: string,
  fixtures: Record<string, unknown>,
  secrets?: Record<string, string>,
): string {
  let out = text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (whole, path: string) => {
    const val = path.split(".").reduce<unknown>((acc, key) => {
      if (acc && typeof acc === "object" && key in (acc as object)) {
        return (acc as Record<string, unknown>)[key];
      }
      return undefined;
    }, fixtures);
    return val === undefined || val === null ? whole : String(val);
  });
  if (secrets) {
    out = out.replace(/\$\{secret:([a-zA-Z0-9_.-]+)\}/g, (whole, name: string) =>
      Object.prototype.hasOwnProperty.call(secrets, name) ? secrets[name] : whole,
    );
  }
  return out;
}

/** A concise, human-readable summary of a step for the editor rail. */
export function describeStep(step: FlowStep): string {
  if (step.label) return step.label;
  const tgt = (s: { text?: string; targetId?: string; x?: number; y?: number }) =>
    s.text ? `"${s.text}"` : s.targetId ? `#${s.targetId}` : s.x !== undefined ? `(${s.x}, ${s.y})` : "?";
  switch (step.action) {
    case "tap": return `Tap at (${step.x}, ${step.y})`;
    case "tapText": return `Tap ${tgt(step)}`;
    case "type": return `Type "${step.text}"${step.submit ? " + Enter" : ""}`;
    case "key": return `Press ${step.key}`;
    case "swipe": return `Swipe ${step.direction ?? "custom"}`;
    case "waitFor": return `Wait for "${step.text}"`;
    case "waitMs": return `Wait ${step.ms}ms`;
    case "screenshot": return "Take a screenshot";
    case "assertVisible": return `Assert ${tgt(step)} is visible`;
    case "doubleTap": return `Double-tap ${tgt(step)}`;
    case "longPress": return `Long-press ${tgt(step)}`;
    case "tapIfVisible": return `Tap "${step.text}" if visible`;
    case "clearText": return "Clear text field";
    case "deleteText": return `Delete ${step.count} characters`;
    case "hideKeyboard": return "Hide keyboard";
    case "scroll": return `Scroll ${step.direction ?? "down"}`;
    case "scrollUntilVisible": return `Scroll until "${step.text}" is visible`;
    case "back": return "Go back";
    case "assertNotVisible": return `Assert "${step.text}" is NOT visible`;
    case "waitForNotVisible": return `Wait until "${step.text}" disappears`;
    case "openLink": return `Open ${step.url}`;
    case "launchApp": return `Launch ${step.bundleId ?? "app"}`;
    case "stopApp": return `Stop ${step.bundleId ?? "app"}`;
    case "copyText": return `Copy text from "${step.text}"`;
    case "pasteText": return "Paste text";
    case "raw": return `Raw: ${step.maestro.split("\n")[0].slice(0, 40)}`;
    case "if": return `If "${step.when.text}" is${step.when.visible === false ? " NOT" : ""} visible (${step.then.length} step${step.then.length === 1 ? "" : "s"})`;
    case "repeat": return step.whileVisible
      ? `Repeat while "${step.whileVisible}" is visible (${step.steps.length} step${step.steps.length === 1 ? "" : "s"})`
      : `Repeat ${step.times ?? 1}x (${step.steps.length} step${step.steps.length === 1 ? "" : "s"})`;
    case "callSubFlow": {
      const params = Object.keys(step.params ?? {});
      return `Call ${step.flowFile}${params.length ? `(${params.join(", ")})` : "()"}`;
    }
  }
}

/**
 * Stable, localizable form of a step summary (task #48). `describeStep` above stays exactly as
 * it was — a hardcoded-English string — because it has several non-UI callers that embed it
 * into their OWN (Vietnamese) message text (shared/library.ts, shared/subflow.ts), a plain-text
 * CLI/log consumer (bridge/ai-rung4.ts), and bridge/report.ts's static HTML/JUnit export via
 * shared/trace.ts's `label` field; none of those have an i18n context to translate through, and
 * changing describeStep's return shape would ripple into all of them for no benefit.
 *
 * Every INTERACTIVE UI surface that shows a step summary (StepEditor, RecordPanel, RunPanel,
 * TraceViewer) should use this instead: `code` is a stable key into i18n's `stepDesc.*`
 * dictionary (see src/i18n/locales/{vi,en}.ts), `params` are pure DATA to interpolate (element
 * text/target, counts, ids — never a phrase to translate). `custom` is set instead of
 * `code`/`params` when the step has an author-supplied label — that text is user-authored and
 * must be rendered verbatim, never looked up in a dictionary.
 *
 * `direction`/`key` param values (swipe/scroll direction, key name) are passed through AS-IS,
 * untranslated — same treatment as any other literal protocol token (e.g. "volume up" as a key
 * name), not a sentence.
 */
export interface StepDescriptor {
  /** Set only when step.label is present — render this verbatim, never through t(). */
  custom?: string;
  /** Stable i18n key suffix (`stepDesc.<code>`) — absent only when `custom` is set. */
  code?: string;
  /** Data to interpolate into the resolved template. */
  params?: Record<string, string | number>;
}

function stepDescTarget(s: { text?: string; targetId?: string; x?: number; y?: number }): string {
  return s.text ? `"${s.text}"` : s.targetId ? `#${s.targetId}` : s.x !== undefined ? `(${s.x}, ${s.y})` : "?";
}

export function describeStepCode(step: FlowStep): StepDescriptor {
  if (step.label) return { custom: step.label };
  switch (step.action) {
    case "tap": return { code: "tap", params: { x: step.x, y: step.y } };
    case "tapText": return { code: "tapText", params: { target: stepDescTarget(step) } };
    case "type": return { code: step.submit ? "typeSubmit" : "type", params: { text: step.text } };
    case "key": return { code: "key", params: { key: step.key } };
    case "swipe": return { code: "swipe", params: { direction: step.direction ?? "custom" } };
    case "waitFor": return { code: "waitFor", params: { text: step.text } };
    case "waitMs": return { code: "waitMs", params: { ms: step.ms } };
    case "screenshot": return { code: "screenshot" };
    case "assertVisible": return { code: "assertVisible", params: { target: stepDescTarget(step) } };
    case "doubleTap": return { code: "doubleTap", params: { target: stepDescTarget(step) } };
    case "longPress": return { code: "longPress", params: { target: stepDescTarget(step) } };
    case "tapIfVisible": return { code: "tapIfVisible", params: { text: step.text } };
    case "clearText": return { code: "clearText" };
    case "deleteText": return { code: "deleteText", params: { count: step.count } };
    case "hideKeyboard": return { code: "hideKeyboard" };
    case "scroll": return { code: "scroll", params: { direction: step.direction ?? "down" } };
    case "scrollUntilVisible": return { code: "scrollUntilVisible", params: { text: step.text } };
    case "back": return { code: "back" };
    case "assertNotVisible": return { code: "assertNotVisible", params: { text: step.text } };
    case "waitForNotVisible": return { code: "waitForNotVisible", params: { text: step.text } };
    case "openLink": return { code: "openLink", params: { url: step.url } };
    case "launchApp":
      return step.bundleId ? { code: "launchApp", params: { bundleId: step.bundleId } } : { code: "launchAppDefault" };
    case "stopApp":
      return step.bundleId ? { code: "stopApp", params: { bundleId: step.bundleId } } : { code: "stopAppDefault" };
    case "copyText": return { code: "copyText", params: { text: step.text } };
    case "pasteText": return { code: "pasteText" };
    case "raw": return { code: "raw", params: { line: step.maestro.split("\n")[0].slice(0, 40) } };
    case "if":
      return {
        code: step.when.visible === false ? "ifNotVisible" : "ifVisible",
        params: { text: step.when.text, n: step.then.length },
      };
    case "repeat":
      return step.whileVisible
        ? { code: "repeatWhileVisible", params: { text: step.whileVisible, n: step.steps.length } }
        : { code: "repeatTimes", params: { times: step.times ?? 1, n: step.steps.length } };
    case "callSubFlow":
      return {
        code: "callSubFlow",
        params: { flowFile: step.flowFile, paramsList: Object.keys(step.params ?? {}).join(", ") },
      };
  }
}

/**
 * The single source of truth for "does this step have nested children, and which field
 * holds them" (E4). Every consumer that needs to walk the step tree — lint, the Maestro
 * exporter, the visual editor — goes through this pair instead of re-deriving container
 * shape knowledge, so adding a third container type later only touches this file.
 */
export function containerChildren(step: FlowStep): FlowStep[] | undefined {
  if (step.action === "if") return step.then;
  if (step.action === "repeat") return step.steps;
  return undefined;
}

/** Return a copy of `step` with its container children replaced (leaf steps are returned as-is). */
export function withContainerChildren(step: FlowStep, children: FlowStep[]): FlowStep {
  if (step.action === "if") return { ...step, then: children };
  if (step.action === "repeat") return { ...step, steps: children };
  return step;
}

/**
 * Recursively collect every named run variable a flow can capture (`captureAs` on any
 * step, at any nesting depth) — the data source for the visual editor's captured-value
 * chips (E4 AC3: chips instead of raw `{{var}}` syntax) and the oracle wizard's
 * captured-variable candidates (E4 AC4).
 */
export function collectCapturedVariables(steps: FlowStep[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  function walk(list: FlowStep[]) {
    for (const step of list) {
      if (step.captureAs && !seen.has(step.captureAs)) {
        seen.add(step.captureAs);
        names.push(step.captureAs);
      }
      const children = containerChildren(step);
      if (children) walk(children);
    }
  }
  walk(steps);
  return names;
}
