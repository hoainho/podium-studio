import { describeStep, leafStepSchema, type FlowStep, type LeafStep } from "../shared/ir.ts";
import type { ScreenElement } from "../shared/lint.ts";
import type { FailureClass } from "../shared/selfheal-types.ts";
import type { AiCallLogEntry, AiMessage, AiProvider, AiRole, Rung4Attempt } from "../shared/ai-types.ts";
import { isAssertionAction } from "./selfheal.ts";
import { completeWithFallback } from "./ai-registry.ts";

/**
 * ai-rung4.ts — the last, optional recovery rung: a single bounded AI request that proposes ONE
 * candidate action (E24, janus-specs/R5-R6-ai-cloud/E24-ai-providers.md AC2/AC3/AC4,
 * PILLAR-9-adaptive-ai.md §2's rung table). Only ever consulted by bridge/runner.ts AFTER rungs
 * 0-3 (E19, zero AI) have already failed, and only when the caller opted in (`aiRecovery: true`)
 * — Strict mode never calls this module at all (RunRequest.aiRecovery is simply omitted there).
 *
 * "Bounded" here means, concretely:
 *   - Heal-type safety (AC4/Pillar I) is checked FIRST, unconditionally, before building a prompt
 *     or making any network/process call — an assertion action never even reaches the model.
 *   - Exactly one candidate action, temp 0, capped tokens, capped time (all enforced by
 *     bridge/ai-registry.ts's `completeWithFallback`, reused here rather than reimplemented).
 *   - The candidate is validated against the closed IR (`shared/ir.ts`'s `leafStepSchema`) AND a
 *     further, MORE conservative rung-4-specific allowlist (`RUNG4_ALLOWED_ACTIONS`) — narrower
 *     than the full 26-action leaf vocabulary: no `raw` (arbitrary Maestro), no `openLink` (no
 *     new URLs), no `launchApp`/`stopApp` (app-lifecycle, not a "recovery nudge"), no
 *     `copyText`/`pasteText` (never a plausible fix for the failure classes rung 4 sees). Illegal
 *     or out-of-allowlist output is discarded, 0 executed (AC2) — this function returns
 *     `healed: false`, never a best-effort guess at fixing up the model's output.
 *   - `agent-cli` providers are NEVER reachable here — the caller only ever passes the
 *     `recovery`-role provider chain, and bridge/ai-registry.ts's `validateProviderRegistry`
 *     statically rejects an agent-cli provider under that role at config-load time (AC5). This
 *     module has no code path that could route to one even if that guard were somehow bypassed:
 *     it only ever calls `completeWithFallback`, never spawns a process itself.
 *   - EVERY call is logged (AC3), healed or not — `Rung4Attempt.logEntry` is always populated.
 *   - Never persists anything — the caller (bridge/runner.ts) surfaces the result as a
 *     `StepResult.pendingHeal`, exactly like rungs 1-3's "save this fix?" flow; nothing here ever
 *     writes to the learning store or a flow file.
 */

/** A conservative SUBSET of the 26-action closed IR (shared/ir.ts) — the only actions rung 4 may
 * ever propose. Deliberately narrower than "every leaf action the IR allows": excludes anything
 * that isn't a plausible, bounded "unblock this step" nudge (navigation, app-lifecycle,
 * clipboard, and the `raw` escape hatch are all excluded even though they're otherwise legal
 * steps a human author could write). */
const RUNG4_ALLOWED_ACTIONS = new Set<FlowStep["action"]>([
  "tap", "tapText", "doubleTap", "longPress", "tapIfVisible",
  "type", "clearText", "deleteText",
  "key", "hideKeyboard",
  "swipe", "scroll", "scrollUntilVisible",
  "waitFor", "waitMs", "waitForNotVisible",
  "back",
]);

const RUNG4_SYSTEM_PROMPT =
  "You are a bounded, single-turn UI-recovery assistant for a mobile/web test runner. A test step " +
  "just failed after every rule-based recovery attempt was exhausted. You will be given the " +
  "current screen's accessibility tree and the failing step's intent. Respond with EXACTLY ONE " +
  "JSON object describing ONE next action to try, and NOTHING else (no prose, no markdown fence, " +
  "no explanation) — a single flat JSON object with an \"action\" field plus that action's own " +
  "fields. Allowed actions: " + [...RUNG4_ALLOWED_ACTIONS].join(", ") + ". Never propose an " +
  "assertion, navigation to a new URL, an app-lifecycle action, or a raw/arbitrary command. If no " +
  "safe action is plausible, respond with {\"action\": \"waitMs\", \"ms\": 500}.";

function buildRung4Prompt(step: FlowStep, elements: ScreenElement[], errorClass: FailureClass): string {
  const labels = elements.map((e) => e.text ?? e.accessibilityId ?? "").filter(Boolean);
  const stepAny = step as unknown as { text?: string; targetId?: string };
  return [
    `Failing step: action="${step.action}"` +
      (stepAny.text ? `, text="${stepAny.text}"` : "") +
      (stepAny.targetId ? `, targetId="${stepAny.targetId}"` : ""),
    `Failure class: ${errorClass}`,
    `On-screen labels right now: ${labels.length > 0 ? labels.join(", ") : "(none detected)"}`,
  ].join("\n");
}

