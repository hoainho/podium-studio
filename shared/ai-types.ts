import type { LeafStep } from "./ir.ts";

/**
 * E24 — AI rung-4 + provider registry + authoring co-pilot
 * (janus-specs/R5-R6-ai-cloud/E24-ai-providers.md, PILLAR-9-adaptive-ai.md §5).
 *
 * Pure, framework-free types shared by bridge/ai-registry.ts (validation + fallback-chain
 * execution), bridge/ai-providers.ts (the two adapter kinds), bridge/ai-rung4.ts (the bounded
 * single-turn recovery engine), bridge/ai-copilot.ts, and — via shared/protocol.ts's wire types —
 * the src/ half of this epic (src/ai-provider.ts, src/copilot-diff.ts). Field names on
 * `ProviderConfig`/`RoutingConfig`/`CoPilotHunk` below are kept IDENTICAL to src/ai-provider.ts's
 * and src/copilot-diff.ts's own local types (already landed concurrently by worker-E24-ui) so the
 * wire contract needs zero translation layer at the src//bridge boundary — this file's shapes are
 * a strict SUPERSET (adds the fields the backend needs to actually operate, e.g. `model`/`args`,
 * that the UI doesn't render yet) rather than a divergent parallel type.
 *
 * HIGH-RISK epic (provider trust boundary, secrets, non-determinism) — nothing here talks to a
 * network or spawns a process; this module is deliberately inert data shapes only, exactly the
 * same "pure types file, zero side effects" discipline shared/selfheal-types.ts established.
 */

export type ProviderKind = "openai-compatible" | "agent-cli";
export type AiRole = "authoring" | "recovery";
export type AiMode = "strict" | "adaptive";

/** Fields every provider row has regardless of kind. `apiKeyRef` is ALWAYS an unresolved
 * reference string (`"env:NAME"` or `"keychain:service"`) — resolution happens at call time via
 * bridge/ai-key-resolver.ts, which is architecturally separate from bridge/secrets.ts's
 * `${secret:...}` seam (E12) per that module's own doc comment: different namespace, different
 * resolver, zero shared code path. Never a raw key, never written to a flow/fixture/log in
 * plaintext (non-negotiable #5). */
interface ProviderConfigBase {
  id: string;
  /** Display name shown in the UI (e.g. "Local Ollama", "CLIProxyAPI"). */
  name: string;
  apiKeyRef?: string;
  enabled: boolean;
}

/** e.g. "http://localhost:11434/v1" — request is POSTed to `${baseUrl}/chat/completions`. */
export interface OpenAiCompatibleProviderConfig extends ProviderConfigBase {
  kind: "openai-compatible";
  baseUrl: string;
  /** The model name/id sent in the request body. */
  model: string;
}

/** Spawns `command` with `args` and reads its JSON stdout (e.g. OpenCode) — authoring-only, see
 * `AiRole`'s own doc comment and bridge/ai-registry.ts's `validateProviderRegistry` (AC5). */
export interface AgentCliProviderConfig extends ProviderConfigBase {
  kind: "agent-cli";
  command: string;
  args?: string[];
}

/** One configured provider row (spec §5.2's "provider registry... a config row, not a code
 * change") — a discriminated union on `kind` (not one flat interface with optional fields) so
 * `baseUrl`/`model` are compile-time GUARANTEED present on an openai-compatible row and `command`
 * on an agent-cli row, rather than merely "usually present, checked at runtime". Wire-compatible
 * with src/ai-provider.ts's own (flat, optional-fields) `ProviderConfig` — both describe the
 * identical JSON shape, a discriminated union vs. a flat interface is a compile-time-only
 * distinction, never a serialization difference. */
export type ProviderConfig = OpenAiCompatibleProviderConfig | AgentCliProviderConfig;

/** Ordered fallback chain per role (spec: "free/local-first" — index 0 tried first). Provider ids
 * reference `ProviderConfig.id`. Exactly 2 roles per this epic's scope (no third "default" role —
 * PILLAR-9-adaptive-ai.md §5.2's own registry example has one, but E24's task scope is explicitly
 * "per-role routing (authoring/recovery)" only). */
export interface RoutingConfig {
  authoring: string[];
  recovery: string[];
}

export interface ProviderRegistryConfig {
  providers: ProviderConfig[];
  routing: RoutingConfig;
}

