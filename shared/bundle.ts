import { containerChildren, validateFlow, withContainerChildren, type Flow, type FlowStep } from "./ir.ts";

/**
 * bundle.ts — flow bundle export/import (E21, janus-specs/R4-selfheal-collab/E21-collaboration.md).
 *
 * A "flow bundle" packages one flow + every sub-flow it (transitively) `callSubFlow`s into a
 * SINGLE shareable file — the non-Git collaboration path P1 needs (Pillar R; §2 P1 bar: no Git
 * literacy required). "Zipped" in the spec is interpreted as "packaged into one file," not
 * literal DEFLATE compression — the bundle is a single self-describing JSON document (a flow's
 * own JSON is already the source of truth everywhere else in this codebase; a second, binary
 * archive format would add a dependency for no fidelity benefit an AC actually requires). If a
 * literal .zip container is ever needed, this module's `FlowBundle` shape is exactly what would
 * go inside one — an additive follow-up, not a redesign.
 *
 * Pure and isomorphic (no fetch, no DOM, no filesystem) — the browser-only glue (triggering a
 * file download, reading a picked file, stashing a local merge baseline) lives in src/bundle-
 * io.ts instead, same "pure logic in shared/, environment glue in src/" split this codebase
 * already uses for shared/subflow.ts vs its src/ callers.
 */

export const BUNDLE_SCHEMA_VERSION = 1 as const;

export interface FlowBundle {
  schemaVersion: 1;
  exportedAt: number;
  /** The flow's own file name (bridge/flows-store.ts identity) — lets the importer recognize
   * "I already have this flow" vs. "this is new to me". */
  sourceFile: string;
  flow: Flow;
  /** Every sub-flow the flow (transitively) calls via `callSubFlow` (E13), keyed by file name —
   * AC2: round-trip fidelity covers "the flow AND all referenced sub-flows/fixtures." A flow's
   * own `fixtures` field travels for free since it's already part of the `Flow` object itself. */
  subFlows: Record<string, Flow>;
  /** The flow's content as the EXPORTING QA last loaded/saved it, before their own further
   * edits — the common ancestor a genuine 3-way merge needs (shared/flow-diff.ts's `diffFlows`).
   * Omitted when the exporter has no such snapshot (e.g. a flow authored fresh, never previously
   * synced) — the diff then falls back to a conservative 2-way heuristic (documented there). */
  baseFlow?: Flow;
}

/**
 * Walk `flow` (recursing through if/repeat containers, E4, and transitively through every
 * `callSubFlow` reference, E13) to collect every distinct sub-flow FILE it depends on. Does not
 * itself fetch/read those files — the caller (src/bundle-io.ts) resolves each via the existing
 * `loadFlow` API and feeds the result back into `buildBundle`'s `subFlows` map, since resolving a
 * file's content is an I/O concern this module deliberately stays free of.
 */
export function collectSubFlowFiles(flow: Flow, out: Set<string> = new Set()): Set<string> {
  function walk(steps: FlowStep[]) {
    for (const step of steps) {
      if (step.action === "callSubFlow") out.add(step.flowFile);
      const children = containerChildren(step);
      if (children) walk(children);
    }
  }
  walk(flow.steps);
  return out;
}

/**
 * Recursively collect every distinct sub-flow file transitively reachable from `flow`, given a
 * `resolve` lookup for an ALREADY-FETCHED sub-flow's own content (so a sub-flow-of-a-sub-flow's
 * own `callSubFlow` references are followed too) — mirrors shared/subflow.ts's own transitive-
 * call-graph walk, but collecting file names instead of expanding steps.
 */
export function collectSubFlowFilesTransitive(flow: Flow, resolve: (file: string) => Flow | undefined): Set<string> {
  const out = new Set<string>();
  const pending = [...collectSubFlowFiles(flow)];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (out.has(file)) continue;
    out.add(file);
    const sub = resolve(file);
    if (!sub) continue; // unresolvable — surfaced as a bundle error by the caller, not here
    for (const nested of collectSubFlowFiles(sub)) {
      if (!out.has(nested)) pending.push(nested);
    }
  }
  return out;
}

export function buildBundle(
  sourceFile: string,
  flow: Flow,
  subFlows: Record<string, Flow>,
  baseFlow?: Flow,
): FlowBundle {
  return {
    schemaVersion: BUNDLE_SCHEMA_VERSION,
    exportedAt: Date.now(),
    sourceFile,
    flow,
    subFlows,
    ...(baseFlow ? { baseFlow } : {}),
  };
}

export function serializeBundle(bundle: FlowBundle): string {
  return JSON.stringify(bundle, null, 2);
}

