import { useEffect, useState } from "react";
import {
  fromWireProviderConfig,
  isEligibleForRole,
  isValidApiKeyRef,
  maskIfNotARef,
  toWireProviderConfig,
  validateRouting,
  type AiRole,
  type ProviderConfig,
  type ProviderKind,
} from "../ai-provider.ts";
import { getAiRegistry, saveAiRegistry, storeProviderKey, testAiProvider } from "../api.ts";
import { friendlyApiError } from "../friendly.ts";
import { useT } from "../i18n/index.tsx";
import { Icon } from "./icons.tsx";

/** This panel's own UI-side registry shape — `providers` in ai-provider.ts's flat form-friendly
 * shape, converted to/from the wire's discriminated union only at the `getAiRegistry`/
 * `saveAiRegistry` boundary (see ai-provider.ts's own doc comment on why). */
interface UiRegistry {
  providers: ProviderConfig[];
  routing: { authoring: string[]; recovery: string[] };
}

function emptyRegistry(): UiRegistry {
  return { providers: [], routing: { authoring: [], recovery: [] } };
}

function emptyProviderDraft(): Omit<ProviderConfig, "id"> {
  return { name: "", kind: "openai-compatible", enabled: true };
}

/**
 * One-click provider presets so a non-technical QA doesn't have to know base URLs, model ids, or
 * the kind toggle — pick a preset and everything is filled EXCEPT the key, which stays a secure
 * `env:`/`keychain:` reference (the app never stores a raw key — E12). The only remaining step is
 * to set the referenced env var / keychain entry to the real key.
 *
 * `apiKeyRef` uses each vendor's conventional env-var name; `keyEnv` is surfaced in the UI as the
 * exact thing to export. Local (Ollama) and agent-CLI (OpenCode) presets need no key.
 */
interface ProviderTemplate {
  id: string;
  label: string;
  /** The env var (or note) the user must set — shown as the "just do this" step. */
  keyEnv?: string;
  draft: Omit<ProviderConfig, "id">;
}

