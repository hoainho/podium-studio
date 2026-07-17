import { describe, it, expect } from "vitest";
import {
  fromWireProviderConfig,
  isAiEnabled,
  isEligibleForRole,
  isValidApiKeyRef,
  maskIfNotARef,
  toWireProviderConfig,
  validateRouting,
  type ProviderConfig,
  type RoutingConfig,
} from "../src/ai-provider.ts";

/**
 * E24-ui — provider registry + Strict/Adaptive mode pure logic. AC5's core rule (agent-cli never
 * eligible for the recovery role) is the one this file cares most about proving thoroughly,
 * since it's the client-side half of a HIGH-risk-flagged epic's hot-path guard.
 */

function provider(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return { id: "p1", name: "Test Provider", kind: "openai-compatible", enabled: true, ...over };
}

describe("isValidApiKeyRef — apiKeyRef must be an env:NAME or keychain:service reference, never a raw key", () => {
  it("accepts a well-formed env: reference", () => {
    expect(isValidApiKeyRef("env:GEMINI_API_KEY")).toBe(true);
  });

  it("accepts a well-formed keychain: reference", () => {
    expect(isValidApiKeyRef("keychain:podium-gemini")).toBe(true);
  });

  it("rejects a bare string that looks like a raw API key", () => {
    expect(isValidApiKeyRef("sk-abcdef1234567890")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidApiKeyRef("")).toBe(false);
  });

  it("rejects the DIFFERENT ${secret:...} namespace (E12's seam) — a distinct, non-interchangeable format", () => {
    expect(isValidApiKeyRef("${secret:geminiApiKey}")).toBe(false);
  });

  it("rejects an unknown/malformed prefix", () => {
    expect(isValidApiKeyRef("vault:oops")).toBe(false);
    expect(isValidApiKeyRef("env:")).toBe(false);
    expect(isValidApiKeyRef("env")).toBe(false);
  });

  it("tolerates surrounding whitespace from a pasted value", () => {
    expect(isValidApiKeyRef("  env:GEMINI_API_KEY  ")).toBe(true);
  });
});

describe("maskIfNotARef — never renders a pasted raw value as plaintext", () => {
  it("leaves a valid env: reference untouched (nothing to hide — it's already just a name)", () => {
    expect(maskIfNotARef("env:GEMINI_API_KEY")).toBe("env:GEMINI_API_KEY");
  });

  it("leaves a valid keychain: reference untouched", () => {
    expect(maskIfNotARef("keychain:podium-gemini")).toBe("keychain:podium-gemini");
  });

  it("masks anything that doesn't look like a reference", () => {
    const masked = maskIfNotARef("sk-abcdef1234567890");
    expect(masked).not.toContain("sk-abcdef");
    expect(masked).toMatch(/^•+$/);
  });

  it("leaves an empty value as empty (nothing pasted yet)", () => {
    expect(maskIfNotARef("")).toBe("");
  });
});

describe("validateRouting — AC5: agent-cli is never eligible for the recovery role", () => {
  it("rejects an agent-cli provider referenced under recovery", () => {
    const providers = [provider({ id: "cli-1", kind: "agent-cli", name: "OpenCode" })];
    const routing: RoutingConfig = { authoring: [], recovery: ["cli-1"] };
    const errors = validateRouting(providers, routing);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ role: "recovery", providerId: "cli-1" });
    expect(errors[0].message).toMatch(/agent-cli/);
  });

  it("allows the SAME agent-cli provider under authoring — the ban is recovery-only", () => {
    const providers = [provider({ id: "cli-1", kind: "agent-cli", name: "OpenCode" })];
    const routing: RoutingConfig = { authoring: ["cli-1"], recovery: [] };
    expect(validateRouting(providers, routing)).toEqual([]);
  });

  it("allows an openai-compatible provider under recovery", () => {
    const providers = [provider({ id: "oa-1", kind: "openai-compatible" })];
    const routing: RoutingConfig = { authoring: [], recovery: ["oa-1"] };
    expect(validateRouting(providers, routing)).toEqual([]);
  });

  it("reports every agent-cli violation when multiple are misconfigured", () => {
    const providers = [
      provider({ id: "cli-1", kind: "agent-cli", name: "OpenCode" }),
      provider({ id: "cli-2", kind: "agent-cli", name: "Aider" }),
    ];
    const routing: RoutingConfig = { authoring: [], recovery: ["cli-1", "cli-2"] };
    expect(validateRouting(providers, routing)).toHaveLength(2);
  });

  it("ignores a routing entry referencing an unknown/deleted provider id (no crash)", () => {
    const routing: RoutingConfig = { authoring: [], recovery: ["does-not-exist"] };
    expect(validateRouting([], routing)).toEqual([]);
  });

  it("an empty routing config is always valid", () => {
    expect(validateRouting([provider()], { authoring: [], recovery: [] })).toEqual([]);
  });
});

