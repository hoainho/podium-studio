import { containerChildren, describeStep, withContainerChildren, type Flow, type FlowStep, type StepAction } from "./ir.ts";

/**
 * library.ts — platform-scoped selector library (E13, janus-specs/R3-reuse-browser/E13-reuse.md).
 *
 * "Define once, per element, not per platform" (spec AC2): one named entry holds BOTH a mobile
 * a11y locator (text/targetId, resolved by `bridge/android-driver.ts`/Podium against the
 * accessibility tree) and a browser DOM locator (text/targetId, resolved by
 * `bridge/browser-driver.ts`'s `resolveLocator` against `getByText`/`getByTestId`) — the SAME
 * field shapes the IR already uses for a leaf step's own `text`/`targetId`, since both drivers
 * already interpret those fields per-platform. A step just references the entry by id
 * (`libraryRef`, added to every step's `meta` in shared/ir.ts) instead of authoring the literal
 * locator twice.
 *
 * Resolution — like sub-flow expansion (shared/subflow.ts) — happens BEFORE a run/export ever
 * sees the flow: `resolveLibraryRefs(flow, platform)` walks the flow (recursing through
 * containers) and replaces every `libraryRef` with the concrete `text`/`targetId` for the
 * requested platform, so the runner/drivers need zero changes — they only ever see ordinary,
 * already-resolved selector fields.
 */

export interface LibrarySelector {
  text?: string;
  targetId?: string;
}

export interface SelectorLibraryEntry {
  id: string;
  /** Plain-language description of the element, shown in the gallery/error messages. */
  label: string;
  mobile?: LibrarySelector;
  browser?: LibrarySelector;
}

export type LibraryPlatform = "mobile" | "browser";

/**
 * Seeded starter-pack entries (E13 spec AC4's demo-app domain templates reference
 * these). Placeholder locator VALUES — a real project swaps these for the actual inspected
 * accessibility labels / DOM testids once real device/browser access is available; the SEAM
 * (one entry, two platforms) is what this epic delivers, not a real demo app element inventory.
 */
export const SELECTOR_LIBRARY: Record<string, SelectorLibraryEntry> = {
  loginEmailField: {
    id: "loginEmailField",
    label: "Ô nhập email/số điện thoại đăng nhập",
    mobile: { targetId: "login_email_field" },
    browser: { targetId: "login-email-input" },
  },
  loginPasswordField: {
    id: "loginPasswordField",
    label: "Ô nhập mật khẩu đăng nhập",
    mobile: { targetId: "login_password_field" },
    browser: { targetId: "login-password-input" },
  },
  loginSubmitButton: {
    id: "loginSubmitButton",
    label: "Nút đăng nhập",
    mobile: { text: "Đăng nhập" },
    browser: { targetId: "login-submit-button" },
  },
  popupDismissButton: {
    id: "popupDismissButton",
    label: "Nút đóng thông báo/popup",
    // Referenced by tapIfVisible (E13 starter pack), which ONLY supports text matching (its
    // schema has no targetId field at all) — a text value is required here, not optional.
    mobile: { text: "Đóng" },
    browser: { text: "Đóng" },
  },
  spinButton: {
    id: "spinButton",
    label: "Nút quay (spin)",
    mobile: { targetId: "spin_button" },
    browser: { targetId: "spin-button" },
  },
  claimRewardButton: {
    id: "claimRewardButton",
    label: "Nút nhận thưởng",
    mobile: { text: "Nhận thưởng" },
    browser: { targetId: "claim-reward-button" },
  },
  entryTab: {
    id: "entryTab",
    label: "Tab/mục vào ứng dụng",
    mobile: { targetId: "entry_tab" },
    browser: { targetId: "entry-tab" },
  },
  balanceText: {
    id: "balanceText",
    label: "Nhãn tĩnh cạnh số dư (\"Số dư\") — không phải con số động, vì assertVisible chỉ khớp văn bản cố định",
    // Referenced by assertVisible (E13 starter pack), which ONLY supports text matching — and
    // the actual balance NUMBER changes at runtime, so this entry deliberately targets the
    // stable static label next to it, not the number itself.
    mobile: { text: "Số dư" },
    browser: { text: "Số dư" },
  },
};

export function getLibraryEntry(id: string): SelectorLibraryEntry | undefined {
  return SELECTOR_LIBRARY[id];
}

export function listLibraryEntries(): SelectorLibraryEntry[] {
  return Object.values(SELECTOR_LIBRARY);
}

/** Selector-bearing leaf actions — mirrors shared/lint.ts's own (non-exported) SELECTOR_ACTIONS
 * set (same IR-SPEC.md §2 source of truth), duplicated here rather than imported since this
 * epic's scope doesn't touch shared/lint.ts and that set isn't exported from it. */
