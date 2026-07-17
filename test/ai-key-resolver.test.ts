import { describe, it, expect, vi } from "vitest";
import {
  resolveApiKeyRef,
  keychainService,
  MissingAiProviderKeyError,
  InvalidApiKeyRefError,
  redactApiKey,
  type AiKeyResolverDeps,
} from "../bridge/ai-key-resolver.ts";

function fakeDeps(overrides: Partial<AiKeyResolverDeps> = {}): AiKeyResolverDeps {
  return {
    keychainRead: vi.fn().mockResolvedValue(undefined),
    getEnv: vi.fn().mockReturnValue(undefined),
    ...overrides,
  };
}

describe("resolveApiKeyRef — E24's AI-provider key seam, architecturally separate from bridge/secrets.ts", () => {
  it("env: ref reads the EXACT env var name given, no PODIUM_SECRET_-style prefixing", async () => {
    const deps = fakeDeps({ getEnv: vi.fn((name) => (name === "CLIPROXY_KEY" ? "sk-real-value" : undefined)) });
    await expect(resolveApiKeyRef("env:CLIPROXY_KEY", deps)).resolves.toBe("sk-real-value");
    expect(deps.getEnv).toHaveBeenCalledWith("CLIPROXY_KEY");
  });

  it("keychain: ref reads via keychainRead using a namespaced service string, distinct from bridge/secrets.ts's own", async () => {
    const deps = fakeDeps({ keychainRead: vi.fn().mockResolvedValue("keychain-value") });
    const value = await resolveApiKeyRef("keychain:gemini", deps);
    expect(value).toBe("keychain-value");
    expect(deps.keychainRead).toHaveBeenCalledWith(expect.any(String), keychainService("gemini"));
    expect(keychainService("gemini")).not.toContain("podium-studio-secret-"); // never collides with E12's namespace
  });

  it("env: takes priority — a keychain entry is never even consulted when the env var is set", async () => {
    const deps = fakeDeps({
      getEnv: vi.fn().mockReturnValue("from-env"),
      keychainRead: vi.fn().mockResolvedValue("from-keychain"),
    });
    // Only env: refs read env; this test just documents env: never falls through to keychain.
    await resolveApiKeyRef("env:SOME_KEY", deps);
    expect(deps.keychainRead).not.toHaveBeenCalled();
  });

  it("throws MissingAiProviderKeyError (never a placeholder) when an env: ref resolves to nothing", async () => {
    const deps = fakeDeps();
    await expect(resolveApiKeyRef("env:MISSING", deps)).rejects.toThrow(MissingAiProviderKeyError);
  });

  it("throws MissingAiProviderKeyError when a keychain: ref resolves to nothing", async () => {
    const deps = fakeDeps();
    await expect(resolveApiKeyRef("keychain:missing", deps)).rejects.toThrow(MissingAiProviderKeyError);
  });

  it("throws InvalidApiKeyRefError for a ref with neither prefix", async () => {
    const deps = fakeDeps();
    await expect(resolveApiKeyRef("just-a-raw-string", deps)).rejects.toThrow(InvalidApiKeyRefError);
  });

  it("MissingAiProviderKeyError's message never contains a resolved value — only the ref name", async () => {
    try {
      await resolveApiKeyRef("env:SOME_SECRET_NAME", fakeDeps());
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain("SOME_SECRET_NAME");
      expect((err as Error).message).not.toMatch(/sk-|Bearer /);
    }
  });
});

describe("redactApiKey", () => {
  it("masks every occurrence of a resolved value out of text", () => {
    expect(redactApiKey("error: Bearer sk-abc123 rejected", "sk-abc123")).toBe("error: Bearer [ai-key redacted] rejected");
  });
  it("is a no-op when no value was resolved (e.g. a keyless local provider)", () => {
    expect(redactApiKey("some text", undefined)).toBe("some text");
  });
});
