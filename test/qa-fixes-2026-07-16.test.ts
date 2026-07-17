import { describe, it, expect } from "vitest";
import {
  isPlausibleApiKeyRef,
  looksLikeRawSecret,
  scrubSecrets,
} from "../shared/ai-types.ts";
import { validateProviderRegistry } from "../bridge/ai-registry.ts";
import { writeAiProviderKey, resolveApiKeyRef, keychainService } from "../bridge/ai-key-resolver.ts";
import { isValidApiKeyRef, maskIfNotARef } from "../src/ai-provider.ts";
import { friendlyApiError } from "../src/friendly.ts";
import { ApiError } from "../src/api.ts";

// Regression tests locking the 2026-07-16 QA-audit fixes (docs/QA-AUDIT-2026-07-16.md):
// AI-1/API-7 (raw secret behind env: prefix), API-8 (call-log credential scrub), AI-3 (generic
// error swallowing). Any regression re-opens a confirmed, user-reported defect.

// A stub translator that echoes the key path, so we can assert WHICH friendly branch fired.
const t = (path: string) => path;

describe("AI-1/API-7 — apiKeyRef must be a reference, never a pasted secret", () => {
  it("accepts real env/keychain references", () => {
    expect(isPlausibleApiKeyRef("env:GEMINI_API_KEY")).toBe(true);
    expect(isPlausibleApiKeyRef("env:OPENAI_API_KEY")).toBe(true);
    expect(isPlausibleApiKeyRef("keychain:my-ai-service")).toBe(true);
    expect(isValidApiKeyRef("env:GROQ_API_KEY")).toBe(true);
  });

  it("rejects a raw Google/OpenAI key disguised behind an env: prefix (the AI-1 bug)", () => {
    expect(isPlausibleApiKeyRef("env:AIzaSyFAKE")).toBe(false);
    expect(isPlausibleApiKeyRef("env:sk-ant-abcDEF0123456789abcDEF0123")).toBe(false);
    // generic high-entropy value (mixed case + digits, long) — env var names are never shaped like this
    expect(isPlausibleApiKeyRef("env:aB3xY7kLmN9pQ2rS5tU8vW1z")).toBe(false);
    expect(isValidApiKeyRef("env:AIzaSyFAKE")).toBe(false);
  });

  it("rejects anything without an env:/keychain: prefix", () => {
    expect(isPlausibleApiKeyRef("sk-abc123")).toBe(false);
    expect(isPlausibleApiKeyRef("")).toBe(false);
  });

  it("masks a mistaken raw value in the UI (maskIfNotARef), leaves a real ref visible", () => {
    expect(maskIfNotARef("env:GEMINI_API_KEY")).toBe("env:GEMINI_API_KEY");
    expect(maskIfNotARef("env:AIzaSyFAKE")).not.toContain("AIza");
  });

  it("looksLikeRawSecret flags vendor tokens and high-entropy strings, not plain names", () => {
    expect(looksLikeRawSecret("AIzaSyFAKE")).toBe(true);
    expect(looksLikeRawSecret("GEMINI_API_KEY")).toBe(false);
    expect(looksLikeRawSecret("MY_KEY")).toBe(false);
  });

  it("validateProviderRegistry rejects a provider persisting a raw-key apiKeyRef", () => {
    const cfg = {
      providers: [{ id: "g", name: "Gemini", kind: "openai-compatible" as const, baseUrl: "https://x.test/v1", model: "m", apiKeyRef: "env:AIzaSyFAKE", enabled: true }],
      routing: { authoring: ["g"], recovery: [] },
    };
    expect(() => validateProviderRegistry(cfg)).toThrow(/must be a reference/i);
  });

  it("validateProviderRegistry accepts a provider with a proper env reference", () => {
    const cfg = {
      providers: [{ id: "g", name: "Gemini", kind: "openai-compatible" as const, baseUrl: "https://x.test/v1", model: "m", apiKeyRef: "env:GEMINI_API_KEY", enabled: true }],
      routing: { authoring: ["g"], recovery: [] },
    };
    expect(() => validateProviderRegistry(cfg)).not.toThrow();
  });
});

describe("API-8 — scrubSecrets redacts credentials from call-log text", () => {
  it("redacts a raw key echoed inside an env: ref", () => {
    const out = scrubSecrets('AI provider key "env:AIzaSyFAKE" not found.');
    expect(out).not.toContain("AIzaSy");
    expect(out).toContain("[redacted]");
  });

  it("redacts a bare vendor token and an inline password", () => {
    expect(scrubSecrets("token is ghp_FAKE0000000000000000")).not.toContain("ghp_FAKE");
    expect(scrubSecrets("login with password: Hunter2Secret")).toMatch(/password:\s*\[redacted\]/i);
  });

  it("leaves ordinary prose untouched", () => {
    expect(scrubSecrets("Draft a login test for the settings screen")).toBe("Draft a login test for the settings screen");
  });
});

describe("Non-tech key entry — Keychain write path (the missing in-app key supply)", () => {
  it("writes the key to the namespaced Keychain service and reads it back via a keychain: ref", async () => {
    const store = new Map<string, string>();
    await writeAiProviderKey("prov-123", "my-secret-key", async (_acct, service, value) => {
      store.set(service, value);
    });
    // stored under the module's namespaced service transform
    expect(store.get(keychainService("prov-123"))).toBe("my-secret-key");
    // and the matching keychain:<name> ref resolves back to it
    const resolved = await resolveApiKeyRef("keychain:prov-123", {
      getEnv: () => undefined,
      keychainRead: async (_a, service) => store.get(service),
    });
    expect(resolved).toBe("my-secret-key");
  });
});

describe("AI-3 — friendlyApiError surfaces the server's specific reason", () => {
  it("shows the server message for a 500 that carried one (no longer generic)", () => {
    const err = new ApiError(500, "Co-pilot failed: the API key is misconfigured.", "Co-pilot failed: the API key is misconfigured.");
    expect(friendlyApiError(t, err)).toBe("Co-pilot failed: the API key is misconfigured.");
  });

  it("shows the server message for a 400 validation error", () => {
    const err = new ApiError(400, 'Invalid AI mode "bogus".', 'Invalid AI mode "bogus".');
    expect(friendlyApiError(t, err)).toBe('Invalid AI mode "bogus".');
  });

  it("falls back to the generic sentence only when there was no server-provided reason", () => {
    const err = new ApiError(500, "500 Internal Server Error"); // no serverMessage
    expect(friendlyApiError(t, err)).toBe("friendly.apiError.generic");
  });

  it("still maps connection failure (0) and missing endpoint (404) to their calm sentences", () => {
    expect(friendlyApiError(t, new ApiError(0, "fetch failed"))).toBe("friendly.apiError.network");
    expect(friendlyApiError(t, new ApiError(404, "404", "Route not found"))).toBe("friendly.apiError.notFound");
  });
});
