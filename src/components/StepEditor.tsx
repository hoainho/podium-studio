import { useEffect, useMemo, useRef, useState } from "react";
import {
  KEY_VALUES,
  containerChildren,
  collectCapturedVariables,
  validateFlow,
  type Flow,
  type FlowParam,
  type FlowStep,
  type StepAction,
} from "../../shared/ir.ts";
import type { LintFinding } from "../../shared/lint.ts";
import { buildBundle, collectSubFlowFiles } from "../../shared/bundle.ts";
import type { ExportResult, FlowListItem } from "../api.ts";
import { inspectScreen, lintFlow as fetchLint, loadFlow } from "../api.ts";
import { downloadBundle, getBaseline } from "../bundle-io.ts";
import { newStep } from "../step-defaults.ts";
import { friendlyValidation, platformLabel } from "../friendly.ts";
import { localizedStepDescription } from "../step-desc.ts";
import { useT } from "../i18n/index.tsx";
import {
  deleteAtPath,
  duplicateAtPath,
  getAtPath,
  insertAtPath,
  moveAtPath,
  setAtPath,
  toggleDisabledAtPath,
  type StepPath,
} from "../step-tree.ts";
import {
  flattenInspectTree,
  getCharterAnswer,
  suggestCoverageNudge,
  suggestOracleFromScreen,
  withCharterAnswer,
  type OracleScreenSuggestion,
} from "../test-design.ts";
import { applyLocatorToStep, SELECTOR_ACTIONS } from "../webview-tree.ts";
import BundleDiffMerge from "./BundleDiffMerge.tsx";
import CoPilotReviewDiff from "./CoPilotReviewDiff.tsx";
import CharterPrompt from "./CharterPrompt.tsx";
import ComponentGallery from "./ComponentGallery.tsx";
import CompletenessMeter, { CompletenessMeterBanner } from "./CompletenessMeter.tsx";
import { Icon } from "./icons.tsx";
import { InfoTip, type InfoTipProps } from "./InfoTip.tsx";
import WebViewInspector from "./WebViewInspector.tsx";

export interface StepEditorProps {
  flow: Flow;
  onChange: (flow: Flow) => void;

  onSave: () => void;
  saving: boolean;
  saveError: string | null;
  justSaved: boolean;
  dirty: boolean;

  onExport: () => void;
  exporting: boolean;
  exportError: string | null;
  exportResult: ExportResult | null;
  onCloseExport: () => void;

  /** Active simulator, for E4 AC5's live selector-ambiguity check (read-only screen inspect). */
  activeUdid?: string | null;
  deviceBooted?: boolean;

  /** True right after "New flow" and before the first save (E14 spec AC3) — gates the
   * charter-first prompt so it appears once, on a genuinely NEW flow, never re-shown on an
   * already-saved/loaded one just because it never had an answer recorded. */
  isNewUnsavedFlow?: boolean;

  /** Every saved flow (E13) — the component gallery filters this to ones declaring `params`
   * (callable as a sub-flow, spec AC3). Omitted entirely (gallery button hidden) when the
   * caller doesn't wire it up. */
  availableSubFlows?: FlowListItem[];

  /** The open flow's saved file name (E21 spec AC1/AC2) — null for a brand-new, never-saved
   * flow. Bundle export/import needs a stable file identity (baseline stash key, bundle
   * `sourceFile`), so the collaboration button is hidden until the flow has been saved once. */
  openFlowFile?: string | null;

  /** Charter-prompt dismissal is owned by the PARENT (App) so "Skip" survives this component's
   * unmount/remount on every tab switch (QA audit P0-2). */
  charterDismissed?: boolean;
  onDismissCharter?: () => void;

  /** Display name of the connected AI provider (e.g. "Gemini", "GPT") — labels the AI draft
   * feature by whatever's connected instead of a fixed "Co-pilot" brand; null → generic "AI". */
  aiProviderName?: string | null;
}

type T = (path: string, vars?: Record<string, string | number>) => string;

/** A rule-based (never AI, non-negotiable #1) expected-value suggestion for the oracle wizard (E4 AC4). */
export interface OracleCandidate {
  value: string;
  source: "typed" | "captured" | "used";
}

/**
 * Scans the whole flow (recursively, through containers) for text an author already
 * committed elsewhere — text typed into a field, a captured variable's `{{name}}`
 * reference, or text already used as a tap/assert target — and offers it back as a
 * pickable "expected value" candidate. Purely deterministic string collection off the
 * flow's own data; no AI call, per the epic's own non-negotiable #1 boundary.
 */
function collectOracleCandidates(steps: FlowStep[]): OracleCandidate[] {
  const seen = new Set<string>();
  const out: OracleCandidate[] = [];
  function add(value: string | undefined, source: OracleCandidate["source"]) {
    if (!value || !value.trim() || seen.has(value)) return;
    seen.add(value);
    out.push({ value, source });
  }
  function walk(list: FlowStep[]) {
    for (const s of list) {
      if (s.captureAs) add(`{{${s.captureAs}}}`, "captured");
      if (s.action === "type") add(s.text, "typed");
      if (
        s.action === "tapText" || s.action === "doubleTap" || s.action === "longPress" ||
        s.action === "assertVisible" || s.action === "assertNotVisible" ||
        s.action === "tapIfVisible" || s.action === "waitFor" || s.action === "waitForNotVisible" ||
        s.action === "scrollUntilVisible" || s.action === "copyText"
      ) {
        add((s as { text?: string }).text, "used");
      }
      if (s.action === "if") add(s.when.text, "used");
      if (s.action === "repeat" && s.whileVisible) add(s.whileVisible, "used");
      const children = containerChildren(s);
      if (children) walk(children);
    }
  }
  walk(steps);
  return out;
}

/** Built from the active locale so every action's display name is translated (E6). */
function actionMeta(t: T): Record<StepAction, { label: string; icon: (p?: { size?: number }) => JSX.Element }> {
  return {
    tap: { label: t("stepEditor.actionLabel.tap"), icon: Icon.target },
    tapText: { label: t("stepEditor.actionLabel.tapText"), icon: Icon.cursor },
    doubleTap: { label: t("stepEditor.actionLabel.doubleTap"), icon: Icon.doubleTap },
    longPress: { label: t("stepEditor.actionLabel.longPress"), icon: Icon.longPress },
    tapIfVisible: { label: t("stepEditor.actionLabel.tapIfVisible"), icon: Icon.tapIfVisible },
    type: { label: t("stepEditor.actionLabel.type"), icon: Icon.keyboard },
    clearText: { label: t("stepEditor.actionLabel.clearText"), icon: Icon.clearText },
    deleteText: { label: t("stepEditor.actionLabel.deleteText"), icon: Icon.deleteText },
    pasteText: { label: t("stepEditor.actionLabel.pasteText"), icon: Icon.paste },
    copyText: { label: t("stepEditor.actionLabel.copyText"), icon: Icon.copy },
    hideKeyboard: { label: t("stepEditor.actionLabel.hideKeyboard"), icon: Icon.hideKeyboard },
    key: { label: t("stepEditor.actionLabel.key"), icon: Icon.key },
    swipe: { label: t("stepEditor.actionLabel.swipe"), icon: Icon.hand },
    scroll: { label: t("stepEditor.actionLabel.scroll"), icon: Icon.scroll },
    scrollUntilVisible: { label: t("stepEditor.actionLabel.scrollUntilVisible"), icon: Icon.scrollTo },
    back: { label: t("stepEditor.actionLabel.back"), icon: Icon.back },
    waitFor: { label: t("stepEditor.actionLabel.waitFor"), icon: Icon.clock },
    waitForNotVisible: { label: t("stepEditor.actionLabel.waitForNotVisible"), icon: Icon.waitGone },
    waitMs: { label: t("stepEditor.actionLabel.waitMs"), icon: Icon.clock },
    assertVisible: { label: t("stepEditor.actionLabel.assertVisible"), icon: Icon.check },
    assertNotVisible: { label: t("stepEditor.actionLabel.assertNotVisible"), icon: Icon.assertNot },
    screenshot: { label: t("stepEditor.actionLabel.screenshot"), icon: Icon.camera },
    openLink: { label: t("stepEditor.actionLabel.openLink"), icon: Icon.link },
    launchApp: { label: t("stepEditor.actionLabel.launchApp"), icon: Icon.rocket },
    stopApp: { label: t("stepEditor.actionLabel.stopApp"), icon: Icon.stop },
    raw: { label: t("stepEditor.actionLabel.raw"), icon: Icon.code },
    if: { label: t("stepEditor.actionLabel.if"), icon: Icon.branch },
    repeat: { label: t("stepEditor.actionLabel.repeat"), icon: Icon.repeatLoop },
    callSubFlow: { label: t("stepEditor.actionLabel.callSubFlow"), icon: Icon.folder },
  };
}

