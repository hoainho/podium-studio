import {
  isPlausibleApiKeyRef,
  type AiMode,
  type AiRole,
  type ProviderConfig as WireProviderConfig,
  type RoutingConfig,
} from "../shared/ai-types.ts";

export type { AiMode, AiRole, RoutingConfig };

/**
 * ai-provider.ts — provider registry + Strict/Adaptive mode, the src/ half of E24
 * (janus-specs/R5-R6-ai-cloud/E24-ai-providers.md).
 *
 * Pure, testable logic only — no fetch, no DOM. The actual provider CRUD / co-pilot HTTP calls
 * live in src/api.ts; the REAL enforcement of every rule below (AC5's agent-cli/recovery ban,
 * "keys never touch Git", IR-legality of a rung-4 action) happens server-side, in worker-E1's
 * concurrent backend work (shared/ai-types.ts + bridge/ai-*.ts) — nothing here is a substitute
 * for that. What this module DOES do is give the UI an immediate, honest, client-side check so a
 * QA gets clear feedback before ever submitting a config the backend would reject anyway,
 * consistent with this codebase's "defense in depth, never trust a single layer alone" convention
 * (see src/heal-approval.ts's own doc comment for the same idea applied to E19).
 *
 * `RoutingConfig`/`AiRole`/`AiMode` are imported straight from shared/ai-types.ts (identical
 * shape either side needs, no translation). `ProviderConfig` here is deliberately kept as this
 * module's OWN flat, every-kind-specific-field-optional shape rather than importing
 * shared/ai-types.ts's discriminated union directly — a form mid-edit needs to hold e.g. a typed
 * `command` value even while `kind` is momentarily "openai-compatible" (the QA hasn't committed
 * to a kind switch yet), which a strict discriminated union can't represent mid-draft.
 * shared/ai-types.ts's own doc comment confirms this is the expected UI-side counterpart, not a
 * divergent parallel type: `toWireProviderConfig`/`fromWireProviderConfig` below convert
 * losslessly at the wire boundary (src/api.ts's `getAiRegistry`/`saveAiRegistry`).
 */

export type ProviderKind = "openai-compatible" | "agent-cli";

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  /** openai-compatible only. */
  baseUrl?: string;
  /** openai-compatible only. */
  model?: string;
  /** agent-cli only. */
  command?: string;
  /** agent-cli only. */
  args?: string[];
  apiKeyRef?: string;
  enabled: boolean;
}

/** Convert this module's flat UI-side draft shape into the real wire contract's discriminated
 * union, for a `saveAiRegistry` call. Kind-specific fields the wrong kind happens to still be
 * holding (e.g. a leftover `command` typed before switching to openai-compatible) are simply
 * dropped — only the fields that belong to the CHOSEN kind travel over the wire. */
export function toWireProviderConfig(p: ProviderConfig): WireProviderConfig {
  const base = { id: p.id, name: p.name, apiKeyRef: p.apiKeyRef, enabled: p.enabled };
  if (p.kind === "openai-compatible") {
    return { ...base, kind: "openai-compatible", baseUrl: p.baseUrl ?? "", model: p.model ?? "" };
  }
  return { ...base, kind: "agent-cli", command: p.command ?? "", args: p.args };
}

/** Convert a real (discriminated-union) `ProviderConfig` from `getAiRegistry` into this module's
 * flat UI-side shape, for editing. */
export function fromWireProviderConfig(p: WireProviderConfig): ProviderConfig {
  return {
    id: p.id,
    name: p.name,
    kind: p.kind,
    baseUrl: p.kind === "openai-compatible" ? p.baseUrl : undefined,
    model: p.kind === "openai-compatible" ? p.model : undefined,
    command: p.kind === "agent-cli" ? p.command : undefined,
    args: p.kind === "agent-cli" ? p.args : undefined,
    apiKeyRef: p.apiKeyRef,
    enabled: p.enabled,
  };
}

/** `apiKeyRef` is ALWAYS an unresolved `"env:NAME"` or `"keychain:service"` reference — never a
 * raw API key (non-negotiable §5: "Provider API keys via keychain/env (apiKeyRef) only; never
 * written to JSON flows, fixtures, or prompt logs in plaintext"). This is a DIFFERENT reference
 * namespace/format from E12's `${secret:...}` seam (shared/ai-types.ts's own doc comment: "a
 * different resolver, zero shared code path") — do not conflate the two when validating input
 * here. Omitted entirely for a provider that needs no key (e.g. a local Ollama instance). */