/** Extract the first `{...}` JSON object from `text` and validate it against BOTH the closed IR
 * (`leafStepSchema`) and rung 4's own narrower allowlist. Returns `undefined` (never throws, never
 * guesses) for anything that doesn't parse as a single, legal, in-bounds leaf step — AC2's "100%
 * of illegal or out-of-bounds outputs are discarded, 0 executed". */
export function parseAndValidateRung4Candidate(text: string): LeafStep | undefined {
  let raw: unknown;
  try {
    // Try a DIRECT parse first — critically, this is what catches "the whole response is a JSON
    // array" (multiple actions) and rejects it via the Array.isArray check below. Only fall back
    // to extracting a `{...}` substring (for a model that wrapped its JSON in prose/a markdown
    // fence) when the direct parse fails — extracting a substring from an array response would
    // otherwise "recover" its first element and wrongly accept it as if it were the whole answer.
    raw = JSON.parse(text.trim());
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return undefined;
    try {
      raw = JSON.parse(match[0]);
    } catch {
      return undefined;
    }
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined; // "one step" bound
  const obj = raw as Record<string, unknown>;
  if (typeof obj.action !== "string" || !RUNG4_ALLOWED_ACTIONS.has(obj.action as FlowStep["action"])) return undefined;

  // leafStepSchema requires `id` (presentation metadata never supplied by the model) — synthesize
  // one so a candidate is judged purely on its FUNCTIONAL fields.
  const parsed = leafStepSchema.safeParse({ id: "rung4-candidate", ...obj });
  if (!parsed.success) return undefined;
  return parsed.data;
}

export interface Rung4Context {
  step: FlowStep;
  errorClass: FailureClass;
  elements: ScreenElement[];
  screenFingerprint: string;
  /** The `recovery` role's fallback chain (provider ids, free/local-first) — NEVER an
   * `agent-cli`-routed chain; enforced at config-load time (AC5), not here. */
  recoveryChain: readonly string[];
  providers: ReadonlyMap<string, AiProvider>;
  timeoutMs?: number;
}

const NEVER_HEALED_LOG: Omit<AiCallLogEntry, "id" | "createdAt"> = {
  role: "recovery" as AiRole,
  providerId: "",
  prompt: "",
  response: "",
  latencyMs: 0,
};

/** Climb rung 4 for one failed step. Rung 0-3 have already run (upstream) and failed; heal-type
 * safety is re-checked here independently (defense in depth — AC4's "never" is architectural, not
 * merely a UI affordance removed), so an assertion action never even reaches a prompt. */
export async function attemptAiRecovery(ctx: Rung4Context): Promise<Rung4Attempt> {
  if (isAssertionAction(ctx.step.action)) {
    return {
      healed: false,
      reason: "assertion failures are never auto-healed by AI (heal-type safety, AC4/Pillar I)",
      logEntry: { ...NEVER_HEALED_LOG, screenFingerprint: ctx.screenFingerprint },
    };
  }
  if (ctx.recoveryChain.length === 0) {
    return {
      healed: false,
      reason: "no recovery-role provider configured",
      logEntry: { ...NEVER_HEALED_LOG, screenFingerprint: ctx.screenFingerprint },
    };
  }

  const prompt = buildRung4Prompt(ctx.step, ctx.elements, ctx.errorClass);
  const messages: AiMessage[] = [
    { role: "system", content: RUNG4_SYSTEM_PROMPT },
    { role: "user", content: prompt },
  ];

  const start = Date.now();
  let providerId = "";
  let responseText = "";
  let tokensUsed: number | undefined;
  try {
    const { result, providerId: id } = await completeWithFallback(
      ctx.recoveryChain,
      ctx.providers,
      messages,
      { temperature: 0, maxTokens: 300 },
      ctx.timeoutMs,
    );
    providerId = id;
    responseText = result.text;
    tokensUsed = result.tokensUsed;
  } catch (err) {
    return {
      healed: false,
      reason: `AI provider call failed: ${(err as Error).message}`,
      logEntry: {
        role: "recovery", providerId: "none", prompt, response: "",
        latencyMs: Date.now() - start, screenFingerprint: ctx.screenFingerprint,
      },
    };
  }

  const latencyMs = Date.now() - start;
  const logEntry: Omit<AiCallLogEntry, "id" | "createdAt"> = {
    role: "recovery", providerId, prompt, response: responseText, tokensUsed, latencyMs,
    screenFingerprint: ctx.screenFingerprint,
  };

  const candidate = parseAndValidateRung4Candidate(responseText);
  if (!candidate) {
    return { healed: false, reason: "AI response was not a legal, in-bounds recovery action (AC2)", logEntry };
  }

  return {
    healed: true,
    appliedRecovery: candidate,
    proposedPatch: {
      healType: "other",
      rung: 4,
      summary: `AI đề xuất: ${describeStep(candidate)}`,
      recovery: candidate as unknown as Record<string, unknown>,
    },
    logEntry,
  };
}