/**
 * Palette grouping for "Add step". The safe, text-based actions a QA reaches for most
 * come first; brittle coordinate taps and the raw escape-hatch live under "Advanced".
 * Control-flow containers (E4) get their own group — this is the visual, zero-DSL path
 * to "Lặp lại…" / "Nếu … hiện…" the epic's AC1 requires.
 */
function actionGroups(t: T): { label: string; actions: StepAction[] }[] {
  return [
    { label: t("stepEditor.groupLabel.tap"), actions: ["tapText", "doubleTap", "longPress", "tapIfVisible"] },
    {
      label: t("stepEditor.groupLabel.typeText"),
      actions: ["type", "clearText", "deleteText", "pasteText", "copyText", "hideKeyboard", "key"],
    },
    { label: t("stepEditor.groupLabel.checkScreen"), actions: ["assertVisible", "assertNotVisible"] },
    { label: t("stepEditor.groupLabel.wait"), actions: ["waitFor", "waitForNotVisible", "waitMs"] },
    { label: t("stepEditor.groupLabel.moveAround"), actions: ["swipe", "scroll", "scrollUntilVisible", "back"] },
    { label: t("stepEditor.groupLabel.appScreenshots"), actions: ["screenshot", "openLink", "launchApp", "stopApp"] },
    { label: t("stepEditor.groupLabel.controlFlow"), actions: ["if", "repeat"] },
    { label: t("stepEditor.groupLabel.reuse"), actions: ["callSubFlow"] },
    { label: t("stepEditor.groupLabel.advanced"), actions: ["tap", "raw"] },
  ];
}

