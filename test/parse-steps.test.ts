import { describe, it, expect } from "vitest";
import { parseSteps, stepsToText } from "../shared/parse-steps.ts";
import { validateFlow } from "../shared/ir.ts";

describe("parseSteps", () => {
  it("parses each command kind", () => {
    const { steps, issues } = parseSteps(`
# a comment
tap Login
tap #login_btn
tap 120, 340
type hello@mail.com
type secret + enter
wait for Home
wait for Dashboard 30s
wait 1500ms
wait 2s
assert Welcome
see General
swipe up
press enter
screenshot
    `);
    expect(issues).toEqual([]);
    expect(steps.map((s) => s.action)).toEqual([
      "tapText", "tapText", "tap", "type", "type",
      "waitFor", "waitFor", "waitMs", "waitMs",
      "assertVisible", "assertVisible", "swipe", "key", "screenshot",
    ]);
  });

  it("maps targets correctly", () => {
    const { steps } = parseSteps("tap Login\ntap #btn_ok\ntap 10, 20");
    expect(steps[0]).toMatchObject({ action: "tapText", text: "Login" });
    expect(steps[1]).toMatchObject({ action: "tapText", targetId: "btn_ok" });
    expect(steps[2]).toMatchObject({ action: "tap", x: 10, y: 20 });
  });

  it("handles submit variants and durations", () => {
    expect(parseSteps("type pw + enter").steps[0]).toMatchObject({ action: "type", text: "pw", submit: true });
    expect(parseSteps("type pw then enter").steps[0]).toMatchObject({ submit: true });
    expect(parseSteps("wait for X 30s").steps[0]).toMatchObject({ action: "waitFor", timeoutMs: 30000 });
    expect(parseSteps("wait 2s").steps[0]).toMatchObject({ action: "waitMs", ms: 2000 });
  });

  it("supports optional :: label and quotes", () => {
    const { steps } = parseSteps(`tap "Log In" :: Open the login screen`);
    expect(steps[0]).toMatchObject({ action: "tapText", text: "Log In", label: "Open the login screen" });
  });

  it("reports issues with line numbers, not throwing", () => {
    const { steps, issues } = parseSteps("tap Login\nfrobnicate widget\ntype x");
    expect(steps).toHaveLength(2);
    expect(issues).toHaveLength(1);
    expect(issues[0].line).toBe(2);
    expect(issues[0].error).toMatch(/unknown command/i);
  });

  it("produces steps that build a valid flow", () => {
    const { steps } = parseSteps("screenshot\nwait for Home\nassert Home");
    const flow = { schemaVersion: 1, name: "T", app: { bundleId: "com.x", platform: "ios-sim" }, steps };
    expect(validateFlow(flow).ok).toBe(true);
  });

  it("round-trips through stepsToText → parseSteps", () => {
    const original = parseSteps("tap Login\ntype a@b.com\nwait for Home 20s\nassert Welcome\nswipe up\nscreenshot").steps;
    const text = stepsToText(original);
    const reparsed = parseSteps(text).steps;
    expect(reparsed.map((s) => s.action)).toEqual(original.map((s) => s.action));
  });
});

