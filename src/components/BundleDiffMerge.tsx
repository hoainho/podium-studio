import { useState } from "react";
import { useEscToClose } from "../use-esc-to-close.ts";
import type { Flow } from "../../shared/ir.ts";
import { findUnsafeSteps, parseBundle, stripUnsafeSteps, type FlowBundle, type UnsafeStepRef } from "../../shared/bundle.ts";
import { diffFlows, mergeFlow, type ConflictResolution, type FlowDiffResult } from "../../shared/flow-diff.ts";
import { getBaseline, readFileAsText } from "../bundle-io.ts";
import { loadFlow, saveFlow } from "../api.ts";
import { useT } from "../i18n/index.tsx";
import { Icon } from "./icons.tsx";

export interface BundleDiffMergeProps {
  /** The flow currently open in the editor ("mine") — undefined if the imported bundle's main
   * flow file has no local counterpart yet (a brand-new import, not a merge). */
  currentFlow: Flow;
  currentFlowFile: string | null;
  /** True when the editor has unsaved edits on `currentFlow` — AUTH-1: gates a confirm before
   * completing a merge whose main flow belongs to a DIFFERENT file than the one open, since
   * that repoints the editor and would otherwise silently discard those edits. */
  dirty: boolean;
  /** Called with the merged MAIN flow once the QA completes the merge — the caller (StepEditor)
   * loads it into the editor exactly like any other edit; the QA still reviews/saves normally,
   * this never silently writes over the open editor without their own Save click following. */
  onMerged: (flow: Flow) => void;
  onClose: () => void;
}

/** One file (the bundle's main flow, or one referenced sub-flow) needing merge attention. */
interface MergeFile {
  file: string;
  isMain: boolean;
  theirs: Flow;
  mine?: Flow;
  base?: Flow;
  diff: FlowDiffResult;
  resolutions: Record<string, ConflictResolution>;
  /** True once this file's resolved/auto-merged result has been applied (saved, or handed to
   * onMerged for the main flow). */
  applied: boolean;
}

type Stage = "pick" | "unsafe-warning" | "review" | "done";

/**
 * E21 spec AC1/AC4: import a flow bundle, see a step-level visual diff against the recipient's
 * own copy, and complete a merge — conflicts (AC4) block completion until explicitly resolved,
 * non-conflicting changes (AC1) apply automatically. AC3: a bundle with `raw` steps is blocked
 * unless the QA explicitly opts in.
 */
