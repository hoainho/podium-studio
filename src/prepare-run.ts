import type { Flow } from "../shared/ir.ts";
import { expandFlow, type ResolveFlowFile } from "../shared/subflow.ts";
import { resolveLibraryRefs, type LibraryPlatform } from "../shared/library.ts";

/**
 * prepare-run.ts — the ONE client-side pre-run step every run/suite-run path shares (E13).
 * Expands `callSubFlow` steps first (a sub-flow's own steps may themselves reference the
 * selector library), then resolves every `libraryRef` across the fully-expanded flow — after
 * this, the flow is pure closed-IR with zero E13-only fields left, exactly what
 * `bridge/runner.ts` already knows how to execute unmodified. Both steps fail closed: any error
 * (missing sub-flow, missing required param, unresolvable library entry) is returned as a plain
 * Vietnamese message and the caller must refuse to run — this IS the "blocked at pre-run lint,
 * not at runtime" behavior spec E13's AC5 asks for.
 */
export interface PrepareRunResult {
  flow: Flow;
  /** Empty iff fully successful. Any entry means: do not send this flow to /api/run or
   * /api/suite — show these to the QA instead. */
  errors: string[];
}

export async function prepareFlowForRun(
  flow: Flow,
  resolveFlowFile: ResolveFlowFile,
  platform: LibraryPlatform = "mobile",
): Promise<PrepareRunResult> {
  const { flow: expanded, errors: expandErrors } = await expandFlow(flow, resolveFlowFile);
  if (expandErrors.length > 0) {
    return { flow: expanded, errors: expandErrors.map((e) => e.message) };
  }
  const { flow: resolved, errors: libErrors } = resolveLibraryRefs(expanded, platform);
  return { flow: resolved, errors: libErrors.map((e) => e.message) };
}
