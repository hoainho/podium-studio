import { randomUUID } from "node:crypto";
import { leafStepSchema, type Flow } from "../shared/ir.ts";
import { scrubSecrets, type AiCallLogEntry, type AiMessage, type AiProvider, type CoPilotHunk, type CoPilotSuggestion } from "../shared/ai-types.ts";
import { completeWithFallback } from "./ai-registry.ts";

/**
 * ai-copilot.ts — the authoring co-pilot (E24, janus-specs/R5-R6-ai-cloud/E24-ai-providers.md
 * AC7, PILLAR-9-adaptive-ai.md §5.3): "draft-a-flow / suggest-assertions using either adapter
 * kind; output is always a review diff (accept/reject per hunk), never auto-saved."
 *
 * Unlike rung 4 (bridge/ai-rung4.ts), this is explicitly allowed to be multi-turn/multi-hunk and
 * to route through EITHER adapter kind (an `agent-cli` provider like OpenCode is fine here — the
 * hot-path guard, AC5, only ever bars `agent-cli` from the `recovery` role; `authoring` has no
 * such restriction). It still shares rung 4's core discipline: every suggested step is validated
 * against the closed IR (`leafStepSchema`) before it's ever offered to the human — an invalid
 * hunk is dropped from the suggestion, never "fixed up" or guessed at, since NOTHING here executes
 * anything; a bad hunk merely never appears in the review-diff for the human to accept.
 *
 * NEVER writes a flow file. `draftCoPilotSuggestion` only ever returns a `CoPilotSuggestion` (a
 * pure data structure); applying accepted hunks is the client's job
 * (src/copilot-diff.ts's `applyAcceptedHunks`) after an explicit, per-hunk human decision (AC7).
 */

const COPILOT_SYSTEM_PROMPT =
  "You are a QA test-flow authoring assistant. You NEVER write files directly — you propose a " +
  "list of suggested changes (\"hunks\") for a human to review and accept/reject individually. " +
  'Respond with EXACTLY ONE JSON array of hunk objects, and NOTHING else (no prose, no markdown ' +
  'fence). Each hunk has the shape: {"kind": "add"|"remove"|"change", "description": "<plain-' +
  'language Vietnamese description of this ONE change>", "step": <a single step object, for ' +
  '"add"/"change" only>, "targetStepId": "<existing step id, for "change"/"remove" only>}. Each ' +
  "step object must use ONLY this closed action vocabulary (no other actions exist): tap, " +
  "tapText, type, key, swipe, waitFor, waitMs, screenshot, assertVisible, doubleTap, longPress, " +
  "tapIfVisible, clearText, deleteText, hideKeyboard, scroll, scrollUntilVisible, back, " +
  "assertNotVisible, waitForNotVisible, openLink, launchApp, stopApp, copyText, pasteText.";

function buildCoPilotPrompt(prompt: string, flow?: Flow): string {
  if (!flow) {
    return `Draft a NEW test flow from this description:\n${prompt}`;
  }
  const stepsSummary = flow.steps.map((s, i) => `${i}: ${s.action} (id=${s.id})`).join("\n");
  return `Existing flow "${flow.name}" (bundleId=${flow.app.bundleId}), current steps:\n${stepsSummary}\n\nRequest: ${prompt}`;
}

/** Extract a JSON array from `text`, validating each hunk. A hunk whose `step` fails IR validation
 * (or whose shape is otherwise malformed) is DROPPED from the result, never coerced — the
 * suggestion may end up with fewer hunks than the model proposed, but every hunk that DOES appear
 * is guaranteed to produce a legal step if accepted. Returns `[]` (never throws) for unparseable
 * output — an empty review diff is an honest, safe result, not a fake success. */
export function parseAndValidateCoPilotHunks(text: string): CoPilotHunk[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text.trim());
  } catch {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    try {
      raw = JSON.parse(match[0]);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];

  const hunks: CoPilotHunk[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const obj = item as Record<string, unknown>;
    if (obj.kind !== "add" && obj.kind !== "remove" && obj.kind !== "change") continue;
    if (typeof obj.description !== "string" || obj.description.length === 0) continue;

    let step: CoPilotHunk["step"];
    if (obj.kind === "add" || obj.kind === "change") {
      if (typeof obj.step !== "object" || obj.step === null) continue;
      const parsed = leafStepSchema.safeParse({ id: randomUUID(), ...(obj.step as Record<string, unknown>) });
      if (!parsed.success) continue;
      step = parsed.data;
    }
    if ((obj.kind === "change" || obj.kind === "remove") && typeof obj.targetStepId !== "string") continue;

    hunks.push({
      id: randomUUID(),
      kind: obj.kind,
      description: obj.description,
      step,
      targetStepId: typeof obj.targetStepId === "string" ? obj.targetStepId : undefined,
    });
  }
  return hunks;
}