const PROVIDER_TEMPLATES: ProviderTemplate[] = [
  {
    id: "gemini",
    label: "Gemini",
    keyEnv: "GEMINI_API_KEY",
    draft: {
      name: "Gemini",
      kind: "openai-compatible",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      model: "gemini-flash-latest",
      enabled: true,
    },
  },
  {
    id: "openai",
    label: "OpenAI",
    keyEnv: "OPENAI_API_KEY",
    draft: { name: "OpenAI", kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", enabled: true },
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    keyEnv: "OPENROUTER_API_KEY",
    draft: { name: "OpenRouter", kind: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", model: "openai/gpt-4o-mini", enabled: true },
  },
  {
    id: "groq",
    label: "Groq",
    keyEnv: "GROQ_API_KEY",
    draft: { name: "Groq", kind: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", enabled: true },
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    keyEnv: "DEEPSEEK_API_KEY",
    draft: { name: "DeepSeek", kind: "openai-compatible", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", enabled: true },
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    draft: { name: "Ollama (local)", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "llama3.1", enabled: true },
  },
  {
    id: "opencode",
    label: "OpenCode (CLI)",
    draft: { name: "OpenCode", kind: "agent-cli", command: "opencode", args: ["run"], enabled: true },
  },
  {
    id: "proxy",
    label: "Proxy (9Router/Omni/CLIProxy…)",
    keyEnv: "PROXY_API_KEY",
    // Proxy gateway URLs vary per deployment — prefill the shape + key ref, user pastes their URL.
    draft: { name: "Proxy", kind: "openai-compatible", baseUrl: "", model: "", enabled: true },
  },
];

/**
 * Provider registry + per-role routing config panel (E24 spec). AC5's hot-path guard is enforced
 * TWICE here: the recovery-role picker structurally never offers an agent-cli provider as an
 * option (`isEligibleForRole`), and Save additionally re-checks the whole routing config
 * (`validateRouting`) before ever calling the backend — belt and suspenders, never trusting a
 * single layer alone, same convention as src/heal-approval.ts's own doc comment. The REAL,
 * authoritative enforcement is still server-side (bridge/ai-registry.ts) — this is a fast, clear
 * client-side rejection, not a substitute for it.
 */
export default function ProviderConfigPanel() {
  const t = useT();
  const [registry, setRegistry] = useState<UiRegistry>(emptyRegistry());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Holds the raw thrown error (usually an api.ts `ApiError`), not a pre-formatted string — the
  // JSX below renders it through `friendlyApiError` so a save failure never shows a raw
  // "404 Not Found" (always English, regardless of locale) instead of a localized sentence.
  const [saveError, setSaveError] = useState<unknown>(null);
  const [saveOk, setSaveOk] = useState(false);
  const [draft, setDraft] = useState<Omit<ProviderConfig, "id"> | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // The raw API key the user is currently typing for `draft` (never persisted into the registry
  // state). On save it's written to the Keychain and the provider's apiKeyRef becomes keychain:<id>.
  const [draftKey, setDraftKey] = useState("");
  // providerId → raw key still to be written to the Keychain when the whole registry is saved.
  const [pendingKeys, setPendingKeys] = useState<Record<string, string>>({});
  // Test-connection UX: which provider is currently being tested + its last result per provider.
  const [testingId, setTestingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; text: string }>>({});

  async function runProviderTest(id: string) {
    setTestingId(id);
    setTestResults((m) => {
      const next = { ...m };
      delete next[id];
      return next;
    });
    try {
      const r = await testAiProvider(id);
      setTestResults((m) => ({
        ...m,
        [id]: r.ok
          ? { ok: true, text: t("aiSettings.testOk", { model: r.model ?? "", ms: r.latencyMs ?? 0 }) }
          : { ok: false, text: r.error || t("aiSettings.testFailGeneric") },
      }));
    } catch (err) {
      setTestResults((m) => ({ ...m, [id]: { ok: false, text: friendlyApiError(t, err) } }));
    } finally {
      setTestingId(null);
    }
  }

  useEffect(() => {
    getAiRegistry()
      .then((wire) => setRegistry({ providers: wire.providers.map(fromWireProviderConfig), routing: wire.routing }))
      .catch((err) => setLoadError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, []);

  const routingErrors = validateRouting(registry.providers, registry.routing);

  function startAdd() {
    setEditingId(null);
    setDraft(emptyProviderDraft());
    setDraftKey("");
  }

  function startFromTemplate(tpl: ProviderTemplate) {
    setEditingId(null);
    setDraft({ ...tpl.draft });
    setDraftKey("");
  }

  function startEdit(p: ProviderConfig) {
    setEditingId(p.id);
    setDraft({ ...p });
    setDraftKey("");
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(null);
    setDraftKey("");
  }

  async function saveDraft() {
    if (!draft) return;
    const hasNewKey = draftKey.trim() !== "";
    if (!hasNewKey && draft.apiKeyRef && !isValidApiKeyRef(draft.apiKeyRef)) return; // guarded by disabled button too
    const id = editingId ?? crypto.randomUUID();
    const apiKeyRef = hasNewKey ? `keychain:${id}` : draft.apiKeyRef;
    // Build the new registry explicitly (so we can persist it atomically below when a key was
    // pasted) rather than only via a setRegistry updater.
    let newReg: UiRegistry;
    if (editingId) {
      newReg = { ...registry, providers: registry.providers.map((p) => (p.id === id ? { ...draft, id, apiKeyRef } : p)) };
    } else {
      // Non-tech convenience: a newly added, enabled provider auto-joins the routing chains so
      // co-pilot (authoring) + self-heal rung 4 (recovery) work immediately. Recovery excludes
      // agent-cli (AC5 hot-path guard).
      const authoring =
        draft.enabled && !registry.routing.authoring.includes(id) ? [...registry.routing.authoring, id] : registry.routing.authoring;
      const recovery =
        draft.enabled && draft.kind !== "agent-cli" && !registry.routing.recovery.includes(id)
          ? [...registry.routing.recovery, id]
          : registry.routing.recovery;
      newReg = { providers: [...registry.providers, { ...draft, id, apiKeyRef }], routing: { authoring, recovery } };
    }
    setRegistry(newReg);
    setEditingId(null);
    setDraft(null);
    setDraftKey("");
    // KEY-ADD RELIABILITY FIX: when the user pasted a key, persist RIGHT NOW — write it to the
    // Keychain and save the registry (with the keychain:<id> ref) in one atomic step — instead of
    // waiting for a separate top-level "Save config" click. Previously the key sat only in local
    // state until that second click; if the user hit "Test" (which reads the SERVER registry) first,
    // it failed on the stale env:/no-key value and looked like "I added the key but it won't connect".
    if (hasNewKey) {
      setSaving(true);
      setSaveError(null);
      setSaveOk(false);
      try {
        await storeProviderKey(id, draftKey);
        const saved = await saveAiRegistry({ providers: newReg.providers.map(toWireProviderConfig), routing: newReg.routing });
        setRegistry({ providers: saved.providers.map(fromWireProviderConfig), routing: saved.routing });
        setSaveOk(true);
      } catch (err) {
        setSaveError(err);
      } finally {
        setSaving(false);
      }
    }
  }

  function deleteProvider(id: string) {
    if (!window.confirm(t("aiSettings.deleteConfirm"))) return;
    setRegistry((r) => ({
      providers: r.providers.filter((p) => p.id !== id),
      routing: {
        authoring: r.routing.authoring.filter((pid) => pid !== id),
        recovery: r.routing.recovery.filter((pid) => pid !== id),
      },
    }));
  }

  function addToRouting(role: AiRole, providerId: string) {
    if (!providerId) return;
    setRegistry((r) => ({ ...r, routing: { ...r.routing, [role]: [...r.routing[role], providerId] } }));
  }

  function removeFromRouting(role: AiRole, index: number) {
    setRegistry((r) => ({
      ...r,
      routing: { ...r.routing, [role]: r.routing[role].filter((_, i) => i !== index) },
    }));
  }

  function moveInRouting(role: AiRole, index: number, delta: number) {
    setRegistry((r) => {
      const chain = [...r.routing[role]];
      const target = index + delta;
      if (target < 0 || target >= chain.length) return r;
      [chain[index], chain[target]] = [chain[target], chain[index]];
      return { ...r, routing: { ...r.routing, [role]: chain } };
    });
  }

  async function handleSave() {
    if (routingErrors.length > 0) return; // guarded by disabled button too
    setSaving(true);
    setSaveError(null);
    setSaveOk(false);
    try {
      // Write any pasted keys to the macOS Keychain FIRST, so the keychain:<id> refs the registry
      // is about to persist actually resolve. The raw key only ever leaves this component here, to
      // the local bridge, which writes it straight to the Keychain — it never enters registry JSON.
      for (const [id, key] of Object.entries(pendingKeys)) {
        await storeProviderKey(id, key);
      }
      const saved = await saveAiRegistry({ providers: registry.providers.map(toWireProviderConfig), routing: registry.routing });
      setRegistry({ providers: saved.providers.map(fromWireProviderConfig), routing: saved.routing });
      setPendingKeys({});
      setSaveOk(true);
    } catch (err) {
      setSaveError(err);
    } finally {
      setSaving(false);
    }
  }

  const providerById = new Map(registry.providers.map((p) => [p.id, p]));
  // QA audit P0-6: a provider persisted before the apiKeyRef guard existed can hold a raw key (or
  // other invalid ref) that blocks Save for the WHOLE registry. Surface exactly which rows need
  // fixing, instead of a single opaque server error naming a UUID.
  const invalidKeyProviders = registry.providers.filter((p) => !!p.apiKeyRef && !isValidApiKeyRef(p.apiKeyRef));

  return (
    <div className="provider-config">
      <div className="add-step__group-label">{t("aiSettings.providersTitle")}</div>
      {loading ? (
        <div className="row" style={{ gap: 8 }}>
          <span className="spinner" /> {t("aiSettings.loading")}
        </div>
      ) : (
        <>
          {loadError && (
            <div className="hint-banner" style={{ marginBottom: 8 }}>
              <Icon.info size={14} />
              <span>{t("aiSettings.registryUnavailableHint")}</span>
            </div>
          )}

          {invalidKeyProviders.length > 0 && (
            <div className="error-banner" role="alert" style={{ marginBottom: 8 }}>
              <Icon.alert size={14} />
              <span>{t("aiSettings.providerKeyInvalidWarn", { names: invalidKeyProviders.map((p) => p.name).join(", ") })}</span>
            </div>
          )}

          <div className="device-list" style={{ marginBottom: 10 }}>
            {registry.providers.length === 0 ? (
              <div className="faint" style={{ padding: "6px 8px" }}>{t("aiSettings.noProviders")}</div>
            ) : (
              registry.providers.map((p) => (
                <div key={p.id}>
                  <div className="device-row">
                    <div className="device-row__main">
                      <span className="device-row__name" title={p.name}>{p.name}</span>
                      <span className="device-row__meta" title={`${p.kind}${p.apiKeyRef ? ` — ${maskIfNotARef(p.apiKeyRef)}` : ""}`}>
                        {p.kind} {p.apiKeyRef ? `— ${maskIfNotARef(p.apiKeyRef)}` : ""}
                      </span>
                    </div>
                    {!!p.apiKeyRef && !isValidApiKeyRef(p.apiKeyRef) && (
                      <span className="badge badge--fail" title={t("aiSettings.providerKeyInvalidRowTitle")}>
                        {t("aiSettings.providerKeyInvalidRow")}
                      </span>
                    )}
                    <span className={`badge ${p.enabled ? "badge--ok" : "badge--neutral"}`}>
                      {p.enabled ? t("aiSettings.enabledBadge") : t("aiSettings.disabledBadge")}
                    </span>
                    <button className="btn btn--sm btn--ghost" onClick={() => runProviderTest(p.id)} disabled={testingId === p.id}>
                      {testingId === p.id ? <span className="spinner" /> : <Icon.play size={12} />}
                      {t("aiSettings.testButton")}
                    </button>
                    <button className="btn btn--sm btn--ghost" onClick={() => startEdit(p)}>
                      {t("aiSettings.editButton")}
                    </button>
                    <button className="btn btn--sm btn--danger" onClick={() => deleteProvider(p.id)}>
                      <Icon.trash size={13} />
                    </button>
                  </div>
                  {testResults[p.id] && (
                    <div className={testResults[p.id].ok ? "success-banner" : "error-banner"} role="status" style={{ marginTop: 4 }}>
                      {testResults[p.id].ok ? <Icon.check size={13} /> : <Icon.alert size={13} />}
                      <span>{testResults[p.id].text}</span>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          {draft ? (
            <ProviderDraftForm
              draft={draft}
              onChange={setDraft}
              keyValue={draftKey}
              onKeyChange={setDraftKey}
              onSave={saveDraft}
              onCancel={cancelEdit}
              isEditing={!!editingId}
            />
          ) : (
            <div className="provider-templates">
              <div className="faint provider-templates__hint">{t("aiSettings.templates.hint")}</div>
              <div className="provider-templates__row">
                {PROVIDER_TEMPLATES.map((tpl) => (
                  <button
                    key={tpl.id}
                    className="btn btn--sm"
                    onClick={() => startFromTemplate(tpl)}
                    title={tpl.keyEnv ? t("aiSettings.templates.pickThenPaste") : t("aiSettings.templates.noKeyTitle")}
                  >
                    <Icon.wand size={12} /> {tpl.label}
                  </button>
                ))}
              </div>
              <button className="btn btn--sm btn--ghost" onClick={startAdd}>
                <Icon.plus size={13} /> {t("aiSettings.templates.manualButton")}
              </button>
            </div>
          )}

          <div className="add-step__group-label" style={{ marginTop: 16 }}>{t("aiSettings.routingTitle")}</div>
          {(["authoring", "recovery"] as AiRole[]).map((role) => (
            <RoutingRoleEditor
              key={role}
              role={role}
              chain={registry.routing[role]}
              providerById={providerById}
              eligibleProviders={registry.providers.filter((p) => isEligibleForRole(p, role))}
              onAdd={(id) => addToRouting(role, id)}
              onRemove={(i) => removeFromRouting(role, i)}
              onMove={(i, delta) => moveInRouting(role, i, delta)}
            />
          ))}

          {routingErrors.length > 0 && (
            <div className="error-banner" role="alert" style={{ marginTop: 10 }}>
              <Icon.alert size={14} />
              <div>
                {routingErrors.map((e, i) => (
                  <div key={i}>{e.message}</div>
                ))}
              </div>
            </div>
          )}

          {saveError != null && (
            <div className="error-banner" role="alert" style={{ marginTop: 10 }}>
              <Icon.alert size={14} />
              <div>{friendlyApiError(t, saveError)}</div>
            </div>
          )}

          <div className="row" style={{ marginTop: 14, gap: 8, alignItems: "center" }}>
            <button className="btn btn--primary" onClick={handleSave} disabled={saving || routingErrors.length > 0}>
              {saving ? <span className="spinner" /> : <Icon.save size={13} />}
              {t("aiSettings.saveButton")}
            </button>
            {saveOk && <span className="faint">{t("aiSettings.savedLabel")}</span>}
          </div>
        </>
      )}
    </div>
  );
}

function ProviderDraftForm({
  draft,
  onChange,
  keyValue,
  onKeyChange,
  onSave,
  onCancel,
  isEditing,
}: {
  draft: Omit<ProviderConfig, "id">;
  onChange: (d: Omit<ProviderConfig, "id">) => void;
  keyValue: string;
  onKeyChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
  isEditing: boolean;
}) {
  const t = useT();
  const [showAdvancedRef, setShowAdvancedRef] = useState(false);
  const hasNewKey = keyValue.trim() !== "";
  const keyAlreadyStored = (draft.apiKeyRef ?? "").startsWith("keychain:");
  // The advanced env:/keychain: reference only needs to be valid when the user is actually relying
  // on it (no freshly-pasted key). A pasted key becomes a keychain:<id> ref on save, so it's fine.
  const apiKeyRefInvalid = !hasNewKey && !!draft.apiKeyRef && !isValidApiKeyRef(draft.apiKeyRef);

  return (
    <div className="provider-config__form">
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <div className="field" style={{ flex: "1 1 160px" }}>
          <label className="field__label">{t("aiSettings.field.name")}</label>
          <input className="input" value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} />
        </div>
        <div className="field" style={{ flex: "1 1 160px" }}>
          <label className="field__label">{t("aiSettings.field.kind")}</label>
          <select
            className="select"
            value={draft.kind}
            onChange={(e) => onChange({ ...draft, kind: e.target.value as ProviderKind })}
          >
            <option value="openai-compatible">{t("aiSettings.kind.openaiCompatible")}</option>
            <option value="agent-cli">{t("aiSettings.kind.agentCli")}</option>
          </select>
        </div>
      </div>

      {draft.kind === "openai-compatible" ? (
        <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          <div className="field" style={{ flex: "2 1 220px" }}>
            <label className="field__label">{t("aiSettings.field.baseUrl")}</label>
            <input
              className="input"
              placeholder="http://localhost:11434/v1"
              value={draft.baseUrl ?? ""}
              onChange={(e) => onChange({ ...draft, baseUrl: e.target.value || undefined })}
            />
          </div>
          <div className="field" style={{ flex: "1 1 160px" }}>
            <label className="field__label">{t("aiSettings.field.model")}</label>
            <input className="input" value={draft.model ?? ""} onChange={(e) => onChange({ ...draft, model: e.target.value || undefined })} />
          </div>
        </div>
      ) : (
        <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 8 }}>
          <div className="field" style={{ flex: "1 1 160px" }}>
            <label className="field__label">{t("aiSettings.field.command")}</label>
            <input className="input" placeholder="opencode" value={draft.command ?? ""} onChange={(e) => onChange({ ...draft, command: e.target.value || undefined })} />
          </div>
          <div className="field" style={{ flex: "2 1 220px" }}>
            <label className="field__label">{t("aiSettings.field.args")}</label>
            <input
              className="input"
              placeholder="run, --json"
              value={(draft.args ?? []).join(", ")}
              onChange={(e) => onChange({ ...draft, args: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) })}
            />
          </div>
        </div>
      )}

      {draft.kind === "openai-compatible" && (
        <div className="field" style={{ marginTop: 8 }}>
          <label className="field__label">{t("aiSettings.field.apiKey")}</label>
          <input
            className="input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={keyAlreadyStored ? t("aiSettings.apiKeyStoredPlaceholder") : t("aiSettings.apiKeyPlaceholder")}
            value={keyValue}
            onChange={(e) => onKeyChange(e.target.value)}
          />
          <div className="faint" style={{ fontSize: 11.5, marginTop: 3 }}>{t("aiSettings.apiKeyHint")}</div>
          {keyAlreadyStored && !hasNewKey && (
            <div className="faint" style={{ fontSize: 11.5, marginTop: 3, display: "flex", alignItems: "center", gap: 4 }}>
              <Icon.check size={12} /> {t("aiSettings.apiKeyStored")}
            </div>
          )}
        </div>
      )}

      <div className="field" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          style={{ paddingLeft: 0 }}
          onClick={() => setShowAdvancedRef((v) => !v)}
        >
          {showAdvancedRef ? "▾" : "▸"} {t("aiSettings.advancedRefToggle")}
        </button>
        {showAdvancedRef && (
          <>
            <label className="field__label" style={{ marginTop: 4 }}>{t("aiSettings.field.apiKeyRef")}</label>
            <input
              className="input"
              placeholder="env:GEMINI_API_KEY"
              value={draft.apiKeyRef ?? ""}
              onChange={(e) => onChange({ ...draft, apiKeyRef: e.target.value || undefined })}
            />
            <div className="faint" style={{ fontSize: 11.5, marginTop: 3 }}>{t("aiSettings.apiKeyRefHint")}</div>
            {apiKeyRefInvalid && (
              <div className="error-banner" role="alert" style={{ marginTop: 4 }}>
                <Icon.alert size={12} />
                <span>{t("aiSettings.apiKeyRefInvalid")}</span>
              </div>
            )}
          </>
        )}
      </div>

      <label className="row" style={{ gap: 6, marginTop: 8, alignItems: "center" }}>
        <input type="checkbox" checked={draft.enabled} onChange={(e) => onChange({ ...draft, enabled: e.target.checked })} />
        {t("aiSettings.field.enabled")}
      </label>

      <div className="row" style={{ gap: 8, marginTop: 10 }}>
        <button className="btn btn--sm btn--primary" onClick={onSave} disabled={!draft.name.trim() || apiKeyRefInvalid}>
          {isEditing ? t("aiSettings.updateProviderButton") : t("aiSettings.addProviderButton")}
        </button>
        <button className="btn btn--sm btn--ghost" onClick={onCancel}>
          {t("common.cancelAria")}
        </button>
      </div>
    </div>
  );
}

function RoutingRoleEditor({
  role,
  chain,
  providerById,
  eligibleProviders,
  onAdd,
  onRemove,
  onMove,
}: {
  role: AiRole;
  chain: string[];
  providerById: Map<string, ProviderConfig>;
  eligibleProviders: ProviderConfig[];
  onAdd: (providerId: string) => void;
  onRemove: (index: number) => void;
  onMove: (index: number, delta: number) => void;
}) {
  const t = useT();
  const available = eligibleProviders.filter((p) => !chain.includes(p.id));

  return (
    <div className="routing-role">
      <div className="faint" style={{ fontWeight: 600, marginBottom: 4 }}>
        {role === "authoring" ? t("aiSettings.role.authoring") : t("aiSettings.role.recovery")}
      </div>
      {chain.length === 0 ? (
        <div className="faint" style={{ fontSize: 12, marginBottom: 6 }}>{t("aiSettings.emptyChain")}</div>
      ) : (
        <ol className="routing-role__chain">
          {chain.map((id, i) => (
            <li key={`${id}-${i}`} className="routing-role__item">
              <span>{providerById.get(id)?.name ?? id}</span>
              <button className="btn btn--ghost btn--icon" onClick={() => onMove(i, -1)} disabled={i === 0} aria-label={t("aiSettings.moveUpAria")}>
                <Icon.up size={12} />
              </button>
              <button className="btn btn--ghost btn--icon" onClick={() => onMove(i, 1)} disabled={i === chain.length - 1} aria-label={t("aiSettings.moveDownAria")}>
                <Icon.down size={12} />
              </button>
              <button className="btn btn--ghost btn--icon" onClick={() => onRemove(i)} aria-label={t("aiSettings.removeFromChainAria")}>
                <Icon.x size={12} />
              </button>
            </li>
          ))}
        </ol>
      )}
      {available.length > 0 && (
        <select
          className="select"
          value=""
          onChange={(e) => {
            onAdd(e.target.value);
            e.target.value = "";
          }}
        >
          <option value="" disabled>
            {t("aiSettings.addToChainPlaceholder")}
          </option>
          {available.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
