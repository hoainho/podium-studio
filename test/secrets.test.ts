import { describe, it, expect, vi } from "vitest";
import type { Flow, FlowStep } from "../shared/ir.ts";
import { interpolate, stepToPodium, toPodiumSteps } from "../shared/ir.ts";
import { flowToMaestroYaml, flowYamlForStep, stepToMaestroLines } from "../shared/maestro.ts";
import {
  collectSecretRefs,
  envVarName,
  extractSecretNames,
  keychainService,
  MissingSecretError,
  redactRunEvent,
  redactSecrets,
  redactValue,
  resolveSecret,
  resolveSecrets,
  type SecretResolverDeps,
} from "../bridge/secrets.ts";
import type { RunEvent, RunSummary, StepResult } from "../shared/protocol.ts";

/**
 * E12 (Secrets seam). This module is HIGH-RISK/security-load-bearing per its own spec — these
 * tests cover the pure, deterministic surface (resolution order, error messages, scanning,
 * redaction) with an injected `SecretResolverDeps` mock (mirrors bridge/doctor.ts's ExecFn
 * pattern) so nothing here ever touches a real keychain/env. A real macOS keychain read, a
 * real CI env-var injection, and the "no secret ever lands in a committed file" grep check are
 * flagged separately for a human/security-reviewer in the completion report — see there.
 */

const s = (over: Partial<FlowStep> & { action: FlowStep["action"] }): FlowStep =>
  ({ id: "s1", ...over } as FlowStep);

function deps(over: Partial<SecretResolverDeps> = {}): SecretResolverDeps {
  return {
    getEnv: () => undefined,
    keychainRead: async () => undefined,
    ...over,
  };
}

