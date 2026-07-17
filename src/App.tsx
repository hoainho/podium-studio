import { useEffect, useRef, useState } from "react";
import { validateFlow, type Flow } from "../shared/ir.ts";
import type { Device, HealthReport, InstalledApp, RunSummary, SuiteJobRequest } from "../shared/protocol.ts";
import { filterFlowsByTags } from "../shared/tags.ts";
import { stashBaseline } from "./bundle-io.ts";
import {
  bootDevice,
  exportFlow as apiExportFlow,
  getAiRegistry,
  getApps,
  getDevices,
  getHealth,
  launchApp,
  listFlows,
  loadFlow as apiLoadFlow,
  runSuite,
  saveFlow as apiSaveFlow,
  type ExportResult,
  type FlowListItem,
} from "./api.ts";
import DevicePanel from "./components/DevicePanel.tsx";
import DoctorPanel from "./components/DoctorPanel.tsx";
import EnvironmentPanel from "./components/EnvironmentPanel.tsx";
import { Icon } from "./components/icons.tsx";
import FlowList from "./components/FlowList.tsx";
import RecordPanel from "./components/RecordPanel.tsx";
import RunPanel from "./components/RunPanel.tsx";
import StepEditor from "./components/StepEditor.tsx";
import TextStepsPanel from "./components/TextStepsPanel.tsx";
import TraceViewer from "./components/TraceViewer.tsx";
import TriagePanel from "./components/TriagePanel.tsx";
import QualityDashboard from "./components/QualityDashboard.tsx";
import AiSettingsPanel from "./components/AiSettingsPanel.tsx";
import CreateTestLauncher from "./components/CreateTestLauncher.tsx";
import DescribeTestPrompt from "./components/DescribeTestPrompt.tsx";
import IntroLoader from "./components/IntroLoader.tsx";
import { DEFAULT_BUNDLE_ID, emptyFlow } from "./step-defaults.ts";
import { activeAuthoringProviderName } from "./ai-provider.ts";
import { ensureUniqueStepIds, friendlyApiError, friendlyLaunchError } from "./friendly.ts";
import { I18nProvider, useI18n, useT } from "./i18n/index.tsx";
import { prepareFlowForRun } from "./prepare-run.ts";
import { buildTrace, type Trace } from "./trace.ts";

type MainTab = "steps" | "text" | "record";

