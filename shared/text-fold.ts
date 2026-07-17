/**
 * text-fold.ts — Vietnamese/Unicode-safe text matching (E6, Pillar K/#3 Vietnamese-first).
 *
 * Folds diacritics, case, and whitespace so a locator or `assert text` can match
 * "Đăng nhập" against "dang nhap" or "  ĐĂNG NHẬP  " — the same three variants a QA
 * types interchangeably. This is the shared primitive; wiring it into the runner's
 * actual locator/assert match path is a later epic (this epic only ships the helper
 * + its test coverage, per spec AC4).
 */

/**
 * NFD-normalize and strip combining diacritical marks. Vietnamese đ/Đ (U+0111/U+0110)
 * don't have an NFD decomposition (they're not "d" + a combining stroke), so they're
 * folded explicitly.
 */
function stripDiacritics(input: string): string {
  return input
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

/** Collapse internal whitespace runs to a single space and trim the ends. */
function foldWhitespace(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}

/** Canonicalize a string for Vietnamese/Unicode-safe comparison: strip diacritics, fold whitespace, lowercase. */
export function foldText(input: string): string {
  return foldWhitespace(stripDiacritics(input)).toLowerCase();
}

/** True if two strings match under diacritic/case/whitespace folding. */
export function textMatches(a: string, b: string): boolean {
  return foldText(a) === foldText(b);
}

/** True if `haystack` contains `needle` under diacritic/case/whitespace folding (for `tapText` / `assert text`). */
export function textContains(haystack: string, needle: string): boolean {
  return foldText(haystack).includes(foldText(needle));
}