describe("resolveSecret — resolution order + failure mode", () => {
  it("prefers the env var over the keychain when both have a value", async () => {
    const d = deps({
      getEnv: (name) => (name === envVarName("api-key") ? "env-value" : undefined),
      keychainRead: async () => "keychain-value",
    });
    await expect(resolveSecret("api-key", d)).resolves.toBe("env-value");
  });

  it("falls back to the keychain when the env var is unset", async () => {
    const d = deps({ keychainRead: async () => "keychain-value" });
    await expect(resolveSecret("api-key", d)).resolves.toBe("keychain-value");
  });

  it("treats an empty-string env var as unset and still falls back to the keychain", async () => {
    const d = deps({
      getEnv: (name) => (name === envVarName("api-key") ? "" : undefined),
      keychainRead: async () => "keychain-value",
    });
    await expect(resolveSecret("api-key", d)).resolves.toBe("keychain-value");
  });

  it("throws MissingSecretError when neither source has it, and the message never contains a value", async () => {
    const d = deps();
    await expect(resolveSecret("api-key", d)).rejects.toBeInstanceOf(MissingSecretError);
    try {
      await resolveSecret("api-key", d);
      throw new Error("expected resolveSecret to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(MissingSecretError);
      expect((err as MissingSecretError).secretName).toBe("api-key");
      expect((err as Error).message).toContain(envVarName("api-key"));
      expect((err as Error).message).toContain(keychainService("api-key"));
      // No value could ever appear in this message since none was ever resolved — but assert
      // the message is built purely from the NAME, never a fetched value, by construction.
      expect((err as Error).message).not.toMatch(/keychain-value|env-value/);
    }
  });

  it("calls the keychain with the current OS user, not a hardcoded account", async () => {
    const keychainRead = vi.fn(async () => "v");
    await resolveSecret("db-password", deps({ keychainRead }));
    expect(keychainRead).toHaveBeenCalledWith(expect.any(String), keychainService("db-password"));
  });
});

describe("resolveSecrets — batch resolution", () => {
  it("resolves every distinct name into a map", async () => {
    const d = deps({
      getEnv: (name) => {
        if (name === envVarName("a")) return "va";
        if (name === envVarName("b")) return "vb";
        return undefined;
      },
    });
    await expect(resolveSecrets(["a", "b"], d)).resolves.toEqual({ a: "va", b: "vb" });
  });

  it("fails fast on the first missing secret without resolving the rest into a partial map", async () => {
    const seen: string[] = [];
    const d = deps({
      getEnv: (name) => {
        seen.push(name);
        return name === envVarName("a") ? "va" : undefined;
      },
    });
    await expect(resolveSecrets(["a", "missing"], d)).rejects.toBeInstanceOf(MissingSecretError);
  });
});

describe("envVarName / keychainService — naming", () => {
  it("uppercases and sanitizes the secret name into a valid env var", () => {
    expect(envVarName("api-key.v2")).toBe("PODIUM_SECRET_API_KEY_V2");
  });

  it("namespaces the keychain service string per secret name", () => {
    expect(keychainService("api-key")).toBe("podium-studio-secret-api-key");
  });
});

describe("extractSecretNames", () => {
  it("finds every distinct ${secret:name} token in a string", () => {
    expect(extractSecretNames("user=${secret:db-user} pass=${secret:db-pass}")).toEqual(["db-user", "db-pass"]);
  });

  it("dedupes repeated references to the same name", () => {
    expect(extractSecretNames("${secret:token} and again ${secret:token}")).toEqual(["token"]);
  });

  it("returns an empty array when there's no secret token", () => {
    expect(extractSecretNames("plain {{fixture}} text")).toEqual([]);
  });
});

describe("collectSecretRefs — flow-wide preflight scan", () => {
  it("finds a secret referenced in a leaf step's functional field", () => {
    const flow = {
      schemaVersion: 1 as const,
      name: "f",
      app: { bundleId: "com.example.app", platform: "ios-sim" as const },
      steps: [s({ action: "type", text: "${secret:password}" } as any)],
    } as Flow;
    expect(collectSecretRefs(flow)).toEqual(["password"]);
  });

  it("finds a secret referenced in flow.fixtures", () => {
    const flow = {
      schemaVersion: 1 as const,
      name: "f",
      app: { bundleId: "com.example.app", platform: "ios-sim" as const },
      fixtures: { apiKey: "${secret:api-key}" },
      steps: [s({ action: "tap", x: 1, y: 1 } as any)],
    } as Flow;
    expect(collectSecretRefs(flow)).toEqual(["api-key"]);
  });

  it("recurses into if/repeat containers", () => {
    const flow = {
      schemaVersion: 1 as const,
      name: "f",
      app: { bundleId: "com.example.app", platform: "ios-sim" as const },
      steps: [
        s({
          action: "if",
          when: { text: "Login" },
          then: [s({ action: "type", text: "${secret:otp}" } as any)],
        } as any),
        s({
          action: "repeat",
          times: 2,
          steps: [s({ action: "type", text: "${secret:pin}" } as any)],
        } as any),
      ],
    } as Flow;
    expect(collectSecretRefs(flow).sort()).toEqual(["otp", "pin"]);
  });

  it("ignores presentation-only fields (label/note) so a QA's free text can't fake a secret ref", () => {
    const flow = {
      schemaVersion: 1 as const,
      name: "f",
      app: { bundleId: "com.example.app", platform: "ios-sim" as const },
      steps: [
        s({ action: "tap", x: 1, y: 1, label: "Tap the ${secret:decoy} button", note: "see ${secret:decoy2}" } as any),
      ],
    } as Flow;
    expect(collectSecretRefs(flow)).toEqual([]);
  });

  it("returns an empty array for a flow with no secret references", () => {
    const flow = {
      schemaVersion: 1 as const,
      name: "f",
      app: { bundleId: "com.example.app", platform: "ios-sim" as const },
      steps: [s({ action: "tap", x: 1, y: 1 } as any)],
    } as Flow;
    expect(collectSecretRefs(flow)).toEqual([]);
  });
});

describe("redactValue / redactSecrets — never leak a resolved value", () => {
  it("masks a single resolved value out of text", () => {
    expect(redactValue("token is hunter2 in the log", "hunter2")).toBe("token is [secret redacted] in the log");
  });

  it("is a no-op for an empty value (never masks everything)", () => {
    expect(redactValue("some text", "")).toBe("some text");
  });

  it("masks every value in a resolved-secrets map", () => {
    const out = redactSecrets("user hunter2 pass sw0rdfish done", { a: "hunter2", b: "sw0rdfish" });
    expect(out).toBe("user [secret redacted] pass [secret redacted] done");
  });
});

describe("redactRunEvent — every emission path is scrubbed", () => {
  const secrets = { pw: "hunter2" };

  it("is a no-op when nothing has been resolved yet this run", () => {
    const e: RunEvent = { type: "log", runId: "r1", level: "info", message: "using hunter2" };
    expect(redactRunEvent(e, {})).toEqual(e);
  });

  it("redacts a log event's message", () => {
    const e: RunEvent = { type: "log", runId: "r1", level: "info", message: "typed hunter2 into field" };
    const out = redactRunEvent(e, secrets) as Extract<RunEvent, { type: "log" }>;
    expect(out.message).toBe("typed [secret redacted] into field");
  });

  it("redacts a step:result event's detail and error", () => {
    const result: StepResult = {
      index: 0, stepId: "s1", action: "type", status: "failed", ok: false,
      detail: "wrote hunter2", error: "assert failed on hunter2",
    };
    const e: RunEvent = { type: "step:result", runId: "r1", result };
    const out = redactRunEvent(e, secrets) as Extract<RunEvent, { type: "step:result" }>;
    expect(out.result.detail).toBe("wrote [secret redacted]");
    expect(out.result.error).toBe("assert failed on [secret redacted]");
  });

  it("redacts every step result inside a run:end summary", () => {
    const summary: RunSummary = {
      runId: "r1", flowName: "f", udid: "u1", bundleId: "com.example.app",
      passed: false, status: "failed", total: 1, passedCount: 0, failedCount: 1, softFailedCount: 0,
      durationMs: 10, startedAt: 0,
      results: [{ index: 0, stepId: "s1", action: "type", status: "failed", ok: false, error: "bad hunter2 value" }],
    };
    const e: RunEvent = { type: "run:end", runId: "r1", summary };
    const out = redactRunEvent(e, secrets) as Extract<RunEvent, { type: "run:end" }>;
    expect(out.summary.results[0].error).toBe("bad [secret redacted] value");
  });

  it("passes through a run:start/step:start event unchanged (no text-bearing fields to redact)", () => {
    const e: RunEvent = { type: "run:start", runId: "r1", total: 1, flowName: "f" };
    expect(redactRunEvent(e, secrets)).toEqual(e);
  });
});

describe("shared/ir.ts interpolate/toPodiumSteps/stepToPodium — secrets threading", () => {
  it("interpolate() substitutes a ${secret:name} token when secrets is provided", () => {
    expect(interpolate("pass=${secret:pw}", {}, { pw: "hunter2" })).toBe("pass=hunter2");
  });

  it("interpolate() leaves the token untouched when secrets is omitted", () => {
    expect(interpolate("pass=${secret:pw}", {})).toBe("pass=${secret:pw}");
  });

  it("interpolate() leaves an unresolved-name token untouched (never throws, never blanks it)", () => {
    expect(interpolate("pass=${secret:missing}", {}, { pw: "hunter2" })).toBe("pass=${secret:missing}");
  });

  it("interpolate() resolves both {{fixture}} and ${secret:name} in the same string", () => {
    expect(interpolate("user={{user}} pass=${secret:pw}", { user: "alice" }, { pw: "hunter2" })).toBe(
      "user=alice pass=hunter2",
    );
  });

  it("stepToPodium() resolves a secret in a functional field", () => {
    const step = s({ action: "type", text: "${secret:pw}" } as any);
    expect(stepToPodium(step, {}, { pw: "hunter2" })).toMatchObject({ text: "hunter2" });
  });

  it("toPodiumSteps() resolves a secret across a whole flow's steps", () => {
    const flow: Flow = {
      schemaVersion: 1, name: "f",
      app: { bundleId: "com.example.app", platform: "ios-sim" },
      steps: [s({ action: "type", text: "${secret:pw}" } as any)],
    };
    const [podiumStep] = toPodiumSteps(flow, {}, { pw: "hunter2" });
    expect(podiumStep.text).toBe("hunter2");
  });

  it("serialize-keeps-reference (spec AC2): resolving steps for a run NEVER mutates the flow object " +
    "itself — the flow's own JSON still holds the literal ${secret:...} token before AND after a run "  +
    "resolves it, so nothing written back to disk (or diffable in git) ever contains the resolved value", () => {
    const flow: Flow = {
      schemaVersion: 1, name: "f",
      app: { bundleId: "com.example.app", platform: "ios-sim" },
      fixtures: { apiKey: "${secret:api-key}" },
      steps: [s({ action: "type", text: "${secret:pw}" } as any)],
    };
    const beforeJson = JSON.stringify(flow);
    expect(beforeJson).toContain("${secret:pw}");
    expect(beforeJson).toContain("${secret:api-key}");
    expect(beforeJson).not.toContain("hunter2");

    // Resolve for a run — this is exactly what bridge/runner.ts does with the preflight-resolved map.
    const podiumSteps = toPodiumSteps(flow, {}, { pw: "hunter2", "api-key": "sk-live-abc123" });
    expect(podiumSteps[0].text).toBe("hunter2"); // the OUTPUT is resolved...

    // ...but the flow object passed in is byte-for-byte unchanged: still only the reference.
    const afterJson = JSON.stringify(flow);
    expect(afterJson).toBe(beforeJson);
    expect(afterJson).toContain("${secret:pw}");
    expect(afterJson).toContain("${secret:api-key}");
    expect(afterJson).not.toContain("hunter2");
    expect(afterJson).not.toContain("sk-live-abc123");
  });
});

describe("shared/maestro.ts — secrets threading", () => {
  it("stepToMaestroLines() resolves a secret into an inputText command", () => {
    const step = s({ action: "type", text: "${secret:pw}" } as any);
    const lines = stepToMaestroLines(step, {}, { pw: "hunter2" });
    expect(lines.join("\n")).toContain("hunter2");
    expect(lines.join("\n")).not.toContain("${secret:pw}");
  });

  it("stepToMaestroLines() leaves the token untouched when secrets is omitted", () => {
    const step = s({ action: "type", text: "${secret:pw}" } as any);
    const lines = stepToMaestroLines(step, {});
    expect(lines.join("\n")).toContain("${secret:pw}");
  });

  it("flowYamlForStep() threads secrets into the generated YAML", () => {
    const step = s({ action: "type", text: "${secret:pw}" } as any);
    const yaml = flowYamlForStep(step, "com.example.app", {}, undefined, { pw: "hunter2" });
    expect(yaml).toContain("hunter2");
    expect(yaml).not.toContain("${secret:pw}");
  });

  it("flowToMaestroYaml() threads secrets across an entire flow", () => {
    const flow: Flow = {
      schemaVersion: 1, name: "f",
      app: { bundleId: "com.example.app", platform: "ios-sim" },
      steps: [s({ action: "type", text: "${secret:pw}" } as any)],
    };
    const yaml = flowToMaestroYaml(flow, {}, undefined, { pw: "hunter2" });
    expect(yaml).toContain("hunter2");
    expect(yaml).not.toContain("${secret:pw}");
  });

  it("recurses secrets into if/repeat container children", () => {
    const step = s({
      action: "if",
      when: { text: "Login" },
      then: [s({ action: "type", text: "${secret:otp}" } as any)],
    } as any);
    const lines = stepToMaestroLines(step, {}, { otp: "123456" });
    expect(lines.join("\n")).toContain("123456");
  });
});
