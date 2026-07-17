import { describe, it, expect, vi } from "vitest";
import {
  createOpenAiCompatibleProvider,
  createAgentCliProvider,
  createProvider,
  type SpawnFn,
  type FetchFn,
} from "../bridge/ai-providers.ts";
import type { AgentCliProviderConfig, OpenAiCompatibleProviderConfig } from "../shared/ai-types.ts";

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("createOpenAiCompatibleProvider — HTTP adapter covering Gemini/CLIProxyAPI/9router/omni/OpenRouter/Ollama", () => {
  const baseConfig: OpenAiCompatibleProviderConfig = {
    id: "local", name: "Local Ollama", kind: "openai-compatible",
    baseUrl: "http://localhost:11434/v1", model: "qwen2.5", enabled: true,
  };

  it("POSTs to <baseUrl>/chat/completions with the OpenAI Chat Completions shape", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: "tapText Log In" } }], usage: { total_tokens: 42 } }));
    const provider = createOpenAiCompatibleProvider(baseConfig, { fetchFn: fetchFn as unknown as FetchFn });
    const result = await provider.complete([{ role: "user", content: "hi" }], { temperature: 0, maxTokens: 100 });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({ model: "qwen2.5", temperature: 0, max_tokens: 100 });
    expect(result).toEqual({ text: "tapText Log In", tokensUsed: 42 });
  });

  it("security-review follow-up — rejects a non-http(s) baseUrl when BUILDING the provider (dispatch time), not just at config-submit/startup validation", () => {
    const fetchFn = vi.fn();
    const badConfig: OpenAiCompatibleProviderConfig = { ...baseConfig, baseUrl: "file:///etc/passwd" };
    expect(() => createOpenAiCompatibleProvider(badConfig, { fetchFn: fetchFn as unknown as FetchFn })).toThrow(/http:\/\/ or https:\/\//);
    expect(fetchFn).not.toHaveBeenCalled(); // never even attempts the network call
  });

  it("never sends an Authorization header when apiKeyRef is absent (e.g. a local Ollama with no auth)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: "x" } }] }));
    const provider = createOpenAiCompatibleProvider(baseConfig, { fetchFn: fetchFn as unknown as FetchFn });
    await provider.complete([], { temperature: 0, maxTokens: 10 });
    const [, init] = fetchFn.mock.calls[0];
    expect((init as RequestInit).headers).not.toHaveProperty("Authorization");
  });

  it("resolves apiKeyRef and sends it as a Bearer token when present", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: "x" } }] }));
    const withKey: OpenAiCompatibleProviderConfig = { ...baseConfig, apiKeyRef: "env:MY_KEY" };
    const provider = createOpenAiCompatibleProvider(withKey, {
      fetchFn: fetchFn as unknown as FetchFn,
      keyDeps: { keychainRead: vi.fn(), getEnv: (n) => (n === "MY_KEY" ? "sk-real" : undefined) },
    });
    await provider.complete([], { temperature: 0, maxTokens: 10 });
    const [, init] = fetchFn.mock.calls[0];
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer sk-real" });
  });

  it("throws (never returns a fake result) on a non-2xx response", async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response("server error", { status: 500 }));
    const provider = createOpenAiCompatibleProvider(baseConfig, { fetchFn: fetchFn as unknown as FetchFn });
    await expect(provider.complete([], { temperature: 0, maxTokens: 10 })).rejects.toThrow(/HTTP 500/);
  });

  it("security-review fix — redacts a resolved apiKeyRef value out of an error response body before it reaches the thrown Error", async () => {
    const fetchFn = vi.fn().mockImplementation(async () => new Response('{"error":"rejected Bearer sk-real, bad token"}', { status: 401 }));
    const withKey: OpenAiCompatibleProviderConfig = { ...baseConfig, apiKeyRef: "env:MY_KEY" };
    const provider = createOpenAiCompatibleProvider(withKey, {
      fetchFn: fetchFn as unknown as FetchFn,
      keyDeps: { keychainRead: vi.fn(), getEnv: (n) => (n === "MY_KEY" ? "sk-real" : undefined) },
    });
    try {
      await provider.complete([], { temperature: 0, maxTokens: 10 });
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain("[ai-key redacted]");
      expect((err as Error).message).not.toContain("sk-real");
    }
  });

  it("forwards the caller's AbortSignal straight through to fetch (AC8's fallback/timeout mechanism)", async () => {
    const fetchFn = vi.fn().mockResolvedValue(okResponse({ choices: [{ message: { content: "x" } }] }));
    const provider = createOpenAiCompatibleProvider(baseConfig, { fetchFn: fetchFn as unknown as FetchFn });
    const controller = new AbortController();
    await provider.complete([], { temperature: 0, maxTokens: 10, signal: controller.signal });
    const [, init] = fetchFn.mock.calls[0];
    expect((init as RequestInit).signal).toBe(controller.signal);
  });
});

describe("createAgentCliProvider — spawns a local CLI, reads its JSON stdout", () => {
  const config: AgentCliProviderConfig = { id: "opencode", name: "OpenCode", kind: "agent-cli", command: "opencode", args: ["run", "--json"], enabled: true };

  it("spawns the configured command+args, writes a JSON request to stdin, parses the JSON stdout", async () => {
    const spawnFn: SpawnFn = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ text: "drafted flow" }), stderr: "", code: 0 });
    const provider = createAgentCliProvider(config, { spawnFn });
    const result = await provider.complete([{ role: "user", content: "draft a login flow" }], { temperature: 0, maxTokens: 500 });
    expect(result.text).toBe("drafted flow");
    expect(spawnFn).toHaveBeenCalledWith("opencode", ["run", "--json"], expect.any(String), undefined);
    const input = JSON.parse((spawnFn as any).mock.calls[0][2]);
    expect(input.messages).toEqual([{ role: "user", content: "draft a login flow" }]);
  });

  it("accepts an 'output' field as a fallback to 'text' in the CLI's JSON response", async () => {
    const spawnFn: SpawnFn = vi.fn().mockResolvedValue({ stdout: JSON.stringify({ output: "alt field" }), stderr: "", code: 0 });
    const provider = createAgentCliProvider(config, { spawnFn });
    const result = await provider.complete([], { temperature: 0, maxTokens: 10 });
    expect(result.text).toBe("alt field");
  });

  it("throws when the CLI exits non-zero", async () => {
    const spawnFn: SpawnFn = vi.fn().mockResolvedValue({ stdout: "", stderr: "boom", code: 1 });
    const provider = createAgentCliProvider(config, { spawnFn });
    await expect(provider.complete([], { temperature: 0, maxTokens: 10 })).rejects.toThrow(/exited 1/);
  });

  it("throws when stdout isn't valid JSON, rather than silently returning empty text", async () => {
    const spawnFn: SpawnFn = vi.fn().mockResolvedValue({ stdout: "not json at all", stderr: "", code: 0 });
    const provider = createAgentCliProvider(config, { spawnFn });
    await expect(provider.complete([], { temperature: 0, maxTokens: 10 })).rejects.toThrow(/valid JSON/);
  });
});

describe("createProvider — dispatches purely on kind (AC6: a new openai-compatible row never touches this)", () => {
  it("builds an openai-compatible provider for that kind", () => {
    const provider = createProvider({ id: "a", name: "A", kind: "openai-compatible", baseUrl: "http://x/v1", model: "m", enabled: true });
    expect(provider.id).toBe("a");
  });
  it("builds an agent-cli provider for that kind", () => {
    const provider = createProvider({ id: "b", name: "B", kind: "agent-cli", command: "cli", enabled: true });
    expect(provider.id).toBe("b");
  });
});