export interface ParseBundleResult {
  ok: boolean;
  bundle?: FlowBundle;
  errors: string[];
}

/**
 * Parse + validate a bundle from raw file text. Every embedded flow (the main flow, every
 * sub-flow, and the optional baseFlow) is re-validated through the SAME `validateFlow` every
 * other flow in this app goes through — a bundle can never inject a schema-invalid flow into a
 * Workspace just because it arrived via file import instead of the normal save path.
 */
export function parseBundle(raw: string): ParseBundleResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, errors: ["Tệp không phải JSON hợp lệ."] };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, errors: ["Tệp gói không đúng định dạng."] };
  }
  const p = parsed as Record<string, unknown>;
  if (p.schemaVersion !== BUNDLE_SCHEMA_VERSION) {
    return { ok: false, errors: [`Phiên bản gói không được hỗ trợ: ${String(p.schemaVersion)}.`] };
  }
  if (typeof p.sourceFile !== "string" || !p.sourceFile) {
    return { ok: false, errors: ["Gói thiếu tên tệp nguồn (sourceFile)."] };
  }

  const errors: string[] = [];
  const flowResult = validateFlow(p.flow);
  if (!flowResult.ok) errors.push(...flowResult.errors.map((e) => `Luồng chính: ${e}`));

  const subFlows: Record<string, Flow> = {};
  if (p.subFlows && typeof p.subFlows === "object") {
    for (const [file, raw] of Object.entries(p.subFlows as Record<string, unknown>)) {
      const r = validateFlow(raw);
      if (!r.ok) errors.push(...r.errors.map((e) => `Luồng con "${file}": ${e}`));
      else subFlows[file] = r.flow!;
    }
  }

  let baseFlow: Flow | undefined;
  if (p.baseFlow) {
    const r = validateFlow(p.baseFlow);
    if (r.ok) baseFlow = r.flow;
    // An invalid/unreadable baseFlow degrades to "no base" (conservative 2-way diff) rather
    // than blocking the whole import — the base is an optimization for a cleaner 3-way merge,
    // never a requirement for AC2's round-trip fidelity.
  }

  if (errors.length > 0 || !flowResult.ok) return { ok: false, errors };

  return {
    ok: true,
    errors: [],
    bundle: {
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      exportedAt: typeof p.exportedAt === "number" ? p.exportedAt : Date.now(),
      sourceFile: p.sourceFile,
      flow: flowResult.flow!,
      subFlows,
      ...(baseFlow ? { baseFlow } : {}),
    },
  };
}

export interface UnsafeStepRef {
  /** "" for the main flow, else the sub-flow's file name. */
  flowFile: string;
  stepId: string;
}

/**
 * Find every `raw` step (arbitrary Maestro-YAML passthrough — the advanced/unsafe tier, Pillar
 * S) across the bundle's main flow AND every sub-flow, recursing through if/repeat containers.
 * AC3: a bundle containing one of these must show an explicit warning and block those steps
 * from import unless the QA opts in.
 */
export function findUnsafeSteps(bundle: FlowBundle): UnsafeStepRef[] {
  const out: UnsafeStepRef[] = [];
  function walk(flowFile: string, steps: FlowStep[]) {
    for (const step of steps) {
      if (step.action === "raw") out.push({ flowFile, stepId: step.id });
      const children = containerChildren(step);
      if (children) walk(flowFile, children);
    }
  }
  walk("", bundle.flow.steps);
  for (const [file, sub] of Object.entries(bundle.subFlows)) walk(file, sub.steps);
  return out;
}

/** Remove every `raw` step (recursing through containers) from a flow — AC3's "blocked from
 * import" path when the QA does NOT opt in. Never mutates `flow`. */
export function stripUnsafeSteps(flow: Flow): Flow {
  // Preserves reference identity when nothing actually changes (no `raw` step anywhere) — same
  // convention shared/subflow.ts/shared/library.ts's own tree-rebuilding passes follow, so a
  // flow with nothing to strip is never needlessly treated as "different" by the UI.
  function walk(steps: FlowStep[]): FlowStep[] {
    let changed = false;
    const out: FlowStep[] = [];
    for (const s of steps) {
      if (s.action === "raw") {
        changed = true;
        continue;
      }
      const children = containerChildren(s);
      if (!children) {
        out.push(s);
        continue;
      }
      const kept = walk(children);
      if (kept === children) {
        out.push(s);
      } else {
        changed = true;
        out.push(withContainerChildren(s, kept));
      }
    }
    return changed ? out : steps;
  }
  const steps = walk(flow.steps);
  return steps === flow.steps ? flow : { ...flow, steps };
}
