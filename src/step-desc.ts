import { describeStepCode, type FlowStep, type StepDescriptor } from "../shared/ir.ts";

type T = (path: string, vars?: Record<string, string | number>) => string;

/**
 * Localizes one step's summary (task #48) via shared/ir.ts's `describeStepCode` — the stable
 * code+params descriptor, NOT `describeStep`'s hardcoded-English string. Shared by every
 * interactive UI surface that shows a step summary (StepEditor, RecordPanel, RunPanel,
 * TraceViewer) so the EN/VI toggle fully translates all of them from one place.
 */
export function renderStepDescriptor(t: T, d: StepDescriptor): string {
  if (d.custom !== undefined) return d.custom;
  return t(`stepDesc.${d.code}`, d.params);
}

export function localizedStepDescription(t: T, step: FlowStep): string {
  return renderStepDescriptor(t, describeStepCode(step));
}