export default function BundleDiffMerge({ currentFlow, currentFlowFile, dirty, onMerged, onClose }: BundleDiffMergeProps) {
  useEscToClose(onClose);
  const t = useT();
  const [stage, setStage] = useState<Stage>("pick");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [bundle, setBundle] = useState<FlowBundle | null>(null);
  const [unsafeRefs, setUnsafeRefs] = useState<UnsafeStepRef[]>([]);
  const [allowUnsafe, setAllowUnsafe] = useState(false);
  const [files, setFiles] = useState<MergeFile[]>([]);

  async function handleFilePicked(file: File) {
    setError(null);
    setLoading(true);
    try {
      const raw = await readFileAsText(file);
      const result = parseBundle(raw);
      if (!result.ok || !result.bundle) {
        setError(result.errors.join(" "));
        return;
      }
      setBundle(result.bundle);
      const unsafe = findUnsafeSteps(result.bundle);
      if (unsafe.length > 0) {
        setUnsafeRefs(unsafe);
        setStage("unsafe-warning");
      } else {
        await prepareReview(result.bundle, false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function prepareReview(b: FlowBundle, keepUnsafe: boolean) {
    setLoading(true);
    setError(null);
    try {
      const stripIfNeeded = (f: Flow) => (keepUnsafe ? f : stripUnsafeSteps(f));
      const mergeFiles: MergeFile[] = [];

      // Main flow — "mine" is the currently-open flow when it's the SAME file; otherwise this
      // bundle's main flow is new to this Workspace, so there's nothing local to diff against.
      const theirsMain = stripIfNeeded(b.flow);
      const mineMain = b.sourceFile === currentFlowFile ? currentFlow : undefined;
      const baseMain = b.baseFlow ?? (currentFlowFile ? getBaseline(b.sourceFile) : undefined);
      mergeFiles.push({
        file: b.sourceFile,
        isMain: true,
        theirs: theirsMain,
        mine: mineMain,
        base: baseMain,
        diff: diffFlows(baseMain, mineMain ?? theirsMain, theirsMain),
        resolutions: {},
        applied: false,
      });

      // Sub-flows — try to load the recipient's own copy of each (a 404/error just means "new
      // to this Workspace," not a real failure, so it's swallowed here, not surfaced as an error).
      for (const [subFile, subTheirs] of Object.entries(b.subFlows)) {
        const theirs = stripIfNeeded(subTheirs);
        let mine: Flow | undefined;
        try {
          mine = await loadFlow(subFile);
        } catch {
          mine = undefined;
        }
        const base = getBaseline(subFile);
        mergeFiles.push({
          file: subFile,
          isMain: false,
          theirs,
          mine,
          base,
          diff: diffFlows(base, mine ?? theirs, theirs),
          resolutions: {},
          applied: false,
        });
      }

      setFiles(mergeFiles);
      setStage("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  function setResolution(fileIndex: number, stepId: string, resolution: ConflictResolution) {
    setFiles((prev) =>
      prev.map((f, i) => (i === fileIndex ? { ...f, resolutions: { ...f.resolutions, [stepId]: resolution } } : f)),
    );
  }

  const allResolved = files.every((f) => mergeFlow(f.mine ?? f.theirs, f.diff, f.resolutions).unresolvedConflicts.length === 0);

  async function completeMerge() {
    // AUTH-1: if the bundle's main flow has no local counterpart under the CURRENTLY-open file
    // (a "foreign" import — `mine` was never populated in prepareReview), onMerged() below
    // repoints the editor at the bundle's flow wholesale. If the editor still has unsaved edits
    // at that moment, they'd be discarded with zero warning — so ask first.
    const foreignMainImport = files.some((f) => f.isMain && !f.mine);
    if (foreignMainImport && dirty && !window.confirm(t("bundle.discardUnsavedConfirm"))) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      for (const f of files) {
        const result = mergeFlow(f.mine ?? f.theirs, f.diff, f.resolutions);
        if (result.unresolvedConflicts.length > 0) continue; // guarded by allResolved, defensive
        if (f.isMain) {
          onMerged(result.flow);
        } else {
          // AUTH-2: `f.mine` means the recipient already has this sub-flow saved under `f.file`
          // — write back to that SAME file instead of letting the server derive a fresh
          // slug-of-name filename, which would orphan it exactly like the main-flow rename bug.
          await saveFlow(
            { ...result.flow, name: f.mine?.name ?? f.theirs.name },
            { fileName: f.mine ? f.file : undefined },
          );
        }
      }
      setStage("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--bundle-merge" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <Icon.branch size={16} />
          <span className="modal__title">{t("bundle.mergeTitle")}</span>
          <button className="btn btn--ghost btn--icon" style={{ marginLeft: "auto" }} onClick={onClose} aria-label={t("common.closeAria")}>
            <Icon.x size={14} />
          </button>
        </div>
        <div className="modal__body">
          {error && (
            <div className="error-banner" role="alert" style={{ marginBottom: 10 }}>
              <Icon.alert size={14} />
              <div>{error}</div>
            </div>
          )}

          {stage === "pick" && (
            <>
              <p className="faint" style={{ marginTop: 0 }}>{t("bundle.pickHint")}</p>
              <input
                type="file"
                accept=".json,application/json"
                className="input"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFilePicked(f);
                }}
                disabled={loading}
              />
              {loading && (
                <div className="row" style={{ gap: 8, marginTop: 10 }}>
                  <span className="spinner" /> {t("bundle.loading")}
                </div>
              )}
            </>
          )}

          {stage === "unsafe-warning" && bundle && (
            <div>
              <div className="error-banner" role="alert">
                <Icon.alert size={14} />
                <div>
                  <div>{t("bundle.unsafeWarningTitle", { n: unsafeRefs.length })}</div>
                  <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                    {unsafeRefs.map((r, i) => (
                      <li key={i} className="mono" style={{ fontSize: 12 }}>
                        {r.flowFile || t("bundle.mainFlowLabel")} — {r.stepId}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              <label className="row" style={{ gap: 8, marginTop: 12, alignItems: "center" }}>
                <input type="checkbox" checked={allowUnsafe} onChange={(e) => setAllowUnsafe(e.target.checked)} />
                {t("bundle.unsafeOptIn")}
              </label>
              <div className="row" style={{ gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
                <button className="btn btn--ghost" onClick={onClose}>{t("common.cancelAria")}</button>
                <button className="btn btn--primary" onClick={() => prepareReview(bundle, allowUnsafe)} disabled={loading}>
                  {loading ? <span className="spinner" /> : t("bundle.continueButton")}
                </button>
              </div>
            </div>
          )}

          {stage === "review" && (
            <>
              {files.map((f, i) => (
                <FileDiffPanel key={f.file} mergeFile={f} onResolve={(stepId, res) => setResolution(i, stepId, res)} />
              ))}
              <div className="row" style={{ gap: 8, marginTop: 14, justifyContent: "flex-end" }}>
                <button className="btn btn--ghost" onClick={onClose}>{t("common.cancelAria")}</button>
                <button className="btn btn--primary" onClick={completeMerge} disabled={!allResolved || loading}>
                  {loading ? <span className="spinner" /> : t("bundle.completeMergeButton")}
                </button>
              </div>
            </>
          )}

          {stage === "done" && (
            <div>
              <p>{t("bundle.mergeDoneMessage")}</p>
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button className="btn btn--primary" onClick={onClose}>{t("common.closeAria")}</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FileDiffPanel({
  mergeFile,
  onResolve,
}: {
  mergeFile: MergeFile;
  onResolve: (stepId: string, resolution: ConflictResolution) => void;
}) {
  const t = useT();
  if (!mergeFile.mine) {
    return (
      <div className="bundle-diff__file">
        <div className="bundle-diff__file-title">{mergeFile.file}</div>
        <span className="badge badge--ok">{t("bundle.newFileBadge")}</span>
      </div>
    );
  }

  const changedEntries = mergeFile.diff.entries.filter((e) => e.kind !== "unchanged");
  if (changedEntries.length === 0) {
    return (
      <div className="bundle-diff__file">
        <div className="bundle-diff__file-title">{mergeFile.file}</div>
        <span className="badge badge--neutral">{t("bundle.identicalBadge")}</span>
      </div>
    );
  }

  return (
    <div className="bundle-diff__file">
      <div className="bundle-diff__file-title">{mergeFile.file}</div>
      {changedEntries.map((entry) => (
        <div key={entry.id} className={`bundle-diff__row bundle-diff__row--${entry.kind}`}>
          <span className={`badge bundle-diff__kind bundle-diff__kind--${entry.kind}`}>
            {t(`bundle.diffKind.${entry.kind}`)}
          </span>
          <span className="mono bundle-diff__step-desc">
            {entry.theirs ? describeStepLoose(entry.theirs) : describeStepLoose(entry.mine)}
          </span>
          {entry.conflict && (
            <div className="bundle-diff__conflict">
              <div className="error-banner" role="alert">
                <Icon.alert size={14} />
                <div>{t("bundle.conflictLabel")}</div>
              </div>
              <div className="bundle-diff__conflict-sides">
                <div className="bundle-diff__side">
                  <div className="faint" style={{ fontSize: 11 }}>{t("bundle.mineLabel")}</div>
                  <div className="mono">{entry.mine ? describeStepLoose(entry.mine) : t("bundle.deletedLabel")}</div>
                  <button className="btn btn--sm btn--ghost" onClick={() => onResolve(entry.id, "mine")}>
                    {t("bundle.keepMineButton")}
                  </button>
                </div>
                <div className="bundle-diff__side">
                  <div className="faint" style={{ fontSize: 11 }}>{t("bundle.theirsLabel")}</div>
                  <div className="mono">{entry.theirs ? describeStepLoose(entry.theirs) : t("bundle.deletedLabel")}</div>
                  <button className="btn btn--sm btn--ghost" onClick={() => onResolve(entry.id, "theirs")}>
                    {t("bundle.takeTheirsButton")}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** A best-effort, dependency-free one-line summary of a step for the diff view — deliberately NOT
 * `shared/ir.ts`'s own `describeStep` (which throws/requires exhaustive action coverage); this
 * only ever needs to be legible, never authoritative. */
function describeStepLoose(step: unknown): string {
  const s = step as Record<string, unknown> | undefined;
  if (!s) return "";
  const text = typeof s.text === "string" ? s.text : undefined;
  const targetId = typeof s.targetId === "string" ? s.targetId : undefined;
  return `${s.action ?? "?"}${text ? ` "${text}"` : ""}${targetId ? ` #${targetId}` : ""}`;
}
