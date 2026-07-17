import type {
  AiCompletionOptions,
  AiCompletionResult,
  AiMessage,
  AiProvider,
  AiRole,
  ProviderRegistryConfig,
} from "../shared/ai-types.ts";
import { AgentCliRecoveryGuardError, ProviderRegistryError, isPlausibleApiKeyRef } from "../shared/ai-types.ts";
import { createProvider, type FetchFn, type SpawnFn } from "./ai-providers.ts";
import type { AiKeyResolverDeps } from "./ai-key-resolver.ts";

/**
 * ai-registry.ts — provider registry validation + free-first fallback-chain execution (E24,
 * janus-specs/R5-R6-ai-cloud/E24-ai-providers.md).
 *
 * `validateProviderRegistry` is the ONE gate AC5 depends on: it runs both at server startup
 * (loading a persisted registry) AND on every `POST /api/ai/providers` submission (bridge/
 * server.ts), so an `agent-cli` provider can NEVER become reachable from the `recovery` role
 * either by a stale on-disk config or a fresh one — "config-load reject... process does not
 * start" (AC5's own wording) is enforced at both of those load points, not just one.
 */

/** AC5 (BLOCKING, hot-path guard) + basic referential-integrity checks a config must pass before
 * it's ever used to build real providers or persisted. Throws `ProviderRegistryError` — never
 * returns a list of problems to silently ignore; a bad registry must never partially load. */
export function validateProviderRegistry(config: ProviderRegistryConfig): void {
  const ids = new Set<string>();
  for (const p of config.providers) {
    if (ids.has(p.id)) throw new ProviderRegistryError(`Duplicate provider id "${p.id}" in registry.`);
    ids.add(p.id);
    if (p.kind === "openai-compatible" && (!p.baseUrl || !p.model)) {
      throw new ProviderRegistryError(`Provider "${p.id}" (openai-compatible) requires both baseUrl and model.`);
    }
    // Security-review MINOR fix: require an actual http(s) URL — an unvalidated baseUrl would
    // otherwise let a config author (or a compromised/bad config source) point the adapter's
    // fetch call at an arbitrary scheme (e.g. `file:`) or a malformed value; this doesn't fully
    // close every SSRF-adjacent concern (a config author is a local, trusted user, and any
    // reachable http(s) host is still allowed by design — that's the whole point of "any
    // OpenAI-compatible endpoint"), but it does reject the obviously-wrong/dangerous shapes.
    if (p.kind === "openai-compatible" && p.baseUrl && !/^https?:\/\//i.test(p.baseUrl)) {
      throw new ProviderRegistryError(`Provider "${p.id}" (openai-compatible) baseUrl must start with http:// or https:// (got "${p.baseUrl}").`);
    }
    if (p.kind === "agent-cli" && !p.command) {
      throw new ProviderRegistryError(`Provider "${p.id}" (agent-cli) requires a command.`);
    }
    // QA audit AI-1 / API-7: an `apiKeyRef`, when present, must be a REFERENCE (env:NAME /
    // keychain:service) — never a raw pasted secret. The pre-QA path accepted `env:<actual key>`
    // and round-tripped it in cleartext through this very endpoint's GET. Rejected here so a bad
    // ref can't be persisted via POST /api/ai/providers (and is logged-and-tolerated, not fatal,
    // for an already-persisted stale one at startup — same convention as the other non-hot-path
    // checks above). An absent/empty ref (a keyless local model) is fine and skipped.
    if (p.apiKeyRef && p.apiKeyRef.trim() !== "" && !isPlausibleApiKeyRef(p.apiKeyRef)) {
      throw new ProviderRegistryError(
        `Provider "${p.id}" apiKeyRef must be a reference like "env:GEMINI_API_KEY" or ` +
          `"keychain:my-service", not a pasted API key. Set the key as an environment variable ` +
          `(or in the keychain) and reference it by name.`,
      );
    }
  }

  const roles: AiRole[] = ["authoring", "recovery"];
  for (const role of roles) {
    for (const id of config.routing[role]) {
      const provider = config.providers.find((p) => p.id === id);
      if (!provider) {
        throw new ProviderRegistryError(`routing.${role} references unknown provider id "${id}".`);
      }
      // AC5 — the hot-path guard: agent-cli spawns an arbitrary local process and has no bounded
      // single-turn guarantee, so it is NEVER routable to the recovery role, full stop. Checked
      // here (config-load time), not just at the moment a recovery attempt happens, so a
      // misconfigured registry is rejected before the process even starts using it.
      if (role === "recovery" && provider.kind === "agent-cli") {
        throw new AgentCliRecoveryGuardError(
          `Provider "${id}" is kind "agent-cli" and cannot be routed to the "recovery" role — ` +
            `agent-cli is authoring-only (hot-path guard, AC5). Remove it from routing.recovery.`,
        );
      }
    }
  }
}

export type ProcessExitFn = (code: number) => void;

/** AC5's own literal wording: "config-load reject... process does not start". Distinguishes the
 * ONE non-negotiable violation (`AgentCliRecoveryGuardError`) from every other registry-validation
 * issue: only THAT one is treated as fatal at startup (calls `exit(1)`) — a duplicate id, missing
 * field, or bad baseUrl scheme in an already-persisted registry is logged and tolerated (same
 * "never crash the whole bridge over a stale/bad persisted config" convention bridge/server.ts's
 * startup block already follows for a corrupted primary store), since the runtime dispatch layer
 * (`resolveRoleChain`) independently guards against agent-cli/recovery regardless — this is
 * belt-and-suspenders on top of an already-closed hole, not the last line of defense. Injectable
 * `exit` (default `process.exit`) so this is testable without actually killing the test process. */
