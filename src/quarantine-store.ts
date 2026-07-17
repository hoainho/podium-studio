import type { QuarantineOverride } from "../shared/flakiness.ts";

/**
 * quarantine-store.ts — the browser-glue half of E23's manual quarantine override (AC4).
 * `shared/flakiness.ts`'s `effectiveQuarantineState` is the pure decision function; this module
 * is just where the QA's manual choice is persisted. Local-first (localStorage), same disclosed
 * "stand-in for E9's primary tier" convention as src/bundle-io.ts's baseline stash and
 * src/telemetry.ts's local event store — bridge/db is off-limits this round.
 */

const KEY_PREFIX = "podium.quarantineOverride.";

export function getQuarantineOverride(key: string): QuarantineOverride | undefined {
  try {
    const raw = window.localStorage.getItem(KEY_PREFIX + key);
    return raw === "quarantined" || raw === "active" ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** `undefined` clears the override entirely — the item then falls back to the auto-computed
 * threshold result (shared/flakiness.ts's own default behavior). */
export function setQuarantineOverride(key: string, override: QuarantineOverride | undefined): void {
  try {
    if (override === undefined) window.localStorage.removeItem(KEY_PREFIX + key);
    else window.localStorage.setItem(KEY_PREFIX + key, override);
  } catch {
    // Full/disabled localStorage degrades to "no override recorded" — never throws, same
    // convention as every other local-store helper in this codebase.
  }
}

/** Every key with a manual override currently recorded — used by the dashboard to know which
 * items to check without having to probe every possible flow name individually. */
export function listQuarantineOverrideKeys(): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k?.startsWith(KEY_PREFIX)) keys.push(k.slice(KEY_PREFIX.length));
    }
  } catch {
    return [];
  }
  return keys;
}
