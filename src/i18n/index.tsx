import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { vi } from "./locales/vi.ts";
import { en } from "./locales/en.ts";

/**
 * i18n scaffold (E6). `vi` is the default locale (non-negotiable #3, Vietnamese-first);
 * `en` is a working fallback — both a selectable locale and the lookup fallback for any
 * key missing from `vi`. The app shell and every panel component pull their static UI
 * copy from this layer; dynamic content (server errors, DSL syntax, external ids) is
 * left as-is per the E6 spec's own scope.
 */

export type Locale = "vi" | "en";
export type Messages = typeof vi;

const MESSAGES: Record<Locale, Messages> = { vi, en };
const STORAGE_KEY = "podium-studio.locale";
const DEFAULT_LOCALE: Locale = "vi";

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  messages: Messages;
}

const I18nContext = createContext<I18nContextValue | null>(null);

function loadStoredLocale(): Locale {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return saved === "en" ? "en" : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE; // private-mode / no storage — fall back to the Vietnamese default
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(loadStoredLocale);

  function setLocale(next: Locale) {
    setLocaleState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode / storage disabled — locale still switches for this session */
    }
  }

  const value = useMemo<I18nContextValue>(
    () => ({ locale, setLocale, messages: MESSAGES[locale] }),
    [locale],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within an <I18nProvider>");
  return ctx;
}

function digPath(obj: unknown, path: string): string | undefined {
  const value = path
    .split(".")
    .reduce<unknown>((acc, part) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined), obj);
  return typeof value === "string" ? value : undefined;
}

/**
 * t("flowList.stepsCount", { n: 3 }) — dotted-path lookup in the active locale, falling
 * back to `en`, then the raw key. `vars` fills `{{name}}` placeholders in the resolved
 * string (used for counts like "3 steps parsed" that can't be a static key).
 */
export function useT(): (path: string, vars?: Record<string, string | number>) => string {
  const { messages } = useI18n();
  return (path: string, vars?: Record<string, string | number>) => {
    const raw = digPath(messages, path) ?? digPath(en, path) ?? path;
    if (!vars) return raw;
    return Object.entries(vars).reduce((acc, [key, val]) => acc.replaceAll(`{{${key}}}`, String(val)), raw);
  };
}
