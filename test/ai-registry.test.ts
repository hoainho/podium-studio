import { describe, it, expect, vi } from "vitest";
import { validateProviderRegistry, validateStartupRegistry, buildProviders, completeWithFallback, resolveRoleChain } from "../bridge/ai-registry.ts";
import { AgentCliRecoveryGuardError, ProviderRegistryError, type AiProvider, type ProviderRegistryConfig } from "../shared/ai-types.ts";

function config(overrides: Partial<ProviderRegistryConfig> = {}): ProviderRegistryConfig {
  return {
    providers: [
      { id: "local", name: "Local", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "qwen2.5", enabled: true },
      { id: "cliproxy", name: "CLIProxy", kind: "openai-compatible", baseUrl: "http://localhost:8317/v1", model: "gemini-2.5-pro", apiKeyRef: "env:CLIPROXY_KEY", enabled: true },
      { id: "opencode", name: "OpenCode", kind: "agent-cli", command: "opencode", args: ["run", "--json"], enabled: true },
    ],
    routing: { authoring: ["local", "opencode"], recovery: ["local", "cliproxy"] },
    ...overrides,
  };
}

describe("validateProviderRegistry — AC5's config-load gate", () => {
  it("accepts a well-formed registry", () => {
    expect(() => validateProviderRegistry(config())).not.toThrow();
  });

  it("AC5 (BLOCKING) — rejects an agent-cli provider referenced under routing.recovery", () => {
    const bad = config({ routing: { authoring: ["local"], recovery: ["opencode"] } });
    expect(() => validateProviderRegistry(bad)).toThrow(ProviderRegistryError);
    expect(() => validateProviderRegistry(bad)).toThrow(/agent-cli.*recovery/i);
  });

  it("the agent-cli/recovery violation is specifically an AgentCliRecoveryGuardError, distinct from every other validation issue", () => {
    const bad = config({ routing: { authoring: ["local"], recovery: ["opencode"] } });
    expect(() => validateProviderRegistry(bad)).toThrow(AgentCliRecoveryGuardError);
  });

  it("the SAME agent-cli provider IS allowed under routing.authoring (authoring-only, per spec)", () => {
    const ok = config({ routing: { authoring: ["opencode"], recovery: ["local"] } });
    expect(() => validateProviderRegistry(ok)).not.toThrow();
  });

  it("rejects a routing entry referencing an unknown provider id", () => {
    const bad = config({ routing: { authoring: ["does-not-exist"], recovery: [] } });
    expect(() => validateProviderRegistry(bad)).toThrow(ProviderRegistryError);
  });

  it("rejects duplicate provider ids", () => {
    const bad = config();
    bad.providers.push({ id: "local", name: "Dup", kind: "openai-compatible", baseUrl: "x", model: "y", enabled: true });
    expect(() => validateProviderRegistry(bad)).toThrow(/duplicate/i);
  });

  it("rejects an openai-compatible row missing baseUrl or model", () => {
    const bad = config();
    (bad.providers[0] as any).model = undefined;
    expect(() => validateProviderRegistry(bad)).toThrow(/baseUrl and model/);
  });

  it("rejects an agent-cli row missing command", () => {
    const bad = config();
    (bad.providers[2] as any).command = undefined;
    expect(() => validateProviderRegistry(bad)).toThrow(/requires a command/);
  });

  it("security-review MINOR fix — rejects an openai-compatible baseUrl without an http(s) scheme", () => {
    const bad = config();
    (bad.providers[0] as any).baseUrl = "file:///etc/passwd";
    expect(() => validateProviderRegistry(bad)).toThrow(/http:\/\/ or https:\/\//);
  });

  it("accepts both http:// and https:// baseUrls", () => {
    const httpConfig = config();
    (httpConfig.providers[0] as any).baseUrl = "http://localhost:11434/v1";
    expect(() => validateProviderRegistry(httpConfig)).not.toThrow();
    const httpsConfig = config();
    (httpsConfig.providers[0] as any).baseUrl = "https://generativelanguage.googleapis.com/v1beta/openai";
    expect(() => validateProviderRegistry(httpsConfig)).not.toThrow();
  });
});

describe("buildProviders — instantiates only ENABLED rows", () => {
  it("builds a provider for every enabled row, keyed by id", () => {
    const providers = buildProviders(config());
    expect([...providers.keys()].sort()).toEqual(["cliproxy", "local", "opencode"]);
  });

  it("skips a disabled row entirely", () => {
    const withDisabled = config();
    withDisabled.providers[1].enabled = false;
    const providers = buildProviders(withDisabled);
    expect(providers.has("cliproxy")).toBe(false);
    expect(providers.has("local")).toBe(true);
  });
});

describe("resolveRoleChain — AC5 defense-in-depth: a SECOND, independent filter beyond validateProviderRegistry", () => {
  it("passes through a well-formed recovery chain unchanged (no agent-cli present)", () => {
    const { chain } = resolveRoleChain(config(), "recovery");
    expect(chain).toEqual(["local", "cliproxy"]);
  });

  it("passes through the authoring chain unchanged, INCLUDING an agent-cli id (no guard on that role)", () => {
    const { chain } = resolveRoleChain(config(), "authoring");
    expect(chain).toEqual(["local", "opencode"]);
  });

  it("AC5 — filters an agent-cli id OUT of a recovery chain even if it somehow bypassed validateProviderRegistry (e.g. a hand-edited DB row)", () => {
    // Deliberately construct an "already invalid" registry — the scenario this defense-in-depth
    // check exists for: something upstream failed to call validateProviderRegistry.
    const bypassed = config({ routing: { authoring: [], recovery: ["local", "opencode"] } });
    const { chain } = resolveRoleChain(bypassed, "recovery");
    expect(chain).toEqual(["local"]); // "opencode" (agent-cli) is silently dropped, never reachable
    expect(chain).not.toContain("opencode");
  });

  it("still builds providers for the FULL registry (both roles can use the same provider map)", () => {
    const { providers } = resolveRoleChain(config(), "recovery");
    expect([...providers.keys()].sort()).toEqual(["cliproxy", "local", "opencode"]);
  });
});

describe("validateStartupRegistry — security-review follow-up: AC5's literal 'process does not start'", () => {
  it("a well-formed registry never calls exit", () => {
    const exit = vi.fn();
    validateStartupRegistry(config(), exit);
    expect(exit).not.toHaveBeenCalled();
  });

  it("the AC5 hot-path-guard violation (agent-cli under recovery) calls exit(1) — the ONE fatal case", () => {
    const bad = config({ routing: { authoring: ["local"], recovery: ["opencode"] } });
    const exit = vi.fn();
    validateStartupRegistry(bad, exit);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("every OTHER validation issue (duplicate id, bad baseUrl, missing field) is logged and tolerated — never fatal", () => {
    const dup = config();
    dup.providers.push({ id: "local", name: "Dup", kind: "openai-compatible", baseUrl: "http://x/v1", model: "y", enabled: true });
    const exitForDup = vi.fn();
    validateStartupRegistry(dup, exitForDup);
    expect(exitForDup).not.toHaveBeenCalled();

    const badUrl = config();
    (badUrl.providers[0] as any).baseUrl = "file:///etc/passwd";
    const exitForBadUrl = vi.fn();
    validateStartupRegistry(badUrl, exitForBadUrl);
    expect(exitForBadUrl).not.toHaveBeenCalled();
  });
});

describe("completeWithFallback — AC8: free-first routing, bounded per-provider timeout, falls through on failure", () => {
  function fakeProvider(id: string, impl: AiProvider["complete"]): AiProvider {
    return { id, complete: impl };
  }

  it("returns the FIRST provider in the chain's result when it succeeds — never even tries the rest", async () => {
    const first = vi.fn().mockResolvedValue({ text: "from first" });
    const second = vi.fn().mockResolvedValue({ text: "from second" });
    const providers = new Map([["a", fakeProvider("a", first)], ["b", fakeProvider("b", second)]]);
    const { result, providerId } = await completeWithFallback(["a", "b"], providers, [], { temperature: 0, maxTokens: 10 });
    expect(result.text).toBe("from first");
    expect(providerId).toBe("a");
    expect(second).not.toHaveBeenCalled();
  });

  it("falls back to the next provider in the chain when the first one throws", async () => {
    const first = vi.fn().mockRejectedValue(new Error("local model down"));
    const second = vi.fn().mockResolvedValue({ text: "from fallback" });
    const providers = new Map([["a", fakeProvider("a", first)], ["b", fakeProvider("b", second)]]);
    const { result, providerId } = await completeWithFallback(["a", "b"], providers, [], { temperature: 0, maxTokens: 10 });
    expect(result.text).toBe("from fallback");
    expect(providerId).toBe("b");
  });

  it("a provider id with no ENABLED provider registered is treated the same as a failure — falls through", async () => {
    const second = vi.fn().mockResolvedValue({ text: "ok" });
    const providers = new Map([["b", fakeProvider("b", second)]]); // "a" was never built (disabled)
    const { providerId } = await completeWithFallback(["a", "b"], providers, [], { temperature: 0, maxTokens: 10 });
    expect(providerId).toBe("b");
  });

  it("throws only when EVERY provider in the chain fails, with the last error's message included", async () => {
    const providers = new Map([
      ["a", fakeProvider("a", vi.fn().mockRejectedValue(new Error("a is down")))],
      ["b", fakeProvider("b", vi.fn().mockRejectedValue(new Error("b is down too")))],
    ]);
    await expect(completeWithFallback(["a", "b"], providers, [], { temperature: 0, maxTokens: 10 })).rejects.toThrow(/b is down too/);
  });

  it("AC8 — a provider that never resolves is aborted within the configured time budget, not left hanging", async () => {
    const hangs = vi.fn(() => new Promise<never>(() => {})); // never resolves/rejects on its own
    const fast = vi.fn().mockResolvedValue({ text: "fast fallback" });
    const providers = new Map([["slow", fakeProvider("slow", hangs)], ["fast", fakeProvider("fast", fast)]]);
    const start = Date.now();
    const { providerId } = await completeWithFallback(["slow", "fast"], providers, [], { temperature: 0, maxTokens: 10 }, 30);
    expect(providerId).toBe("fast");
    expect(Date.now() - start).toBeLessThan(2000); // well within budget, not an unbounded hang
  });
});
