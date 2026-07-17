import { useMemo, useState } from "react";
import { collectAllTags, filterFlowsByTags } from "../../shared/tags.ts";
import type { FlowListItem } from "../api.ts";
import { useT } from "../i18n/index.tsx";
import { Icon } from "./icons.tsx";

export interface FlowListProps {
  flows: FlowListItem[];
  loading: boolean;
  error: string | null;
  openFile: string | null;
  onRefresh: () => void;
  onNewFlow: () => void;
  onLoadFlow: (file: string) => void;
  /** Run every flow matching the currently-selected tags as a suite (E18 spec AC1) — through
   * the EXISTING /api/suite (E15), just narrowed by tag on the client side first. Omitted
   * entirely (no button rendered) when the caller doesn't wire it up. */
  onRunSuite?: (tags: string[]) => void;
  runningSuite?: boolean;
}

export default function FlowList({
  flows,
  loading,
  error,
  openFile,
  onRefresh,
  onNewFlow,
  onLoadFlow,
  onRunSuite,
  runningSuite,
}: FlowListProps) {
  const t = useT();
  // E18: tag filter/selector — narrows the visible list AND, via onRunSuite, what a "run
  // tagged suite" click actually executes. Selecting NO tags shows/runs everything (an
  // "include" filter of nothing means no filter — see shared/tags.ts's filterFlowsByTags).
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const allTags = useMemo(() => collectAllTags(flows), [flows]);
  const visibleFlows = useMemo(
    () => (selectedTags.length > 0 ? filterFlowsByTags(flows, selectedTags) : flows),
    [flows, selectedTags],
  );

  function toggleTag(tag: string) {
    setSelectedTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]));
  }

  return (
    <div className="panel" style={{ flex: 1 }}>
      <div className="panel__header">
        <span className="panel__title">{t("flowList.title")}</span>
        <div className="row" style={{ gap: 4 }}>
          <button
            className="btn btn--ghost btn--icon"
            onClick={onRefresh}
            disabled={loading}
            aria-label={t("flowList.refreshAria")}
            title={t("flowList.refreshTitle")}
          >
            {loading ? <span className="spinner" /> : <Icon.refresh />}
          </button>
          <button className="btn btn--primary btn--sm" onClick={onNewFlow}>
            <Icon.plus size={13} />
            {t("flowList.newButton")}
          </button>
        </div>
      </div>

      {allTags.length > 0 && (
        <div className="row" role="group" aria-label={t("flowList.tagFilterAria")} style={{ gap: 4, flexWrap: "wrap", padding: "0 4px 8px" }}>
          {allTags.map((tag) => {
            const active = selectedTags.includes(tag);
            return (
              <button
                key={tag}
                type="button"
                className={`badge${active ? " badge--accent" : " badge--neutral"}`}
                style={{ cursor: "pointer", border: "none" }}
                onClick={() => toggleTag(tag)}
                aria-pressed={active}
              >
                @{tag}
              </button>
            );
          })}
          {onRunSuite && selectedTags.length > 0 && (
            <button
              type="button"
              className="btn btn--sm btn--primary"
              onClick={() => onRunSuite(selectedTags)}
              disabled={!!runningSuite}
            >
              {runningSuite ? <span className="spinner" /> : <Icon.play size={12} />}
              {t("flowList.runSuiteButton", { n: visibleFlows.length })}
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="error-banner" role="alert">
          <Icon.alert size={14} />
          <span>{error}</span>
        </div>
      )}

      {!error && visibleFlows.length === 0 && (
        <div className="empty-state" style={{ padding: "20px 4px" }}>
          <div className="empty-state__icon">
            <Icon.folder size={22} />
          </div>
          <div className="empty-state__title">
            {loading ? t("flowList.loading") : selectedTags.length > 0 ? t("flowList.emptyFiltered") : t("flowList.empty")}
          </div>
          <div className="empty-state__hint">{t("flowList.emptyHint")}</div>
        </div>
      )}

      <div className="flow-list">
        {visibleFlows.map((f) => {
          const isOpen = f.file === openFile;
          return (
            <button
              key={f.file}
              type="button"
              className={`flow-row${isOpen ? " flow-row--active" : ""}`}
              onClick={() => onLoadFlow(f.file)}
              aria-current={isOpen}
            >
              <div className="flow-row__main">
                <span className="flow-row__name" title={f.name}>{f.name}</span>
                <span
                  className="flow-row__meta"
                  title={`${f.steps} ${t("common.stepsUnit")} · ${f.bundleId}${f.tags.length > 0 ? ` · ${f.tags.map((tag) => `@${tag}`).join(" ")}` : ""}`}
                >
                  {f.steps} {t("common.stepsUnit")} · {f.bundleId}
                  {f.tags.length > 0 && ` · ${f.tags.map((tag) => `@${tag}`).join(" ")}`}
                </span>
              </div>
              {isOpen && <span className="badge badge--accent">{t("flowList.openBadge")}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
