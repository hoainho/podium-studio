/**
 * tags.ts — suite-by-tag filtering (E18, janus-specs/R3-reuse-browser/E18-tags-trace.md).
 *
 * Kept as its own small file rather than folded into shared/ir.ts (this epic's own scope keeps
 * that diff to just the `tags` schema field) or bridge/server.ts (owned by a concurrent worker
 * this round) — a pure, generic filter over anything shaped `{ tags?: string[] }`, so it works
 * identically over full `Flow` objects and the lighter-weight flow-listing shape the UI already
 * uses, without either caller needing to load full flow JSON just to filter by tag.
 */

export interface Taggable {
  tags?: string[];
}

/**
 * Filter a list down to items whose tags satisfy BOTH:
 *   - `include` (if given, non-empty): the item has AT LEAST ONE tag in this list (OR semantics
 *     — "smoke" or "checkout" runs anything tagged either, matching AC1's "flows whose tags
 *     match", not requiring every included tag on a single flow).
 *   - `exclude` (if given): the item has NONE of these tags.
 * An empty/omitted `include` means "no include filter" (everything passes that step) — this is
 * what makes an all-exclude call (e.g. "run everything except @flaky") work without also having
 * to enumerate every other tag. The result is exact — no off-by-one, no wildcard leakage — the
 * review gate's own AC1 wording ("executed count equals the exact tag-membership count").
 */
export function filterFlowsByTags<T extends Taggable>(
  items: readonly T[],
  include?: readonly string[],
  exclude?: readonly string[],
): T[] {
  const includeSet = include && include.length > 0 ? new Set(include) : undefined;
  const excludeSet = exclude && exclude.length > 0 ? new Set(exclude) : undefined;
  return items.filter((item) => {
    const tags = item.tags ?? [];
    if (includeSet && !tags.some((t) => includeSet.has(t))) return false;
    if (excludeSet && tags.some((t) => excludeSet.has(t))) return false;
    return true;
  });
}

/** Every distinct tag across a list of items, sorted for stable UI rendering (e.g. a filter
 * chip row) — never invents a tag, never drops a real one, order-independent of input order. */
export function collectAllTags<T extends Taggable>(items: readonly T[]): string[] {
  const set = new Set<string>();
  for (const item of items) for (const t of item.tags ?? []) set.add(t);
  return [...set].sort();
}
