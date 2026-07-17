import type { Device, InstalledApp } from "../../shared/protocol.ts";
import { useT } from "../i18n/index.tsx";
import { Icon } from "./icons.tsx";
import { InfoTip } from "./InfoTip.tsx";

export interface DevicePanelProps {
  devices: Device[];
  devicesLoading: boolean;
  devicesError: string | null;
  onRefreshDevices: () => void;

  activeUdid: string | null;
  onSelectDevice: (udid: string) => void;

  bootingUdid: string | null;
  onBoot: (udid: string) => void;

  apps: InstalledApp[];
  appsLoading: boolean;
  appsError: string | null;
  onRefreshApps: () => void;

  bundleId: string;
  onBundleIdChange: (bundleId: string) => void;
  onLaunch: () => void;
  launching: boolean;
}

export default function DevicePanel(props: DevicePanelProps) {
  const {
    devices,
    devicesLoading,
    devicesError,
    onRefreshDevices,
    activeUdid,
    onSelectDevice,
    bootingUdid,
    onBoot,
    apps,
    appsLoading,
    appsError,
    onRefreshApps,
    bundleId,
    onBundleIdChange,
    onLaunch,
    launching,
  } = props;
  const t = useT();

  const activeDevice = devices.find((d) => d.udid === activeUdid) ?? null;
  const activeIsBooted = activeDevice?.state === "Booted";

  return (
    <div>
      <div className="panel">
        <div className="panel__header">
          <span className="panel__title">{t("devicePanel.title")}</span>
          <button
            className="btn btn--ghost btn--icon"
            onClick={onRefreshDevices}
            disabled={devicesLoading}
            aria-label={t("devicePanel.refreshAria")}
            title={t("devicePanel.refreshTitle")}
          >
            {devicesLoading ? <span className="spinner" /> : <Icon.refresh />}
          </button>
        </div>

        {devicesError && (
          <div className="error-banner" role="alert">
            <Icon.alert size={14} />
            <span>{devicesError}</span>
          </div>
        )}

        {!devicesError && devices.length === 0 && (
          <div className="empty-state" style={{ padding: "20px 4px" }}>
            <div className="empty-state__icon">
              <Icon.device size={22} />
            </div>
            <div className="empty-state__title">
              {devicesLoading ? t("devicePanel.loading") : t("devicePanel.empty")}
            </div>
          </div>
        )}

        <div className="device-list">
          {devices.map((d) => {
            const isBooted = d.state === "Booted";
            const isActive = d.udid === activeUdid;
            const isBooting = bootingUdid === d.udid;
            return (
              <div
                key={d.udid}
                className={`device-row${isActive ? " device-row--active" : ""}`}
              >
                <button
                  type="button"
                  className={`dot dot--${isBooted ? "ok" : "pending"}`}
                  style={{ border: "none", padding: 0 }}
                  aria-hidden="true"
                  tabIndex={-1}
                />
                <button
                  type="button"
                  className="device-row__main"
                  onClick={() => onSelectDevice(d.udid)}
                  aria-pressed={isActive}
                >
                  <span className="device-row__name" title={d.name}>{d.name}</span>
                  <span className="device-row__meta" title={`${d.state} · ${d.runtime.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, "")}`}>
                    {d.state} · {d.runtime.replace(/^com\.apple\.CoreSimulator\.SimRuntime\./, "")}
                  </span>
                </button>
                {!isBooted && (
                  <button
                    className="btn btn--sm btn--ghost"
                    onClick={() => onBoot(d.udid)}
                    disabled={isBooting}
                    title={t("devicePanel.startTitle", { name: d.name })}
                  >
                    {isBooting ? <span className="spinner" /> : <Icon.power size={13} />}
                    {t("devicePanel.startButton")}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="panel">
        <div className="panel__header">
          <span className="panel__title">{t("devicePanel.appsTitle")}</span>
          <button
            className="btn btn--ghost btn--icon"
            onClick={onRefreshApps}
            disabled={!activeIsBooted || appsLoading}
            aria-label={t("devicePanel.appsRefreshAria")}
            title={t("devicePanel.appsRefreshTitle")}
          >
            {appsLoading ? <span className="spinner" /> : <Icon.refresh />}
          </button>
        </div>

        {!activeDevice && (
          <div className="empty-state" style={{ padding: "20px 4px" }}>
            <div className="empty-state__title">{t("devicePanel.noActiveDevice")}</div>
            <div className="empty-state__hint">{t("devicePanel.noActiveDeviceHint")}</div>
          </div>
        )}

        {activeDevice && !activeIsBooted && (
          <div className="hint-banner">
            <Icon.info size={14} />
            <span>{t("devicePanel.startDeviceHint", { name: activeDevice.name })}</span>
          </div>
        )}

        {activeDevice && activeIsBooted && (
          // Reserve a stable height so the panel never collapses/jumps between the
          // loading, empty, and list states.
          <div style={{ minHeight: 132 }}>
            {appsError && (
              <div className="error-banner" role="alert">
                <Icon.alert size={14} />
                <span>{appsError}</span>
              </div>
            )}
            {/* Only a first-load placeholder — during a manual refresh the existing list
                stays on screen (only the header shows a spinner), so nothing flickers. */}
            {appsLoading && apps.length === 0 && !appsError && (
              <div className="faint" style={{ padding: "8px 4px" }}>{t("devicePanel.appsLoading")}</div>
            )}
            {!appsLoading && !appsError && apps.length === 0 && (
              <div className="faint" style={{ padding: "8px 4px" }}>{t("devicePanel.noApps")}</div>
            )}
            <div className="device-list" style={{ maxHeight: 220, overflowY: "auto" }}>
              {apps.map((a) => (
                <div className="app-row" key={a.bundleId}>
                  <div className="app-row__main">
                    <div className="app-row__name">{a.name}</div>
                    <div className="app-row__id">{a.bundleId}</div>
                  </div>
                  <button
                    className="btn btn--sm btn--ghost"
                    onClick={() => onBundleIdChange(a.bundleId)}
                    title={t("devicePanel.useButtonTitle")}
                  >
                    {t("devicePanel.useButton")}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="stack" style={{ marginTop: 12 }}>
          <div className="field">
            <span className="field__label-row">
              <label className="field__label" htmlFor="bundle-id-input">
                {t("devicePanel.bundleIdLabel")}
              </label>
              <InfoTip text={t("devicePanel.bundleIdTip")} example="com.apple.mobilesafari" />
            </span>
            <input
              id="bundle-id-input"
              className="input mono"
              value={bundleId}
              onChange={(e) => onBundleIdChange(e.target.value)}
              placeholder="com.example.demoapp"
              spellCheck={false}
            />
          </div>
          <button
            className="btn btn--primary"
            onClick={onLaunch}
            disabled={!activeIsBooted || !bundleId.trim() || launching}
          >
            {launching ? <span className="spinner" /> : <Icon.rocket size={13} />}
            {t("devicePanel.launchButton")}
          </button>
        </div>
      </div>
    </div>
  );
}
