import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { KEY_VALUES, type Flow, type FlowStep } from "../../shared/ir.ts";
import { actStep, artifactUrl, captureScreen, launchApp } from "../api.ts";
import { friendlyRunError } from "../friendly.ts";
import { localizedStepDescription } from "../step-desc.ts";
import { useT } from "../i18n/index.tsx";
import { Icon } from "./icons.tsx";

export interface RecordPanelProps {
  activeUdid: string | null;
  deviceBooted: boolean;
  flow: Flow;
  onChange: (flow: Flow) => void;
}

/** Actions confirmed via a single free-text (or numeric) inline field. */
type InlineAction =
  | "type"
  | "waitFor"
  | "waitForNotVisible"
  | "assertVisible"
  | "assertNotVisible"
  | "tapIfVisible"
  | "scrollUntilVisible"
  | "openLink"
  | "copyText"
  | "deleteText"
  | "raw";

/** Which gesture the NEXT mirror click will record. */
type ClickMode = "tap" | "doubleTap" | "longPress";

interface Marker {
  /** Pixel offset of the click within the mirror stage, anchored to the image's actual
   *  laid-out box (img.offsetLeft/Top + fraction × img.offsetWidth/Height). Using pixels — not
   *  a percentage of the stage — keeps the dot on the click point even when the stage is wider
   *  than the image (WebKit flex sizing does not always shrink-wrap the stage to the image). */
  mx: number;
  my: number;
}

function freshId(): string {
  return crypto.randomUUID();
}

/**
 * "Click the screen to record" mode. Every action here is executed live on the device via
 * `actStep` and, on success or failure, the step is appended to the flow — this list of
 * recorded steps *is* the flow being built. No AI: the mapping from click/button to step
 * shape is fixed and deterministic.
 */
