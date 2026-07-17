import type { Flow } from "../shared/ir.ts";
import { ApiError } from "./api.ts";

/**
 * Plain-language helpers so a non-technical QA never sees raw engine / Maestro / Zod
 * strings. Every mapper falls back to a calm generic sentence — the raw text is only
 * ever shown behind an explicit "Show technical details" toggle.
 *
 * Every friendly.* helper here (`friendlyRunError`/`friendlyValidation`/`friendlyStepError`/
 * `platformLabel`/`friendlyLaunchError`/`friendlyApiError`) takes `t` and returns a string looked
 * up from src/i18n/locales/{vi,en}.ts's `friendly.*` keys instead of a hardcoded sentence, so the
 * EN/VI toggle translates them fully — no language ever leaks in the wrong mode.
 */
type T = (path: string, vars?: Record<string, string | number>) => string;

/** Turn a raw run / record error into one plain sentence + a suggested next action. */
export function friendlyRunError(t: T, raw: string | null | undefined): string {
  if (!raw || !raw.trim()) return t("friendly.runError.generic");
  const s = raw.toLowerCase();

  if (s.includes("ambiguous")) return t("friendly.runError.ambiguous");
  if (
    s.includes("not visible") ||
    s.includes("not found") ||
    s.includes("no element") ||
    s.includes("could not find") ||
    s.includes("couldn't find") ||
    s.includes("no view")
  )
    return t("friendly.runError.notFound");
  if (s.includes("not installed") || s.includes("no app") || s.includes("app is not") || s.includes("no such app"))
    return t("friendly.runError.notInstalled");
  if (s.includes("timed out") || s.includes("timeout") || s.includes("deadline"))
    return t("friendly.runError.timeout");
  if (s.includes("not booted") || s.includes("not started") || s.includes("shutdown"))
    return t("friendly.runError.notBooted");
  if (
    s.includes("maestro") ||
    s.includes("run_steps") ||
    s.includes("econnrefused") ||
    s.includes("fetch failed") ||
    s.includes("socket") ||
    s.includes("spawn") ||
    s.includes("driver")
  )
    return t("friendly.runError.driverTrouble");
  return t("friendly.runError.fallback");
}

/**
 * Turn a raw app-launch failure (simctl / FBSOpenApplicationServiceErrorDomain, e.g. "launch
 * failed (code 4)... failed to launch safari") into one plain Vietnamese sentence. The single
 * most common cause by far is a bundle id that isn't actually a bundle id — a plain app name
 * like "safari" instead of the real identifier ("com.apple.mobilesafari") — so that's what this
 * leads with; the raw message is never lost, only kept out of the primary banner (callers should
 * still log/keep it available behind a "technical details" toggle if they have one).
 */
export function friendlyLaunchError(t: T, raw: string | null | undefined): string {
  if (!raw || !raw.trim()) return t("friendly.launchError.generic");
  const s = raw.toLowerCase();

  if (
    s.includes("fbsopenapplication") ||
    s.includes("code 4") ||
    s.includes("launch failed") ||
    s.includes("failed to launch")
  ) {
    return t("friendly.launchError.badBundle");
  }
  if (s.includes("not installed") || s.includes("no such app") || s.includes("no app"))
    return t("friendly.launchError.notInstalled");
  if (s.includes("not booted") || s.includes("not started") || s.includes("shutdown"))
    return t("friendly.launchError.notBooted");
  return t("friendly.launchError.fallback");
}

export interface FriendlyValidation {
  general: string[];
  byStep: Map<number, string[]>;
}

/**
 * Map raw Zod validation strings into plain guidance, keyed by step. "Duplicate step ids"
 * is an internal concern and is never surfaced (it's fixed automatically on edit).
 */
