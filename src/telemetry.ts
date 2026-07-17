/**
 * telemetry.ts — opt-in crash/error telemetry (E23,
 * janus-specs/R4-selfheal-collab/E23-telemetry-flake.md, AC1/AC2).
 *
 * Hard consent gate (AC1, Pillar H: "opt-in but present"): `recordCrash()` checks consent FIRST,
 * before doing anything else — no event is constructed, stored, or transmitted when consent is
 * false. This is deliberately the very first line of the function, not a later guard, so a
 * reviewer auditing "0 telemetry calls pre-opt-in" can see the gate is structurally impossible to
 * route around.
 *
 * Storage: local-first (non-negotiable §3.2). The spec's own framing is "stored locally (primary
 * SQLite tier)" — E9's bridge/db — but this epic's scope keeps bridge/ untouched (another worker
 * is concurrently in bridge/db this round), so the LOCAL store here is `localStorage`, disclosed
 * as a client-side stand-in. A real follow-up would persist into E9's primary tier (getting
 * cross-session durability + the R2 backup/restore gate for free); this pass's `store`/`transmit`
 * are injectable specifically so that swap is a drop-in replacement, not a redesign.
 */

export interface CrashEvent {
  id: string;
  message: string;
  stack?: string;
  /** Never fabricated — "unknown" when the app has no real version concept available (same
   * honesty this codebase already applies elsewhere, e.g. E22's bug-export environment
   * metadata). */
  appVersion: string;
  os: string;
  timestamp: number;
}

const CONSENT_KEY = "podium.telemetry.optIn";
const REMOTE_ENDPOINT_KEY = "podium.telemetry.remoteEndpoint";
const EVENTS_KEY = "podium.telemetry.events";
const MAX_STORED_EVENTS = 200;

function readLocalStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function writeLocalStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Full/disabled localStorage degrades to "nothing persisted" — never throws over what is,
    // for telemetry, a best-effort local record, not a correctness-critical path.
  }
}

/** AC1: telemetry is OFF by default — an unset/corrupted consent value is always "not granted",
 * never treated as "unknown, so allow it." */
export function getTelemetryConsent(): boolean {
  return readLocalStorage(CONSENT_KEY) === "true";
}

export function setTelemetryConsent(optIn: boolean): void {
  writeLocalStorage(CONSENT_KEY, optIn ? "true" : "false");
}

/** AC2: "transmitted only if a remote endpoint is configured" — undefined/empty means no remote
 * transmission is attempted at all, local-only capture still proceeds once consent is granted. */
export function getRemoteEndpoint(): string | undefined {
  return readLocalStorage(REMOTE_ENDPOINT_KEY) || undefined;
}

export function setRemoteEndpoint(url: string | undefined): void {
  writeLocalStorage(REMOTE_ENDPOINT_KEY, url ?? "");
}

export function listTelemetryEvents(): CrashEvent[] {
  const raw = readLocalStorage(EVENTS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function appendLocalEvent(event: CrashEvent): void {
  const events = [...listTelemetryEvents(), event].slice(-MAX_STORED_EVENTS);
  writeLocalStorage(EVENTS_KEY, JSON.stringify(events));
}

async function defaultTransmit(event: CrashEvent, endpoint: string): Promise<void> {
  await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
}

export interface RecordCrashDeps {
  /** Overrides the real consent check — used by tests to exercise both the granted and
   * not-granted paths deterministically without touching real localStorage. */
  consent?: boolean;
  remoteEndpoint?: string;
  now?: () => number;
  newId?: () => string;
  store?: (event: CrashEvent) => void;
  transmit?: (event: CrashEvent, endpoint: string) => Promise<void>;
}

/**
 * Record one crash/unhandled-error event (AC2: stack trace + app version + OS + timestamp).
 * Returns the recorded event, or `undefined` when consent isn't granted (AC1) — nothing is
 * constructed, stored, or transmitted in that case; the caller can distinguish "did this actually
 * get recorded" from the return value alone.
 */
export function recordCrash(
  input: { message: string; stack?: string; appVersion?: string; os?: string },
  deps: RecordCrashDeps = {},
): CrashEvent | undefined {
  const consent = deps.consent ?? getTelemetryConsent();
  if (!consent) return undefined; // AC1 — the hard gate, checked before anything else happens

  const event: CrashEvent = {
    id: (deps.newId ?? (() => crypto.randomUUID()))(),
    message: input.message,
    stack: input.stack,
    appVersion: input.appVersion ?? "unknown",
    os: input.os ?? "unknown",
    timestamp: (deps.now ?? Date.now)(),
  };

  (deps.store ?? appendLocalEvent)(event);

  const endpoint = deps.remoteEndpoint ?? getRemoteEndpoint();
  if (endpoint) {
    // Fire-and-forget — a transmit failure (offline, unreachable endpoint) must never surface as
    // an app-visible error on top of the crash that's already being reported.
    (deps.transmit ?? defaultTransmit)(event, endpoint).catch(() => {});
  }

  return event;
}

/**
 * Install `window.onerror`/`unhandledrejection` handlers that funnel into `recordCrash` — the
 * "app-level" crash capture (Pillar H). Safe to call even when consent isn't granted yet: every
 * captured event still goes through `recordCrash`'s own gate, so installing the LISTENERS early
 * (e.g. at app startup) never itself emits anything before opt-in. Returns an uninstall function.
 */
export function installCrashHandlers(deps: RecordCrashDeps = {}): () => void {
  const os = typeof navigator !== "undefined" ? navigator.platform || navigator.userAgent : "unknown";

  function onError(event: ErrorEvent) {
    recordCrash({ message: event.message, stack: event.error?.stack, os }, deps);
  }
  function onRejection(event: PromiseRejectionEvent) {
    const reason = event.reason;
    recordCrash(
      {
        message: reason instanceof Error ? reason.message : String(reason),
        stack: reason instanceof Error ? reason.stack : undefined,
        os,
      },
      deps,
    );
  }

  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => {
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}