/** True when `value` is a well-formed `env:NAME` / `keychain:service` reference — the ONLY shape
 * an `apiKeyRef` should ever hold. This is a UI-level nudge (reject obviously-wrong input before
 * it's ever submitted), not a cryptographic guarantee that no raw key can ever be pasted in —
 * documented here as a mitigation, matching this epic's own "guardrails are mitigations, not
 * guarantees" framing (AC9).
 *
 * QA audit AI-1 fix: delegates to shared `isPlausibleApiKeyRef`, which additionally rejects a raw
 * secret disguised behind an `env:`/`keychain:` prefix (the old `[a-zA-Z0-9_.-]+` charset-only
 * regex accepted `env:<actual API key>` because a key's characters trivially satisfy it — the key
 * then round-tripped in cleartext through the registry, UI, and call log). The SAME check now runs
 * server-side in `validateProviderRegistry`, so the guard holds even if the UI is bypassed. */
export function isValidApiKeyRef(value: string): boolean {
  return isPlausibleApiKeyRef(value);
}

/** A deliberately unhelpful, non-reversible display string for an apiKeyRef in the UI — even
 * though `apiKeyRef` is already just a reference (never the real key), this keeps the input
 * field from ever rendering something that LOOKS like a secret value if a user pastes a raw
 * token in by mistake (defense in depth for the "never plaintext" bar). */
export function maskIfNotARef(value: string): string {
  if (isValidApiKeyRef(value) || value.trim() === "") return value;
  return "•".repeat(Math.min(value.length, 24));
}

export interface RoutingValidationError {
  role: AiRole;
  providerId: string;
  message: string;
}

/**
 * AC5: an `agent-cli` provider must never appear in the `recovery` role's fallback chain — spawning
 * an arbitrary local CLI process has no place in the bounded, single-turn recovery hot path (spec's
 * own "Hot-path guard" scope line). This is the SAME rule the backend enforces at config-load
 * time (registry validation error, process does not start) — this client-side check exists so
 * the UI can refuse to even LET a QA build such a config, with an immediate, clear explanation,
 * rather than silently letting them submit something the backend will reject moments later.
 */
export function validateRouting(providers: readonly ProviderConfig[], routing: RoutingConfig): RoutingValidationError[] {
  const byId = new Map(providers.map((p) => [p.id, p]));
  const errors: RoutingValidationError[] = [];
  for (const providerId of routing.recovery) {
    const provider = byId.get(providerId);
    if (provider?.kind === "agent-cli") {
      errors.push({
        role: "recovery",
        providerId,
        message: `Nhà cung cấp "${provider.name}" là agent-cli — KHÔNG được dùng cho vai trò recovery (chỉ dùng cho authoring).`,
      });
    }
  }
  return errors;
}

/** True when it's structurally safe to even OFFER `provider` as a recovery-role option in the
 * routing UI — i.e. `validateRouting` would never reject it. Used to disable/hide the option
 * entirely in a role picker, rather than letting a QA pick it and then showing an error. */
export function isEligibleForRole(provider: ProviderConfig, role: AiRole): boolean {
  if (role === "recovery" && provider.kind === "agent-cli") return false;
  return true;
}

/** AC1's own framing, made explicit and testable: Strict mode means AI is OFF, full stop — no
 * rung-4, no co-pilot, regardless of what providers/routing are configured. Adaptive is the only
 * mode where any of this epic's AI paths are reachable at all. */
export function isAiEnabled(mode: AiMode): boolean {
  return mode === "adaptive";
}

/** The display name of the AI provider that would actually author a draft — the first ENABLED
 * provider in the authoring chain (else the first enabled provider at all). Used to label the AI
 * feature by whatever's connected ("Gemini", "GPT", …) instead of a fixed brand, per the product
 * decision to drop the "Co-pilot" name. Returns null when no provider is configured/enabled, so the
 * UI can fall back to a generic "AI". */
export function activeAuthoringProviderName(
  registry: { providers: ReadonlyArray<{ id: string; name: string; enabled: boolean }>; routing: { authoring: readonly string[] } } | null | undefined,
): string | null {
  if (!registry) return null;
  const enabled = registry.providers.filter((p) => p.enabled);
  const byId = new Map(enabled.map((p) => [p.id, p]));
  for (const id of registry.routing.authoring) {
    const p = byId.get(id);
    if (p) return p.name;
  }
  return enabled[0]?.name ?? null;
}

/** Plain-Vietnamese description of what Adaptive mode actually turns on — shown next to the
 * Strict/Adaptive toggle so "AI OFF by default" isn't just a label but an explained trade-off
 * (spec: "clear 'AI OFF by default' messaging + what Adaptive enables"). */
// (The Adaptive-mode "what this enables" bullet list moved to i18n — aiSettings.adaptiveEnables.*
// in src/i18n/locales/{vi,en}.ts, rendered by AiModeToggle — so it translates with the locale.)