export default function RecordPanel(props: RecordPanelProps) {
  const { activeUdid, deviceBooted, flow, onChange } = props;
  const t = useT();
  const imgRef = useRef<HTMLImageElement>(null);

  const INLINE_PLACEHOLDER: Record<InlineAction, string> = {
    type: t("recordPanel.placeholder.type"),
    waitFor: t("recordPanel.placeholder.waitFor"),
    waitForNotVisible: t("recordPanel.placeholder.waitForNotVisible"),
    assertVisible: t("recordPanel.placeholder.assertVisible"),
    assertNotVisible: t("recordPanel.placeholder.assertNotVisible"),
    tapIfVisible: t("recordPanel.placeholder.tapIfVisible"),
    scrollUntilVisible: t("recordPanel.placeholder.scrollUntilVisible"),
    openLink: t("recordPanel.placeholder.openLink"),
    copyText: t("recordPanel.placeholder.copyText"),
    deleteText: t("recordPanel.placeholder.deleteText"),
    raw: t("recordPanel.placeholder.raw"),
  };

  const [framePath, setFramePath] = useState<string | null>(null);
  const [scale, setScale] = useState(1);
  const [frameTs, setFrameTs] = useState(0);
  const [loadingFrame, setLoadingFrame] = useState(false);
  const [frameError, setFrameError] = useState<string | null>(null);

  const [acting, setActing] = useState(false);
  const [lastOk, setLastOk] = useState<boolean | null>(null);
  const [lastDetail, setLastDetail] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [showLastRaw, setShowLastRaw] = useState(false);

  const [marker, setMarker] = useState<Marker | null>(null);
  const [clickMode, setClickMode] = useState<ClickMode>("tap");
  // RUN-2: a click that lands while the previous action is still in flight is dropped (the
  // guard below in handleMirrorClick) — this shows a brief, localized "still recording…" hint
  // instead of silently swallowing the click.
  const [showBusyHint, setShowBusyHint] = useState(false);
  const busyHintTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(busyHintTimer.current), []);

  const [inlineAction, setInlineAction] = useState<InlineAction | null>(null);
  const [inlineValue, setInlineValue] = useState("");

  const [selectedKey, setSelectedKey] = useState<(typeof KEY_VALUES)[number]>(KEY_VALUES[0]);

  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const autoLaunchedRef = useRef<string | null>(null);

  const ready = !!activeUdid && deviceBooted;
  const flowBundleId = flow.app.bundleId.trim();

  async function refreshScreen() {
    if (!activeUdid) return;
    setLoadingFrame(true);
    setFrameError(null);
    try {
      const frame = await captureScreen(activeUdid);
      setFramePath(frame.path);
      setScale(frame.scale);
      setFrameTs(frame.ts);
    } catch (err) {
      setFrameError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingFrame(false);
    }
  }

  async function doLaunch() {
    if (!activeUdid || !flowBundleId) return;
    setLaunching(true);
    setLaunchError(null);
    try {
      await launchApp(activeUdid, flowBundleId);
      await refreshScreen();
    } catch (err) {
      setLaunchError(err instanceof Error ? err.message : String(err));
    } finally {
      setLaunching(false);
    }
  }

  useEffect(() => {
    if (ready) {
      void refreshScreen();
    } else {
      setFramePath(null);
      setMarker(null);
    }
    // Only re-capture when the active/booted device actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeUdid, deviceBooted]);

  // Auto-launch the flow's app once per (device, app) combo when Record mode becomes
  // usable. Gesture/key actions fail server-side when nothing is foregrounded, so this
  // guarantees there's always an app on screen to record against.
  useEffect(() => {
    if (!ready || !flowBundleId) return;
    const key = `${activeUdid}::${flowBundleId}`;
    if (autoLaunchedRef.current === key) return;
    autoLaunchedRef.current = key;
    void doLaunch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, activeUdid, flowBundleId]);

  async function recordStep(step: FlowStep) {
    if (!activeUdid || acting) return;
    setActing(true);
    setLastOk(null);
    setLastDetail(null);
    setLastError(null);
    setShowLastRaw(false);
    try {
      // The flow's own app is the single source of truth for what's on screen.
      const res = await actStep(activeUdid, step, flowBundleId || undefined);
      // Only keep the step if it actually worked — never record a junk/failed step.
      if (res.ok) {
        onChange({ ...flow, steps: [...flow.steps, step] });
      }
      setFramePath(res.screen);
      setScale(res.scale);
      setFrameTs(res.ts);
      setLastOk(res.ok);
      setLastDetail(res.detail);
      setLastError(res.error);
    } catch (err) {
      setLastOk(false);
      setLastError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
    }
  }

  function handleMirrorClick(e: MouseEvent<HTMLImageElement>) {
    if (acting || !activeUdid) {
      // RUN-2: the click landed while the previous action was still in flight — surface a
      // subtle, self-clearing hint instead of a silent no-op.
      if (acting) {
        setShowBusyHint(true);
        window.clearTimeout(busyHintTimer.current);
        busyHintTimer.current = window.setTimeout(() => setShowBusyHint(false), 1500);
      }
      return;
    }
    const img = imgRef.current;
    if (!img || !img.naturalWidth || !img.naturalHeight) return;
    const rect = img.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top) / rect.height;
    const x = Math.round((fx * img.naturalWidth) / scale);
    const y = Math.round((fy * img.naturalHeight) / scale);
    // Anchor the marker to the image's own laid-out box within the (position:relative) stage,
    // in pixels — see the Marker interface for why percentages of the stage are unreliable here.
    setMarker({
      mx: img.offsetLeft + fx * img.offsetWidth,
      my: img.offsetTop + fy * img.offsetHeight,
    });
    const mode = clickMode;
    // No `label` here: an auto-generated English label would take the `custom` (verbatim) path in
    // describeStepCode and defeat localization. Leaving it unset lets the step list render the
    // localized `stepDesc.*` template (task #48). `label` is reserved for user-authored names.
    const step: FlowStep =
      mode === "doubleTap"
        ? { id: freshId(), action: "doubleTap", x, y }
        : mode === "longPress"
          ? { id: freshId(), action: "longPress", x, y }
          : { id: freshId(), action: "tap", x, y };
    if (mode !== "tap") setClickMode("tap"); // one-shot: consume the armed gesture
    void recordStep(step);
  }

  function openInline(action: InlineAction) {
    setInlineAction(action);
    setInlineValue("");
  }

  function cancelInline() {
    setInlineAction(null);
    setInlineValue("");
  }

  function confirmInline() {
    if (!inlineAction) return;
    const raw = inlineValue.trim();
    if (!raw) return;
    let step: FlowStep;
    switch (inlineAction) {
      case "type":
        step = { id: freshId(), action: "type", text: raw };
        break;
      case "waitFor":
        step = { id: freshId(), action: "waitFor", text: raw, timeoutMs: 10_000 };
        break;
      case "waitForNotVisible":
        step = { id: freshId(), action: "waitForNotVisible", text: raw, timeoutMs: 10_000 };
        break;
      case "assertVisible":
        step = { id: freshId(), action: "assertVisible", text: raw, timeoutMs: 10_000 };
        break;
      case "assertNotVisible":
        step = { id: freshId(), action: "assertNotVisible", text: raw, timeoutMs: 5_000 };
        break;
      case "tapIfVisible":
        step = { id: freshId(), action: "tapIfVisible", text: raw, timeoutMs: 5_000 };
        break;
      case "scrollUntilVisible":
        step = { id: freshId(), action: "scrollUntilVisible", text: raw };
        break;
      case "openLink":
        step = { id: freshId(), action: "openLink", url: raw };
        break;
      case "copyText":
        step = { id: freshId(), action: "copyText", text: raw };
        break;
      case "deleteText": {
        const n = Number(raw);
        step = { id: freshId(), action: "deleteText", count: Number.isFinite(n) && n > 0 ? Math.round(n) : 1 };
        break;
      }
      case "raw":
        step = { id: freshId(), action: "raw", maestro: raw };
        break;
    }
    setInlineAction(null);
    setInlineValue("");
    void recordStep(step);
  }

  function swipe(direction: "up" | "down" | "left" | "right") {
    void recordStep({ id: freshId(), action: "swipe", direction });
  }

  function scroll(direction: "up" | "down" | "left" | "right") {
    void recordStep({ id: freshId(), action: "scroll", direction });
  }

  function takeScreenshot() {
    void recordStep({ id: freshId(), action: "screenshot" });
  }

  function sendKey() {
    void recordStep({ id: freshId(), action: "key", key: selectedKey });
  }

  function clearText() {
    void recordStep({ id: freshId(), action: "clearText" });
  }

  function hideKeyboard() {
    void recordStep({ id: freshId(), action: "hideKeyboard" });
  }

  function goBack() {
    void recordStep({ id: freshId(), action: "back" });
  }

  function pasteText() {
    void recordStep({ id: freshId(), action: "pasteText" });
  }

  function removeLast() {
    if (flow.steps.length === 0) return;
    onChange({ ...flow, steps: flow.steps.slice(0, -1) });
  }

  function deleteStepAt(index: number) {
    onChange({ ...flow, steps: flow.steps.filter((_, i) => i !== index) });
  }

  if (!ready) {
    return (
      <div className="record-panel">
        <div className="hint-banner">
          <Icon.info size={14} />
          <span>{t("recordPanel.hintStartSimulator")}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="record-panel">
      <div className="record-panel__mirror-col">
        <div className="record-app-bar">
          <div className="record-app-bar__info">
            <span className="field__label" style={{ marginBottom: 0 }}>
              {t("recordPanel.flowAppLabel")}
            </span>
            <span className="mono" style={{ fontSize: 12 }}>
              {flowBundleId || "—"}
            </span>
          </div>
          <button
            className="btn btn--sm"
            onClick={() => void doLaunch()}
            disabled={launching || !flowBundleId}
            title={!flowBundleId ? t("recordPanel.launchTitleNoBundle") : t("recordPanel.launchTitleRelaunch")}
          >
            {launching ? <span className="spinner" /> : <Icon.rocket size={13} />}
            {t("recordPanel.launchButton")}
          </button>
        </div>
        {!flowBundleId && (
          <div className="hint-banner">
            <Icon.info size={14} />
            <span>{t("recordPanel.hintNoBundle")}</span>
          </div>
        )}
        {launchError && (
          <div className="error-banner" role="alert">
            <Icon.alert size={14} />
            <span>{launchError}</span>
          </div>
        )}

        <div className="record-panel__mirror-toolbar">
          <span className="panel__title" style={{ margin: 0 }}>
            {t("recordPanel.liveMirror")}
          </span>
          <div className="spacer" />
          {acting && (
            <span className="badge badge--running">
              <span className="spinner" /> {t("recordPanel.recordingBadge")}
            </span>
          )}
          <button
            className="btn btn--sm"
            onClick={refreshScreen}
            disabled={loadingFrame || acting}
          >
            {loadingFrame ? <span className="spinner" /> : <Icon.refresh size={13} />}
            {t("recordPanel.refreshScreenButton")}
          </button>
        </div>

        {frameError && (
          <div className="error-banner" role="alert">
            <Icon.alert size={14} />
            <span>{friendlyRunError(t, frameError)}</span>
          </div>
        )}

        <div className="record-mirror-caption">
          <Icon.cursor size={13} />
          <span>{t("recordPanel.mirrorCaption")}</span>
        </div>

        <div className={`record-mirror${acting ? " record-mirror--busy" : ""}`}>
          {framePath ? (
            // The stage shrink-wraps the image so the marker's percentage offsets map to the
            // IMAGE box, not the (wider, flex-centred, padded) .record-mirror container.
            <div className="record-mirror__stage">
              <img
                ref={imgRef}
                src={artifactUrl(framePath, frameTs)}
                alt="Device mirror — click to tap"
                className="record-mirror__img"
                onClick={handleMirrorClick}
              />
              {marker && (
                <div
                  className="record-mirror__marker"
                  style={{ left: `${marker.mx}px`, top: `${marker.my}px` }}
                  aria-hidden="true"
                />
              )}
            </div>
          ) : (
            <div className="empty-state" style={{ padding: "48px 24px" }}>
              <div className="empty-state__title">
                {loadingFrame ? t("recordPanel.capturingScreen") : t("recordPanel.noScreenCaptured")}
              </div>
            </div>
          )}
        </div>

        {showBusyHint && (
          <div className="hint-banner" role="status">
            <Icon.info size={14} />
            <span>{t("recordPanel.stillRecordingHint")}</span>
          </div>
        )}

        {clickMode !== "tap" && (
          <div className="hint-banner">
            <Icon.info size={14} />
            <span>
              {t("recordPanel.nextClickHint", {
                gesture:
                  clickMode === "doubleTap"
                    ? t("recordPanel.gestureDoubleTap")
                    : t("recordPanel.gestureLongPress"),
              })}
            </span>
          </div>
        )}

        {(lastOk !== null || lastError) && (
          <div
            className={`record-panel__status ${
              lastOk ? "record-panel__status--ok" : "record-panel__status--fail"
            }`}
          >
            {lastOk ? <Icon.check size={13} /> : <Icon.alert size={13} />}
            {lastOk ? (
              // RUN-1: never render the raw backend `detail` here — for a native tap it's
              // mobilecli's own unlocalized CLI stdout, which also leaks the device UDID. Always
              // show the clean, localized confirmation instead.
              <span>{t("recordPanel.stepRecorded")}</span>
            ) : (
              <div className="record-panel__status-body">
                <span>{friendlyRunError(t, lastError ?? lastDetail)}</span>
                <span className="record-panel__status-note">
                  {t("recordPanel.stepNotAddedNote")}
                </span>
                {(lastError || lastDetail) && (
                  <>
                    <button
                      type="button"
                      className="linklike"
                      onClick={() => setShowLastRaw((v) => !v)}
                      aria-expanded={showLastRaw}
                    >
                      {showLastRaw ? t("common.hideTechDetails") : t("common.showTechDetails")}
                    </button>
                    {showLastRaw && <code className="tech-details">{lastError ?? lastDetail}</code>}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="record-panel__actions-col">
        <div className="panel__title">{t("recordPanel.actionsColTitle")}</div>
        <div className="record-actions">
          <div className="record-actions__section-title">{t("recordPanel.sectionTapMode")}</div>
          <div className="record-actions__row">
            <button
              className={`btn btn--sm${clickMode === "doubleTap" ? " btn--armed" : ""}`}
              onClick={() => setClickMode((m) => (m === "doubleTap" ? "tap" : "doubleTap"))}
              disabled={acting}
            >
              <Icon.doubleTap size={13} /> {t("recordPanel.doubleTapButton")}
            </button>
            <button
              className={`btn btn--sm${clickMode === "longPress" ? " btn--armed" : ""}`}
              onClick={() => setClickMode((m) => (m === "longPress" ? "tap" : "longPress"))}
              disabled={acting}
            >
              <Icon.longPress size={13} /> {t("recordPanel.longPressButton")}
            </button>
            <button
              className="btn btn--sm"
              onClick={() => openInline("tapIfVisible")}
              disabled={acting}
            >
              <Icon.tapIfVisible size={13} /> {t("recordPanel.tapIfVisibleButton")}
            </button>
          </div>

          <div className="record-actions__section-title">{t("recordPanel.sectionText")}</div>
          <div className="record-actions__row">
            <button className="btn btn--sm" onClick={() => openInline("type")} disabled={acting}>
              <Icon.keyboard size={13} /> {t("recordPanel.typeButton")}
            </button>
            <button className="btn btn--sm" onClick={clearText} disabled={acting}>
              <Icon.clearText size={13} /> {t("recordPanel.clearTextButton")}
            </button>
            <button className="btn btn--sm" onClick={() => openInline("deleteText")} disabled={acting}>
              <Icon.deleteText size={13} /> {t("recordPanel.deleteButton")}
            </button>
            <button className="btn btn--sm" onClick={pasteText} disabled={acting}>
              <Icon.paste size={13} /> {t("recordPanel.pasteButton")}
            </button>
            <button className="btn btn--sm" onClick={() => openInline("copyText")} disabled={acting}>
              <Icon.copy size={13} /> {t("recordPanel.copyButton")}
            </button>
            <button className="btn btn--sm" onClick={hideKeyboard} disabled={acting}>
              <Icon.hideKeyboard size={13} /> {t("recordPanel.hideKeyboardButton")}
            </button>
          </div>

          {inlineAction && (
            <div className="record-actions__inline">
              {inlineAction === "raw" ? (
                <textarea
                  autoFocus
                  className="textarea"
                  style={{ flex: 1, minHeight: 60 }}
                  value={inlineValue}
                  onChange={(e) => setInlineValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") cancelInline();
                  }}
                  placeholder={INLINE_PLACEHOLDER[inlineAction]}
                />
              ) : (
                <input
                  autoFocus
                  className="input"
                  value={inlineValue}
                  onChange={(e) => setInlineValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") confirmInline();
                    if (e.key === "Escape") cancelInline();
                  }}
                  placeholder={INLINE_PLACEHOLDER[inlineAction]}
                />
              )}
              <button
                className="btn btn--sm btn--primary"
                onClick={confirmInline}
                disabled={!inlineValue.trim() || acting}
                aria-label={t("common.confirmAria")}
              >
                <Icon.check size={13} />
              </button>
              <button
                className="btn btn--sm btn--ghost"
                onClick={cancelInline}
                disabled={acting}
                aria-label={t("common.cancelAria")}
              >
                <Icon.x size={13} />
              </button>
            </div>
          )}

          <div className="record-actions__section-title">{t("recordPanel.sectionNavigate")}</div>
          <div className="record-actions__row">
            <select
              className="select"
              style={{ maxWidth: 140 }}
              value={selectedKey}
              onChange={(e) => setSelectedKey(e.target.value as (typeof KEY_VALUES)[number])}
              disabled={acting}
              aria-label={t("recordPanel.sendKeyAria")}
            >
              {KEY_VALUES.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <button className="btn btn--sm" onClick={sendKey} disabled={acting}>
              <Icon.key size={13} /> {t("recordPanel.sendKeyButton")}
            </button>
            <button className="btn btn--sm" onClick={goBack} disabled={acting}>
              <Icon.back size={13} /> {t("recordPanel.backButton")}
            </button>
          </div>
          <div className="record-actions__row">
            <span className="field__label" style={{ alignSelf: "center" }}>
              {t("recordPanel.swipeLabel")}
            </span>
            <button className="btn btn--sm" onClick={() => swipe("up")} disabled={acting}>
              <Icon.up size={13} /> {t("recordPanel.upButton")}
            </button>
            <button className="btn btn--sm" onClick={() => swipe("down")} disabled={acting}>
              <Icon.down size={13} /> {t("recordPanel.downButton")}
            </button>
            <button className="btn btn--sm" onClick={() => swipe("left")} disabled={acting}>
              <Icon.up size={13} style={{ transform: "rotate(-90deg)" }} /> {t("recordPanel.leftButton")}
            </button>
            <button className="btn btn--sm" onClick={() => swipe("right")} disabled={acting}>
              <Icon.up size={13} style={{ transform: "rotate(90deg)" }} /> {t("recordPanel.rightButton")}
            </button>
          </div>
          <div className="record-actions__row">
            <span className="field__label" style={{ alignSelf: "center" }}>
              {t("recordPanel.scrollLabel")}
            </span>
            <button className="btn btn--sm" onClick={() => scroll("up")} disabled={acting}>
              <Icon.scroll size={13} /> {t("recordPanel.upButton")}
            </button>
            <button className="btn btn--sm" onClick={() => scroll("down")} disabled={acting}>
              <Icon.scroll size={13} style={{ transform: "rotate(180deg)" }} /> {t("recordPanel.downButton")}
            </button>
            <button className="btn btn--sm" onClick={() => scroll("left")} disabled={acting}>
              <Icon.scroll size={13} style={{ transform: "rotate(-90deg)" }} /> {t("recordPanel.leftButton")}
            </button>
            <button className="btn btn--sm" onClick={() => scroll("right")} disabled={acting}>
              <Icon.scroll size={13} style={{ transform: "rotate(90deg)" }} /> {t("recordPanel.rightButton")}
            </button>
            <button
              className="btn btn--sm"
              onClick={() => openInline("scrollUntilVisible")}
              disabled={acting}
            >
              <Icon.scrollTo size={13} /> {t("recordPanel.scrollToButton")}
            </button>
          </div>

          <div className="record-actions__section-title">{t("recordPanel.sectionWaitAssert")}</div>
          <div className="record-actions__row">
            <button
              className="btn btn--sm"
              onClick={() => openInline("waitFor")}
              disabled={acting}
            >
              <Icon.clock size={13} /> {t("recordPanel.waitForButton")}
            </button>
            <button
              className="btn btn--sm"
              onClick={() => openInline("waitForNotVisible")}
              disabled={acting}
            >
              <Icon.waitGone size={13} /> {t("recordPanel.waitGoneButton")}
            </button>
            <button
              className="btn btn--sm"
              onClick={() => openInline("assertVisible")}
              disabled={acting}
            >
              <Icon.check size={13} /> {t("recordPanel.assertButton")}
            </button>
            <button
              className="btn btn--sm"
              onClick={() => openInline("assertNotVisible")}
              disabled={acting}
            >
              <Icon.assertNot size={13} /> {t("recordPanel.assertNotButton")}
            </button>
          </div>

          <div className="record-actions__section-title">{t("recordPanel.sectionAppAdvanced")}</div>
          <div className="record-actions__row">
            <button className="btn btn--sm" onClick={() => openInline("openLink")} disabled={acting}>
              <Icon.link size={13} /> {t("recordPanel.openLinkButton")}
            </button>
            <button className="btn btn--sm" onClick={takeScreenshot} disabled={acting}>
              <Icon.camera size={13} /> {t("recordPanel.screenshotButton")}
            </button>
            <button className="btn btn--sm" onClick={() => openInline("raw")} disabled={acting}>
              <Icon.code size={13} /> {t("recordPanel.rawButton")}
            </button>
          </div>
        </div>

        <div className="panel__header" style={{ marginTop: 16 }}>
          <span className="panel__title">
            {t("recordPanel.recordedStepsTitle", { n: flow.steps.length })}
          </span>
          <button
            className="btn btn--sm btn--ghost"
            onClick={removeLast}
            disabled={flow.steps.length === 0 || acting}
          >
            <Icon.trash size={12} /> {t("recordPanel.removeLastButton")}
          </button>
        </div>

        {flow.steps.length === 0 ? (
          <div className="empty-state" style={{ padding: "20px 4px" }}>
            <div className="empty-state__title">{t("recordPanel.emptyStepsTitle")}</div>
            <div className="empty-state__hint">{t("recordPanel.emptyStepsHint")}</div>
          </div>
        ) : (
          <ol className="record-list">
            {flow.steps.map((step, i) => (
              <li key={step.id} className="record-list__item">
                <span className="record-list__index">{i + 1}</span>
                <span className="record-list__desc">{localizedStepDescription(t, step)}</span>
                <button
                  className="btn btn--ghost btn--icon record-list__delete"
                  onClick={() => deleteStepAt(i)}
                  disabled={acting}
                  aria-label={t("recordPanel.deleteStepAria", { n: i + 1 })}
                  title={t("recordPanel.deleteStepTitle")}
                >
                  <Icon.trash size={12} />
                </button>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
