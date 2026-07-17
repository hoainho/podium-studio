import { PrimaryStore } from "../../../bridge/db/primary-store.ts";
import { main, tempDir, cleanupDir } from "./_harness.ts";

/**
 * E24 — provider registry + AI call-log CRUD on the primary store, mirroring E19's own
 * learning-store.fixture.ts pattern (same file, same locked-write/unlocked-read split, same
 * backup/restore coverage — nothing new needed there, so this fixture only exercises the CRUD
 * surface itself, not a separate backup/restore round-trip).
 */

main(async (h) => {
  const dir = tempDir("podium-studio-ai-registry-");
  try {
    const store = new PrimaryStore(`${dir}/ai.sqlite`, `${dir}/ai-backups`);
    store.open();

    // ── empty registry round-trips as empty, not undefined/throwing ──────────────────────────
    h.equal("empty-registry-providers", store.getProviderRegistry().providers, []);
    h.equal("empty-registry-routing", store.getProviderRegistry().routing, { authoring: [], recovery: [] });

    // ── save + reload the whole registry ──────────────────────────────────────────────────────
    await store.saveProviderRegistry({
      providers: [
        { id: "local", name: "Local Ollama", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "qwen2.5", enabled: true },
        { id: "cliproxy", name: "CLIProxy", kind: "openai-compatible", baseUrl: "http://localhost:8317/v1", model: "gemini-2.5-pro", apiKeyRef: "env:CLIPROXY_KEY", enabled: true },
        { id: "opencode", name: "OpenCode", kind: "agent-cli", command: "opencode", args: ["run", "--json"], enabled: false },
      ],
      routing: { authoring: ["local", "opencode"], recovery: ["local", "cliproxy"] },
    });

    const reloaded = store.getProviderRegistry();
    h.equal("registry-provider-count", reloaded.providers.length, 3);
    const local = reloaded.providers.find((p) => p.id === "local");
    h.equal("openai-compatible-fields-roundtrip", { baseUrl: local?.baseUrl, model: local?.model }, { baseUrl: "http://localhost:11434/v1", model: "qwen2.5" });
    const opencode = reloaded.providers.find((p) => p.id === "opencode");
    h.equal("agent-cli-fields-roundtrip", { command: opencode?.command, args: opencode?.args }, { command: "opencode", args: ["run", "--json"] });
    h.equal("disabled-flag-roundtrips", opencode?.enabled, false);
    h.equal("apiKeyRef-roundtrips-as-unresolved-reference", reloaded.providers.find((p) => p.id === "cliproxy")?.apiKeyRef, "env:CLIPROXY_KEY");
    h.equal("routing-roundtrips", reloaded.routing, { authoring: ["local", "opencode"], recovery: ["local", "cliproxy"] });

    // ── saving again REPLACES the whole registry atomically, never merges/appends ────────────
    await store.saveProviderRegistry({
      providers: [{ id: "only-one", name: "Only One", kind: "openai-compatible", baseUrl: "http://x/v1", model: "m", enabled: true }],
      routing: { authoring: ["only-one"], recovery: [] },
    });
    h.equal("save-replaces-not-appends", store.getProviderRegistry().providers.length, 1);

    // ── AI call log: insert, list (newest first), and purge ──────────────────────────────────
    await store.insertAiCallLog({ role: "recovery", providerId: "local", prompt: "p1", response: "r1", latencyMs: 120, tokensUsed: 42, screenFingerprint: "fp-1" });
    await new Promise((r) => setTimeout(r, 2)); // ensure a distinct created_at for ordering
    await store.insertAiCallLog({ role: "authoring", providerId: "opencode", prompt: "p2", response: "r2", latencyMs: 900 });

    const logs = store.listAiCallLog();
    h.equal("call-log-count", logs.length, 2);
    h.equal("call-log-newest-first", logs[0]?.prompt, "p2");
    h.equal("call-log-tokens-roundtrip", logs[1]?.tokensUsed, 42);
    h.equal("call-log-screen-fingerprint-present-for-recovery", logs[1]?.screenFingerprint, "fp-1");
    h.equal("call-log-screen-fingerprint-absent-for-authoring", logs[0]?.screenFingerprint, undefined);

    await store.purgeAiCallLog();
    h.equal("purge-clears-everything", store.listAiCallLog().length, 0);

    store.close();
  } finally {
    cleanupDir(dir);
  }
});