/** Raised by `validateProviderRegistry` (bridge/ai-registry.ts) — AC5's "config-load reject", AC6
 * (unknown-id typos caught at the same gate a new-provider row would be validated at). */
export class ProviderRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRegistryError";
  }
}

/** The ONE non-negotiable violation among `ProviderRegistryError`'s causes (AC5's hot-path
 * guard: an `agent-cli` provider routed to the `recovery` role) — a distinct subclass so a
 * caller can single THIS one out as fatal ("config-load reject... process does not start", AC5's
 * own literal wording) while every other registry-validation issue (duplicate ids, a missing
 * field, a malformed baseUrl) stays a log-and-tolerate concern, matching bridge/server.ts's
 * existing "never crash the whole bridge over a stale/bad persisted config" startup convention. */
export class AgentCliRecoveryGuardError extends ProviderRegistryError {
  constructor(message: string) {
    super(message);
    this.name = "AgentCliRecoveryGuardError";
  }
}

// ─── Secret-safety helpers (QA audit AI-1 / API-7 / API-8) ────────────────────────────────────
// Shared by the client form guard (src/ai-provider.ts's isValidApiKeyRef) AND the server registry
// gate (bridge/ai-registry.ts's validateProviderRegistry), so a raw pasted key can be rejected at
// BOTH boundaries with one definition — non-negotiable #5 ("keys via keychain/env reference only,
// never plaintext"). These are heuristics/nudges, never a cryptographic guarantee (matching the
// epic's own "guardrails are mitigations, not guarantees" framing).

/** True when `s` looks like a raw secret VALUE rather than an env-var NAME / keychain service —
 * the exact mistake AI-1 caught (a QA pasting `env:<actual key>` into the "reference" field). It
 * fires on (a) known vendor key prefixes, and (b) the generic high-entropy shape env-var names
 * essentially never have (long + simultaneously mixing lower, upper, and digits). */
export function looksLikeRawSecret(s: string): boolean {
  if (/^(AIza|sk-|sk-ant|rk_|ghp_|gho_|ghs_|github_pat_|xox[baprs]-|AKIA|ya29\.|glpat-|hf_|pk_live_|sk_live_)/.test(s)) {
    return true;
  }
  if (s.length >= 20 && /[a-z]/.test(s) && /[A-Z]/.test(s) && /[0-9]/.test(s)) return true;
  return false;
}

/** Structural check that an `apiKeyRef` is a *reference* (`env:NAME` / `keychain:service`), never a
 * pasted secret. The pre-QA regex only checked the character class after the prefix, so a raw key
 * (all-alphanumeric) sailed through; this additionally requires a plausible identifier shape, a
 * sane length, and that it not `looksLikeRawSecret`. An absent/empty ref (a keyless local model) is
 * the caller's concern — this only judges a non-empty ref's shape. */
export function isPlausibleApiKeyRef(ref: string): boolean {
  const s = ref.trim();
  if (s.startsWith("env:")) {
    const name = s.slice("env:".length);
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name.length <= 128 && !looksLikeRawSecret(name);
  }
  if (s.startsWith("keychain:")) {
    const svc = s.slice("keychain:".length);
    return /^[A-Za-z0-9_.-]+$/.test(svc) && svc.length <= 128 && !looksLikeRawSecret(svc);
  }
  return false;
}

/** Redact secret-shaped substrings out of free text before it is persisted to / served from the AI
 * call log (API-8: a QA can type a real password into a co-pilot prompt; API-1: a failed-key error
 * echoes the `env:<rawkey>` ref verbatim). Best-effort scrubbing — covers vendor-key tokens, the
 * `env:`/`keychain:` + secret-shaped-tail case, and inline `password:`/`pwd=` values. */
export function scrubSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  // env:/keychain: refs whose tail looks like a raw secret → keep the prefix, redact the value.
  out = out.replace(/\b(env:|keychain:)([A-Za-z0-9._-]{8,})/g, (m, prefix: string, tail: string) =>
    looksLikeRawSecret(tail) ? `${prefix}[redacted]` : m,
  );
  // Bare vendor-key tokens anywhere in the text.
  out = out.replace(
    /\b(AIza[A-Za-z0-9_-]{10,}|sk-(?:ant-)?[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{12,}|glpat-[A-Za-z0-9_-]{16,}|hf_[A-Za-z0-9]{16,})\b/g,
    "[redacted]",
  );
  // Inline credential phrases (e.g. "password: Hunter2", "pwd=Hunter2").
  out = out.replace(/\b(pass(?:word)?|pwd|secret|token|api[_-]?key)\b(\s*[:=]\s*)(\S+)/gi, "$1$2[redacted]");
  return out;
}

