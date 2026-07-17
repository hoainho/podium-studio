import { describe, it, expect, vi } from "vitest";
import { draftCoPilotSuggestion, parseAndValidateCoPilotHunks, type CoPilotDraftContext } from "../bridge/ai-copilot.ts";
import type { AiProvider } from "../shared/ai-types.ts";
import type { Flow } from "../shared/ir.ts";

function providerReturning(text: string): ReadonlyMap<string, AiProvider> {
  return new Map([["local", { id: "local", complete: vi.fn().mockResolvedValue({ text }) }]]);
}

describe("parseAndValidateCoPilotHunks", () => {
  it("parses a well-formed array of add/change/remove hunks", () => {
    const hunks = parseAndValidateCoPilotHunks(JSON.stringify([
      { kind: "add", description: "Thêm bước đăng nhập", step: { action: "tapText", text: "Log In" } },
      { kind: "change", description: "Sửa lại văn bản", targetStepId: "s1", step: { action: "tapText", text: "New Text" } },
      { kind: "remove", description: "Xóa bước thừa", targetStepId: "s2" },
    ]));
    expect(hunks).toHaveLength(3);
    expect(hunks[0]).toMatchObject({ kind: "add", step: { action: "tapText", text: "Log In" } });
    expect(hunks[1]).toMatchObject({ kind: "change", targetStepId: "s1" });
    expect(hunks[2]).toMatchObject({ kind: "remove", targetStepId: "s2" });
  });

  it("drops a hunk whose step is not a legal IR action, keeping the other valid hunks", () => {
    const hunks = parseAndValidateCoPilotHunks(JSON.stringify([
      { kind: "add", description: "OK hunk", step: { action: "tapText", text: "Log In" } },
      { kind: "add", description: "Bad hunk", step: { action: "deleteEverything" } },
    ]));
    expect(hunks).toHaveLength(1);
    expect(hunks[0].description).toBe("OK hunk");
  });

  it("drops a change/remove hunk missing targetStepId", () => {
    const hunks = parseAndValidateCoPilotHunks(JSON.stringify([
      { kind: "remove", description: "no target" },
    ]));
    expect(hunks).toHaveLength(0);
  });

  it("drops an add/change hunk missing its step object", () => {
    const hunks = parseAndValidateCoPilotHunks(JSON.stringify([
      { kind: "add", description: "no step" },
    ]));
    expect(hunks).toHaveLength(0);
  });

  it("returns [] (never throws) for unparseable text", () => {
    expect(parseAndValidateCoPilotHunks("I cannot help with that")).toEqual([]);
  });

  it("tolerates a model wrapping the JSON array in prose", () => {
    const hunks = parseAndValidateCoPilotHunks('Here:\n```json\n[{"kind":"add","description":"x","step":{"action":"waitMs","ms":500}}]\n```');
    expect(hunks).toHaveLength(1);
  });

  it("returns [] for a bare JSON object (not an array)", () => {
    expect(parseAndValidateCoPilotHunks(JSON.stringify({ kind: "add" }))).toEqual([]);
  });
});

describe("draftCoPilotSuggestion — AC7: always a review diff, never a write", () => {
  it("returns the requestSummary + parsed hunks from the authoring chain's response", async () => {
    const providers = providerReturning(JSON.stringify([
      { kind: "add", description: "Thêm bước", step: { action: "tapText", text: "Log In" } },
    ]));
    const ctx: CoPilotDraftContext = { prompt: "draft a login flow", authoringChain: ["local"], providers };
    const outcome = await draftCoPilotSuggestion(ctx);
    expect(outcome.suggestion.requestSummary).toBe("draft a login flow");
    expect(outcome.suggestion.hunks).toHaveLength(1);
    expect(outcome.error).toBeUndefined();
  });

  it("security-review fix — every successful call produces a logEntry (role authoring, prompt/response/latency populated)", async () => {
    const providers = providerReturning(JSON.stringify([{ kind: "add", description: "x", step: { action: "waitMs", ms: 500 } }]));
    const outcome = await draftCoPilotSuggestion({ prompt: "draft a login flow", authoringChain: ["local"], providers });
    expect(outcome.logEntry).toMatchObject({ role: "authoring", providerId: "local" });
    expect(outcome.logEntry.prompt).toContain("draft a login flow");
    expect(outcome.logEntry.response).toContain("waitMs");
    expect(typeof outcome.logEntry.latencyMs).toBe("number");
  });

  it("builds a prompt that includes the existing flow's steps when suggesting edits (flow present)", async () => {
    const complete = vi.fn().mockResolvedValue({ text: "[]" });
    const providers: ReadonlyMap<string, AiProvider> = new Map([["local", { id: "local", complete }]]);
    const flow: Flow = { schemaVersion: 1, name: "Login Flow", app: { bundleId: "com.example.app", platform: "ios-sim" }, steps: [{ id: "s1", action: "tapText", text: "Log In" } as any] };
    await draftCoPilotSuggestion({ prompt: "suggest an assertion", flow, authoringChain: ["local"], providers });
    const userMessage = complete.mock.calls[0][0].find((m: any) => m.role === "user");
    expect(userMessage.content).toContain("Login Flow");
    expect(userMessage.content).toContain("tapText");
  });

  it("calls with temperature 0", async () => {
    const complete = vi.fn().mockResolvedValue({ text: "[]" });
    const providers: ReadonlyMap<string, AiProvider> = new Map([["local", { id: "local", complete }]]);
    await draftCoPilotSuggestion({ prompt: "x", authoringChain: ["local"], providers });
    expect(complete.mock.calls[0][1]).toMatchObject({ temperature: 0 });
  });

  it("security-review fix — a provider failure never rejects: returns a generic error + empty-hunks suggestion, and is still logged", async () => {
    const providers: ReadonlyMap<string, AiProvider> = new Map([["local", { id: "local", complete: vi.fn().mockRejectedValue(new Error("down, leaked-secret-xyz")) }]]);
    const outcome = await draftCoPilotSuggestion({ prompt: "x", authoringChain: ["local"], providers });
    expect(outcome.suggestion).toEqual({ requestSummary: "x", hunks: [] });
    expect(outcome.error).toBeTruthy();
    // The GENERIC client-facing error must never echo the adapter's raw failure text (which could
    // itself carry a provider's leaked error-body content) — only the local logEntry.response does.
    expect(outcome.error).not.toContain("leaked-secret-xyz");
    expect(outcome.logEntry.response).toContain("down, leaked-secret-xyz");
    expect(outcome.logEntry.providerId).toBe("none");
  });

  it("security-review follow-up — a malformed flow object (missing .app/.steps) never throws an unhandled exception: returns a graceful error outcome instead", async () => {
    const complete = vi.fn(); // must never even be reached — prompt-building fails first
    const providers: ReadonlyMap<string, AiProvider> = new Map([["local", { id: "local", complete }]]);
    const malformedFlow = { name: "Broken" } as unknown as Flow; // no .app, no .steps
    const outcome = await draftCoPilotSuggestion({ prompt: "suggest an edit", flow: malformedFlow, authoringChain: ["local"], providers });
    expect(outcome.suggestion).toEqual({ requestSummary: "suggest an edit", hunks: [] });
    expect(outcome.error).toBeTruthy();
    expect(complete).not.toHaveBeenCalled();
    // Even the failed-to-build-prompt case still gets a real, logged call entry (AC3) — the
    // fallback prompt text is the raw user prompt, never left blank/undefined.
    expect(outcome.logEntry.prompt).toBe("suggest an edit");
  });
});
