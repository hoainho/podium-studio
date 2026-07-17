import { containerChildren, withContainerChildren, type FlowStep } from "../shared/ir.ts";

/**
 * Path-based step-tree editing (E4). A `StepPath` is a list of child-indices descending
 * from the flow's root `steps[]` through zero or more `if`/`repeat` containers to one
 * step — e.g. `[2, 0]` means "the 1st child of the 3rd top-level step's container". Every
 * mutation (move/delete/duplicate/insert/toggle) goes through these pure helpers so
 * StepEditor never hand-rolls tree surgery at more than one nesting depth.
 */
export type StepPath = number[];

/** The step at `path`, or undefined if the path doesn't resolve (e.g. a leaf step reached with path left over). */
export function getAtPath(steps: FlowStep[], path: StepPath): FlowStep | undefined {
  if (path.length === 0) return undefined;
  const [head, ...rest] = path;
  const step = steps[head];
  if (!step) return undefined;
  if (rest.length === 0) return step;
  const children = containerChildren(step);
  return children ? getAtPath(children, rest) : undefined;
}

/** Replace the step at `path` with `next`. Steps outside the path are returned unchanged (structural sharing). */
export function setAtPath(steps: FlowStep[], path: StepPath, next: FlowStep): FlowStep[] {
  if (path.length === 0) return steps;
  const [head, ...rest] = path;
  return steps.map((s, i) => {
    if (i !== head) return s;
    if (rest.length === 0) return next;
    const children = containerChildren(s);
    return children ? withContainerChildren(s, setAtPath(children, rest, next)) : s;
  });
}

/** Remove the step at `path`. */
export function deleteAtPath(steps: FlowStep[], path: StepPath): FlowStep[] {
  if (path.length === 0) return steps;
  const [head, ...rest] = path;
  if (rest.length === 0) return steps.filter((_, i) => i !== head);
  return steps.map((s, i) => {
    if (i !== head) return s;
    const children = containerChildren(s);
    return children ? withContainerChildren(s, deleteAtPath(children, rest)) : s;
  });
}

/** Swap the step at `path` with its previous (-1) or next (+1) sibling in the SAME list. No-op at a list edge. */
export function moveAtPath(steps: FlowStep[], path: StepPath, dir: -1 | 1): FlowStep[] {
  if (path.length === 0) return steps;
  const [head, ...rest] = path;
  if (rest.length === 0) {
    const target = head + dir;
    if (target < 0 || target >= steps.length) return steps;
    const copy = steps.slice();
    [copy[head], copy[target]] = [copy[target], copy[head]];
    return copy;
  }
  return steps.map((s, i) => {
    if (i !== head) return s;
    const children = containerChildren(s);
    return children ? withContainerChildren(s, moveAtPath(children, rest, dir)) : s;
  });
}

/**
 * Insert `newStep` into the list living at `parentPath` (the container whose children we're
 * adding to — an empty path means the flow's own top-level list), at `atIndex` (defaults to
 * the end of that list).
 */
export function insertAtPath(
  steps: FlowStep[],
  parentPath: StepPath,
  newStep: FlowStep,
  atIndex?: number,
): FlowStep[] {
  if (parentPath.length === 0) {
    const copy = steps.slice();
    copy.splice(atIndex ?? steps.length, 0, newStep);
    return copy;
  }
  const [head, ...rest] = parentPath;
  return steps.map((s, i) => {
    if (i !== head) return s;
    const children = containerChildren(s) ?? [];
    if (rest.length === 0) {
      const copy = children.slice();
      copy.splice(atIndex ?? children.length, 0, newStep);
      return withContainerChildren(s, copy);
    }
    return withContainerChildren(s, insertAtPath(children, rest, newStep, atIndex));
  });
}

/** Deep-clone a step (and, recursively, every descendant) with a fresh id at every level. */
function deepCloneWithFreshIds(step: FlowStep, freshId: () => string): FlowStep {
  const cloned = { ...step, id: freshId() };
  const children = containerChildren(step);
  return children ? withContainerChildren(cloned, children.map((c) => deepCloneWithFreshIds(c, freshId))) : cloned;
}

/** Duplicate the step at `path` (deep — nested children get fresh ids too), inserted right after the original. */
export function duplicateAtPath(steps: FlowStep[], path: StepPath, freshId: () => string): FlowStep[] {
  const step = getAtPath(steps, path);
  if (!step) return steps;
  const clone = deepCloneWithFreshIds(step, freshId);
  const [head, ...rest] = path;
  if (rest.length === 0) {
    const copy = steps.slice();
    copy.splice(head + 1, 0, clone);
    return copy;
  }
  return steps.map((s, i) => {
    if (i !== head) return s;
    const children = containerChildren(s);
    return children ? withContainerChildren(s, duplicateAtPath(children, rest, freshId)) : s;
  });
}

/** Flip `disabled` on the step at `path` (containers can be disabled as a whole, same as any leaf step). */
export function toggleDisabledAtPath(steps: FlowStep[], path: StepPath): FlowStep[] {
  const step = getAtPath(steps, path);
  if (!step) return steps;
  return setAtPath(steps, path, { ...step, disabled: !step.disabled });
}
