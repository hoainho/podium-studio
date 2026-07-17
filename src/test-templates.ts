import type { Flow, FlowStep } from "../shared/ir.ts";
import { DEFAULT_BUNDLE_ID } from "./step-defaults.ts";

/**
 * Create-a-test launcher — Template path (Phase A, docs/TEST-AUTHORING-UPGRADE-PLAN.md §7).
 *
 * Pure data + a builder, no React/DOM here (TemplatePicker.tsx is the UI half). Every template
 * is a small, GENERIC flow skeleton (not tied to any one real app's actual selectors) that already
 * satisfies `flowSchema` the instant it's built — sensible steps, a prefilled charter answer
 * (fixtures.charterAnswer, same field CharterPrompt/test-design.ts's `withCharterAnswer` writes to
 * for the Record/Steps paths, so a template-started flow gets the SAME charter-driven coverage
 * nudges as any other), and at least one assertion so the flow is never "just taps" out of the box.
 *
 * `fields` lets TemplatePicker collect a handful of QA-fillable placeholders (bundle id, a product
 * name, a search term, ...) per template before building the Flow — everything else about the
 * steps is fixed. A missing field falls back to the template's own `defaultValue`.
 */

export type TemplateId = "login" | "search" | "addToCart" | "formSubmit" | "onboarding";

export interface TemplateField {
  /** Looked up by TemplatePicker as `createTest.template.field.<key>` for the input's label. */
  key: string;
  defaultValue: string;
}

export interface FlowTemplateMeta {
  id: TemplateId;
  /** TemplatePicker resolves title/description as `createTest.template.items.<id>.{title,desc}`. */
  fields: TemplateField[];
}

export const TEMPLATES: FlowTemplateMeta[] = [
  {
    id: "login",
    fields: [
      { key: "bundleId", defaultValue: DEFAULT_BUNDLE_ID },
      { key: "username", defaultValue: "qa_tester" },
      { key: "password", defaultValue: "Test@1234" },
    ],
  },
  {
    id: "search",
    fields: [
      { key: "bundleId", defaultValue: DEFAULT_BUNDLE_ID },
      { key: "query", defaultValue: "áo thun" },
    ],
  },
  {
    id: "addToCart",
    fields: [
      { key: "bundleId", defaultValue: DEFAULT_BUNDLE_ID },
      { key: "productName", defaultValue: "Áo thun trắng" },
    ],
  },
  {
    id: "formSubmit",
    fields: [
      { key: "bundleId", defaultValue: DEFAULT_BUNDLE_ID },
      { key: "fullName", defaultValue: "Nguyễn Văn A" },
    ],
  },
  {
    id: "onboarding",
    fields: [{ key: "bundleId", defaultValue: DEFAULT_BUNDLE_ID }],
  },
];

function findTemplate(id: TemplateId): FlowTemplateMeta {
  const tpl = TEMPLATES.find((t) => t.id === id);
  if (!tpl) throw new Error(`Unknown template id: ${id}`);
  return tpl;
}

/** Resolve a field's value: caller-supplied (non-empty, trimmed) wins, else the template default. */
function resolve(tpl: FlowTemplateMeta, fields: Record<string, string>, key: string): string {
  const supplied = fields[key]?.trim();
  if (supplied) return supplied;
  return tpl.fields.find((f) => f.key === key)?.defaultValue ?? "";
}

function sid(): string {
  return crypto.randomUUID();
}

function tap(text: string): FlowStep {
  return { id: sid(), action: "tapText", text };
}
function type(text: string, submit = false): FlowStep {
  return { id: sid(), action: "type", text, submit };
}
function assertVisible(text: string): FlowStep {
  return { id: sid(), action: "assertVisible", text };
}
function launchApp(): FlowStep {
  return { id: sid(), action: "launchApp" };
}

function buildSteps(id: TemplateId, v: Record<string, string>): FlowStep[] {
  switch (id) {
    case "login":
      return [
        launchApp(),
        tap("Username"),
        type(v.username),
        tap("Password"),
        type(v.password, true),
        tap("Log In"),
        assertVisible(v.username),
      ];
    case "search":
      return [
        launchApp(),
        tap("Search"),
        type(v.query, true),
        { id: sid(), action: "waitFor", text: v.query, timeoutMs: 10_000 },
        assertVisible(v.query),
      ];
    case "addToCart":
      return [
        launchApp(),
        tap(v.productName),
        tap("Add to Cart"),
        tap("Cart"),
        assertVisible(v.productName),
      ];
    case "formSubmit":
      return [
        launchApp(),
        tap("Name"),
        type(v.fullName),
        tap("Submit"),
        assertVisible("Thank you"),
      ];
    case "onboarding":
      return [
        launchApp(),
        tap("Get Started"),
        tap("Next"),
        tap("Next"),
        tap("Done"),
        assertVisible("Home"),
      ];
  }
}

function charterAnswer(id: TemplateId, v: Record<string, string>): string {
  switch (id) {
    case "login":
      return `Đăng nhập bằng tài khoản "${v.username}" rồi kiểm tra tên đăng nhập hiển thị ở màn hình chính.`;
    case "search":
      return `Tìm kiếm "${v.query}" và kiểm tra kết quả tìm kiếm hiển thị đúng từ khoá.`;
    case "addToCart":
      return `Thêm sản phẩm "${v.productName}" vào giỏ hàng và kiểm tra giỏ hàng có sản phẩm đó.`;
    case "formSubmit":
      return `Điền tên "${v.fullName}" vào biểu mẫu, gửi đi và kiểm tra thông báo thành công hiển thị.`;
    case "onboarding":
      return "Đi qua toàn bộ các màn hình giới thiệu (onboarding) và kiểm tra sau khi hoàn tất sẽ vào được màn hình chính.";
  }
}

function flowName(id: TemplateId): string {
  switch (id) {
    case "login": return "Login";
    case "search": return "Search";
    case "addToCart": return "Add to cart";
    case "formSubmit": return "Form submit";
    case "onboarding": return "Onboarding";
  }
}

/** Build a ready-to-edit, schema-valid Flow from a template + the QA's fill-in-the-blank fields. */
export function buildTemplateFlow(id: TemplateId, fields: Record<string, string> = {}): Flow {
  const tpl = findTemplate(id);
  const v: Record<string, string> = {};
  for (const f of tpl.fields) v[f.key] = resolve(tpl, fields, f.key);

  return {
    schemaVersion: 1,
    name: flowName(id),
    app: {
      bundleId: v.bundleId || DEFAULT_BUNDLE_ID,
      platform: "ios-sim",
    },
    fixtures: { charterAnswer: charterAnswer(id, v) },
    steps: buildSteps(id, v),
  };
}