export function validateStartupRegistry(config: ProviderRegistryConfig, exit: ProcessExitFn = (code) => process.exit(code)): void {
  try {
    validateProviderRegistry(config);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[podium-studio] Persisted AI provider registry is invalid:", message);
    if (err instanceof AgentCliRecoveryGuardError) {
      console.error(
        '[podium-studio] FATAL: an agent-cli provider is routed to the "recovery" role in the ' +
          "persisted registry — refusing to start (AC5: \"process does not start\"). Fix the " +
          "registry (e.g. via the primary store) and restart.",
      );
      exit(1);
    }
  }
}

/** Instantiate a real `AiProvider` for every ENABLED row — disabled rows are skipped entirely
 * (never built, never callable), even if a stale routing chain still references their id (the
 * fallback runner below simply treats a missing provider as "this one is unavailable, try the
 * next"). Call `validateProviderRegistry(config)` before this — it is NOT re-validated here, to
 * keep this a single, cheap, non-throwing build step. */
export function buildProviders(
  config: ProviderRegistryConfig,
  deps: { fetchFn?: FetchFn; keyDeps?: AiKeyResolverDeps; spawnFn?: SpawnFn } = {},
): Map<string, AiProvider> {
  const out = new Map<string, AiProvider>();
  for (const p of config.providers) {
    if (!p.enabled) continue;
    out.set(p.id, createProvider(p, deps));
  }
  return out;
}

/**
 * Resolve the (chain, built providers) pair for ONE role from a registry — the single call site
 * bridge/ai-recovery-live-hooks.ts and the co-pilot draft endpoint should use, instead of reading
 * `config.routing[role]` directly. For the `recovery` role, this is a SECOND, independent
 * enforcement of AC5's hot-path guard (defense in depth — never trust `validateProviderRegistry`
 * having already run as the ONLY gate, same "never trust a single layer alone" discipline this
 * codebase applies everywhere else, e.g. rung 3's own re-check of assertion healType): any
 * `agent-cli` id is filtered OUT of the chain here too, so even a registry that somehow bypassed
 * config-load validation (a hand-edited DB row, a future code path that forgets to call it) can
 * never actually dispatch an agent-cli process from the recovery hot path.
 */
export function resolveRoleChain(
  config: ProviderRegistryConfig,
  role: AiRole,
  deps: { fetchFn?: FetchFn; keyDeps?: AiKeyResolverDeps; spawnFn?: SpawnFn } = {},
): { chain: string[]; providers: Map<string, AiProvider> } {
  const byId = new Map(config.providers.map((p) => [p.id, p]));
  const rawChain = config.routing[role];
  const chain =
    role === "recovery" ? rawChain.filter((id) => byId.get(id)?.kind !== "agent-cli") : [...rawChain];
  return { chain, providers: buildProviders(config, deps) };
}

export interface FallbackResult {
  result: AiCompletionResult;
  /** Which provider in the chain actually answered — absent from the request/response pair
   * itself, so callers (bridge/ai-rung4.ts's call-log entry) always know which one to attribute
   * cost/latency to. */
  providerId: string;
}

/**
 * AC8 (free-first routing + bounded fallback): try each provider id in `chain` order; the first
 * one to resolve wins. A provider that's disabled/missing, times out (per-call `timeoutMs`, AC8's
 * "within the configured time budget"), or throws is skipped — NOT retried — and the next one in
 * the chain is tried immediately, so a hung/down local model can never turn into an unbounded
 * hang for the caller. Throws only when EVERY provider in the chain has failed.
 *
 * The time budget is enforced by THIS function via `Promise.race` against its own timer, not
 * merely by handing the provider an `AbortSignal` and trusting it to honor it — both adapter
 * kinds here DO respect the signal (fetch natively; the agent-cli spawn via its own abort
 * listener), but the "no unbounded hang" guarantee shouldn't depend on every provider
 * implementation being well-behaved. A provider that ignores its signal and never settles still
 * gets raced against the deadline and loses, rather than hanging this call (and its caller's
 * whole run) forever.
 */
export async function completeWithFallback(
  chain: readonly string[],
  providers: ReadonlyMap<string, AiProvider>,
  messages: AiMessage[],
  opts: Omit<AiCompletionOptions, "signal">,
  timeoutMs = 5000,
): Promise<FallbackResult> {
  let lastError: unknown;
  for (const id of chain) {
    const provider = providers.get(id);
    if (!provider) {
      lastError = new Error(`no enabled provider for id "${id}"`);
      continue;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`provider "${id}" exceeded its ${timeoutMs}ms time budget`));
      }, timeoutMs);
    });
    try {
      const result = await Promise.race([provider.complete(messages, { ...opts, signal: controller.signal }), deadline]);
      return { result, providerId: id };
    } catch (err) {
      lastError = err;
      // fall through — try the next provider in the chain
    } finally {
      clearTimeout(timer);
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`All providers in fallback chain [${chain.join(", ")}] failed. Last error: ${message}`);
}