function numberOr<T2>(raw: string, fallback: T2): number | T2 {
  if (raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** Everything a step-card at any nesting depth needs, threaded once from the top instead
 * of re-derived at every recursion level. */
interface EditCtx {
  t: T;
  actionMeta: Record<StepAction, { label: string; icon: (p?: { size?: number }) => JSX.Element }>;
  actionGroups: { label: string; actions: StepAction[] }[];
  capturedVars: string[];
  oracleCandidates: OracleCandidate[];
  lintByStepId: Map<string, LintFinding[]>;
  stepErrorsByTopIndex: Map<number, string[]>;
  mutate: (updater: (steps: FlowStep[]) => FlowStep[]) => void;
  openPaletteKey: string | null;
  setOpenPaletteKey: (key: string | null) => void;
  /** For the E14 oracle-from-screen suggester (spec AC4) — only assertVisible/assertNotVisible
   * fields use these, to fetch a live snapshot on demand. */
  activeUdid?: string | null;
  deviceBooted?: boolean;
  /** The flow's own bundle id (spec AC1's E17 inspector needs it to find the right app's
   * WebView) — threaded through unchanged, not a new prop on StepEditorProps itself. */
  bundleId: string;
}

export default function StepEditor(props: StepEditorProps) {
  const {
    flow,
    onChange,
    onSave,
    saving,
    saveError,
    justSaved,
    dirty,
    onExport,
    exporting,
    exportError,
    exportResult,
    onCloseExport,
    activeUdid,
    deviceBooted,
    isNewUnsavedFlow,
    availableSubFlows,
    openFlowFile,
    charterDismissed,
    onDismissCharter,
    aiProviderName,
  } = props;
  const t = useT();
  // Label the AI draft feature by the connected provider ("Gemini"/"GPT"/…), or a generic "AI".
  const aiName = aiProviderName || t("copilot.genericName");
  const ACTION_META = actionMeta(t);
  const ACTION_GROUPS = actionGroups(t);

  // ── E14: charter-first framing (spec AC3) — shown once per genuinely new, unsaved flow. ──
  // Dismissal state is owned by App (QA audit P0-2) so "Bỏ qua" survives this component being
  // remounted on tab switches; App resets it when a new flow is started, preserving the original
  // "nudge again next time they start a fresh flow" intent.
  const showCharterPrompt = !!isNewUnsavedFlow && !getCharterAnswer(flow) && !charterDismissed;
  const coverageNudge = useMemo(() => suggestCoverageNudge(flow), [flow]);

  // ── E13: component gallery (spec AC3) — browse/insert sub-flows + selector-library entries. ──
  const [galleryOpen, setGalleryOpen] = useState(false);
  const gallerySubFlows = useMemo(
    () => (availableSubFlows ?? []).filter((f) => f.params.length > 0),
    [availableSubFlows],
  );

  // ── E21: flow bundles + visual diff/merge (spec AC1-AC4) — non-Git collaboration. ──
  const [bundleMergeOpen, setBundleMergeOpen] = useState(false);
  const [bundleExporting, setBundleExporting] = useState(false);
  const [bundleExportError, setBundleExportError] = useState<string | null>(null);

  // ── E24: authoring co-pilot review-diff (spec AC7) — draft-a-flow / suggest-assertions. ──
  const [coPilotOpen, setCoPilotOpen] = useState(false);

  async function handleExportBundle() {
    if (!openFlowFile) return;
    setBundleExporting(true);
    setBundleExportError(null);
    try {
      // Transitively resolve every sub-flow the flow (or a sub-flow it calls) references, via
      // the SAME `loadFlow` API every other flow read in this app goes through — no new
      // bridge/ endpoint needed (AC2: "flow + referenced sub-flows/fixtures").
      const subFlows: Record<string, Flow> = {};
      const pending = [...collectSubFlowFiles(flow)];
      while (pending.length > 0) {
        const file = pending.pop()!;
        if (subFlows[file]) continue;
        const sub = await loadFlow(file);
        subFlows[file] = sub;
        for (const nested of collectSubFlowFiles(sub)) if (!subFlows[nested]) pending.push(nested);
      }
      const baseFlow = getBaseline(openFlowFile);
      const bundle = buildBundle(openFlowFile, flow, subFlows, baseFlow);
      downloadBundle(bundle, flow.name.replace(/[^\w.-]+/g, "_") || "flow");
    } catch (err) {
      setBundleExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setBundleExporting(false);
    }
  }

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [openPaletteKey, setOpenPaletteKey] = useState<string | null>(null);
  const advancedRef = useRef<HTMLDivElement>(null);

  const validation = validateFlow(flow);
  const { general: generalErrors, byStep: stepErrorsByTopIndex } = friendlyValidation(t, validation.errors, flow);

  const capturedVars = useMemo(() => collectCapturedVariables(flow.steps), [flow.steps]);
  const oracleCandidates = useMemo(() => collectOracleCandidates(flow.steps), [flow.steps]);

  // ── E4 AC5: selector-ambiguity lint, debounced, live against the active device's CURRENT
  // screen when one is booted (read-only inspect — never taps/types, per shared/lint.ts). ──
  const [lintFindings, setLintFindings] = useState<LintFinding[]>([]);
  const [lintChecking, setLintChecking] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setLintChecking(true);
    const timer = window.setTimeout(() => {
      fetchLint(flow, deviceBooted && activeUdid ? activeUdid : undefined)
        .then((res) => {
          if (!cancelled) setLintFindings(res.lint.findings);
        })
        .catch(() => {
          if (!cancelled) setLintFindings([]);
        })
        .finally(() => {
          if (!cancelled) setLintChecking(false);
        });
    }, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flow, activeUdid, deviceBooted]);

  const lintByStepId = useMemo(() => {
    const m = new Map<string, LintFinding[]>();
    for (const f of lintFindings) {
      if (!f.stepId) continue;
      const list = m.get(f.stepId) ?? [];
      list.push(f);
      m.set(f.stepId, list);
    }
    return m;
  }, [lintFindings]);

  function mutate(updater: (steps: FlowStep[]) => FlowStep[]) {
    onChange({ ...flow, steps: updater(flow.steps) });
  }

  // Close the Advanced menu on Escape or an outside click.
  useEffect(() => {
    if (!advancedOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setAdvancedOpen(false);
    }
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      if (advancedRef.current && !advancedRef.current.contains(target)) setAdvancedOpen(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [advancedOpen]);

  // Close the export modal on Escape.
  useEffect(() => {
    if (!exportResult && !exportError) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCloseExport();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [exportResult, exportError, onCloseExport]);

  const ctx: EditCtx = {
    t, actionMeta: ACTION_META, actionGroups: ACTION_GROUPS,
    capturedVars, oracleCandidates, lintByStepId, stepErrorsByTopIndex,
    mutate, openPaletteKey, setOpenPaletteKey, activeUdid, deviceBooted,
    bundleId: flow.app.bundleId,
  };

  return (
    <div className="editor">
      <div className="editor__header">
        <div className="editor__title-row">
          <input
            className="editor__name-input"
            value={flow.name}
            onChange={(e) => onChange({ ...flow, name: e.target.value })}
            aria-label={t("stepEditor.flowNameAria")}
            placeholder={t("stepEditor.flowNamePlaceholder")}
            title={flow.name}
            style={{ textOverflow: "ellipsis" }}
          />
        </div>

        <div className="editor__meta-row">
          <div className="field" style={{ maxWidth: 320 }}>
            <span className="field__label-row">
              <label className="field__label" htmlFor="flow-bundle-id">
                {t("stepEditor.bundleIdLabel")}
              </label>
              <InfoTip text={t("stepEditor.bundleIdTip")} example="com.example.demoapp" />
            </span>
            <input
              id="flow-bundle-id"
              className="input editor__bundle-input"
              value={flow.app.bundleId}
              onChange={(e) =>
                onChange({ ...flow, app: { ...flow.app, bundleId: e.target.value } })
              }
              placeholder="com.example.demoapp"
              spellCheck={false}
            />
          </div>
          <span className="badge badge--neutral">{platformLabel(t, flow.app.platform)}</span>
          <span className="badge badge--neutral">
            {flow.steps.length} {t("common.stepsUnit")}
          </span>
          {lintChecking ? (
            <span className="faint" style={{ fontSize: 12 }}>{t("stepEditor.lint.checking")}</span>
          ) : lintFindings.length > 0 ? (
            <span className="badge badge--warn">{t("stepEditor.lint.title")}: {lintFindings.length}</span>
          ) : null}
          <CompletenessMeter flow={flow} />

          <div className="editor__actions">
            {availableSubFlows && (
              <button className="btn btn--ghost btn--sm" onClick={() => setGalleryOpen(true)}>
                <Icon.folder size={13} />
                {t("gallery.openButton")}
              </button>
            )}
            {openFlowFile && (
              <button
                className="btn btn--ghost btn--sm"
                onClick={handleExportBundle}
                disabled={bundleExporting}
                title={bundleExportError ?? undefined}
              >
                {bundleExporting ? <span className="spinner" /> : <Icon.export size={13} />}
                {t("bundle.exportButton")}
              </button>
            )}
            <button className="btn btn--ghost btn--sm" onClick={() => setBundleMergeOpen(true)}>
              <Icon.branch size={13} />
              {t("bundle.importButton")}
            </button>
            <button className="btn btn--ghost btn--sm" onClick={() => setCoPilotOpen(true)}>
              <Icon.wand size={13} />
              {t("copilot.openButton", { provider: aiName })}
            </button>
            <div className="editor__advanced" ref={advancedRef}>
              <button
                className="btn"
                onClick={() => setAdvancedOpen((v) => !v)}
                aria-expanded={advancedOpen}
                aria-haspopup="menu"
              >
                {t("stepEditor.groupLabel.advanced")}
                <Icon.down size={12} />
              </button>
              {advancedOpen && (
                <div className="editor__advanced-menu" role="menu">
                  <button
                    className="editor__advanced-item"
                    role="menuitem"
                    onClick={() => {
                      setAdvancedOpen(false);
                      onExport();
                    }}
                    disabled={!validation.ok || exporting}
                    title={!validation.ok ? t("stepEditor.exportDisabledTitle") : undefined}
                  >
                    {exporting ? <span className="spinner" /> : <Icon.export size={13} />}
                    <span>
                      <span className="editor__advanced-item-title">{t("stepEditor.exportMenuTitle")}</span>
                      <span className="editor__advanced-item-desc">{t("stepEditor.exportMenuDesc")}</span>
                    </span>
                  </button>
                </div>
              )}
            </div>
            <button
              className="btn btn--primary"
              onClick={onSave}
              disabled={!validation.ok || saving}
              title={!validation.ok ? t("stepEditor.saveDisabledTitle") : undefined}
            >
              {saving ? (
                <span className="spinner" />
              ) : dirty && !justSaved ? (
                <span className="save-dot" aria-hidden="true" />
              ) : (
                <Icon.save size={13} />
              )}
              {justSaved
                ? t("stepEditor.saveButtonSaved")
                : dirty
                  ? t("stepEditor.saveButtonSaveChanges")
                  : t("stepEditor.saveButtonSave")}
            </button>
          </div>
        </div>

        <FlowParamsSection flow={flow} onChange={onChange} />

        {bundleExportError && (
          <div className="error-banner" role="alert">
            <Icon.alert size={14} />
            <div>{bundleExportError}</div>
          </div>
        )}

        {!deviceBooted && (
          <div className="hint-banner">
            <Icon.info size={14} />
            <span>{t("stepEditor.lint.noDevice")}</span>
          </div>
        )}

        <CompletenessMeterBanner flow={flow} />

        {coverageNudge && (
          <div className="hint-banner">
            <Icon.wand size={14} />
            <div>
              <div>{t(`testDesign.nudge.${coverageNudge.key}.question`)}</div>
              <div className="faint" style={{ marginTop: 2 }}>{t(`testDesign.nudge.${coverageNudge.key}.example`)}</div>
            </div>
          </div>
        )}

        {generalErrors.length > 0 && (
          <div className="error-banner" role="alert">
            <Icon.alert size={14} />
            <div>
              {generalErrors.map((e, i) => (
                <div key={i}>{e}</div>
              ))}
            </div>
          </div>
        )}
        {saveError && (
          <div className="error-banner" role="alert">
            <Icon.alert size={14} />
            <span>{saveError}</span>
          </div>
        )}
      </div>

      {showCharterPrompt && (
        <CharterPrompt
          onSave={(answer) => {
            onChange(withCharterAnswer(flow, answer));
            onDismissCharter?.();
          }}
          onSkip={() => onDismissCharter?.()}
        />
      )}

      {galleryOpen && (
        <ComponentGallery
          subFlows={gallerySubFlows}
          onInsertSubFlow={(step) => mutate((steps) => [...steps, step])}
          onClose={() => setGalleryOpen(false)}
        />
      )}

      {bundleMergeOpen && (
        <BundleDiffMerge
          currentFlow={flow}
          currentFlowFile={openFlowFile ?? null}
          dirty={dirty}
          onMerged={(merged) => onChange(merged)}
          onClose={() => setBundleMergeOpen(false)}
        />
      )}

      {coPilotOpen && (
        <CoPilotReviewDiff
          flow={flow}
          providerName={aiName}
          onApply={(merged) => onChange(merged)}
          onClose={() => setCoPilotOpen(false)}
        />
      )}

      <StepListView steps={flow.steps} path={[]} ctx={ctx} />

      {(exportResult || exportError) && (
        <div className="modal-backdrop" onClick={onCloseExport}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal__header">
              <Icon.export size={16} />
              <span className="modal__title">{t("stepEditor.exportModalTitle")}</span>
              <button
                className="btn btn--ghost btn--icon"
                style={{ marginLeft: "auto" }}
                onClick={onCloseExport}
                aria-label={t("common.closeAria")}
              >
                <Icon.x size={14} />
              </button>
            </div>
            <div className="modal__body">
              {exportError && (
                <div className="error-banner" role="alert">
                  <Icon.alert size={14} />
                  <span>{exportError}</span>
                </div>
              )}
              {exportResult && (
                <>
                  {exportResult.warnings.length > 0 && (
                    <ul className="warnings-list">
                      {exportResult.warnings.map((w, i) => (
                        <li key={i}>
                          <Icon.alert size={13} />
                          <span>{w}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="yaml-block" style={{ marginTop: exportResult.warnings.length ? 10 : 0 }}>
                    {exportResult.yaml}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** One list of sibling steps — the flow's own top level (`path = []`), or one container's
 * children — rendered recursively. Every container's body is just another `StepListView`. */
function StepListView({ steps, path, ctx }: { steps: FlowStep[]; path: StepPath; ctx: EditCtx }) {
  return (
    <>
      <div className={path.length ? "steps steps--nested" : "steps"}>
        {steps.map((step, index) => (
          <StepNode key={step.id} step={step} index={index} total={steps.length} path={[...path, index]} ctx={ctx} />
        ))}
      </div>
      <AddStepRow parentPath={path} ctx={ctx} />
    </>
  );
}

/** One step card — a leaf action, or a control-flow container (which nests its own StepListView). */
function StepNode({ step, index, total, path, ctx }: { step: FlowStep; index: number; total: number; path: StepPath; ctx: EditCtx }) {
  const { t, actionMeta: ACTION_META, capturedVars, oracleCandidates, lintByStepId, stepErrorsByTopIndex, mutate, activeUdid, deviceBooted, bundleId } = ctx;
  const meta = ACTION_META[step.action];
  // E17 spec AC1: "click-to-select an element -> fills a step's locator" — only offered on a
  // selector-bearing action, and only when there's an actual booted device + bundle id to
  // attach a WebView inspection to (same "needs a live device" gating screenSuggestEnabled
  // already uses for the E14 oracle-from-screen suggester, just extended with bundleId since
  // finding the right app's WebView needs it). No target-profile awareness here — the button
  // shows up whenever a device is booted, even for a purely-native flow; if the app has no
  // attached WebView the fetch just errors clearly, same fail-visibly approach used everywhere
  // else in this codebase, rather than the client trying to guess it up front.
  const [webviewInspectorOpen, setWebviewInspectorOpen] = useState(false);
  const canInspectWebView = SELECTOR_ACTIONS.has(step.action) && !!activeUdid && !!deviceBooted && !!bundleId;
  // Field-level Zod errors are only mapped by TOP-LEVEL index today (a pre-existing
  // friendly.ts limitation, not new to E4) — a nested step's own errors still surface as
  // a general error on its top-level ancestor's card rather than the exact nested field.
  const errors = path.length === 1 ? (stepErrorsByTopIndex.get(path[0]) ?? []) : [];
  const findings = lintByStepId.get(step.id) ?? [];
  const children = containerChildren(step);

  function updateThis(next: FlowStep) {
    mutate((steps) => setAtPath(steps, path, next));
  }

  function deleteThis() {
    if (total <= 1) return;
    const label = localizedStepDescription(t, step);
    if (!window.confirm(`${t("stepEditor.deleteConfirm", { n: index + 1 })}\n\n${label}`)) return;
    mutate((steps) => deleteAtPath(steps, path));
  }

  return (
    <div className={`step-card${step.disabled ? " step-card--disabled" : ""}`}>
      <div className="step-card__index">{index + 1}</div>
      <div className="step-card__icon">{meta.icon({ size: 15 })}</div>
      <div className="step-card__body">
        <div className="step-card__top">
          <span className="badge badge--accent">{meta.label}</span>
          <span className="step-card__desc">{localizedStepDescription(t, step)}</span>
        </div>

        <div className="step-card__fields">
          <StepFields
            step={step}
            onChange={updateThis}
            capturedVars={capturedVars}
            oracleCandidates={oracleCandidates}
            activeUdid={activeUdid}
            deviceBooted={deviceBooted}
          />
        </div>

        {canInspectWebView && (
          <button
            type="button"
            className="btn btn--sm btn--ghost"
            style={{ marginTop: 6 }}
            onClick={() => setWebviewInspectorOpen(true)}
          >
            <Icon.code size={13} />
            {t("webviewInspector.openButton")}
          </button>
        )}
        {webviewInspectorOpen && activeUdid && (
          <WebViewInspector
            udid={activeUdid}
            bundleId={bundleId}
            onPick={(locator) => updateThis(applyLocatorToStep(step, locator))}
            onClose={() => setWebviewInspectorOpen(false)}
          />
        )}

        {findings.map((finding, i) => (
          <LintFindingBanner
            key={i}
            finding={finding}
            t={t}
            onPickCandidate={(candidateIndex) => {
              // Resolve the CURRENT step from the live steps array `mutate` hands in (not a
              // stale closure over `step`), then set `index` to disambiguate — the same field
              // `tapText`/`assertVisible`/etc. already use, so no new IR concept is needed.
              mutate((steps) => {
                const target = getAtPath(steps, path);
                if (!target || !("index" in target)) return steps;
                return setAtPath(steps, path, { ...target, index: candidateIndex } as FlowStep);
              });
            }}
          />
        ))}

        <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
          <div className="field" style={{ flex: "1 1 200px" }}>
            <label className="field__label" htmlFor={`label-${step.id}`}>
              {t("stepEditor.customLabelField")}
            </label>
            <input
              id={`label-${step.id}`}
              className="input"
              value={step.label ?? ""}
              onChange={(e) => updateThis({ ...step, label: e.target.value || undefined })}
              placeholder={localizedStepDescription(t, { ...step, label: undefined })}
            />
          </div>
          <div className="field" style={{ flex: "1 1 200px" }}>
            <label className="field__label" htmlFor={`note-${step.id}`}>
              {t("stepEditor.qaNoteField")}
            </label>
            <input
              id={`note-${step.id}`}
              className="input step-card__note-input"
              value={step.note ?? ""}
              onChange={(e) => updateThis({ ...step, note: e.target.value || undefined })}
              placeholder={t("stepEditor.qaNotePlaceholder")}
            />
          </div>
        </div>

        {errors.length > 0 && (
          <div className="step-card__errors">
            {errors.map((e, i) => (
              <div key={i}>{e}</div>
            ))}
          </div>
        )}

        {children && (
          <div className="container-body" style={{ marginTop: 10, paddingLeft: 12, borderLeft: "2px solid var(--border)" }}>
            <div className="field__label" style={{ marginBottom: 6 }}>
              {step.action === "if" ? t("stepEditor.container.thenLabel") : t("stepEditor.container.stepsLabel")}
            </div>
            <StepListView steps={children} path={path} ctx={ctx} />
          </div>
        )}
      </div>

      <div className="step-card__controls">
        <button
          className="btn btn--ghost btn--icon"
          onClick={() => mutate((steps) => moveAtPath(steps, path, -1))}
          disabled={index === 0}
          aria-label={t("stepEditor.moveUpAria")}
          title={t("stepEditor.moveUpTitle")}
        >
          <Icon.up size={14} />
        </button>
        <button
          className="btn btn--ghost btn--icon"
          onClick={() => mutate((steps) => moveAtPath(steps, path, 1))}
          disabled={index === total - 1}
          aria-label={t("stepEditor.moveDownAria")}
          title={t("stepEditor.moveDownTitle")}
        >
          <Icon.down size={14} />
        </button>
        <button
          className="btn btn--ghost btn--icon"
          onClick={() => mutate((steps) => duplicateAtPath(steps, path, () => crypto.randomUUID()))}
          aria-label={t("stepEditor.duplicateAria")}
          title={t("stepEditor.duplicateTitle")}
        >
          <Icon.copy size={13} />
        </button>
        <button
          className="btn btn--ghost btn--icon"
          onClick={() => mutate((steps) => toggleDisabledAtPath(steps, path))}
          aria-label={step.disabled ? t("stepEditor.enableAria") : t("stepEditor.disableAria")}
          title={step.disabled ? t("stepEditor.enableTitle") : t("stepEditor.disableTitle")}
        >
          {step.disabled ? <Icon.eyeOff size={14} /> : <Icon.eye size={14} />}
        </button>
        <button
          className="btn btn--icon btn--danger"
          onClick={deleteThis}
          disabled={total <= 1}
          aria-label={t("stepEditor.deleteAria")}
          title={total <= 1 ? t("stepEditor.deleteMinStepsTitle") : t("stepEditor.deleteTitle")}
        >
          <Icon.trash size={13} />
        </button>
      </div>
    </div>
  );
}

/** Inline "Add step" trigger + palette, scoped to one list (root, or one container's children). */
function AddStepRow({ parentPath, ctx }: { parentPath: StepPath; ctx: EditCtx }) {
  const { t, actionMeta: ACTION_META, actionGroups: ACTION_GROUPS, mutate, openPaletteKey, setOpenPaletteKey } = ctx;
  const key = parentPath.join(".");
  const isOpen = openPaletteKey === key;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpenPaletteKey(null);
    }
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpenPaletteKey(null);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [isOpen]);

  function add(action: StepAction) {
    mutate((steps) => insertAtPath(steps, parentPath, newStep(action)));
    setOpenPaletteKey(null);
  }

  return (
    <div className="add-step" ref={ref}>
      {isOpen && (
        <div className="add-step__palette" role="menu">
          {ACTION_GROUPS.map((group) => (
            <div key={group.label} className="add-step__group">
              <div className="add-step__group-label">{group.label}</div>
              <div className="add-step__group-options">
                {group.actions.map((action) => {
                  const meta = ACTION_META[action];
                  return (
                    <button key={action} className="add-step__option" onClick={() => add(action)} role="menuitem">
                      {meta.icon({ size: 14 })}
                      {meta.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
      <button
        className="add-step__trigger"
        onClick={() => setOpenPaletteKey(isOpen ? null : key)}
        aria-expanded={isOpen}
      >
        <Icon.plus size={13} /> {parentPath.length ? t("stepEditor.container.addStepHere") : t("stepEditor.addStepButton")}
      </button>
    </div>
  );
}

/** Localizes one lint finding by `finding.class` (+ `matchCount` for ambiguous-match) instead of
 * rendering shared/lint.ts's own `message`, which is always Vietnamese (task #47 — EN mode was
 * leaking raw Vietnamese lint text). Drops the embedded selector label the raw message carries
 * (not its own field on LintFinding) — a deliberate simplification, not a bug. */
export function localizedLintMessage(t: T, finding: LintFinding): string {
  if (finding.class === "ambiguous-match") {
    return t("stepEditor.lint.classMessage.ambiguous-match", { n: finding.matchCount ?? 0 });
  }
  return t(`stepEditor.lint.classMessage.${finding.class}`);
}

/** Inline banner for one lint finding (E4 AC5: "khớp N phần tử" + a candidate picker, no DSL fallback). */
function LintFindingBanner({
  finding,
  t,
  onPickCandidate,
}: {
  finding: LintFinding;
  t: T;
  onPickCandidate: (candidateIndex: number) => void;
}) {
  const isAmbiguous = finding.class === "ambiguous-match" && !!finding.matchCount;
  return (
    <div className="error-banner" role="alert" style={{ marginTop: 6 }}>
      <Icon.alert size={14} />
      <div>
        <div>{localizedLintMessage(t, finding)}</div>
        {isAmbiguous && (
          <div className="row" style={{ gap: 4, marginTop: 6, flexWrap: "wrap", alignItems: "center" }}>
            <span className="badge badge--warn">{t("stepEditor.lint.matchCount", { n: finding.matchCount! })}</span>
            <span className="faint" style={{ fontSize: 12 }}>{t("stepEditor.lint.confidenceExact")}</span>
            {Array.from({ length: finding.matchCount! }, (_, i) => (
              <button
                key={i}
                type="button"
                className="btn btn--sm btn--ghost"
                onClick={() => onPickCandidate(i)}
                title={t("stepEditor.lint.pickCandidate", { n: i })}
              >
                {t("stepEditor.lint.pickCandidate", { n: i })}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** Renders the inline, per-action editable fields — the switch narrows `step` per case. */
function StepFields({
  step,
  onChange,
  capturedVars,
  oracleCandidates,
  activeUdid,
  deviceBooted,
}: {
  step: FlowStep;
  onChange: (step: FlowStep) => void;
  capturedVars: string[];
  oracleCandidates: OracleCandidate[];
  /** E14 oracle-from-screen suggester (spec AC4) — only used by assertVisible/assertNotVisible below. */
  activeUdid?: string | null;
  deviceBooted?: boolean;
}) {
  const t = useT();

  // Reusable plain-language explainers for the jargon fields a QA meets in the editor.
  const ACCESSIBILITY_ID_TIP: InfoTipProps = { text: t("stepEditor.tip.accessibilityId"), example: "login_button" };
  const INDEX_TIP: InfoTipProps = { text: t("stepEditor.tip.index"), example: "0 = the first match" };
  const COORD_TIP: InfoTipProps = { text: t("stepEditor.tip.coord"), example: "X 120, Y 340" };
  const TIMEOUT_TIP: InfoTipProps = { text: t("stepEditor.tip.timeout"), example: "10 = wait up to 10 seconds" };
  const RAW_TIP: InfoTipProps = { text: t("stepEditor.tip.raw"), example: '- tapOn: "Login"' };

  switch (step.action) {
    case "tap":
      return (
        <>
          <NumberField
            label={t("stepEditor.field.x")}
            value={step.x}
            onChange={(x) => onChange({ ...step, x: x ?? 0 })}
            tip={COORD_TIP}
          />
          <NumberField
            label={t("stepEditor.field.y")}
            value={step.y}
            onChange={(y) => onChange({ ...step, y: y ?? 0 })}
            tip={COORD_TIP}
          />
        </>
      );

    case "tapText":
      return (
        <>
          <TextField
            label={t("stepEditor.field.elementText")}
            value={step.text ?? ""}
            onChange={(text) => onChange({ ...step, text: text || undefined })}
            placeholder={t("stepEditor.ph.egLogin")}
            capturedVars={capturedVars}
          />
          <TextField
            label={t("stepEditor.field.accessibilityId")}
            value={step.targetId ?? ""}
            onChange={(targetId) => onChange({ ...step, targetId: targetId || undefined })}
            placeholder={t("stepEditor.ph.optional")}
            tip={ACCESSIBILITY_ID_TIP}
          />
          <NumberField
            label={t("stepEditor.field.index")}
            value={step.index}
            onChange={(index) => onChange({ ...step, index })}
            optional
            tip={INDEX_TIP}
          />
        </>
      );

    case "type":
      return (
        <>
          <TextField
            label={t("stepEditor.field.textToType")}
            value={step.text}
            onChange={(text) => onChange({ ...step, text })}
            placeholder={t("stepEditor.ph.egEmail")}
            grow
            capturedVars={capturedVars}
          />
          <CheckboxField
            label={t("stepEditor.field.pressEnterAfter")}
            checked={!!step.submit}
            onChange={(submit) => onChange({ ...step, submit })}
          />
        </>
      );

    case "key":
      return (
        <div className="field">
          <label className="field__label">{t("stepEditor.field.key")}</label>
          <select
            className="select"
            value={step.key}
            onChange={(e) => onChange({ ...step, key: e.target.value as (typeof KEY_VALUES)[number] })}
          >
            {KEY_VALUES.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </div>
      );

    case "swipe":
      return (
        <>
          <div className="field">
            <label className="field__label">{t("stepEditor.field.direction")}</label>
            <select
              className="select"
              value={step.direction ?? ""}
              onChange={(e) =>
                onChange({
                  ...step,
                  direction: (e.target.value || undefined) as typeof step.direction,
                })
              }
            >
              <option value="">{t("stepEditor.option.customCoordinates")}</option>
              <option value="up">{t("stepEditor.option.up")}</option>
              <option value="down">{t("stepEditor.option.down")}</option>
              <option value="left">{t("stepEditor.option.left")}</option>
              <option value="right">{t("stepEditor.option.right")}</option>
            </select>
          </div>
          {step.direction === undefined && (
            <>
              <NumberField label={t("stepEditor.field.startX")} value={step.startX} onChange={(v) => onChange({ ...step, startX: v })} optional />
              <NumberField label={t("stepEditor.field.startY")} value={step.startY} onChange={(v) => onChange({ ...step, startY: v })} optional />
              <NumberField label={t("stepEditor.field.endX")} value={step.endX} onChange={(v) => onChange({ ...step, endX: v })} optional />
              <NumberField label={t("stepEditor.field.endY")} value={step.endY} onChange={(v) => onChange({ ...step, endY: v })} optional />
            </>
          )}
        </>
      );

    case "waitFor":
      return (
        <>
          <TextField
            label={t("stepEditor.field.waitForText")}
            value={step.text}
            onChange={(text) => onChange({ ...step, text })}
            placeholder={t("stepEditor.ph.egWelcome")}
            grow
            capturedVars={capturedVars}
            oracleCandidates={oracleCandidates}
          />
          <SecondsField
            label={t("stepEditor.field.timeoutSeconds")}
            ms={step.timeoutMs}
            onChange={(timeoutMs) => onChange({ ...step, timeoutMs })}
            optional
            tip={TIMEOUT_TIP}
          />
        </>
      );

    case "waitMs":
      return (
        <SecondsField
          label={t("stepEditor.field.waitSeconds")}
          ms={step.ms}
          onChange={(ms) => onChange({ ...step, ms: ms ?? 0 })}
        />
      );

    case "screenshot":
      return <span className="faint">{t("stepEditor.field.noFieldsScreenshot")}</span>;

    case "assertVisible":
      return (
        <>
          <TextField
            label={t("stepEditor.field.assertVisibleText")}
            value={step.text}
            onChange={(text) => onChange({ ...step, text })}
            placeholder={t("stepEditor.ph.egWelcome")}
            grow
            capturedVars={capturedVars}
            oracleCandidates={oracleCandidates}
            screenSuggestEnabled
            activeUdid={activeUdid}
            deviceBooted={deviceBooted}
          />
          <SecondsField
            label={t("stepEditor.field.timeoutSeconds")}
            ms={step.timeoutMs}
            onChange={(timeoutMs) => onChange({ ...step, timeoutMs })}
            optional
            tip={TIMEOUT_TIP}
          />
        </>
      );

    case "doubleTap":
    case "longPress":
      return (
        <>
          <TextField
            label={t("stepEditor.field.elementText")}
            value={step.text ?? ""}
            onChange={(text) => onChange({ ...step, text: text || undefined })}
            placeholder={t("stepEditor.ph.egLogin")}
            capturedVars={capturedVars}
          />
          <TextField
            label={t("stepEditor.field.accessibilityId")}
            value={step.targetId ?? ""}
            onChange={(targetId) => onChange({ ...step, targetId: targetId || undefined })}
            placeholder={t("stepEditor.ph.optional")}
            tip={ACCESSIBILITY_ID_TIP}
          />
          <NumberField
            label={t("stepEditor.field.x")}
            value={step.x}
            onChange={(x) => onChange({ ...step, x })}
            optional
            tip={COORD_TIP}
          />
          <NumberField
            label={t("stepEditor.field.y")}
            value={step.y}
            onChange={(y) => onChange({ ...step, y })}
            optional
            tip={COORD_TIP}
          />
          <NumberField
            label={t("stepEditor.field.index")}
            value={step.index}
            onChange={(index) => onChange({ ...step, index })}
            optional
            tip={INDEX_TIP}
          />
        </>
      );

    case "tapIfVisible":
      return (
        <>
          <TextField
            label={t("stepEditor.field.tapIfVisibleText")}
            value={step.text}
            onChange={(text) => onChange({ ...step, text })}
            placeholder={t("stepEditor.ph.egAllow")}
            grow
            capturedVars={capturedVars}
            oracleCandidates={oracleCandidates}
          />
          <SecondsField
            label={t("stepEditor.field.timeoutSeconds")}
            ms={step.timeoutMs}
            onChange={(timeoutMs) => onChange({ ...step, timeoutMs })}
            optional
            tip={TIMEOUT_TIP}
          />
        </>
      );

    case "clearText":
      return <span className="faint">{t("stepEditor.field.noFieldsClearText")}</span>;

    case "deleteText":
      return (
        <NumberField
          label={t("stepEditor.field.charsToDelete")}
          value={step.count}
          onChange={(count) => onChange({ ...step, count: count ?? 1 })}
        />
      );

    case "hideKeyboard":
      return <span className="faint">{t("stepEditor.field.noFieldsHideKeyboard")}</span>;

    case "scroll":
      return (
        <div className="field">
          <label className="field__label">{t("stepEditor.field.direction")}</label>
          <select
            className="select"
            value={step.direction ?? "down"}
            onChange={(e) =>
              onChange({ ...step, direction: e.target.value as typeof step.direction })
            }
          >
            <option value="up">{t("stepEditor.option.up")}</option>
            <option value="down">{t("stepEditor.option.down")}</option>
            <option value="left">{t("stepEditor.option.left")}</option>
            <option value="right">{t("stepEditor.option.right")}</option>
          </select>
        </div>
      );

    case "scrollUntilVisible":
      return (
        <TextField
          label={t("stepEditor.field.scrollUntilVisibleText")}
          value={step.text}
          onChange={(text) => onChange({ ...step, text })}
          placeholder={t("stepEditor.ph.egTerms")}
          grow
          capturedVars={capturedVars}
          oracleCandidates={oracleCandidates}
        />
      );

    case "back":
      return <span className="faint">{t("stepEditor.field.noFieldsBack")}</span>;

    case "assertNotVisible":
      return (
        <>
          <TextField
            label={t("stepEditor.field.assertNotVisibleText")}
            value={step.text}
            onChange={(text) => onChange({ ...step, text })}
            placeholder={t("stepEditor.ph.egError")}
            grow
            capturedVars={capturedVars}
            oracleCandidates={oracleCandidates}
            screenSuggestEnabled
            activeUdid={activeUdid}
            deviceBooted={deviceBooted}
          />
          <SecondsField
            label={t("stepEditor.field.timeoutSeconds")}
            ms={step.timeoutMs}
            onChange={(timeoutMs) => onChange({ ...step, timeoutMs })}
            optional
            tip={TIMEOUT_TIP}
          />
        </>
      );

    case "waitForNotVisible":
      return (
        <>
          <TextField
            label={t("stepEditor.field.waitUntilGoneText")}
            value={step.text}
            onChange={(text) => onChange({ ...step, text })}
            placeholder={t("stepEditor.ph.egLoading")}
            grow
            capturedVars={capturedVars}
            oracleCandidates={oracleCandidates}
          />
          <SecondsField
            label={t("stepEditor.field.timeoutSeconds")}
            ms={step.timeoutMs}
            onChange={(timeoutMs) => onChange({ ...step, timeoutMs })}
            optional
            tip={TIMEOUT_TIP}
          />
        </>
      );

    case "openLink":
      return (
        <TextField
          label={t("stepEditor.field.urlDeepLink")}
          value={step.url}
          onChange={(url) => onChange({ ...step, url })}
          placeholder={t("stepEditor.ph.egUrl")}
          grow
        />
      );

    case "launchApp":
    case "stopApp":
      return (
        <TextField
          label={t("stepEditor.field.bundleId")}
          value={step.bundleId ?? ""}
          onChange={(bundleId) => onChange({ ...step, bundleId: bundleId || undefined })}
          placeholder={t("stepEditor.ph.defaultsToApp")}
          grow
          tip={{ text: t("stepEditor.tip.launchStopBundleId"), example: "com.example.demoapp" }}
        />
      );

    case "copyText":
      return (
        <TextField
          label={t("stepEditor.field.copyTextFrom")}
          value={step.text}
          onChange={(text) => onChange({ ...step, text })}
          placeholder={t("stepEditor.ph.egReferral")}
          grow
          capturedVars={capturedVars}
        />
      );

    case "pasteText":
      return <span className="faint">{t("stepEditor.field.noFieldsPaste")}</span>;

    case "raw":
      return (
        <TextAreaField
          label={t("stepEditor.field.rawMaestro")}
          value={step.maestro}
          onChange={(maestro) => onChange({ ...step, maestro })}
          placeholder='- tapOn: "..."'
          tip={RAW_TIP}
        />
      );

    // ── Control-flow containers (E4) — only their OWN condition/count fields; their
    // nested children are rendered by StepNode's `container-body` zone, not here. ──
    case "if":
      return (
        <>
          <TextField
            label={t("stepEditor.container.ifConditionLabel")}
            value={step.when.text}
            onChange={(text) => onChange({ ...step, when: { ...step.when, text } })}
            placeholder={t("stepEditor.ph.egWelcome")}
            grow
            capturedVars={capturedVars}
            oracleCandidates={oracleCandidates}
          />
          <div className="field">
            <label className="field__label">&nbsp;</label>
            <select
              className="select"
              value={step.when.visible === false ? "not" : "visible"}
              onChange={(e) => onChange({ ...step, when: { ...step.when, visible: e.target.value !== "not" } })}
            >
              <option value="visible">{t("stepEditor.container.ifVisibleOption")}</option>
              <option value="not">{t("stepEditor.container.ifNotVisibleOption")}</option>
            </select>
          </div>
        </>
      );

    case "repeat": {
      const mode: "times" | "while" = step.whileVisible !== undefined ? "while" : "times";
      return (
        <>
          <div className="field">
            <label className="field__label">{t("stepEditor.container.repeatModeLabel")}</label>
            <select
              className="select"
              value={mode}
              onChange={(e) => {
                if (e.target.value === "while") {
                  onChange({ id: step.id, action: "repeat", label: step.label, note: step.note, disabled: step.disabled, whileVisible: "", maxIterations: 20, steps: step.steps });
                } else {
                  onChange({ id: step.id, action: "repeat", label: step.label, note: step.note, disabled: step.disabled, times: 1, steps: step.steps });
                }
              }}
            >
              <option value="times">{t("stepEditor.container.repeatModeTimes")}</option>
              <option value="while">{t("stepEditor.container.repeatModeWhile")}</option>
            </select>
          </div>
          {mode === "times" ? (
            <NumberField
              label={t("stepEditor.container.repeatTimesField")}
              value={step.times}
              onChange={(times) => onChange({ ...step, times: times ?? 1 })}
            />
          ) : (
            <>
              <TextField
                label={t("stepEditor.container.repeatWhileField")}
                value={step.whileVisible ?? ""}
                onChange={(whileVisible) => onChange({ ...step, whileVisible })}
                placeholder={t("stepEditor.ph.egWelcome")}
                grow
                capturedVars={capturedVars}
                oracleCandidates={oracleCandidates}
              />
              <NumberField
                label={t("stepEditor.container.repeatMaxIterationsField")}
                value={step.maxIterations}
                onChange={(maxIterations) => onChange({ ...step, maxIterations: maxIterations ?? 20 })}
                optional
              />
            </>
          )}
        </>
      );
    }

    case "callSubFlow": {
      const params = step.params ?? {};
      const paramNames = Object.keys(params);
      return (
        <>
          <TextField
            label={t("stepEditor.subflow.flowFileLabel")}
            value={step.flowFile}
            onChange={(flowFile) => onChange({ ...step, flowFile })}
            placeholder={t("stepEditor.subflow.flowFilePlaceholder")}
            grow
          />
          <div className="field" style={{ flexBasis: "100%" }}>
            <label className="field__label">{t("stepEditor.subflow.paramsLabel")}</label>
            <div className="stack" style={{ gap: 6 }}>
              {paramNames.length === 0 && (
                <span className="faint" style={{ fontSize: 12 }}>{t("stepEditor.subflow.noParams")}</span>
              )}
              {paramNames.map((name) => (
                <div className="row" key={name} style={{ gap: 6, alignItems: "flex-end" }}>
                  <TextField
                    label={name}
                    value={params[name]}
                    onChange={(value) => onChange({ ...step, params: { ...params, [name]: value } })}
                    grow
                    capturedVars={capturedVars}
                  />
                  <button
                    type="button"
                    className="btn btn--sm btn--ghost btn--icon"
                    onClick={() => {
                      const next = { ...params };
                      delete next[name];
                      onChange({ ...step, params: next });
                    }}
                    aria-label={t("stepEditor.subflow.removeParamAria", { name })}
                    title={t("stepEditor.subflow.removeParamAria", { name })}
                  >
                    <Icon.x size={12} />
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="btn btn--sm btn--ghost"
                onClick={() => {
                  const name = window.prompt(t("stepEditor.subflow.newParamPrompt"));
                  if (!name || !name.trim() || name in params) return;
                  onChange({ ...step, params: { ...params, [name.trim()]: "" } });
                }}
              >
                <Icon.plus size={12} />
                {t("stepEditor.subflow.addParamButton")}
              </button>
            </div>
          </div>
        </>
      );
    }
  }
}

/**
 * AUTH-3 authoring-side UI: declare THIS flow's own call-parameter signature (`flow.params`,
 * shared/ir.ts's `FlowParam`) so it shows up as a callable sub-flow in another flow's Reuse
 * Library / component gallery. Mirrors the callSubFlow step's own param editor (add/remove,
 * `window.prompt` for a new name) — just shaped like `{name, required, default}` instead of the
 * step's own `{name: value}` call-site map.
 */
function FlowParamsSection({ flow, onChange }: { flow: Flow; onChange: (flow: Flow) => void }) {
  const t = useT();
  const params = flow.params ?? [];

  function updateParam(index: number, patch: Partial<FlowParam>) {
    onChange({ ...flow, params: params.map((p, i) => (i === index ? { ...p, ...patch } : p)) });
  }

  function removeParam(index: number) {
    const next = params.filter((_, i) => i !== index);
    onChange({ ...flow, params: next.length > 0 ? next : undefined });
  }

  function addParam() {
    const name = window.prompt(t("stepEditor.flowParams.newParamPrompt"))?.trim();
    if (!name || params.some((p) => p.name === name)) return;
    onChange({ ...flow, params: [...params, { name }] });
  }

  return (
    <div className="field" style={{ marginTop: 4 }}>
      <span className="field__label-row">
        <label className="field__label">{t("stepEditor.flowParams.title")}</label>
        <InfoTip text={t("stepEditor.flowParams.tip")} example="username, env" />
      </span>
      <div className="stack" style={{ gap: 6 }}>
        {params.length === 0 && (
          <span className="faint" style={{ fontSize: 12 }}>{t("stepEditor.flowParams.empty")}</span>
        )}
        {params.map((p, i) => (
          <div className="row" key={i} style={{ gap: 6, alignItems: "flex-end", flexWrap: "wrap" }}>
            <TextField
              label={t("stepEditor.flowParams.nameField")}
              value={p.name}
              onChange={(name) => updateParam(i, { name })}
            />
            <CheckboxField
              label={t("stepEditor.flowParams.requiredField")}
              checked={!!p.required}
              onChange={(required) => updateParam(i, { required: required || undefined })}
            />
            <TextField
              label={t("stepEditor.flowParams.defaultField")}
              value={p.default ?? ""}
              onChange={(value) => updateParam(i, { default: value || undefined })}
            />
            <button
              type="button"
              className="btn btn--sm btn--ghost btn--icon"
              onClick={() => removeParam(i)}
              aria-label={t("stepEditor.flowParams.removeParamAria", { name: p.name })}
              title={t("stepEditor.flowParams.removeParamAria", { name: p.name })}
            >
              <Icon.x size={12} />
            </button>
          </div>
        ))}
        <button type="button" className="btn btn--sm btn--ghost" onClick={addParam}>
          <Icon.plus size={12} />
          {t("stepEditor.flowParams.addParamButton")}
        </button>
      </div>
    </div>
  );
}

/** A field label with an optional "(i)" explainer next to it. */
function FieldLabel({ label, tip }: { label: string; tip?: InfoTipProps }) {
  if (!tip) return <label className="field__label">{label}</label>;
  return (
    <span className="field__label-row">
      <label className="field__label">{label}</label>
      <InfoTip {...tip} />
    </span>
  );
}

/** Renders `{{var}}` references as visual chips instead of raw mustache syntax (E4 AC3). */
function ChipText({ text }: { text: string }) {
  const parts = text.split(/(\{\{\s*[\w.]+\s*\}\})/g);
  return (
    <>
      {parts.map((part, i) => {
        const m = /^\{\{\s*([\w.]+)\s*\}\}$/.exec(part);
        if (m) return <span key={i} className="badge badge--accent" style={{ margin: "0 2px" }}>{m[1]}</span>;
        return part ? <span key={i}>{part}</span> : null;
      })}
    </>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  grow,
  tip,
  capturedVars,
  oracleCandidates,
  screenSuggestEnabled,
  activeUdid,
  deviceBooted,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  grow?: boolean;
  tip?: InfoTipProps;
  /** Captured-variable names offered as clickable "insert {{var}}" chips (E4 AC3). */
  capturedVars?: string[];
  /** Rule-based expected-value candidates for the oracle wizard (E4 AC4). Omit for non-assertion fields. */
  oracleCandidates?: OracleCandidate[];
  /** E14 spec AC4: also offer a "suggest from the current screen" fetch inside the same popover
   * — only set on assertVisible/assertNotVisible fields, where a live, verified suggestion
   * actually makes sense. */
  screenSuggestEnabled?: boolean;
  activeUdid?: string | null;
  deviceBooted?: boolean;
}) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [oracleOpen, setOracleOpen] = useState(false);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [screenSuggestions, setScreenSuggestions] = useState<OracleScreenSuggestion[] | null>(null);
  const [screenSuggestLoading, setScreenSuggestLoading] = useState(false);
  const [screenSuggestError, setScreenSuggestError] = useState<string | null>(null);

  function fetchScreenSuggestions() {
    if (!activeUdid) return;
    setScreenSuggestLoading(true);
    setScreenSuggestError(null);
    inspectScreen(activeUdid)
      .then((raw) => {
        const elements = flattenInspectTree(raw);
        setScreenSuggestions(suggestOracleFromScreen(elements));
      })
      .catch((err) => {
        setScreenSuggestError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setScreenSuggestLoading(false));
  }

  useEffect(() => {
    if (!oracleOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOracleOpen(false);
    }
    function onDown(e: MouseEvent) {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) setOracleOpen(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [oracleOpen]);

  function insertAtCursor(token: string) {
    const el = inputRef.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + token + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el?.focus();
      const pos = start + token.length;
      el?.setSelectionRange(pos, pos);
    });
  }

  const hasChipPreview = /\{\{\s*[\w.]+\s*\}\}/.test(value);

  return (
    <div className="field" style={grow ? { flex: "2 1 260px" } : undefined}>
      <FieldLabel label={label} tip={tip} />
      <div className="row" style={{ gap: 6 }}>
        <input
          ref={inputRef}
          className="input"
          style={{ flex: 1 }}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
        />
        {((oracleCandidates && oracleCandidates.length > 0) || screenSuggestEnabled) && (
          <div style={{ position: "relative" }} ref={popoverRef}>
            <button
              type="button"
              className="btn btn--sm btn--ghost"
              onClick={() => setOracleOpen((v) => !v)}
              title={t("stepEditor.oracle.pickButton")}
              aria-label={t("stepEditor.oracle.pickButton")}
              aria-expanded={oracleOpen}
            >
              <Icon.wand size={13} />
            </button>
            {oracleOpen && (
              <div
                className="add-step__palette"
                role="menu"
                style={{ position: "absolute", right: 0, top: "100%", zIndex: 20, minWidth: 220 }}
              >
                <div className="add-step__group-label">{t("stepEditor.oracle.title")}</div>
                {!oracleCandidates || oracleCandidates.length === 0 ? (
                  <div className="faint" style={{ padding: "6px 8px" }}>{t("stepEditor.oracle.empty")}</div>
                ) : (
                  oracleCandidates.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      className="add-step__option"
                      role="menuitem"
                      onClick={() => {
                        onChange(c.value);
                        setOracleOpen(false);
                      }}
                    >
                      <span className="mono" style={{ flex: 1, textAlign: "left" }}>{c.value}</span>
                      <span className="faint" style={{ fontSize: 11 }}>
                        {c.source === "typed"
                          ? t("stepEditor.oracle.sourceTyped")
                          : c.source === "captured"
                            ? t("stepEditor.oracle.sourceCaptured")
                            : t("stepEditor.oracle.sourceUsed")}
                      </span>
                    </button>
                  ))
                )}

                {screenSuggestEnabled && (
                  <>
                    <div className="add-step__group-label" style={{ marginTop: 6 }}>
                      {t("testDesign.oracle.fromScreenTitle")}
                    </div>
                    {!deviceBooted ? (
                      <div className="faint" style={{ padding: "6px 8px" }}>{t("testDesign.oracle.needDevice")}</div>
                    ) : screenSuggestions === null ? (
                      <button
                        type="button"
                        className="add-step__option"
                        onClick={fetchScreenSuggestions}
                        disabled={screenSuggestLoading}
                      >
                        {screenSuggestLoading ? <span className="spinner" /> : <Icon.wand size={13} />}
                        <span style={{ textAlign: "left" }}>{t("testDesign.oracle.fromScreenButton")}</span>
                      </button>
                    ) : screenSuggestError ? (
                      <div className="faint" style={{ padding: "6px 8px" }}>{screenSuggestError}</div>
                    ) : screenSuggestions.length === 0 ? (
                      <div className="faint" style={{ padding: "6px 8px" }}>{t("testDesign.oracle.fromScreenEmpty")}</div>
                    ) : (
                      screenSuggestions.map((s) => (
                        <button
                          key={s.value}
                          type="button"
                          className="add-step__option"
                          role="menuitem"
                          onClick={() => {
                            onChange(s.value);
                            setOracleOpen(false);
                          }}
                          title={s.hint}
                        >
                          <span className="mono" style={{ flex: 1, textAlign: "left" }}>{s.value}</span>
                          <span className="faint" style={{ fontSize: 11 }}>{t("testDesign.oracle.fromScreenBadge")}</span>
                        </button>
                      ))
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      {capturedVars && capturedVars.length > 0 && (
        <div className="row" role="group" aria-label={t("stepEditor.chip.insertLabel")} style={{ gap: 4, marginTop: 4, flexWrap: "wrap" }}>
          {capturedVars.map((name) => (
            <button
              key={name}
              type="button"
              className="badge badge--neutral"
              style={{ cursor: "pointer", border: "none" }}
              onClick={() => insertAtCursor(`{{${name}}}`)}
              title={t("stepEditor.chip.insertLabel")}
            >
              <Icon.variable size={11} /> {name}
            </button>
          ))}
        </div>
      )}
      {hasChipPreview && (
        <div className="faint" style={{ marginTop: 4, fontSize: 12 }}>
          <ChipText text={value} />
        </div>
      )}
    </div>
  );
}

function TextAreaField({
  label,
  value,
  onChange,
  placeholder,
  tip,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  tip?: InfoTipProps;
}) {
  return (
    <div className="field" style={{ flex: "1 1 100%" }}>
      <FieldLabel label={label} tip={tip} />
      <textarea
        className="textarea"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={3}
        spellCheck={false}
      />
    </div>
  );
}

function NumberField({
  label,
  value,
  onChange,
  optional,
  tip,
}: {
  label: string;
  value: number | undefined;
  onChange: (v: number | undefined) => void;
  optional?: boolean;
  tip?: InfoTipProps;
}) {
  const t = useT();
  return (
    <div className="field">
      <FieldLabel label={label} tip={tip} />
      <input
        className="input mono"
        type="number"
        value={value ?? ""}
        onChange={(e) => onChange(numberOr(e.target.value, optional ? undefined : 0))}
        placeholder={optional ? t("stepEditor.ph.optional") : "0"}
      />
    </div>
  );
}

/**
 * Shows/accepts a duration in SECONDS but stores milliseconds — QA thinks in seconds,
 * the engine wants ms. Empty clears the value (falls back to the engine default).
 */
function SecondsField({
  label,
  ms,
  onChange,
  optional,
  tip,
}: {
  label: string;
  ms: number | undefined;
  onChange: (ms: number | undefined) => void;
  optional?: boolean;
  tip?: InfoTipProps;
}) {
  const t = useT();
  const seconds = ms === undefined ? "" : String(ms / 1000);
  return (
    <div className="field">
      <FieldLabel label={label} tip={tip} />
      <input
        className="input mono"
        type="number"
        min={0}
        step="0.5"
        value={seconds}
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (raw === "") {
            onChange(optional ? undefined : 0);
            return;
          }
          const n = Number(raw);
          onChange(Number.isFinite(n) ? Math.round(n * 1000) : optional ? undefined : 0);
        }}
        placeholder={optional ? t("stepEditor.ph.optional") : "0"}
      />
    </div>
  );
}

function CheckboxField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="field" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="field__label" style={{ marginBottom: 0 }}>
        {label}
      </span>
    </label>
  );
}
