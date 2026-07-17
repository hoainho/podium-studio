import { spawn } from "node:child_process";
import type {
  AgentCliProviderConfig,
  AiCompletionOptions,
  AiCompletionResult,
  AiMessage,
  AiProvider,
  OpenAiCompatibleProviderConfig,
  ProviderConfig,
} from "../shared/ai-types.ts";
import { type AiKeyResolverDeps, defaultAiKeyResolverDeps, redactApiKey, resolveApiKeyRef } from "./ai-key-resolver.ts";

/**
 * ai-providers.ts — the two adapter kinds (E24, PILLAR-9-adaptive-ai.md §5.1/§5.2): every
 * provider in the registry is EITHER `openai-compatible` (HTTP; covers Gemini/CLIProxyAPI/
 * 9router/omni/OpenRouter/Ollama/OpenAI — all speak the OpenAI Chat Completions shape) OR
 * `agent-cli` (spawns a local CLI, e.g. OpenCode, and reads its JSON output). Adding a new
 * `openai-compatible` provider is a config row (AC6) — nothing here branches on WHICH proxy/model
 * it points at.
 *
 * Both adapters are pure factories over injectable I/O (`fetchFn`/`spawnFn`) — mirrors this
 * codebase's established DI convention (bridge/android-driver.ts's `AndroidExecFn`,
 * bridge/doctor.ts's `ExecFn`) so bridge/ai-registry.ts and bridge/ai-rung4.ts are fully
 * unit-testable with zero real network/subprocess calls.
 */

export type FetchFn = typeof fetch;

/** POST `${baseUrl}/chat/completions` — the OpenAI Chat Completions request/response shape every
 * listed proxy/model speaks (spec §5.1). Key resolution is fully optional (a local Ollama needs
 * none) and, when present, goes through bridge/ai-key-resolver.ts — NEVER bridge/secrets.ts (see
 * that resolver's own doc comment for why the two credential seams never share code). */
export function createOpenAiCompatibleProvider(
  config: OpenAiCompatibleProviderConfig,
  deps: { fetchFn?: FetchFn; keyDeps?: AiKeyResolverDeps } = {},
): AiProvider {
  const fetchFn = deps.fetchFn ?? fetch;
  if (!config.baseUrl) throw new Error(`openai-compatible provider "${config.id}" is missing baseUrl`);
  if (!config.model) throw new Error(`openai-compatible provider "${config.id}" is missing model`);
  // Security-review follow-up: bridge/ai-registry.ts's validateProviderRegistry already checks
  // this at config-submit/startup time — re-checked here too (defense in depth, same "never
  // trust a single layer alone" discipline as the recovery-role hot-path guard) so a provider
  // object built any other way (a future call site, a test double, a config loaded by a path that
  // forgot to validate first) still can never make a real fetch() call to a non-http(s) target.
  if (!/^https?:\/\//i.test(config.baseUrl)) {
    throw new Error(`openai-compatible provider "${config.id}" baseUrl must start with http:// or https:// (got "${config.baseUrl}")`);
  }
  const baseUrl = config.baseUrl;
  const model = config.model;

  return {
    id: config.id,
    async complete(messages: AiMessage[], opts: AiCompletionOptions): Promise<AiCompletionResult> {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      let resolvedKey: string | undefined;
      if (config.apiKeyRef) {
        resolvedKey = await resolveApiKeyRef(config.apiKeyRef, deps.keyDeps ?? defaultAiKeyResolverDeps());
        headers.Authorization = `Bearer ${resolvedKey}`;
      }

      const res = await fetchFn(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages,
          temperature: opts.temperature,
          max_tokens: opts.maxTokens,
        }),
        signal: opts.signal,
      });

      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        // Security-review fix: some providers echo request headers (including Authorization)
        // back into an error body for debugging — redact the resolved key out of it before it
        // ever becomes part of a thrown Error's message, which a caller (e.g. the co-pilot HTTP
        // endpoint) could otherwise relay toward an HTTP client.
        const redactedBody = redactApiKey(bodyText, resolvedKey);
        throw new Error(`AI provider "${config.id}" returned HTTP ${res.status}: ${redactedBody.slice(0, 500)}`);
      }
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { total_tokens?: number };
      };
      const text = json.choices?.[0]?.message?.content ?? "";
      return { text, tokensUsed: json.usage?.total_tokens };
    },
  };
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Injectable process-spawn primitive — the ONLY place bridge/ai-providers.ts touches
 * node:child_process directly, so a test can substitute a fake CLI without ever spawning a real
 * process (matches bridge/doctor.ts's own "one narrow exec seam" pattern). */
export type SpawnFn = (command: string, args: string[], input: string, signal?: AbortSignal) => Promise<SpawnResult>;

function defaultSpawn(command: string, args: string[], input: string, signal?: AbortSignal): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const onAbort = () => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`agent-cli "${command}" aborted (time budget exceeded)`));
    };
    signal?.addEventListener("abort", onAbort);

    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, code });
    });

    child.stdin.write(input);
    child.stdin.end();
  });
}

/** Spawns `command` with `args`, writes a single JSON-encoded request to stdin, reads a single
 * JSON response from stdout — the "multi-step authoring assist" shape (spec §5.2/§5.3: e.g.
 * OpenCode). NEVER routable to the `recovery` role (bridge/ai-registry.ts's `validateProviderRegistry`
 * statically rejects that at config-load time, AC5) — this factory itself has no opinion on role,
 * it's just the adapter; the role restriction is enforced one layer up, deliberately not
 * duplicated here (single source of truth for the hot-path guard). */
export function createAgentCliProvider(
  config: AgentCliProviderConfig,
  deps: { spawnFn?: SpawnFn } = {},
): AiProvider {
  const spawnFn = deps.spawnFn ?? defaultSpawn;
  if (!config.command) throw new Error(`agent-cli provider "${config.id}" is missing command`);
  const command = config.command;
  const args = config.args ?? [];

  return {
    id: config.id,
    async complete(messages: AiMessage[], opts: AiCompletionOptions): Promise<AiCompletionResult> {
      const input = JSON.stringify({ messages, temperature: opts.temperature, maxTokens: opts.maxTokens });
      const result = await spawnFn(command, args, input, opts.signal);
      if (result.code !== 0) {
        throw new Error(`agent-cli "${config.id}" exited ${result.code}: ${result.stderr.slice(0, 500)}`);
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        throw new Error(`agent-cli "${config.id}" did not print valid JSON to stdout`);
      }
      const obj = parsed as { text?: unknown; output?: unknown };
      const text = typeof obj.text === "string" ? obj.text : typeof obj.output === "string" ? obj.output : "";
      return { text };
    },
  };
}

/** Build the real `AiProvider` for one config row — dispatches purely on `kind`, no per-provider
 * branching beyond that (AC6: a new `openai-compatible` row never touches this function's body). */
export function createProvider(
  config: ProviderConfig,
  deps: { fetchFn?: FetchFn; keyDeps?: AiKeyResolverDeps; spawnFn?: SpawnFn } = {},
): AiProvider {
  if (config.kind === "openai-compatible") return createOpenAiCompatibleProvider(config, deps);
  return createAgentCliProvider(config, deps);
}
