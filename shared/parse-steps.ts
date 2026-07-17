import type { FlowStep, StepAction } from "./ir.ts";
import { KEY_VALUES } from "./ir.ts";

/**
 * Deterministic plain-text → Flow steps parser.
 *
 * This is the "write your test in plain lines" authoring path — NO AI. It's a tiny,
 * fully predictable line grammar over Podium's closed 9-action vocabulary, so the same
 * text always produces the same steps. One line = one step. Blank lines and lines
 * starting with `#` or `//` are ignored. An optional ` :: label` suffix on any line
 * sets that step's human label.
 *
 * Grammar (keywords are case-insensitive; quotes around text are optional):
 *   tap Login                 → tapText  "Login"
 *   tap #login_btn            → tapText  by accessibility/semantic id
 *   tap 120, 340              → tap      at logical point (120,340)
 *   type hello@mail.com       → type     "hello@mail.com"
 *   type secret + enter       → type     "secret", submit
 *   wait for Home             → waitFor  "Home"           (optional trailing "30s"/"5000ms")
 *   wait 1500ms  |  wait 2s   → waitMs
 *   assert Welcome            → assertVisible "Welcome"   (also: see Welcome / assert Welcome visible)
 *   swipe up|down|left|right  → swipe
 *   press enter  |  key home  → key
 *   screenshot   |  shot      → screenshot
 *
 * Control-flow blocks (E4) — nested steps between a block header and a matching `end`:
 *   if Popup:                 → if      { when: { text: "Popup", visible: true } }
 *     tap Close
 *   end
 *   if not Popup:              → if      { when: { text: "Popup", visible: false } }
 *   repeat 3:                  → repeat  { times: 3 }
 *   repeat while Loading:      → repeat  { whileVisible: "Loading" }
 *   end
 * Indentation is cosmetic only (not enforced) — a block is closed by the next `end` line
 * regardless of indent, so a non-technical author's spacing mistakes never break parsing.
 * These keywords stay English per the E4 spec's own §7-6 carve-out (Vietnamese DSL keyword
 * aliases are a separate, still-undecided product decision) — the VISUAL editor is the
 * primary, code-free authoring path for control flow; this text grammar exists so Text and
 * Visual stay in sync (AC2), not as the primary path for a non-technical author.
 *
 * Sub-flow calls (E13 — janus-specs/R3-reuse-browser/E13-reuse.md):
 *   call login.flow.json                          → callSubFlow, no params
 *   call login.flow.json(email=a@b.com, pw=hunter2) → callSubFlow with params
 * Param values are taken verbatim, no quoting/escaping (same spirit as `raw`) — the component
 * gallery / Visual editor (E13) is the primary authoring path for parameterized sub-flow calls;
 * this text form exists, same as control-flow blocks above, just to keep Text and Visual in sync.
 */

export interface ParseIssue {
  line: number; // 1-based
  text: string;
  error: string;
}

export interface ParseResult {
  steps: FlowStep[];
  issues: ParseIssue[];
}

