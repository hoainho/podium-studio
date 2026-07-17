import { useEffect, useMemo, useState } from "react";
import { inspectWebView, type WebViewInspectorNode } from "../api.ts";
import { nodeLocator, nodeMatchesQuery, subtreeMatchesQuery, type WebViewLocator } from "../webview-tree.ts";
import { useT } from "../i18n/index.tsx";
import { Icon } from "./icons.tsx";

export interface WebViewInspectorProps {
  udid: string;
  bundleId: string;
  /** Fills the calling step's text/targetId field(s) (StepEditor.tsx's `applyLocatorToStep`) —
   * this component only ever hands back a locator, never mutates a step itself. */
  onPick: (locator: WebViewLocator) => void;
  onClose: () => void;
}

/**
 * WebView-aware inspector UI (E17 spec AC1): renders the target app's live WebView DOM as a
 * tree and lets a QA click any element to fill in the step's locator — no leaving the visual
 * editor, no raw JSON/YAML. Reuses the same modal-backdrop/modal shell E13's ComponentGallery
 * already established, and the same badge/faint/error-banner primitives used throughout
 * StepEditor's own lint/oracle UI, so this reads as one more panel in the same system rather
 * than a bolted-on one-off.
 */
export default function WebViewInspector({ udid, bundleId, onPick, onClose }: WebViewInspectorProps) {
  const t = useT();
  const [tree, setTree] = useState<WebViewInspectorNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    inspectWebView(udid, bundleId)
      .then((node) => {
        if (!cancelled) setTree(node);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [udid, bundleId]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function pick(node: WebViewInspectorNode) {
    const locator = nodeLocator(node);
    if (!locator) return;
    onPick(locator);
    onClose();
  }

  const noMatches = !!query.trim() && !!tree && !subtreeMatchesQuery(tree, query);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--webview-inspector" onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <Icon.code size={16} />
          <span className="modal__title">{t("webviewInspector.title")}</span>
          <button
            className="btn btn--ghost btn--icon"
            style={{ marginLeft: "auto" }}
            onClick={onClose}
            aria-label={t("common.closeAria")}
          >
            <Icon.x size={14} />
          </button>
        </div>
        <div className="modal__body">
          <p className="faint" style={{ marginTop: 0 }}>{t("webviewInspector.hint")}</p>
          <input
            className="input"
            style={{ marginBottom: 10, width: "100%" }}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("webviewInspector.searchPlaceholder")}
            aria-label={t("webviewInspector.searchPlaceholder")}
          />
          {loading ? (
            <div className="row" style={{ gap: 8 }}>
              <span className="spinner" /> {t("webviewInspector.loading")}
            </div>
          ) : error ? (
            <div className="error-banner" role="alert">
              <Icon.alert size={14} />
              <div>{error}</div>
            </div>
          ) : !tree ? (
            <div className="faint">{t("webviewInspector.empty")}</div>
          ) : noMatches ? (
            <div className="faint">{t("webviewInspector.noMatches")}</div>
          ) : (
            <div className="webview-tree" role="tree">
              <WebViewTreeNode node={tree} query={query} onPick={pick} depth={0} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function WebViewTreeNode({
  node,
  query,
  onPick,
  depth,
}: {
  node: WebViewInspectorNode;
  query: string;
  onPick: (node: WebViewInspectorNode) => void;
  depth: number;
}) {
  const t = useT();
  // Shallow levels open by default (AC1: "renders with correct node hierarchy" should be
  // visible at a glance) — deeper branches start collapsed so a large real Win Zone WebView
  // tree doesn't dump thousands of rows on first open.
  const [expanded, setExpanded] = useState(depth < 2);
  const hasChildren = node.children.length > 0;
  const visibleChildren = useMemo(
    () => node.children.filter((c) => subtreeMatchesQuery(c, query)),
    [node.children, query],
  );
  const selfMatches = nodeMatchesQuery(node, query);
  const searching = !!query.trim();
  // A search filter force-opens any branch that leads to a match, regardless of the manual
  // expand/collapse state — otherwise typing a query would just filter INSIDE a collapsed
  // subtree the QA can't see.
  const isOpen = expanded || (searching && visibleChildren.length > 0);
  const locator = nodeLocator(node);

  if (searching && !selfMatches && visibleChildren.length === 0) return null;

  return (
    <div className="webview-tree__node" role="treeitem" aria-expanded={hasChildren ? isOpen : undefined}>
      <div className="webview-tree__row" style={{ paddingLeft: depth * 16 }}>
        {hasChildren ? (
          <button
            type="button"
            className="webview-tree__toggle"
            onClick={() => setExpanded((v) => !v)}
            aria-label={isOpen ? t("webviewInspector.collapseAria") : t("webviewInspector.expandAria")}
          >
            <Icon.down size={12} style={{ transform: isOpen ? undefined : "rotate(-90deg)" }} />
          </button>
        ) : (
          <span className="webview-tree__toggle-spacer" />
        )}
        <span className="mono webview-tree__tag">&lt;{node.tag}&gt;</span>
        {node.testId && <span className="badge badge--accent webview-tree__badge">{node.testId}</span>}
        {node.text && <span className="faint webview-tree__text">&quot;{node.text}&quot;</span>}
        {locator && (
          <button
            type="button"
            className="btn btn--sm btn--primary webview-tree__pick"
            onClick={() => onPick(node)}
          >
            <Icon.target size={12} />
            {t("webviewInspector.pickButton")}
          </button>
        )}
      </div>
      {hasChildren && isOpen && (
        <div className="webview-tree__children">
          {visibleChildren.map((child, i) => (
            <WebViewTreeNode key={i} node={child} query={query} onPick={onPick} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}