describe("isEligibleForRole — the form-level guard mirroring validateRouting", () => {
  it("agent-cli is ineligible for recovery", () => {
    expect(isEligibleForRole(provider({ kind: "agent-cli" }), "recovery")).toBe(false);
  });

  it("agent-cli IS eligible for authoring", () => {
    expect(isEligibleForRole(provider({ kind: "agent-cli" }), "authoring")).toBe(true);
  });

  it("openai-compatible is eligible for both roles", () => {
    const p = provider({ kind: "openai-compatible" });
    expect(isEligibleForRole(p, "authoring")).toBe(true);
    expect(isEligibleForRole(p, "recovery")).toBe(true);
  });
});

describe("isAiEnabled — Strict means AI is OFF, full stop", () => {
  it("strict is always disabled", () => {
    expect(isAiEnabled("strict")).toBe(false);
  });

  it("adaptive is enabled", () => {
    expect(isAiEnabled("adaptive")).toBe(true);
  });
});

describe("toWireProviderConfig / fromWireProviderConfig — lossless round-trip through the wire's discriminated union", () => {
  it("an openai-compatible provider round-trips baseUrl/model, drops any stray agent-cli fields", () => {
    const flat = provider({ kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "gemma", command: "leftover-typed-value" });
    const wire = toWireProviderConfig(flat);
    expect(wire).toMatchObject({ kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "gemma" });
    expect(wire).not.toHaveProperty("command");
    const back = fromWireProviderConfig(wire);
    expect(back.baseUrl).toBe("http://localhost:11434/v1");
    expect(back.model).toBe("gemma");
    expect(back.command).toBeUndefined();
  });

  it("an agent-cli provider round-trips command/args, drops any stray openai-compatible fields", () => {
    const flat = provider({ kind: "agent-cli", command: "opencode", args: ["run", "--json"], baseUrl: "leftover-typed-value" });
    const wire = toWireProviderConfig(flat);
    expect(wire).toMatchObject({ kind: "agent-cli", command: "opencode", args: ["run", "--json"] });
    expect(wire).not.toHaveProperty("baseUrl");
    const back = fromWireProviderConfig(wire);
    expect(back.command).toBe("opencode");
    expect(back.args).toEqual(["run", "--json"]);
    expect(back.baseUrl).toBeUndefined();
  });

  it("preserves id/name/apiKeyRef/enabled through the round-trip for both kinds", () => {
    const flat = provider({ id: "p-42", name: "My Provider", apiKeyRef: "env:X", enabled: false, baseUrl: "http://x", model: "m" });
    const back = fromWireProviderConfig(toWireProviderConfig(flat));
    expect(back).toMatchObject({ id: "p-42", name: "My Provider", apiKeyRef: "env:X", enabled: false });
  });

  it("an agent-cli provider with no args converts cleanly (args stays undefined, not [])", () => {
    const flat = provider({ kind: "agent-cli", command: "opencode" });
    const wire = toWireProviderConfig(flat);
    expect(wire).toMatchObject({ kind: "agent-cli", command: "opencode" });
    const back = fromWireProviderConfig(wire);
    expect(back.args).toBeUndefined();
  });
});
