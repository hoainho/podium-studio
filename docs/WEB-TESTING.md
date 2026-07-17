# Web testing

Podium Studio runs the same style of test in a **real browser**. Web apps are
harder than they look — the tricks below are built in, so a tester doesn't have
to know they exist.

## What works out of the box

### Frame-aware element resolution
Modern apps often render inside a cross-origin **iframe**. A naive driver only
searches the top page and never finds anything. Podium resolves every target
across the **main frame and every child iframe**, returning the frame that
actually contains it. This is the single biggest reason "the element is right
there but the test can't find it" — and it's handled automatically.

### Automatic consent / overlay dismissal
Cookie and consent banners (Accept all / Đồng ý / common CMPs) sit on top of the
page and swallow the first click. Podium dismisses them after navigation, then
waits for the reload the banner often triggers — so your first real step acts on
the live page, not a stale one.

### Wait-until-visible, across frames
Content that mounts late (lazy sections, iframe apps) is polled for until it
appears, instead of failing on a single early check.

### Role-preferred tapping
When you tap by text, Podium prefers the real interactive control (a button or
link) over a same-text heading, so a tap actually triggers the action.

## Evidence for every run
- **Per-step screenshots** (before/after) in the run timeline.
- A full **trace** (DOM / network / console timeline).
- A **video** of the entire run.

## Actionable failures
Instead of "waited and gave up", a failed web step tells you the likely cause:

- *blocked by an overlay* → dismiss a banner (or rely on auto-dismiss),
- *not found in any frame* → check the exact text or an iframe,
- *timeout / not loaded* → give it longer or wait on a known element.

## Engine
The default web engine is **Playwright** (native trace + video). A
**CloakBrowser** fallback is available for sites behind bot-protection. Chromium
is downloaded once and shared per machine — it is never bundled into the app
installer.

## Example
```
openLink   https://example.com
tap        "Sign in"          # found even if the app is inside an iframe
waitFor    "Password"
type       password: "${secret:demo-password}"
tap        "Continue"
assertVisible "Welcome back"  # the check that proves it worked
```
