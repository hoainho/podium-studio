import { listLibraryEntries } from "../../shared/library.ts";
import { useEscToClose } from "../use-esc-to-close.ts";
import type { FlowStep } from "../../shared/ir.ts";
import type { FlowListItem } from "../api.ts";
import { useT } from "../i18n/index.tsx";
import { Icon } from "./icons.tsx";

export interface ComponentGalleryProps {
  /** Every saved flow that declares a call-parameter signature (params.length > 0) — the
   * "callable as a sub-flow" candidates (E13 spec AC3). */
  subFlows: FlowListItem[];
  /** Inserts a pre-filled `callSubFlow` step (flowFile + one empty param slot per declared
   * param) into the currently-open flow — zero raw-JSON/YAML edits (spec AC3's own wording). */
  onInsertSubFlow: (step: FlowStep) => void;
  onClose: () => void;
}

/**
 * ComponentGallery — E13 spec AC3. Browse reusable building blocks (parameterized sub-flows +
 * the platform-scoped selector library, shared/library.ts) without ever touching raw JSON/YAML.
 * Inserting a sub-flow appends a `callSubFlow` step, pre-filled with one empty slot per the
 * sub-flow's own declared params — the QA then fills in literal values or captured-variable
 * chips via the normal step editor fields (same TextField/chip mechanism every other step uses).
 */
export default function ComponentGallery({ subFlows, onInsertSubFlow, onClose }: ComponentGalleryProps) {
  useEscToClose(onClose);
  const t = useT();
  const libraryEntries = listLibraryEntries();

  function insert(flow: FlowListItem) {
    const params: Record<string, string> = {};
    for (const p of flow.params) params[p.name] = p.default ?? "";
    onInsertSubFlow({
      id: crypto.randomUUID(),
      action: "callSubFlow",
      label: t("gallery.insertedLabel", { name: flow.name }),
      flowFile: flow.file,
      params,
    } as FlowStep);
    onClose();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <Icon.folder size={16} />
          <span className="modal__title">{t("gallery.title")}</span>
          <button className="btn btn--ghost btn--icon" style={{ marginLeft: "auto" }} onClick={onClose} aria-label={t("common.closeAria")}>
            <Icon.x size={14} />
          </button>
        </div>
        <div className="modal__body">
          <div className="add-step__group-label">{t("gallery.subFlowsTitle")}</div>
          {subFlows.length === 0 ? (
            <div className="faint" style={{ padding: "6px 8px 14px" }}>{t("gallery.noSubFlows")}</div>
          ) : (
            <div className="device-list" style={{ marginBottom: 14 }}>
              {subFlows.map((f) => {
                const paramsText = f.params.map((p) => `${p.name}${p.required ? "" : "?"}`).join(", ") || t("gallery.noParams");
                return (
                  <div className="device-row" key={f.file}>
                    <div className="device-row__main">
                      <span className="device-row__name" title={f.name}>{f.name}</span>
                      <span className="device-row__meta" title={paramsText}>{paramsText}</span>
                    </div>
                    <button className="btn btn--sm btn--primary" onClick={() => insert(f)}>
                      <Icon.plus size={12} />
                      {t("gallery.insertButton")}
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="add-step__group-label">{t("gallery.libraryTitle")}</div>
          <div className="device-list">
            {libraryEntries.map((entry) => (
              <div className="device-row" key={entry.id}>
                <div className="device-row__main">
                  {/* Library element descriptions can be long (e.g. a static label distinguishing
                   * itself from a similar dynamic value) — device-row__name truncates with an
                   * ellipsis at this width, so the full text must stay available via `title`. */}
                  <span className="device-row__name" title={entry.label}>{entry.label}</span>
                  <span className="device-row__meta mono" title={entry.id}>{entry.id}</span>
                </div>
                <span className={`badge ${entry.mobile ? "badge--ok" : "badge--neutral"}`} title={t("gallery.mobileCoverage")}>
                  {t("gallery.mobileBadge")}
                </span>
                <span className={`badge ${entry.browser ? "badge--ok" : "badge--neutral"}`} title={t("gallery.browserCoverage")}>
                  {t("gallery.browserBadge")}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