// ─── The universal adapter (PILLAR-9-adaptive-ai.md §5.1) ─────────────────────────────────────

export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiCompletionOptions {
  /** Always 0 for rung-4 recovery (spec: "temp 0" — reduces, never guarantees, variance). Co-pilot
   * authoring also defaults to 0 (spec §5.3: "temp 0"). */
  temperature: number;
  maxTokens: number;
  /** Per-call wall-clock budget (ms) — AC8's "falls back... within the configured time budget".
   * Enforced by bridge/ai-registry.ts's fallback runner via AbortSignal, not by the adapter
   * itself, so both adapter kinds share one enforcement point. */
  signal?: AbortSignal;
}

export interface AiCompletionResult {
  text: string;
  /** Token usage, when the provider reports it — absent for an agent-cli adapter that doesn't
   * surface this (best-effort, logged as `undefined` rather than guessed). */
  tokensUsed?: number;
}

/** `interface AiProvider { id; complete(messages, opts): Promise<{text, toolCalls?}> }` per
 * PILLAR-9-adaptive-ai.md §5.1 — `toolCalls` omitted here (out of scope: rung-4/co-pilot never
 * need tool-calling, only a single text/JSON response). */
export interface AiProvider {
  id: string;
  complete(messages: AiMessage[], opts: AiCompletionOptions): Promise<AiCompletionResult>;
}

// ─── Call log (AC3: every rung-4/co-pilot call logged locally, sensitive-at-rest) ──────────────

export interface AiCallLogEntry {
  id: string;
  role: AiRole;
  providerId: string;
  prompt: string;
  response: string;
  tokensUsed?: number;
  /** Best-effort estimate — absent when the provider/model's per-token price isn't known. */
  costUsd?: number;
  latencyMs: number;
  /** Present for a rung-4 recovery call; absent for a co-pilot authoring call (no single screen). */
  screenFingerprint?: string;
  createdAt: number;
}

// ─── Rung 4 (bridge/ai-rung4.ts) ────────────────────────────────────────────────────────────────

/** The result of one bounded rung-4 attempt. Mirrors `shared/selfheal-types.ts`'s `HealAttempt`
 * shape exactly (same `healed`/`appliedRecovery`/`proposedPatch`/`reason` fields) so
 * bridge/runner.ts's existing rung 1-3 call site needs minimal, additive changes to also drive
 * rung 4 — not a parallel, differently-shaped result type to special-case. */
export interface Rung4Attempt {
  healed: boolean;
  /** The single, already-validated leaf-step action to retry with — undefined when `healed` is
   * false (illegal/out-of-bounds output, provider failure, or heal-type safety refusal). Always a
   * `LeafStep`-shaped object (AC2: validated against the closed IR before this is ever set). */
  appliedRecovery?: LeafStep;
  proposedPatch?: {
    lessonId?: string;
    healType: "locator" | "assertion" | "interstitial" | "other";
    rung: 4;
    summary: string;
    recovery: Record<string, unknown>;
  };
  reason?: string;
  /** Always present, healed or not (AC3: "every rung-4 heal is logged locally" — logged
   * regardless of outcome, for observability/audit of what the AI was even asked/answered). */
  logEntry: Omit<AiCallLogEntry, "id" | "createdAt">;
}

// ─── Authoring co-pilot (bridge/ai-copilot.ts) ──────────────────────────────────────────────────
// Field names identical to src/copilot-diff.ts's own local types (landed concurrently by
// worker-E24-ui) — see this file's own top doc comment.

export type CoPilotHunkKind = "add" | "remove" | "change";

export interface CoPilotHunk {
  id: string;
  kind: CoPilotHunkKind;
  description: string;
  /** The step this hunk introduces/changes TO — absent for a pure "remove" hunk. */
  step?: LeafStep;
  /** The existing step's id this hunk targets ("change"/"remove") — absent for a pure "add" hunk. */
  targetStepId?: string;
}

export interface CoPilotSuggestion {
  requestSummary: string;
  hunks: CoPilotHunk[];
}
