# IR-SPEC.md — Podium Studio Intermediate Representation

> Versioned artifact. This is the single source of truth for the closed action vocabulary that every
> driver, lint engine, authoring UI, and future migration in Podium Studio must consume — no epic may
> invent an action, field, or platform behavior that isn't documented here (Pillar IR, non‑negotiable #7).

| Field | Value |
|---|---|
| Epic | E1 (R1‑foundations) |
| `schema_version` (flow JSON, §6) | `1` — IR spec semver `1.0.0` |
| Status | Draft — published, pending independent review sign‑off (§7) |
| Source spec | `janus-specs/R1-foundations/E1-ir-spec.md` |
| Plan reference | `PODIUM-STUDIO-PLAN.md` §3 (non‑negotiables), §4 Pillar IR |
| Carries forward | R0 baseline — all **26** actions from `shared/ir.ts`, zero dropped |
| Known consumers (R1) | E2 (robust execution), E3 (lint/dry‑run), E4 (non‑tech authoring), E7 (browser first‑run) |

---

## 1. Purpose & scope

The IR is the human‑diffable, closed‑vocabulary representation of a QA flow. "Closed" means: the editor,
the recorder, and every driver can only ever emit one of the actions listed in §2 — this is what keeps a
run **decidable** (non‑negotiable #1: no AI in the Strict/CI path; a fixed vocabulary + a deterministic
resolver = same result every run). Every action must map cleanly onto an exportable Maestro primitive
(non‑negotiable #6) — §2 documents that mapping per action; nothing in this spec may define an action
with no export path.

This document does **not** implement a driver, a lint engine, or a UI (that's E2/E3/E4/E7+). It also does
not implement the browser driver itself (E16), the selector *library* product feature (E13), or AI‑
proposed action extensions (R5/E24) — it only reserves the data model those epics build on top of.

## 2. Closed action vocabulary & per-action field schema

#### 2.0 Common step metadata

Every action below carries these four presentation fields in addition to its action‑specific fields.
They are stripped before the step is sent to Podium (`toPodiumSteps` / `stepToPodium` in `shared/ir.ts`)
and never appear in the Maestro export — they exist purely for the visual editor (reorder, evidence
correlation, QA notes, soft‑disable).

| Field | Type | Required | Notes |
|---|---|---|---|
| `id` | string | required | Stable step id (reorder / evidence correlation) |
| `label` | string | optional | Plain‑language description shown to QA |
| `note` | string | optional | Optional QA note |
| `disabled` | boolean | optional | Skip this step without deleting it |

Each of the 26 actions below documents only its action‑specific fields on top of these four.

---

### `tap`
Tap at an absolute coordinate. **Execution path:** native (`run_steps`).

**Fields:**
| Field | Type | Required | Notes |
|---|---|---|---|
| `x` | number | required | X in logical points |
| `y` | number | required | Y in logical points |

**Maestro export:** `tapOn: { point: "x,y" }`

---

### `tapText`
Tap an element by visible text or accessibility id. **Execution path:** native (`run_steps`).

**Fields:**
| Field | Type | Required | Notes |
|---|---|---|---|
| `text` | string | optional | Element text (full, case‑insensitive) |
| `targetId` | string | optional | Accessibility id / semantic id (maps to Podium `id`) |
| `index` | number (int ≥0) | optional | Disambiguates when multiple elements match |

At least one of `text` / `targetId` should be supplied (author responsibility; the schema does not
enforce a `oneOf`, matching the R0 baseline).

**Maestro export:** `tapOn: { text: "…" }` or `tapOn: { id: "…" }`

---

### `type`
Type text into the currently focused field. **Execution path:** native (`run_steps`).

**Fields:**
| Field | Type | Required | Notes |
|---|---|---|---|
| `text` | string | required | Text to type into the focused field |
| `submit` | boolean | optional | Press Enter after typing |

**Maestro export:** `inputText: "…"` (+ `pressKey: "Enter"` if `submit`)

---

### `key`
Press a hardware/software key. **Execution path:** native (`run_steps`).

**Fields:**
| Field | Type | Required | Notes |
|---|---|---|---|
| `key` | enum | required | One of `enter, home, lock, backspace, volume up, volume down, back, power, tab` (`KEY_VALUES`) |

**Maestro export:** `pressKey: "<TitleCase key>"`

---

### `swipe`
Swipe in a direction, or between two explicit points. **Execution path:** extended (compiled Maestro
`run_flow`).

**Fields:**
| Field | Type | Required | Notes |
|---|---|---|---|
| `direction` | enum (`up,down,left,right`) | optional | Ignored if start/end coordinates are given |
| `startX`, `startY`, `endX`, `endY` | number | optional | Explicit swipe path; all four must be given together to take precedence over `direction` |

**Maestro export:** `swipe: { direction: "UP" }` or `swipe: { start: "x,y", end: "x,y" }`

---

### `waitFor`
Wait until an element with the given text is visible. **Execution path:** native (`run_steps`).

**Fields:**
| Field | Type | Required | Notes |
|---|---|---|---|
| `text` | string | required | Wait until an element with this text is visible |
| `timeoutMs` | number (int, 0–120 000) | optional | Default 10 000ms at the driver layer |

**Maestro export:** `extendedWaitUntil: { visible: "…", timeout: … }`

---

### `waitMs`
Wait a fixed duration. **Execution path:** native (`run_steps`).

**Fields:**
| Field | Type | Required | Notes |
|---|---|---|---|
| `ms` | number (int, 0–30 000) | required | Milliseconds to wait |

**Maestro export:** `waitForAnimationToEnd: { timeout: ms }`

---

### `screenshot`
Take a screenshot for evidence. **Execution path:** native (`run_steps`).

**Fields:** _None beyond the common step metadata (§2.0)._

**Maestro export:** `takeScreenshot: "shot_<id prefix>"`

---

### `assertVisible`
Assert an element with the given text is visible. **Execution path:** native (`run_steps`).

**Fields:**
| Field | Type | Required | Notes |
|---|---|---|---|
| `text` | string | required | Assert an element with this text is visible |
| `timeoutMs` | number (int, 0–120 000) | optional | |

**Maestro export:** `assertVisible: "…"` (or with an explicit `timeout:` block)

---

### `doubleTap`
Double‑tap an element (by text/id) or a coordinate. **Execution path:** extended (compiled Maestro
`run_flow`).

**Fields:**
| Field | Type | Required | Notes |
|---|---|---|---|
| `text` | string | optional | |
| `targetId` | string | optional | |
| `x`, `y` | number | optional | |
| `index` | number (int ≥0) | optional | |

**Maestro export:** `doubleTapOn: { text \| id \| point }`

---

### `longPress`
Long‑press an element (by text/id) or a coordinate. **Execution path:** extended (compiled Maestro
`run_flow`).

**Fields:** identical shape to `doubleTap` (`text`, `targetId`, `x`, `y`, `index`, all optional).

**Maestro export:** `longPressOn: { text \| id \| point }`

---

### `tapIfVisible`
Optional tap — dismiss a popup / conditional tap without failing when it's not there. **Execution path:**
extended (compiled Maestro `run_flow`).

**Fields:**
| Field | Type | Required | Notes |
|---|---|---|---|
| `text` | string | required | Tap this element only if visible; never fails the run if absent |
| `timeoutMs` | number (int, 0–120 000) | optional | |

**Maestro export:** `tapOn: { text: "…", optional: true }`

---

### `clearText`
Erase all text in the focused field. **Execution path:** extended (compiled Maestro `run_flow`).

**Fields:** _None beyond the common step metadata (§2.0)._

**Maestro export:** `eraseText`

---

### `deleteText`
Erase N characters from the focused field. **Execution path:** extended (compiled Maestro `run_flow`).

**Fields:**
| Field | Type | Required | Notes |
|---|---|---|---|
| `count` | number (int, 1–200) | required | How many characters to erase |

**Maestro export:** `eraseText: count`

---

### `hideKeyboard`
Dismiss the on‑screen keyboard. **Execution path:** extended (compiled Maestro `run_flow`).

**Fields:** _None beyond the common step metadata (§2.0)._

**Maestro export:** `hideKeyboard`

> This is the canonical no‑op‑on‑web example referenced in §3 — desktop browsers have no on‑screen
> keyboard to dismiss.

---

### `scroll`
Scroll the screen one page in a direction (default down). **Execution path:** extended (compiled Maestro
`run_flow`).

**Fields:**
| Field | Type | Required | Notes |
|---|---|---|---|
| `direction` | enum (`up,down,left,right`) | optional | Default `down` |

**Maestro export:** `scroll` (plain, down) or `swipe: { direction: "<DIR>" }` for other directions

---

### `scrollUntilVisible`
Keep scrolling until the target text is visible. **Execution path:** extended (compiled Maestro
`run_flow`).

**Fields:**
| Field | Type | Required | Notes |
|---|---|---|---|
| `text` | string | required | Scroll until an element with this text appears |

**Maestro export:** `scrollUntilVisible: { element: { text: "…" } }`

---

### `back`
Navigate back (Android hardware back / iOS edge‑swipe). **Execution path:** extended (compiled Maestro
`run_flow`).

**Fields:** _None beyond the common step metadata (§2.0)._

**Maestro export:** `back`

---

### `assertNotVisible`
Assert an element is absent. **Execution path:** extended (compiled Maestro `run_flow`).

**Fields:**
| Field | Type | Required | Notes |
|---|---|---|---|
| `text` | string | required | Assert this text is NOT visible |
| `timeoutMs` | number (int, 0–120 000) | optional | |

**Maestro export:** `assertNotVisible: "…"` (or with an explicit `timeout:` block)

---

### `waitForNotVisible`
Wait until an element disappears (e.g. a loading spinner). **Execution path:** extended (compiled
Maestro `run_flow`).

**Fields:**
| Field | Type | Required | Notes |
|---|---|---|---|
| `text` | string | required | Wait until this text disappears |
| `timeoutMs` | number (int, 0–120 000) | optional | |

**Maestro export:** `extendedWaitUntil: { notVisible: "…", timeout: … }`

---

### `openLink`
Open a URL / deep link. **Execution path:** extended (compiled Maestro `run_flow`).

**Fields:**
| Field | Type | Required | Notes |
|---|---|---|---|
| `url` | string | required | Deep link or URL to open |

**Maestro export:** `openLink: "…"`

---

### `launchApp`
Launch (foreground) an app. **Execution path:** extended (compiled Maestro `run_flow`).

**Fields:**
| Field | Type | Required | Notes |
|---|---|---|---|
| `bundleId` | string | optional | Defaults to the flow's app |

**Maestro export:** `launchApp` (or `launchApp: { appId: "…" }`)

---

### `stopApp`
Terminate an app. **Execution path:** extended (compiled Maestro `run_flow`).

**Fields:**
| Field | Type | Required | Notes |
|---|---|---|---|
| `bundleId` | string | optional | Defaults to the flow's app |

**Maestro export:** `stopApp` (or `stopApp: { appId: "…" }`)

---

### `copyText`
Copy text from an element into the clipboard. **Execution path:** extended (compiled Maestro
`run_flow`).

**Fields:**
| Field | Type | Required | Notes |
|---|---|---|---|
| `text` | string | required | Copy text from the element matching this text |

**Maestro export:** `copyTextFrom: { text: "…" }`

> This is the action §4's worked variable‑capture example is built on — see §4.3.

---

### `pasteText`
Paste the clipboard into the focused field. **Execution path:** extended (compiled Maestro `run_flow`).

**Fields:** _None beyond the common step metadata (§2.0)._

**Maestro export:** `pasteText`

---

### `raw`
Run a raw Maestro command (advanced escape hatch). **Execution path:** extended (compiled Maestro
`run_flow`).

**Fields:**
| Field | Type | Required | Notes |
|---|---|---|---|
| `maestro` | string (min length 1) | required | Raw Maestro command(s) — the escape hatch for anything not covered by the closed vocabulary |

**Maestro export:** the string is emitted verbatim, one Maestro command per non‑blank line.

> Per Pillar S, `raw` (like `${expr}`) is an **advanced/unsafe tier** — flag‑gated, sandboxed, import‑
> warned, and explicitly **excluded from the "closed‑IR → deterministic" guarantee**. It is the one
> action whose behavior this spec cannot fully close over, by design.

---

**Vocabulary count check:** 26 actions listed above (`tap, tapText, type, key, swipe, waitFor, waitMs,
screenshot, assertVisible, doubleTap, longPress, tapIfVisible, clearText, deleteText, hideKeyboard,
scroll, scrollUntilVisible, back, assertNotVisible, waitForNotVisible, openLink, launchApp, stopApp,
copyText, pasteText, raw`) — matches `NATIVE_ACTIONS` (9) + extended (17) in `shared/ir.ts`, zero dropped
from the R0 baseline.

## 3. Platform capability matrix

Every action × {mobile, browser}, zero blank cells. "Mobile" = iOS‑sim/Android via Maestro (today).
"Browser" = the Playwright/CloakBrowser driver reserved by Pillar J (ships in E16; this matrix is the
contract that driver must satisfy on day one).

| Action | Mobile | Browser | Notes |
|---|---|---|---|
| `tap` | supported | supported | Browser: mouse click at viewport coordinate |
| `tapText` | supported | supported | Browser: click via the DOM locator (§5) |
| `type` | supported | supported | |
| `key` | supported | supported\* | \*Mobile‑only values (`home, lock, volume up, volume down, power`) are **no‑op** on browser — no hardware equivalent. `enter/backspace/tab/back` map to standard browser key events |
| `swipe` | supported | **unsupported** | No native touch‑swipe gesture on a desktop browser; author should use `scroll` on browser targets. Lint (E3) should flag `swipe` on a browser target profile |
| `waitFor` | supported | supported | |
| `waitMs` | supported | supported | |
| `screenshot` | supported | supported | |
| `assertVisible` | supported | supported | |
| `doubleTap` | supported | supported | Browser: dispatched as a native `dblclick` |
| `longPress` | supported | supported | Browser: simulated via pointerdown → wait → pointerup (no true OS long‑press) |
| `tapIfVisible` | supported | supported | |
| `clearText` | supported | supported | |
| `deleteText` | supported | supported | Browser: simulated via N `Backspace` key presses |
| `hideKeyboard` | supported | **no‑op** | Canonical no‑op example (AC3): desktop browsers have no on‑screen keyboard to dismiss |
| `scroll` | supported | supported | |
| `scrollUntilVisible` | supported | supported | |
| `back` | supported | supported | Mobile: Android hardware back / iOS edge‑swipe. Browser: history‑back navigation — semantically different ("navigate back" vs. "close overlay"), so lint should *warn*, not error, on browser targets |
| `assertNotVisible` | supported | supported | |
| `waitForNotVisible` | supported | supported | |
| `openLink` | supported | supported | Mobile: deep link. Browser: URL navigation — the canonical browser‑flow entry point (see E7) |
| `launchApp` | supported | **unsupported** | Browser has no installed‑app concept; browser flows start via `openLink` instead (driver‑level context creation, not an IR action) |
| `stopApp` | supported | **unsupported** | No app process to terminate on browser; closing a browser context/tab is a driver‑orchestration concern, not an IR action |
| `copyText` | supported | supported | Browser: requires a clipboard‑write permission grant in the driver profile |
| `pasteText` | supported | supported | Browser: requires a clipboard‑read permission grant |
| `raw` | supported | **unsupported** | `raw` is a Maestro‑YAML escape hatch; a pure‑Playwright browser driver has no Maestro process to hand raw YAML to (also already excluded from the determinism guarantee, see §2 `raw`) |

**Legend:** `supported` = the driver executes the action's real semantics · `no‑op` = the driver accepts
the step and safely does nothing (never fails the run) · `unsupported` = the action is invalid on this
platform and MUST be caught at lint time (E3) rather than at runtime.

## 4. Variable‑scope rules

#### 4.1 Two variable kinds

1. **Fixture variables** — declared in `flow.fixtures` (or merged in at run time), referenced via
   `{{dot.path}}` in any string‑typed field, resolved once at compile time by `interpolate()`
   (`shared/ir.ts`). Scope: the entire flow, immutable for the duration of a run.
2. **Captured variables** — produced *during* execution by a step whose result is inherently textual.
   In the closed R1 vocabulary the capture surface is `copyText` (element text → clipboard). Scope:
   from the point of capture to the end of the run, visible to every later step regardless of which
   engine (native or Maestro) executes them.

#### 4.2 The native↔Maestro `env` boundary

A flow's steps are split across two execution engines by `isNativeAction()` (`shared/ir.ts`): contiguous
`NATIVE_ACTIONS` run through Podium's `run_steps` (fast, streamed, structured per‑step results); every
other action is compiled into a per‑step (or per‑segment) Maestro `run_flow` YAML (`shared/maestro.ts`).
These are two separate processes — a value captured inside one is invisible to the other unless the
runner (Pillar A) explicitly bridges it.

The rule: **at segment‑compile time** — i.e. the moment the runner is about to hand the next contiguous
segment to a different engine than the previous one — every variable captured so far (fixtures +
runtime‑captured) is serialized into that segment's context:

- **native → Maestro:** captured values are written into the compiled flow's `env:` block, so the
  Maestro segment can reference them as `${VAR_NAME}` in any field that accepts interpolation.
- **Maestro → native:** the structured result of the `run_flow` call is parsed back by the runner and
  merged into the native `interpolate()` fixtures context for subsequent steps.

This keeps captured variables on **one timeline** across the boundary, regardless of which engine
produced or consumes them — this is exactly what E2 AC4 (hybrid boundary crossing, 0 data loss) verifies
at runtime; E1's job is only to fix the contract both engines agree on.

#### 4.3 Worked example (native‑capture → `env` → Maestro‑assertion, traceable end to end)

A login flow needs to read a one‑time‑passcode (OTP) shown on screen after requesting it, then confirm
the *same* OTP is echoed back on a confirmation screen one segment later.

1. **Native segment (`run_steps`):** step 3 is `{ action: "copyText", text: "otp-display" }`. Podium
   executes it natively and returns the copied string, e.g. `"482913"`, in the structured `run_steps`
   result.
2. **Runner captures the value:** the runner names it `otp_code` (the capture name is the runner's
   bookkeeping, not an IR field — no new IR action is introduced) and adds `otp_code: "482913"` to the
   run's variable table.
3. **Segment boundary:** step 4 is `assertVisible` on the *next* screen, but it's grouped into a
   compiled Maestro segment because a preceding `waitForNotVisible` (extended action) forced the switch.
   At segment‑compile time the runner injects the variable table into that segment's `env:` block:
   ```yaml
   appId: com.example.app
   env:
     otp_code: "482913"
   ---
   - assertVisible: "${otp_code}"
   ```
4. **Maestro executes the segment** using its own native `${otp_code}` env‑var interpolation — no
   IR‑level string substitution is needed here because the value already crossed the boundary as `env`.
5. **Result mapping:** the segment's pass/fail result is stitched back onto the same run timeline the
   native steps started, so the run report shows one continuous sequence, not two disjoint runs.

A reviewer can trace this end to end with zero ambiguity: `copyText` (native) → runner variable table →
`env:` injection at compile time → `${otp_code}` (Maestro) → result merged onto one timeline.

## 5. Selector data model

#### 5.1 Why platform‑scoped

Pillar F's future selector library ("define once, reuse everywhere") and Pillar T's WebView‑aware
targets both require that **one logical element** (e.g. "the login button") can carry a locator for
*each* platform it might be driven on — a mobile a11y locator and a browser DOM locator are stored
side by side on the same selector entry, not as two separate elements. E1 only reserves this shape; the
selector *library* feature (lookup, reuse, versioning of entries) is E13's job, and the browser driver
that would actually resolve the browser half is E16's job.

#### 5.2 Schema

```
SelectorEntry {
  id: string                          // stable id, for future library reuse (E13)
  label: string                       // human-readable name, e.g. "Login button"
  mobile?: MobileLocator
  browser?: BrowserLocator
}

MobileLocator {                       // a11y-first — maps 1:1 onto today's inline
                                       // tapText/doubleTap/longPress/… fields
  text?: string                       // visible text (→ IR `text`, Podium/Maestro `text`)
  accessibilityId?: string            // → IR `targetId`, Podium `id`
  index?: number                      // disambiguates repeated matches (→ IR `index`)
  platform?: "ios" | "android" | "both"
}

BrowserLocator {                      // DOM-first — reserved field set, not yet
                                       // present on stepSchema; added when E16 ships
  role?: string                       // ARIA role, e.g. "button"
  testId?: string                     // data-testid attribute (preferred — most stable)
  cssSelector?: string                // fallback CSS selector
  text?: string                       // visible text match
  nth?: number                        // disambiguates repeated matches
}
```

`MobileLocator` is not a new schema — it is the same `text` / `targetId` / `index` fields the tap‑like
actions in §2 already carry inline, named here so they can be addressed as a unit. `BrowserLocator` is
the reserved addition: it does not exist on `stepSchema` today (no code change in this epic — see §6.3
for how it gets added as a MINOR, backward‑compatible bump when E16 ships).

#### 5.3 Worked example — "Login button"

```
{
  id: "sel-login-button",
  label: "Login button",
  mobile: {
    text: "Đăng nhập",
    accessibilityId: "login_btn",
    index: 0,
    platform: "both"
  },
  browser: {
    role: "button",
    testId: "login-button",
    text: "Đăng nhập",
    nth: 0
  }
}
```

On mobile this resolves through the existing `tapText` fields (`text`/`targetId`/`index`) exactly as
`shared/ir.ts` defines them today. On browser it resolves through the reserved `BrowserLocator` fields —
preferring `testId` (most stable), falling back to `role` + `text`, with `nth` to disambiguate — once
E16's driver implements resolution. Both locators describe the *same* logical element, satisfying
Pillar F's "define once per element, not per platform."

## 6. Versioning scheme

#### 6.1 `schema_version` field & semver rule

`flowSchema.schemaVersion` (`shared/ir.ts`) is an integer that tracks **MAJOR** only — today it is `1`,
paired with an IR spec semver of `1.0.0`. The full rule:

| Bump | Meaning | Effect on `flow.schemaVersion` | Effect on existing v1 flows |
|---|---|---|---|
| **MAJOR** (`X.0.0`) | Breaking change — a field is renamed/removed, an action is removed, or an existing field's meaning changes | Increments (e.g. `1` → `2`); a migration function is required | Old flows must run through the migration before they validate under the new schema |
| **MINOR** (`1.X.0`) | Additive, backward‑compatible change — a new action is added to the discriminated union, or a new *optional* field is added to an existing action | **Unchanged** — stays `1` | Continue to `safeParse` successfully with zero changes, because a `z.discriminatedUnion` only needs to recognize the variants it was built with; new variants don't invalidate old ones |
| **PATCH** (`1.0.X`) | Documentation/typo fixes to this spec, no schema change at all | Unchanged | Unaffected |

The versioning scheme is **additive‑by‑default**: no breaking change ships without an explicit MAJOR
bump and a migration note (per the E1 review gate).

#### 6.2 Worked example — adding one action under this rule (v1.0.0 → v1.1.0)

Proposal: add a hypothetical `dragAndDrop` action (drag one element onto another), executed via the
extended (Maestro `run_flow`) path like `doubleTap`/`longPress`.

1. Add one new member to the `stepSchema` discriminated union:
   ```ts
   z.object({
     ...meta,
     action: z.literal("dragAndDrop"),
     fromText: z.string(),
     toText: z.string(),
   }).describe("Drag one element onto another.")
   ```
2. This is purely additive: no existing action's fields change, nothing is removed.
3. `flow.schemaVersion` **stays `1`** — the IR spec bumps to `1.1.0`, not `2.0.0`.
4. Compatibility check: take any existing v1 flow (e.g. the 14‑step reference flow used by E2/E3's test
   matrices, which uses only `tap/type/assertVisible/waitFor/…`). Run it through `flowSchema.safeParse()`
   both before and after the `dragAndDrop` addition. The result is identical — `ok: true`, same parsed
   steps, same errors array (empty) — because `z.discriminatedUnion` dispatches on the `action` literal
   already present in every existing step; a v1 flow never contains `"action": "dragAndDrop"`, so the
   new union member is never even reached during its parse. **Zero v1 flows change behavior.**
5. Downstream: `NATIVE_ACTIONS` is untouched (drag‑and‑drop is extended‑only), so `isNativeAction()`'s
   behavior for all 26 existing actions is unchanged; `shared/maestro.ts` gets one new `case` in its
   switch, and TypeScript's exhaustiveness check on the switch is what forces that case to be added
   before the code compiles — this is the concrete mechanism that prevents "an action with no export
   path" (non‑negotiable #6).

This walkthrough is the "add one action" compatibility example required by AC6: additive, no
`schema_version` bump, no v1 flow invalidated.

## 7. Changelog & sign‑off

| Version | Date | Author | Change |
|---|---|---|---|
| 1.0.0 | 2026‑07‑14 | worker‑E1 (agent, Janus E1 run) | Initial publication. Carries forward all 26 R0‑baseline actions from `shared/ir.ts` with zero drops; adds the platform capability matrix, variable‑scope rules (native↔Maestro `env` boundary), the reserved selector data model (§5), and the versioning scheme (§6). No code changed — doc‑only per E1 scope. |

**Review gate (reviewer ≠ implementer):** _Pending — sign‑off must be recorded here by a reviewer who did
not author this document, per the Janus review gate in `janus-specs/R1-foundations/E1-ir-spec.md`. The
reviewer must confirm: this IR does not contradict `PODIUM-STUDIO-PLAN.md` §4 Pillar IR; all 26
R0‑baseline actions are carried forward with no silent drops; the selector model pre‑reserves platform
scoping without overbuilding E13/E16's functionality; the versioning scheme is additive‑by‑default; no
epic downstream of E1 has begun assuming an action or field not documented here._

| Reviewer | Date | Verdict |
|---|---|---|
| _TBD — assign at team run_ | _TBD_ | _TBD_ |