export function friendlyValidation(t: T, errors: string[], flow: Flow): FriendlyValidation {
  const byStep = new Map<number, string[]>();
  const general: string[] = [];

  for (const err of errors) {
    if (err.startsWith("Duplicate step ids")) continue; // handled internally

    const stepMatch = /^steps\.(\d+)\.(.+)$/.exec(err);
    if (stepMatch) {
      const idx = Number(stepMatch[1]);
      const rest = stepMatch[2];
      const field = rest.split(":")[0]?.trim() ?? "";
      const action = flow.steps[idx]?.action ?? "";
      const list = byStep.get(idx) ?? [];
      list.push(friendlyStepError(t, action, field));
      byStep.set(idx, list);
      continue;
    }

    if (err.startsWith("name")) {
      general.push(t("friendly.validation.needName"));
    } else if (err.startsWith("app.bundleId") || err.startsWith("app.")) {
      general.push(t("friendly.validation.needApp"));
    } else {
      general.push(t("friendly.validation.generic"));
    }
  }

  // De-dupe repeated general messages.
  return { general: [...new Set(general)], byStep };
}

function friendlyStepError(t: T, action: string, field: string): string {
  switch (field) {
    case "text":
      switch (action) {
        case "tapText":
        case "doubleTap":
        case "longPress":
        case "tapIfVisible":
          return t("friendly.stepError.textTap");
        case "assertVisible":
          return t("friendly.stepError.textAssertVisible");
        case "assertNotVisible":
        case "waitForNotVisible":
          return t("friendly.stepError.textDisappear");
        case "waitFor":
          return t("friendly.stepError.textWaitFor");
        case "scrollUntilVisible":
          return t("friendly.stepError.textScrollUntil");
        case "copyText":
          return t("friendly.stepError.textCopy");
        case "type":
          return t("friendly.stepError.textType");
        default:
          return t("friendly.stepError.textGeneric");
      }
    case "url":
      return t("friendly.stepError.url");
    case "maestro":
      return t("friendly.stepError.maestro");
    case "x":
    case "y":
    case "startX":
    case "startY":
    case "endX":
    case "endY":
      return t("friendly.stepError.coord");
    case "count":
      return t("friendly.stepError.count");
    case "ms":
      return t("friendly.stepError.ms");
    case "timeoutMs":
      return t("friendly.stepError.timeoutMs");
    case "key":
      return t("friendly.stepError.key");
    case "flowFile":
      return t("friendly.stepError.flowFile");
    default:
      return t("friendly.stepError.generic");
  }
}

/**
 * Turn an api.ts `request()` failure into one calm sentence.
 *
 * QA audit AI-3 fix: the old version special-cased ONLY status 404 and 0, so EVERY other failure
 * — including every 400/500 that already carried a specific, human-meaningful `{ error }` reason
 * from the bridge (e.g. "AI provider key ... not found", "Invalid AI mode ...", the co-pilot
 * "check your API key" hint) — collapsed to the fully generic "Something went wrong talking to the
 * server", discarding the one piece of actionable information the user needed. That is exactly the
 * bug users kept reporting. Now: a connection failure (status 0) and a genuine missing endpoint
 * (404) still map to their calm localized sentences, but when the bridge returned a real reason
 * (`ApiError.serverMessage`, set by `request()` only when the JSON body had an `error` field — NOT
 * a bare "500 Internal Server Error" status line), that specific, already-curated message is shown
 * verbatim. Falls back to the generic sentence only when there was no server-provided reason.
 */
export function friendlyApiError(t: T, err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 0) return t("friendly.apiError.network");
    if (err.status === 404) return t("friendly.apiError.notFound");
    if (err.serverMessage && err.serverMessage.trim() !== "") return err.serverMessage;
  }
  return t("friendly.apiError.generic");
}

/** Friendly label for a platform code shown in badges. */
export function platformLabel(t: T, platform: string): string {
  if (platform === "ios-sim") return t("friendly.platformLabel.ios-sim");
  if (platform === "android-emu") return t("friendly.platformLabel.android-emu");
  return platform;
}

/** Ensure every step has a unique id (auto-fix so "Duplicate step ids" never blocks a QA). */
export function ensureUniqueStepIds<T extends { id: string }>(steps: T[]): T[] {
  const seen = new Set<string>();
  let changed = false;
  const next = steps.map((s) => {
    if (seen.has(s.id)) {
      changed = true;
      seen.add(s.id);
      return { ...s, id: crypto.randomUUID() };
    }
    seen.add(s.id);
    return s;
  });
  return changed ? next : steps;
}
