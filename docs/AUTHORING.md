# Authoring a test (no code required)

A Podium Studio test is a short list of plain steps. If you can describe what you
do by hand, you can author the test.

## The building blocks
| You want to… | Step |
|---|---|
| Open a screen / URL | `openLink https://example.com` (web) or launch the app (mobile) |
| Tap a button or link | `tap "Log In"` |
| Type into a field | `type email: "user@example.com"` |
| Scroll to something | `scrollUntilVisible "Pricing"` |
| Wait for something | `waitFor "Dashboard"` |
| **Check the result** | `assertVisible "Welcome, Sam"` |

## Start with a charter
When you begin a new test, Podium asks one question: **what are you checking, and
what could go wrong?** A one-line answer ("logging in with email — worry: wrong
password still gets in") keeps the test focused on a real risk.

## Always end an action with a check
The single most important habit: after an action, **prove the result** — don't
just trust it ran. Podium nudges you when a test has actions but no check:

> You just did an action — did the screen change the way you expected? What would
> prove this action worked? Example: after tapping a button, check that a specific
> word or number appears (like "Order placed" or the new balance).

A good login test doesn't just check "the login screen is gone" — it checks the
logged-in user's name actually appears.

## Run it and read the evidence
Press **Run**. Each step turns green (passed) or red (failed) in the timeline,
with a **before/after screenshot**. A failing step gives an *actionable* reason
("an overlay is covering the page", "no element matches 'Log In' in any frame")
instead of a raw timeout — plus a full trace and a video of the whole run.

## Reuse and stay robust
- Save common sequences as sub-flows and call them from other tests.
- Prefer stable targets: visible text or a test id over pixel coordinates.
- Self-healing suggests a new selector when a label changes, so small UI edits
  don't break every test.