describe("parseSteps — extended vocabulary", () => {
  it("parses the new action verbs", () => {
    const { steps, issues } = parseSteps(`
double tap Photo
long press Message
tap Close if visible
clear text
delete 3
hide keyboard
scroll down
scroll until "Load More"
back
assert not "Error"
wait until Loading gone
open demoapp://home
launch
stop
copy from Code
paste
raw - tapOn: "Anything"
`);
    expect(issues).toEqual([]);
    expect(steps.map((s) => s.action)).toEqual([
      "doubleTap", "longPress", "tapIfVisible", "clearText", "deleteText",
      "hideKeyboard", "scroll", "scrollUntilVisible", "back", "assertNotVisible",
      "waitForNotVisible", "openLink", "launchApp", "stopApp", "copyText", "pasteText", "raw",
    ]);
  });

  it("'type X into <field>' expands to tap-the-field + type (2 steps)", () => {
    const { steps } = parseSteps(`type user@example.com into Email`);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ action: "tapText", text: "Email" });
    expect(steps[1]).toMatchObject({ action: "type", text: "user@example.com" });
  });

  it("'type <field>: <text>' also expands to tap-the-field + type", () => {
    const { steps } = parseSteps(`type email: "qa@example.com"`);
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ action: "tapText", text: "email" });
    expect(steps[1]).toMatchObject({ action: "type", text: "qa@example.com" });
  });

  it("'tap X if <condition>' becomes a best-effort tapIfVisible", () => {
    const { steps } = parseSteps(`tap Reveal if popup is DailyBonus`);
    expect(steps[0]).toMatchObject({ action: "tapIfVisible", text: "Reveal" });
  });

  it("delete without a number defaults to 1; deleteText carries the count", () => {
    expect(parseSteps("delete").steps[0]).toMatchObject({ action: "deleteText", count: 1 });
    expect(parseSteps("delete text 5").steps[0]).toMatchObject({ action: "deleteText", count: 5 });
  });

  it("raw preserves the Maestro command verbatim", () => {
    const { steps } = parseSteps(`raw - scrollUntilVisible: { element: { text: "X" } }`);
    expect(steps[0]).toMatchObject({ action: "raw", maestro: `- scrollUntilVisible: { element: { text: "X" } }` });
  });

  it("launch/stop keep bundle ids that start with 'app' (regex word-boundary fix)", () => {
    expect(parseSteps("launch apple.foo").steps[0]).toMatchObject({ action: "launchApp", bundleId: "apple.foo" });
    expect(parseSteps("launch app.company.x").steps[0]).toMatchObject({ action: "launchApp", bundleId: "app.company.x" });
    expect(parseSteps("launch com.foo").steps[0]).toMatchObject({ action: "launchApp", bundleId: "com.foo" });
    expect(parseSteps("launch app").steps[0]).toMatchObject({ action: "launchApp" });
    expect(parseSteps("launch app").steps[0]).not.toHaveProperty("bundleId");
    expect(parseSteps("launch").steps[0]).not.toHaveProperty("bundleId");
    expect(parseSteps("stop apple.foo").steps[0]).toMatchObject({ action: "stopApp", bundleId: "apple.foo" });
    expect(parseSteps("stop app.company.x").steps[0]).toMatchObject({ action: "stopApp", bundleId: "app.company.x" });
    expect(parseSteps("stop com.foo").steps[0]).toMatchObject({ action: "stopApp", bundleId: "com.foo" });
    expect(parseSteps("stop app").steps[0]).not.toHaveProperty("bundleId");
  });

  it("'tap Close if popup' still becomes tapIfVisible", () => {
    expect(parseSteps("tap Close if popup").steps[0]).toMatchObject({ action: "tapIfVisible", text: "Close" });
  });

  it("a QUOTED tap target with 'if' inside stays a literal tapText (no split, no stray quote)", () => {
    const { steps } = parseSteps(`tap "Notify me if available"`);
    expect(steps[0]).toMatchObject({ action: "tapText", text: "Notify me if available" });
  });

  it("'type submit' types the literal word 'submit' (no empty text)", () => {
    const { steps } = parseSteps("type submit");
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ action: "type", text: "submit" });
    expect(steps[0]).not.toHaveProperty("submit");
  });

  it("'call <flowFile>' parses to a param-less callSubFlow (E13)", () => {
    const { steps, issues } = parseSteps("call login.flow.json");
    expect(issues).toEqual([]);
    expect(steps).toEqual([{ id: expect.any(String), action: "callSubFlow", flowFile: "login.flow.json" }]);
  });

  it("'call <flowFile>(name=value, ...)' parses params into a callSubFlow (E13)", () => {
    const { steps, issues } = parseSteps("call login.flow.json(email=a@b.com, pw=hunter2)");
    expect(issues).toEqual([]);
    expect(steps[0]).toMatchObject({
      action: "callSubFlow",
      flowFile: "login.flow.json",
      params: { email: "a@b.com", pw: "hunter2" },
    });
  });

  it("'call' round-trips through stepsToText → parseSteps, with and without params", () => {
    const original = parseSteps(`call login.flow.json
call spin.flow.json(email={{savedEmail}}, pw=\${secret:testPw})`).steps;
    const text = stepsToText(original);
    const reparsed = parseSteps(text);
    expect(reparsed.issues).toEqual([]);
    expect(reparsed.steps.map((s) => s.action)).toEqual(["callSubFlow", "callSubFlow"]);
    expect(reparsed.steps[1]).toMatchObject({ params: { email: "{{savedEmail}}", pw: "${secret:testPw}" } });
  });

  it("'call' reports an issue instead of throwing when given no flow file or malformed params", () => {
    expect(parseSteps("call").issues[0].error).toMatch(/needs a sub-flow file/);
    expect(parseSteps("call login.flow.json(bogus)").issues[0].error).toMatch(/name=value/);
  });

  it("'type X into <coords>' taps the coordinate point, not tapText", () => {
    const { steps } = parseSteps("type hello into 120, 340");
    expect(steps).toHaveLength(2);
    expect(steps[0]).toMatchObject({ action: "tap", x: 120, y: 340 });
    expect(steps[0]).not.toHaveProperty("text");
    expect(steps[1]).toMatchObject({ action: "type", text: "hello" });
  });

  it("the user's real scenario parses to sensible steps", () => {
    const { steps, issues } = parseSteps(`tap login
type email: "qa@example.com"
type password: "Test12345@"
wait 5000ms
tap Close if popup
tap Reveal if popup is DailyBonus
screenshot`);
    expect(issues).toEqual([]);
    expect(steps.map((s) => s.action)).toEqual([
      "tapText",                 // tap login
      "tapText", "type",          // type email into field
      "tapText", "type",          // type password into field
      "waitMs",
      "tapIfVisible",             // tap Close if popup
      "tapIfVisible",             // tap Reveal if popup is DailyBonus
      "screenshot",
    ]);
  });
});