export interface CoPilotDraftContext {
  prompt: string;
  flow?: Flow;
  /** The `authoring` role's fallback chain — MAY include an `agent-cli` provider (no hot-path
   * guard applies here, unlike rung 4's `recovery` chain). */
  authoringChain: readonly string[];
  providers: ReadonlyMap<string, AiProvider>;
  timeoutMs?: number;
}

export interface CoPilotDraftOutcome {
  suggestion: CoPilotSuggestion;
  /** Every co-pilot call is logged, success or failure — same "log regardless of outcome"
   * discipline as rung 4 (security-review finding: this was previously missing entirely for the
   * authoring/co-pilot path, an AC3/§5.4 guardrail gap). The caller (bridge/server.ts) persists
   * this via `primaryStore.insertAiCallLog`. */
  logEntry: Omit<AiCallLogEntry, "id" | "createdAt">;
  /** Present only when every provider in the chain failed — `suggestion.hunks` is always `[]` in
   * that case. Deliberately a GENERIC message, never the adapter's raw thrown text (security-
   * review finding: a provider's raw HTTP error body can itself echo back sensitive request
   * details) — the real failure reason is still captured in `logEntry.response` for local
   * diagnosis, just never relayed verbatim to the HTTP client. */
  error?: string;
}

/** Ask the authoring provider chain to draft-a-flow (no `flow` given) or suggest edits to an
 * existing one, and return the review diff. Never persists, never executes. Never throws — a
 * provider failure OR a malformed `ctx.flow` (security-review follow-up: `buildCoPilotPrompt`
 * reads `.app.bundleId`/`.steps` directly and previously ran BEFORE this function's own try block,
 * so a bad flow object would throw an unhandled exception instead of a graceful outcome — moved
 * inside the try below; bridge/server.ts also now validates `flow` with `validateFlow` before it
 * ever reaches here, so this is defense-in-depth, not the only gate) is reported via `error` (a
 * generic message) plus an empty-hunks suggestion, both logged the same as a successful call,
 * rather than a rejected promise the caller would otherwise have to special-case for logging. */
export async function draftCoPilotSuggestion(ctx: CoPilotDraftContext): Promise<CoPilotDraftOutcome> {
  const start = Date.now();
  let promptText = ctx.prompt; // fallback for the log entry if buildCoPilotPrompt itself throws
  try {
    promptText = buildCoPilotPrompt(ctx.prompt, ctx.flow);
    const messages: AiMessage[] = [
      { role: "system", content: COPILOT_SYSTEM_PROMPT },
      { role: "user", content: promptText },
    ];
    const { result, providerId } = await completeWithFallback(
      ctx.authoringChain,
      ctx.providers,
      messages,
      { temperature: 0, maxTokens: 4000 },
      ctx.timeoutMs,
    );
    const hunks = parseAndValidateCoPilotHunks(result.text);
    return {
      suggestion: { requestSummary: ctx.prompt, hunks },
      logEntry: {
        // QA audit API-8: a QA can type a real credential into a co-pilot prompt ("log in with
        // X/Y"); scrub secret-shaped strings out of BOTH prompt and response before this is
        // persisted to the (sensitive-at-rest, but now credential-scrubbed) call log.
        role: "authoring", providerId, prompt: scrubSecrets(promptText), response: scrubSecrets(result.text),
        tokensUsed: result.tokensUsed, latencyMs: Date.now() - start,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // QA audit AI-1/AI-2: the underlying failure message (from completeWithFallback) can embed the
    // provider's `apiKeyRef` verbatim — which, in the misconfigured "env:<raw key>" case, IS the
    // secret. Scrub it before it reaches the log. And when the failure is a missing/misconfigured
    // key, surface a SPECIFIC, actionable (still secret-free) reason instead of the fully generic
    // one, so a QA knows to fix their key rather than seeing an unexplained "something went wrong".
    const isKeyProblem = /\bkey\b/i.test(message) && (/\bnot found\b/i.test(message) || /apiKeyRef/i.test(message) || /env:/i.test(message) || /keychain:/i.test(message));
    return {
      suggestion: { requestSummary: ctx.prompt, hunks: [] },
      logEntry: {
        role: "authoring", providerId: "none", prompt: scrubSecrets(promptText), response: scrubSecrets(message),
        latencyMs: Date.now() - start,
      },
      error: isKeyProblem
        ? "Co-pilot failed: the AI provider's API key is missing or misconfigured. Check that the provider's apiKeyRef points to an environment variable name (e.g. env:GEMINI_API_KEY) and that the variable is set for the bridge process."
        : "Co-pilot request failed — no provider in the authoring chain responded successfully.",
    };
  }
}