const SELECTOR_ACTIONS = new Set<StepAction>([
  "tapText", "doubleTap", "longPress", "tapIfVisible",
  "assertVisible", "assertNotVisible", "waitFor", "waitForNotVisible",
  "scrollUntilVisible", "copyText",
]);

/** Actions whose schema has ONLY a `text` field — no `targetId` alternative at all (unlike
 * tapText/doubleTap/longPress, which accept either). A library entry resolved against one of
 * these MUST supply a `text` locator for the requested platform; a targetId-only entry can
 * never satisfy them, so that's flagged as an error here rather than silently producing a step
 * whose (required, non-optional) `text` field ends up `undefined`. */
const TEXT_ONLY_ACTIONS = new Set<StepAction>([
  "assertVisible", "assertNotVisible", "tapIfVisible", "waitFor", "waitForNotVisible",
  "scrollUntilVisible", "copyText",
]);

export interface LibraryResolveError {
  message: string;
  stepId?: string;
}

function resolveOneStep(
  step: FlowStep,
  platform: LibraryPlatform,
  registry: Record<string, SelectorLibraryEntry>,
  errors: LibraryResolveError[],
): FlowStep {
  const libraryRef = (step as { libraryRef?: string }).libraryRef;
  if (!libraryRef) return step;
  if (!SELECTOR_ACTIONS.has(step.action)) {
    errors.push({
      message: `Bước "${describeStep(step)}" có tham chiếu thư viện nhưng hành động này không dùng bộ chọn phần tử.`,
      stepId: step.id,
    });
    return step;
  }
  const entry = registry[libraryRef];
  if (!entry) {
    errors.push({ message: `Không tìm thấy phần tử "${libraryRef}" trong thư viện bộ chọn.`, stepId: step.id });
    return step;
  }
  const target = platform === "mobile" ? entry.mobile : entry.browser;
  if (!target) {
    errors.push({
      message: `Phần tử "${entry.label}" (${libraryRef}) chưa có bộ chọn cho nền tảng ${platform === "mobile" ? "di động" : "trình duyệt"}.`,
      stepId: step.id,
    });
    return step;
  }
  if (TEXT_ONLY_ACTIONS.has(step.action) && !target.text) {
    errors.push({
      message:
        `Phần tử "${entry.label}" (${libraryRef}) chỉ có mã nhận diện (targetId) cho nền tảng ` +
        `${platform === "mobile" ? "di động" : "trình duyệt"}, nhưng bước "${describeStep(step)}" chỉ hỗ trợ khớp theo văn bản.`,
      stepId: step.id,
    });
    return step;
  }
  // Same "generic step reconstruction" cast pattern as shared/subflow.ts's
  // interpolateStepStrings: TS can't see that resolveOneStep only ever reaches this line for a
  // step whose action is already SELECTOR_ACTIONS-vetted (and, for TEXT_ONLY_ACTIONS, further
  // vetted to have a text locator) — the runtime checks above are what actually guarantee the
  // resulting shape is schema-valid, not the type checker.
  const clone = { ...step } as Record<string, unknown>;
  clone.text = target.text;
  clone.targetId = target.targetId;
  return clone as FlowStep;
}

/**
 * Resolve every `libraryRef` in `flow` (recursing through if/repeat containers, E4) into
 * concrete `text`/`targetId` for ONE platform — "define once" (spec AC2): the same flow (or a
 * sub-flow it calls) resolves correctly for a mobile build AND a browser build from the exact
 * same authored step, zero additional per-platform authoring. Steps without a `libraryRef` pass
 * through completely unchanged. Never throws — every problem (unknown entry, wrong action,
 * missing platform locator) is collected into `errors` instead, same fail-fast-before-run
 * contract as shared/subflow.ts's `expandFlow()`.
 *
 * `registry` is injectable (defaults to the real `SELECTOR_LIBRARY`) — same "injectable deps"
 * pattern as bridge/doctor.ts's `ExecFn`/bridge/secrets.ts's `SecretResolverDeps` — so a test
 * can exercise every resolution branch (including ones no REAL seeded entry happens to hit)
 * without needing to pollute the real starter-pack library with synthetic test-only entries.
 */
export function resolveLibraryRefs(
  flow: Flow,
  platform: LibraryPlatform,
  registry: Record<string, SelectorLibraryEntry> = SELECTOR_LIBRARY,
): { flow: Flow; errors: LibraryResolveError[] } {
  const errors: LibraryResolveError[] = [];
  function walk(steps: FlowStep[]): FlowStep[] {
    return steps.map((step) => {
      const resolved = resolveOneStep(step, platform, registry, errors);
      const children = containerChildren(resolved);
      return children ? withContainerChildren(resolved, walk(children)) : resolved;
    });
  }
  return { flow: { ...flow, steps: walk(flow.steps) }, errors };
}