function AppShell() {
  const { locale, setLocale } = useI18n();
  const t = useT();

  // ─── Intro loader ──────────────────────────────────────────────────────────
  // Shown once on app open; the loader owns its own timeline + reduced-motion handling and
  // calls onDone when it finishes fading out, at which point we unmount it.
  const [showIntro, setShowIntro] = useState(true);

  // ─── Health ──────────────────────────────────────────────────────────────
  const [health, setHealth] = useState<HealthReport | null>(null);

  // ─── Devices & apps ──────────────────────────────────────────────────────
  const [devices, setDevices] = useState<Device[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [activeUdid, setActiveUdid] = useState<string | null>(null);
  const [bootingUdid, setBootingUdid] = useState<string | null>(null);

  const [apps, setApps] = useState<InstalledApp[]>([]);
  const [appsLoading, setAppsLoading] = useState(false);
  const [appsError, setAppsError] = useState<string | null>(null);

  const [bundleId, setBundleId] = useState(DEFAULT_BUNDLE_ID);
  const [launching, setLaunching] = useState(false);

  // ─── Flows ───────────────────────────────────────────────────────────────
  const [flows, setFlows] = useState<FlowListItem[]>([]);
  const [flowsLoading, setFlowsLoading] = useState(false);
  const [flowsError, setFlowsError] = useState<string | null>(null);

  const [openFlow, setOpenFlow] = useState<Flow | null>(null);
  const [openFlowFile, setOpenFlowFile] = useState<string | null>(null);
  // E14 spec AC3: gates the charter-first prompt — true only right after "New flow", so it's
  // never re-shown just because an OLD, loaded flow happens to have no charter answer recorded.
  const [isNewUnsavedFlow, setIsNewUnsavedFlow] = useState(false);
  // QA audit P0-2: charter-prompt dismissal lives HERE (not in StepEditor), because App unmounts/
  // remounts StepEditor on every tab switch — a local flag reset each time, so "Skip" never stuck
  // and the prompt re-nagged on every return to the Steps tab. Reset per new flow.
  const [charterDismissed, setCharterDismissed] = useState(false);
  const [mainTab, setMainTab] = useState<MainTab>("steps");
  // Unsaved-edits guard: set on any edit, cleared on save / load / new.
  const [dirty, setDirty] = useState(false);
  // Narrow-width Run drawer (the run rail collapses under 960px).
  const [runOpen, setRunOpen] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const savedTimer = useRef<number | undefined>(undefined);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<ExportResult | null>(null);

  // ─── E18: tags/suites + trace viewer ─────────────────────────────────────
  const [viewingTraces, setViewingTraces] = useState<Trace[] | null>(null);
  // ── E22: failure-triage panel ─────────────────────────────────────────────
  const [viewingTriage, setViewingTriage] = useState<{ summary: RunSummary; trace: Trace } | null>(null);
  // ── E23: crash telemetry + flakiness trend/quarantine dashboard ───────────
  const [qualityDashboardOpen, setQualityDashboardOpen] = useState(false);
  // ── E24: AI provider registry + Strict/Adaptive mode settings ────────────
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  // Name of the connected AI provider (e.g. "Gemini", "GPT") — the AI feature is labelled by
  // whatever's connected instead of a fixed "Co-pilot" brand. null → no provider → generic "AI".
  const [aiProviderName, setAiProviderName] = useState<string | null>(null);
  // ── Create-a-test launcher (Phase A) ──────────────────────────────────────
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [describeBaseFlow, setDescribeBaseFlow] = useState<Flow | null>(null);

  function refreshAiProviderName() {
    getAiRegistry()
      .then((reg) => setAiProviderName(activeAuthoringProviderName(reg)))
      .catch(() => {
        /* AI not configured/reachable — the label falls back to a generic "AI" */
      });
  }
  const [suiteRunning, setSuiteRunning] = useState(false);
  const [suiteError, setSuiteError] = useState<string | null>(null);

  // ─── Loaders ─────────────────────────────────────────────────────────────
  async function refreshDevices() {
    setDevicesLoading(true);
    setDevicesError(null);
    try {
      const { ios } = await getDevices();
      setDevices(ios);
    } catch (err) {
      setDevicesError(friendlyApiError(t, err));
    } finally {
      setDevicesLoading(false);
    }
  }

  async function refreshFlows() {
    setFlowsLoading(true);
    setFlowsError(null);
    try {
      setFlows(await listFlows());
    } catch (err) {
      setFlowsError(friendlyApiError(t, err));
    } finally {
      setFlowsLoading(false);
    }
  }

  useEffect(() => {
    // QA follow-up ("Load fail" shown despite data): in the PACKAGED app the WKWebView renders
    // before the Node sidecar bridge has finished binding :8787, so an immediate fetch throws
    // WebKit's `TypeError: Load failed`. Poll health with a short backoff until the bridge answers,
    // THEN load devices/flows — so a purely transient startup race never surfaces as a scary error
    // banner over data that's about to appear. Only if the bridge is STILL unreachable after
    // several seconds do we mark it disconnected (a genuine failure worth showing).
    let cancelled = false;
    (async () => {
      let reached = false;
      for (let attempt = 0; attempt < 20 && !cancelled; attempt++) {
        try {
          const h = await getHealth();
          if (cancelled) return;
          setHealth(h);
          reached = true;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 400));
        }
      }
      if (cancelled) return;
      if (!reached) setHealth({ ok: false, error: "unreachable" });
      refreshDevices();
      refreshFlows();
      refreshAiProviderName();
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Live-poll health + device state so a simulator booted AFTER Studio opened appears
  // automatically, and a dropped engine connection recovers on screen without a manual
  // refresh (RC3). Lightweight: two cheap calls every 4s.
  useEffect(() => {
    const pollId = window.setInterval(() => {
      getHealth()
        .then(setHealth)
        .catch((err) => setHealth({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      getDevices()
        .then(({ ios }) => setDevices(ios))
        .catch(() => {
          /* keep last-known devices; the health poll surfaces the connection error */
        });
    }, 4000);
    return () => window.clearInterval(pollId);
  }, []);

  // Whether the ACTIVE device is booted — a primitive so the apps effect below only
  // re-runs when this actually changes, NOT on every 4s device poll (which replaces the
  // `devices` array reference each tick and used to cause the Installed Apps list to
  // flicker/reload constantly).
  const activeBooted = devices.find((d) => d.udid === activeUdid)?.state === "Booted";

  // Manual refresh for the Installed Apps list (wired to a button in DevicePanel).
  async function refreshApps() {
    if (!activeUdid || !activeBooted) return;
    setAppsLoading(true);
    setAppsError(null);
    try {
      setApps(await getApps(activeUdid));
    } catch (err) {
      setAppsError(err instanceof Error ? err.message : String(err));
    } finally {
      setAppsLoading(false);
    }
  }

  // Fetch apps ONCE when the active device changes or first becomes booted (not on the poll).
  useEffect(() => {
    if (!activeUdid || !activeBooted) {
      setApps([]);
      setAppsError(null);
      return;
    }
    let cancelled = false;
    setAppsLoading(true);
    setAppsError(null);
    getApps(activeUdid)
      .then((a) => {
        if (!cancelled) setApps(a);
      })
      .catch((err) => {
        if (!cancelled) setAppsError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setAppsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeUdid, activeBooted]);

  // ─── Device handlers ─────────────────────────────────────────────────────
  async function handleBoot(udid: string) {
    setBootingUdid(udid);
    try {
      await bootDevice(udid);
      await refreshDevices();
      setActiveUdid(udid);
    } catch (err) {
      setDevicesError(err instanceof Error ? err.message : String(err));
    } finally {
      setBootingUdid(null);
    }
  }

  async function handleLaunch() {
    if (!activeUdid || !bundleId.trim()) return;
    setLaunching(true);
    setAppsError(null);
    try {
      await launchApp(activeUdid, bundleId.trim());
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      // Keep the raw simctl/FBSOpenApplication message in the console for anyone debugging —
      // the banner itself shows a plain-Vietnamese message instead (friendly.ts).
      console.error("[podium-studio] launch failed:", raw);
      setAppsError(friendlyLaunchError(t, raw));
    } finally {
      setLaunching(false);
    }
  }

  // ─── Flow handlers ───────────────────────────────────────────────────────
  /** True to proceed; asks the QA to confirm losing unsaved edits when dirty. */
  function confirmDiscardIfDirty(): boolean {
    if (!dirty) return true;
    return window.confirm(t("app.discardConfirm"));
  }

  /** Shared reset for "start authoring a brand-new flow" — used by every Create-a-test path.
   * `tab` picks which editor tab it lands on (Record → "record", Template/Describe → "steps");
   * `flow` defaults to emptyFlow() (Record/Describe) but Template passes its own built Flow. */
  function startNewFlow(tab: MainTab, flow: Flow = emptyFlow()) {
    setOpenFlow(flow);
    setOpenFlowFile(null);
    setIsNewUnsavedFlow(true);
    setCharterDismissed(false);
    setSaveError(null);
    setExportResult(null);
    setExportError(null);
    setMainTab(tab);
    setDirty(false);
  }

  /** "New flow" entry (FlowList toolbar + welcome CTA) — now opens the neutral Create-a-test
   * launcher instead of jumping straight to the Steps tab (Phase A / AC2). */
  function handleNewFlow() {
    if (!confirmDiscardIfDirty()) return;
    setLauncherOpen(true);
  }

  function handleLauncherPickRecord() {
    startNewFlow("record");
    setLauncherOpen(false);
  }

  function handleLauncherPickDescribe() {
    const base = emptyFlow();
    startNewFlow("steps", base);
    setDescribeBaseFlow(base);
    setLauncherOpen(false);
  }

  function handleLauncherPickTemplate(flow: Flow) {
    startNewFlow("steps", flow);
    setLauncherOpen(false);
  }

  async function handleLoadFlow(file: string) {
    if (!confirmDiscardIfDirty()) return;
    setFlowsError(null);
    try {
      const flow = await apiLoadFlow(file);
      setOpenFlow(flow);
      setOpenFlowFile(file);
      // E21: this is now the local "last-known-shared-version" for this flow file — the common
      // ancestor a later 3-way bundle merge needs (shared/flow-diff.ts's `diffFlows`).
      stashBaseline(file, flow);
      setIsNewUnsavedFlow(false);
      setSaveError(null);
      setExportResult(null);
      setExportError(null);
      setMainTab("steps");
      setDirty(false);
    } catch (err) {
      setFlowsError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleFlowChange(flow: Flow) {
    // Auto-fix duplicate step ids internally so a QA never hits "Duplicate step ids".
    const steps = ensureUniqueStepIds(flow.steps);
    setOpenFlow(steps === flow.steps ? flow : { ...flow, steps });
    setDirty(true);
    setJustSaved(false);
  }

  async function handleSave() {
    if (!openFlow) return;
    setSaving(true);
    setSaveError(null);
    try {
      // AUTH-2: pass the file this flow was loaded from (undefined for a brand-new flow) so a
      // rename + Save writes back to the SAME file instead of creating a slug-of-new-name
      // duplicate and orphaning the original on disk.
      const res = await apiSaveFlow(openFlow, { fileName: openFlowFile ?? undefined });
      setOpenFlow(res.flow);
      setOpenFlowFile(res.file);
      stashBaseline(res.file, res.flow); // E21: a fresh save is also a new sync point
      setJustSaved(true);
      setDirty(false);
      window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => setJustSaved(false), 2000);
      refreshFlows();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleExport() {
    if (!openFlow) return;
    setExporting(true);
    setExportError(null);
    setExportResult(null);
    try {
      setExportResult(await apiExportFlow(openFlow));
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }

  // ─── E18: run a tag-filtered suite through the EXISTING /api/suite (E15) ─────────────────
  // filterFlowsByTags (shared/tags.ts) does the narrowing client-side; the endpoint itself
  // needed no changes for this. Requires an active device — every job in a suite request
  // needs a udid, same as a single run does.
  async function handleRunSuite(tags: string[]) {
    if (!activeUdid) {
      setSuiteError(t("flowList.suiteNeedsDevice"));
      return;
    }
    const matched = filterFlowsByTags(flows, tags);
    if (matched.length === 0) return;
    setSuiteRunning(true);
    setSuiteError(null);
    try {
      const loadedFlows = await Promise.all(matched.map((f) => apiLoadFlow(f.file)));
      // E13: expand callSubFlow calls + resolve selector-library refs BEFORE dispatch — every
      // flow the runner ever sees is already pure closed-IR, zero E13-only fields.
      const resolveFlowFile = async (file: string) => {
        try {
          return await apiLoadFlow(file);
        } catch {
          return undefined;
        }
      };
      const prepared = await Promise.all(loadedFlows.map((flow) => prepareFlowForRun(flow, resolveFlowFile)));
      const prepErrors = prepared.flatMap((p) => p.errors);
      if (prepErrors.length > 0) {
        setSuiteError(prepErrors.join(" "));
        return;
      }
      const jobs: SuiteJobRequest[] = prepared.map((p, i) => ({
        udid: activeUdid,
        flow: p.flow,
        tag: loadedFlows[i].tags?.[0],
      }));
      const report = await runSuite({ jobs });
      const traces = report.results.map((summary) => {
        // Match against the EXPANDED flow (not the original) — its step ids are what the
        // runner/StepResult actually used (E13's sub-flow expansion renames ids), so this is
        // what lets buildTrace resolve a proper label for an expanded sub-flow's own steps too.
        const originFlow = prepared.find((p) => p.flow.name === summary.flowName)?.flow ?? prepared[0]?.flow;
        return buildTrace(originFlow, summary);
      });
      setViewingTraces(traces);
    } catch (err) {
      setSuiteError(err instanceof Error ? err.message : String(err));
    } finally {
      setSuiteRunning(false);
    }
  }

  const activeDevice = devices.find((d) => d.udid === activeUdid) ?? null;
  const flowValid = openFlow ? validateFlow(openFlow).ok : false;
  // Is the open flow's target app installed on the active booted device? null = unknown
  // (no device / not booted / apps still loading) → don't block; false = definitely missing.
  const runBundleId = openFlow?.app.bundleId ?? null;
  const appInstalled: boolean | null =
    !runBundleId || activeDevice?.state !== "Booted" || appsLoading
      ? null
      : apps.some((a) => a.bundleId === runBundleId);

  return (
    <div className="app-shell">
      {/* Intro loader overlays everything (position:fixed) until its timeline completes. */}
      {showIntro && <IntroLoader onDone={() => setShowIntro(false)} />}
      <header className="titlebar">
        {/* Auto-P brand mark (matches brand/mark-auto.svg + the dock icon), inlined so it needs
            no asset fetch — the packaged WKWebView can't load bundled files by relative URL. */}
        <svg className="titlebar__mark" viewBox="0 0 512 512" role="img" aria-label={t("app.title")}>
          <path d="M 314 98 A 168 168 0 1 1 198 98" fill="none" stroke="#8b7bff" strokeWidth="18" strokeLinecap="round" />
          <path d="M 220 90 L 199 114 L 189 85 Z" fill="#8b7bff" />
          <path
            d="M 198 350 C 191 280 192 214 197 170 C 256 160 313 174 314 226 C 315 274 256 289 201 280"
            fill="none"
            stroke="#6d5cf6"
            strokeWidth="46"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="titlebar__title">{t("app.title")}</span>
        <div className="titlebar__health">
          <span
            className={`dot ${health?.ok ? "dot--ok" : health ? "dot--fail" : "dot--pending"}`}
          />
          {health?.ok
            ? t("app.connectedStatus")
            : health
              ? t("app.disconnectedStatus")
              : t("app.connectingStatus")}
        </div>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setLocale(locale === "vi" ? "en" : "vi")}
          aria-label={t("app.localeToggleLabel")}
          title={t("app.localeToggleLabel")}
        >
          {locale === "vi" ? "VI" : "EN"}
        </button>
      </header>

      <aside className="sidebar">
        <DevicePanel
          devices={devices}
          devicesLoading={devicesLoading}
          devicesError={devicesError}
          onRefreshDevices={refreshDevices}
          activeUdid={activeUdid}
          onSelectDevice={setActiveUdid}
          bootingUdid={bootingUdid}
          onBoot={handleBoot}
          apps={apps}
          appsLoading={appsLoading}
          appsError={appsError}
          onRefreshApps={refreshApps}
          bundleId={bundleId}
          onBundleIdChange={setBundleId}
          onLaunch={handleLaunch}
          launching={launching}
        />
        <FlowList
          flows={flows}
          loading={flowsLoading}
          error={flowsError}
          openFile={openFlowFile}
          onRefresh={refreshFlows}
          onNewFlow={handleNewFlow}
          onLoadFlow={handleLoadFlow}
          onRunSuite={handleRunSuite}
          runningSuite={suiteRunning}
        />
        {suiteError && (
          <div className="error-banner" role="alert" style={{ margin: "0 4px 8px" }}>
            <Icon.alert size={14} />
            <span>{suiteError}</span>
          </div>
        )}
        <EnvironmentPanel />
        <DoctorPanel />
        <button className="btn btn--ghost btn--sm" style={{ margin: "4px" }} onClick={() => setQualityDashboardOpen(true)}>
          <Icon.info size={13} />
          {t("quality.openButton")}
        </button>
        <button className="btn btn--ghost btn--sm" style={{ margin: "4px" }} onClick={() => setAiSettingsOpen(true)}>
          <Icon.wand size={13} />
          {t("aiSettings.openButton")}
        </button>
      </aside>

      <main className="main">
        {openFlow ? (
          <>
            <div className="tab-bar">
              <button
                className={`tab-bar__tab${mainTab === "steps" ? " tab-bar__tab--active" : ""}`}
                onClick={() => setMainTab("steps")}
                aria-current={mainTab === "steps"}
              >
                <Icon.target size={13} />
                {t("tabs.steps")}
              </button>
              <button
                className={`tab-bar__tab${mainTab === "text" ? " tab-bar__tab--active" : ""}`}
                onClick={() => setMainTab("text")}
                aria-current={mainTab === "text"}
              >
                <Icon.keyboard size={13} />
                {t("tabs.text")}
              </button>
              <button
                className={`tab-bar__tab${mainTab === "record" ? " tab-bar__tab--active" : ""}`}
                onClick={() => setMainTab("record")}
                aria-current={mainTab === "record"}
              >
                <Icon.camera size={13} />
                {t("tabs.record")}
              </button>
              <span className="tab-bar__hint">{t("tabs.hint")}</span>
              {/* Only visible under 960px, where the Run rail collapses into a drawer. */}
              <button
                className={`tab-bar__tab tab-bar__tab--run${runOpen ? " tab-bar__tab--active" : ""}`}
                onClick={() => setRunOpen((v) => !v)}
                aria-current={runOpen}
              >
                <Icon.play size={13} />
                {t("tabs.run")}
              </button>
            </div>

            {mainTab === "steps" && (
              <StepEditor
                flow={openFlow}
                onChange={handleFlowChange}
                onSave={handleSave}
                saving={saving}
                saveError={saveError}
                justSaved={justSaved}
                dirty={dirty}
                onExport={handleExport}
                exporting={exporting}
                exportError={exportError}
                exportResult={exportResult}
                onCloseExport={() => {
                  setExportResult(null);
                  setExportError(null);
                }}
                activeUdid={activeUdid}
                deviceBooted={activeDevice?.state === "Booted"}
                isNewUnsavedFlow={isNewUnsavedFlow}
                availableSubFlows={flows}
                openFlowFile={openFlowFile}
                charterDismissed={charterDismissed}
                onDismissCharter={() => setCharterDismissed(true)}
                aiProviderName={aiProviderName}
              />
            )}

            {mainTab === "text" && (
              <TextStepsPanel flow={openFlow} onChange={handleFlowChange} dirty={dirty} />
            )}

            {mainTab === "record" && (
              <RecordPanel
                activeUdid={activeUdid}
                deviceBooted={activeDevice?.state === "Booted"}
                flow={openFlow}
                onChange={handleFlowChange}
              />
            )}
          </>
        ) : (
          <div className="welcome">
            <div className="welcome__mark">
              {/* Auto-P brand mark (same shape as the titlebar/dock icon), white strokes so it
                  reads on the violet gradient chip. Inlined — the packaged WKWebView can't load
                  bundled assets by relative URL. */}
              <svg viewBox="0 0 512 512" width="40" height="40" role="img" aria-label={t("app.title")}>
                <path d="M 314 98 A 168 168 0 1 1 198 98" fill="none" stroke="#fff" strokeWidth="18" strokeLinecap="round" />
                <path d="M 220 90 L 199 114 L 189 85 Z" fill="#fff" />
                <path
                  d="M 198 350 C 191 280 192 214 197 170 C 256 160 313 174 314 226 C 315 274 256 289 201 280"
                  fill="none"
                  stroke="#fff"
                  strokeWidth="46"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <h1 className="welcome__title">{t("welcome.title")}</h1>
            <p className="welcome__lead">{t("welcome.lead")}</p>
            <ol className="welcome__steps">
              <li>
                <span className="welcome__num">1</span>
                <div>
                  <strong>{t("welcome.step1Title")}</strong>
                  <span className="welcome__desc">{t("welcome.step1Desc")}</span>
                </div>
              </li>
              <li>
                <span className="welcome__num">2</span>
                <div>
                  <strong>{t("welcome.step2Title")}</strong>
                  <span className="welcome__desc">{t("welcome.step2Desc")}</span>
                </div>
              </li>
              <li>
                <span className="welcome__num">3</span>
                <div>
                  <strong>{t("welcome.step3Title")}</strong>
                  <span className="welcome__desc">{t("welcome.step3Desc")}</span>
                </div>
              </li>
            </ol>
            <div className="welcome__cta">
              <button className="btn btn--primary" onClick={handleNewFlow}>
                <Icon.plus size={14} /> {t("welcome.cta")}
              </button>
              <span className="welcome__cta-hint">{t("welcome.ctaHint")}</span>
            </div>
          </div>
        )}
      </main>

      {runOpen && <div className="run-rail-backdrop" onClick={() => setRunOpen(false)} />}
      <aside className={`run-rail${runOpen ? " run-rail--open" : ""}`}>
        <RunPanel
          activeUdid={activeUdid}
          deviceBooted={activeDevice?.state === "Booted"}
          flow={openFlow}
          flowValid={flowValid}
          appInstalled={appInstalled}
          appBundleId={runBundleId}
          onOpenTrace={(summary) => {
            if (openFlow) setViewingTraces([buildTrace(openFlow, summary)]);
          }}
          onOpenTriage={(summary) => {
            if (openFlow) setViewingTriage({ summary, trace: buildTrace(openFlow, summary) });
          }}
        />
      </aside>

      {viewingTraces && <TraceViewer traces={viewingTraces} onClose={() => setViewingTraces(null)} />}
      {viewingTriage && openFlow && (
        <TriagePanel
          summary={viewingTriage.summary}
          trace={viewingTriage.trace}
          flow={openFlow}
          onClose={() => setViewingTriage(null)}
        />
      )}
      {qualityDashboardOpen && <QualityDashboard onClose={() => setQualityDashboardOpen(false)} />}
      {launcherOpen && (
        <CreateTestLauncher
          onPickRecord={handleLauncherPickRecord}
          onPickDescribe={handleLauncherPickDescribe}
          onPickTemplate={handleLauncherPickTemplate}
          onClose={() => setLauncherOpen(false)}
        />
      )}
      {describeBaseFlow && (
        <DescribeTestPrompt
          flow={describeBaseFlow}
          providerName={aiProviderName}
          onApply={(merged) => {
            handleFlowChange(merged);
            setDescribeBaseFlow(null);
          }}
          onClose={() => setDescribeBaseFlow(null)}
          onOpenAiSettings={() => {
            setDescribeBaseFlow(null);
            setAiSettingsOpen(true);
          }}
        />
      )}
      {aiSettingsOpen && (
        <AiSettingsPanel
          onClose={() => {
            setAiSettingsOpen(false);
            refreshAiProviderName(); // a provider may have just been added/renamed/removed
          }}
        />
      )}
    </div>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <AppShell />
    </I18nProvider>
  );
}