let counter = 0;
function freshId(): string {
  // crypto.randomUUID exists in browser + Node ≥ 19; fall back to a counter for old runtimes.
  const g = globalThis as unknown as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  counter += 1;
  return `step-${Date.now().toString(36)}-${counter}`;
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Pull a trailing duration like "30s" or "5000ms" off the end; returns [remaining, ms?]. */
function extractTrailingDuration(arg: string): [string, number | undefined] {
  const m = arg.match(/\s+(\d+)\s*(ms|s)\s*$/i);
  if (!m) return [arg, undefined];
  const n = Number(m[1]);
  const ms = m[2].toLowerCase() === "s" ? n * 1000 : n;
  return [arg.slice(0, m.index).trim(), ms];
}

function parseDuration(arg: string): number | undefined {
  const m = arg.trim().match(/^(\d+)\s*(ms|s)?$/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  return (m[2]?.toLowerCase() === "s") ? n * 1000 : n; // bare number treated as ms
}

type Meta = { id: string; label?: string };
const step = (m: Meta, s: Record<string, unknown>): FlowStep => ({ ...m, ...s } as FlowStep);

/** A tap-like target → {text} | {targetId} | {x,y}. */
function target(arg: string): Record<string, unknown> {
  const coord = arg.match(/^(\d+)\s*,\s*(\d+)$/);
  if (coord) return { x: Number(coord[1]), y: Number(coord[2]) };
  if (arg.startsWith("#")) return { targetId: arg.slice(1).trim() };
  return { text: unquote(arg) };
}

function parseOne(raw: string, id: string): FlowStep[] | string {
  let label: string | undefined;
  const labelSplit = raw.split(/\s+::\s+/);
  let line = raw;
  if (labelSplit.length > 1) {
    line = labelSplit[0];
    label = labelSplit.slice(1).join(" :: ").trim() || undefined;
  }
  line = line.trim();
  const m: Meta = label ? { id, label } : { id };
  const lower = line.toLowerCase();
  // arg after an N-word command prefix
  const after = (words: number) => line.split(/\s+/).slice(words).join(" ").trim();

  // ── multi-word commands first ──────────────────────────────────────────────
  if (/^double[ -]?tap /.test(lower)) return [step(m, { action: "doubleTap", ...target(after(lower.startsWith("double tap") ? 2 : 1)) })];
  if (/^long[ -]?press /.test(lower)) return [step(m, { action: "longPress", ...target(after(lower.startsWith("long press") ? 2 : 1)) })];
  if (/^hide keyboard$/.test(lower)) return [step(m, { action: "hideKeyboard" })];
  if (/^(go back|back)$/.test(lower)) return [step(m, { action: "back" })];
  if (/^clear( text)?$/.test(lower)) return [step(m, { action: "clearText" })];
  if (/^delete( text)?\b/.test(lower)) {
    const n = line.match(/(\d+)/);
    return [step(m, { action: "deleteText", count: n ? Number(n[1]) : 1 })];
  }
  if (/^paste( text)?$/.test(lower)) return [step(m, { action: "pasteText" })];
  if (/^scroll (until|to) /.test(lower)) {
    const t = unquote(line.replace(/^scroll (until|to)\s+/i, ""));
    return t ? [step(m, { action: "scrollUntilVisible", text: t })] : `"scroll until" needs text`;
  }
  if (/^scroll\b/.test(lower)) {
    const d = after(1).toLowerCase();
    const dir = ["up", "down", "left", "right"].includes(d) ? d : "down";
    return [step(m, { action: "scroll", direction: dir })];
  }
  if (/^(open link|open) /.test(lower)) {
    const url = unquote(line.replace(/^(open link|open)\s+/i, ""));
    return url ? [step(m, { action: "openLink", url })] : `"open" needs a url`;
  }
  if (/^launch(?:\s+app)?\b/.test(lower)) {
    const b = (line.match(/^launch(?:\s+app)?(?:\s+(.*))?$/i)?.[1] ?? "").trim();
    return [step(m, { action: "launchApp", ...(b ? { bundleId: unquote(b) } : {}) })];
  }
  if (/^stop(?:\s+app)?\b/.test(lower)) {
    const b = (line.match(/^stop(?:\s+app)?(?:\s+(.*))?$/i)?.[1] ?? "").trim();
    return [step(m, { action: "stopApp", ...(b ? { bundleId: unquote(b) } : {}) })];
  }
  if (/^copy( from| text from| text)? /.test(lower)) {
    const t = unquote(line.replace(/^copy( from| text from| text)?\s+/i, ""));
    return t ? [step(m, { action: "copyText", text: t })] : `"copy" needs a target text`;
  }
  if (/^(assert not|assertnotvisible|dont see|don't see|do not see) /.test(lower)) {
    const t = unquote(line.replace(/^(assert not|assertnotvisible|dont see|don't see|do not see)\s+/i, "").replace(/\s+visible$/i, ""));
    return t ? [step(m, { action: "assertNotVisible", text: t, timeoutMs: 5000 })] : `needs text`;
  }
  if (/ (gone|disappear|disappears|to disappear)$/.test(lower) && /^wait/.test(lower)) {
    const t = unquote(line.replace(/^wait (until|for)\s+/i, "").replace(/\s+(gone|disappears?|to disappear)$/i, ""));
    return t ? [step(m, { action: "waitForNotVisible", text: t, timeoutMs: 10000 })] : `needs text`;
  }
  if (/^raw /.test(lower)) {
    const maestro = line.slice(4).trim();
    return maestro ? [step(m, { action: "raw", maestro })] : `"raw" needs a Maestro command`;
  }
  if (/^call\b/.test(lower)) {
    // call <flowFile>                                  → callSubFlow, no params (E13)
    // call <flowFile>(name=value, name2=value2)         → callSubFlow with params
    // A param value is taken verbatim (no quoting/escaping) — same "no fancy escaping" spirit
    // as the rest of this deterministic grammar; a value containing a literal comma doesn't
    // round-trip through text, an acceptable gap for this best-effort text path (the Visual
    // editor / component gallery, E13, is the primary authoring path for sub-flow calls).
    // \b (not a trailing space) so bare "call" with nothing after it still reaches this branch
    // and gets the targeted "needs a sub-flow file" error below, instead of falling through to
    // the generic "unknown command" message.
    const rest = line.slice(4).trim();
    if (!rest) return `"call" needs a sub-flow file, e.g. "call login.flow.json" or "call login.flow.json(email=..., pw=...)"`;
    const paramsMatch = rest.match(/^(.+?)\((.*)\)$/);
    const flowFile = (paramsMatch ? paramsMatch[1] : rest).trim();
    if (!flowFile) return `"call" needs a sub-flow file`;
    const params: Record<string, string> = {};
    if (paramsMatch && paramsMatch[2].trim()) {
      for (const pair of paramsMatch[2].split(",")) {
        const eq = pair.indexOf("=");
        if (eq === -1) return `"call" params must be name=value, got "${pair.trim()}"`;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (!name) return `"call" params must be name=value, got "${pair.trim()}"`;
        params[name] = value;
      }
    }
    return [step(m, { action: "callSubFlow", flowFile, ...(Object.keys(params).length ? { params } : {}) })];
  }

  // ── single-word verbs ────────────────────────────────────────────────────
  const spaceIdx = line.search(/\s/);
  const keyword = (spaceIdx === -1 ? line : line.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? "" : line.slice(spaceIdx + 1).trim();

  switch (keyword) {
    case "tap":
    case "click": {
      if (!rest) return `"${keyword}" needs a target (text, #id, or x,y)`;
      // conditional: "tap X if <anything>" → tapIfVisible X. But a QUOTED target is
      // taken literally (e.g. `tap "Notify me if available"`), never split on " if ".
      const isQuoted = rest.startsWith('"') || rest.startsWith("'");
      if (!isQuoted) {
        const ifIdx = rest.toLowerCase().search(/\s+if\s+/);
        if (ifIdx >= 0) return [step(m, { action: "tapIfVisible", text: unquote(rest.slice(0, ifIdx).trim()), timeoutMs: 5000 })];
      }
      return [step(m, { action: rest.match(/^\d+\s*,\s*\d+$/) ? "tap" : "tapText", ...target(rest) })];
    }
    case "tapifvisible":
      return rest ? [step(m, { action: "tapIfVisible", text: unquote(rest), timeoutMs: 5000 })] : `needs text`;
    case "type":
    case "set": {
      if (!rest) return `"type" needs text to enter`;
      // "type X into <field>"  or  "type <field>: X"  → tap the field, then type X
      const intoM = rest.match(/^(.*?)\s+into\s+(.+)$/i);
      const fieldM = !intoM ? rest.match(/^([A-Za-z][\w -]*):\s+(.+)$/) : null;
      let textRaw: string, field: string | null = null;
      if (intoM) { textRaw = intoM[1]; field = intoM[2]; }
      else if (fieldM) { field = fieldM[1]; textRaw = fieldM[2]; }
      else { textRaw = rest; }
      let submit = false;
      const sub = textRaw.match(/\s*(?:\+\s*enter|then\s+enter|submit)\s*$/i);
      if (sub) {
        // Only strip the submit suffix when real text remains; otherwise it's the literal
        // word (e.g. `type submit` → type the text "submit").
        const stripped = textRaw.slice(0, sub.index).trim();
        if (stripped) { submit = true; textRaw = stripped; }
      }
      const typeStep = step(m, { action: "type", text: unquote(textRaw), ...(submit ? { submit: true } : {}) });
      if (field) {
        // When the field parses as coordinates, tap the point; otherwise tap by text/id.
        const fieldTarget = target(field.trim());
        const fieldAction = fieldTarget.x !== undefined ? "tap" : "tapText";
        return [step({ id: freshId() }, { action: fieldAction, ...fieldTarget }), typeStep];
      }
      return [typeStep];
    }
    case "wait": {
      if (/^for\s+/i.test(rest)) {
        const [textPart, ms] = extractTrailingDuration(rest.replace(/^for\s+/i, ""));
        const text = unquote(textPart);
        return text ? [step(m, { action: "waitFor", text, timeoutMs: ms ?? 10_000 })] : `"wait for" needs text`;
      }
      const ms = parseDuration(rest);
      return ms === undefined ? `"wait" needs a duration (e.g. "wait 1500ms") or "wait for <text>"` : [step(m, { action: "waitMs", ms })];
    }
    case "waitfor": {
      const [textPart, ms] = extractTrailingDuration(rest);
      const text = unquote(textPart);
      return text ? [step(m, { action: "waitFor", text, timeoutMs: ms ?? 10_000 })] : `"waitFor" needs text`;
    }
    case "assert":
    case "see":
    case "expect": {
      const [textPart, ms] = extractTrailingDuration(rest.replace(/\s+visible$/i, ""));
      const text = unquote(textPart);
      return text ? [step(m, { action: "assertVisible", text, timeoutMs: ms ?? 10_000 })] : `"assert" needs text that should be visible`;
    }
    case "swipe": {
      const dir = rest.toLowerCase().trim();
      return ["up", "down", "left", "right"].includes(dir)
        ? [step(m, { action: "swipe", direction: dir })]
        : `"swipe" needs a direction: up, down, left, or right`;
    }
    case "press":
    case "key": {
      const key = rest.toLowerCase().trim();
      return (KEY_VALUES as readonly string[]).includes(key)
        ? [step(m, { action: "key", key })]
        : `unknown key "${rest}". Valid: ${KEY_VALUES.join(", ")}`;
    }
    case "screenshot":
    case "shot":
    case "capture":
      return [step(m, { action: "screenshot" })];
    default:
      return `unknown command "${keyword}". Try: tap, double tap, long press, tap X if visible, type, type X into <field>, clear, delete N, hide keyboard, wait, wait for, wait until X gone, assert, assert not, swipe, scroll, scroll until, back, press, open, launch, stop, copy, paste, screenshot, raw, call`;
  }
}

/** One currently-open `if`/`repeat` block while scanning lines top to bottom. */
interface OpenBlock {
  startLine: number; // 1-based, for an "unclosed block" issue if never matched by `end`
  children: FlowStep[];
  /** Builds the finished container step once a matching `end` closes this block. */
  build: (children: FlowStep[]) => FlowStep;
}

const IF_HEADER = /^if\s+(.+):$/i;
const REPEAT_TIMES_HEADER = /^repeat\s+(\d+)\s*:$/i;
const REPEAT_WHILE_HEADER = /^repeat\s+while\s+(.+):$/i;
const END_LINE = /^end$/i;

export function parseSteps(text: string): ParseResult {
  const root: FlowStep[] = [];
  const issues: ParseIssue[] = [];
  const stack: OpenBlock[] = [];
  const lines = text.split(/\r?\n/);

  const currentList = () => (stack.length ? stack[stack.length - 1].children : root);

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) continue;

    const ifMatch = IF_HEADER.exec(trimmed);
    const repeatTimesMatch = REPEAT_TIMES_HEADER.exec(trimmed);
    const repeatWhileMatch = REPEAT_WHILE_HEADER.exec(trimmed);

    if (ifMatch) {
      const condRaw = ifMatch[1].trim();
      const notMatch = /^not\s+(.+)$/i.exec(condRaw);
      const condText = unquote((notMatch ? notMatch[1] : condRaw).trim());
      if (!condText) {
        issues.push({ line: i + 1, text: trimmed, error: `"if" needs a condition, e.g. "if Popup:"` });
        continue;
      }
      stack.push({
        startLine: i + 1,
        children: [],
        build: (children) => ({
          id: freshId(), action: "if",
          when: notMatch ? { text: condText, visible: false } : { text: condText },
          then: children,
        }),
      });
      continue;
    }
    // A step still mid-edit (e.g. the container's condition hasn't been typed yet) can
    // render as a header-shaped-but-empty line like "if :" — IF_HEADER's `.+` requires at
    // least one condition character, so it doesn't match. Give the same clear error as the
    // "empty condition" case above instead of falling through to the generic "unknown
    // command" message, which would be genuinely confusing for this specific shape.
    if (/^if\b.*:$/i.test(trimmed)) {
      issues.push({ line: i + 1, text: trimmed, error: `"if" needs a condition, e.g. "if Popup:"` });
      continue;
    }

    if (repeatTimesMatch || repeatWhileMatch) {
      const n = repeatTimesMatch ? Number(repeatTimesMatch[1]) : undefined;
      const whileText = repeatWhileMatch ? unquote(repeatWhileMatch[1].trim()) : undefined;
      if (repeatWhileMatch && !whileText) {
        issues.push({ line: i + 1, text: trimmed, error: `"repeat while" needs a condition, e.g. "repeat while Loading:"` });
        continue;
      }
      stack.push({
        startLine: i + 1,
        children: [],
        build: (children) => ({
          id: freshId(), action: "repeat",
          ...(n !== undefined ? { times: n } : { whileVisible: whileText, maxIterations: 20 }),
          steps: children,
        }),
      });
      continue;
    }
    // Same rationale as the `if` fallback above: a "repeat :"-shaped line that didn't match
    // either repeat header (e.g. "repeat while :" with an empty condition) gets a targeted
    // error instead of "unknown command".
    if (/^repeat\b.*:$/i.test(trimmed)) {
      issues.push({
        line: i + 1, text: trimmed,
        error: `"repeat" needs a count or condition, e.g. "repeat 3:" or "repeat while Loading:"`,
      });
      continue;
    }

    if (END_LINE.test(trimmed)) {
      const frame = stack.pop();
      if (!frame) {
        issues.push({ line: i + 1, text: trimmed, error: `"end" with no matching "if"/"repeat" block` });
        continue;
      }
      if (frame.children.length === 0) {
        issues.push({ line: frame.startLine, text: lines[frame.startLine - 1]?.trim() ?? "", error: `this block has no steps before "end"` });
        continue;
      }
      currentList().push(frame.build(frame.children));
      continue;
    }

    const result = parseOne(trimmed, freshId());
    if (typeof result === "string") issues.push({ line: i + 1, text: trimmed, error: result });
    else currentList().push(...result);
  }

  for (const frame of stack) {
    issues.push({
      line: frame.startLine,
      text: lines[frame.startLine - 1]?.trim() ?? "",
      error: `unclosed block — missing a matching "end"`,
    });
  }

  return { steps: root, issues };
}

/** Render existing steps back to the plain-text grammar (for editing an open flow as text). */
export function stepsToText(steps: FlowStep[]): string {
  const tgt = (s: { text?: string; targetId?: string; x?: number; y?: number }) =>
    s.text ?? (s.targetId ? "#" + s.targetId : s.x !== undefined ? `${s.x}, ${s.y}` : "");
  const to = (t?: number) => (t && t !== 10000 ? ` ${t}ms` : "");

  /** One leaf step's line — no trailing newline, no indentation (the recursive renderer adds both). */
  function leafLine(s: FlowStep): string {
    const label = s.label ? ` :: ${s.label}` : "";
    switch (s.action) {
      case "tap": return `tap ${s.x}, ${s.y}${label}`;
      case "tapText": return `tap ${tgt(s)}${label}`;
      case "doubleTap": return `double tap ${tgt(s)}${label}`;
      case "longPress": return `long press ${tgt(s)}${label}`;
      case "tapIfVisible": return `tap ${s.text} if visible${label}`;
      case "type": return `type ${s.text}${s.submit ? " + enter" : ""}${label}`;
      case "clearText": return `clear text${label}`;
      case "deleteText": return `delete ${s.count}${label}`;
      case "pasteText": return `paste${label}`;
      case "copyText": return `copy from ${s.text}${label}`;
      case "hideKeyboard": return `hide keyboard${label}`;
      case "key": return `press ${s.key}${label}`;
      case "swipe": return `swipe ${s.direction ?? "up"}${label}`;
      case "scroll": return `scroll ${s.direction ?? "down"}${label}`;
      case "scrollUntilVisible": return `scroll until ${s.text}${label}`;
      case "back": return `back${label}`;
      case "waitFor": return `wait for ${s.text}${to(s.timeoutMs)}${label}`;
      case "waitForNotVisible": return `wait until ${s.text} gone${label}`;
      case "waitMs": return `wait ${s.ms}ms${label}`;
      case "assertVisible": return `assert ${s.text}${to(s.timeoutMs)}${label}`;
      case "assertNotVisible": return `assert not ${s.text}${label}`;
      case "screenshot": return `screenshot${label}`;
      case "openLink": return `open ${s.url}${label}`;
      case "launchApp": return `launch${s.bundleId ? " " + s.bundleId : ""}${label}`;
      case "stopApp": return `stop${s.bundleId ? " " + s.bundleId : ""}${label}`;
      case "raw": return `raw ${s.maestro.split("\n")[0]}${label}`;
      case "callSubFlow": {
        const entries = Object.entries(s.params ?? {});
        const paramsPart = entries.length ? `(${entries.map(([k, v]) => `${k}=${v}`).join(", ")})` : "";
        return `call ${s.flowFile}${paramsPart}${label}`;
      }
      case "if": case "repeat": return ""; // handled by render() below, never reached
    }
  }

  /** Recursive, indentation-aware renderer — `if`/`repeat` (E4) open a block, render their
   * children one level deeper, then close with `end`, keeping Text and Visual in sync (AC2). */
  function render(list: FlowStep[], depth: number): string[] {
    const pad = "  ".repeat(depth);
    const out: string[] = [];
    for (const s of list) {
      if (s.action === "if") {
        const cond = s.when.visible === false ? `not ${s.when.text}` : s.when.text;
        out.push(`${pad}if ${cond}:`);
        out.push(...render(s.then, depth + 1));
        out.push(`${pad}end`);
      } else if (s.action === "repeat") {
        out.push(`${pad}repeat ${s.whileVisible ? `while ${s.whileVisible}` : (s.times ?? 1)}:`);
        out.push(...render(s.steps, depth + 1));
        out.push(`${pad}end`);
      } else {
        out.push(`${pad}${leafLine(s)}`);
      }
    }
    return out;
  }

  return render(steps, 0).join("\n");
}
