import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isActionSensitive,
  isExfilNavigation,
  pruneImageBlocks,
  actionSignature,
  formatElementsList,
  formatPageInfo,
  interpretCoordinates,
  refHint,
  suggestRef,
  SENSITIVE_LABEL_RE,
} from "../src/agent.js";
import { assertNavigable, assertInjectable, rankAndTrim } from "../src/tab-actions.js";

const el = (ref, label, extra = {}) => ({ ref, label, tag: "button", ...extra });

// --- the approval gate ------------------------------------------------------

test("model self-flagging always wins", () => {
  assert.equal(isActionSensitive("scroll", { sensitive: true }), true);
});

test("consequential button labels are caught even when the model forgets", () => {
  const elements = [el("0", "Submit application"), el("1", "Learn more")];
  assert.equal(isActionSensitive("click", { ref: "0" }, { elements }), true);
  assert.equal(isActionSensitive("click", { ref: "1" }, { elements }), false);
});

test("the label list stays narrow enough to not fire on ordinary UI", () => {
  for (const benign of ["Accept all cookies", "I agree", "Cancel", "Sign in", "Follow", "Apply filters"]) {
    assert.equal(SENSITIVE_LABEL_RE.test(benign), false, `${benign} should not be flagged`);
  }
  for (const risky of ["Submit", "Buy now", "Place order", "Send message", "Delete account", "Post"]) {
    assert.equal(SENSITIVE_LABEL_RE.test(risky), true, `${risky} should be flagged`);
  }
});

test("PayPal does not trip the 'pay' word boundary", () => {
  assert.equal(SENSITIVE_LABEL_RE.test("Log in with PayPal"), false);
});

test("typing into a password field needs approval", () => {
  const pageInfo = { focus: { tag: "input", type: "password", inForm: true } };
  assert.equal(isActionSensitive("type", { text: "hunter2" }, { pageInfo }), true);
  const searchBox = { focus: { tag: "input", type: "search", inForm: true } };
  assert.equal(isActionSensitive("type", { text: "shoes" }, { pageInfo: searchBox }), false);
});

test("password check follows the ref when type targets a field directly", () => {
  const elements = [
    { ref: "0", tag: "input", type: "password", label: "Password" },
    { ref: "1", tag: "input", type: "search", label: "Search" },
  ];
  // A ref-targeted type never focuses first, so the focus-based check alone
  // would miss it.
  const noFocus = { focus: null };
  assert.equal(isActionSensitive("type", { ref: "0", text: "hunter2" }, { elements, pageInfo: noFocus }), true);
  assert.equal(isActionSensitive("type", { ref: "1", text: "jobs" }, { elements, pageInfo: noFocus }), false);
});

test("Enter inside a form needs approval, since it submits", () => {
  const inForm = { focus: { tag: "input", type: "text", inForm: true } };
  assert.equal(isActionSensitive("key", { key: "Enter" }, { pageInfo: inForm }), true);
  assert.equal(isActionSensitive("key", { key: "Escape" }, { pageInfo: inForm }), false);

  const notInForm = { focus: { tag: "div", type: "", inForm: false } };
  assert.equal(isActionSensitive("key", { key: "Enter" }, { pageInfo: notInForm }), false);
});

test("gate tolerates missing page state", () => {
  assert.equal(isActionSensitive("key", { key: "Enter" }, {}), false);
  assert.equal(isActionSensitive("click", { ref: "9" }, { elements: [] }), false);
  assert.equal(isActionSensitive("click", {}), false);
});

// --- navigation safety ------------------------------------------------------

test("only http and https are navigable", () => {
  assert.equal(assertNavigable("https://example.com/x"), "https://example.com/x");
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,<b>", "chrome://settings"]) {
    assert.throws(() => assertNavigable(bad), /Refusing to navigate|Not a valid URL/);
  }
});

test("browser-internal pages are not injectable", () => {
  assert.throws(() => assertInjectable("chrome://extensions"), /Cannot run on/);
  assert.throws(() => assertInjectable("view-source:https://example.com"), /Cannot run on/);
  assert.doesNotThrow(() => assertInjectable("https://example.com"));
});

test("exfiltration-shaped navigation is flagged, ordinary navigation is not", () => {
  const here = "https://mail.example.com/inbox";
  const payload = "https://evil.test/collect?d=" + "A".repeat(200);
  assert.equal(isExfilNavigation(payload, here), true);
  assert.equal(isExfilNavigation("https://www.google.com/search?q=wireless+mouse", here), false);
  assert.equal(isExfilNavigation("https://news.example.org", here), false);
  // Same origin is the agent moving around the site it's already on.
  assert.equal(isExfilNavigation("https://mail.example.com/x?" + "b".repeat(200), here), false);
  assert.equal(isExfilNavigation("not a url", here), false);
});

// --- context management -----------------------------------------------------

const imageMsg = (n) => ({
  role: "user",
  content: [
    { type: "text", text: `step ${n}` },
    { type: "image_url", image_url: { url: `data:image/png;base64,AAA${n}` } },
  ],
});

test("only the most recent screenshots survive pruning", () => {
  const messages = [{ role: "system", content: "sys" }, ...[1, 2, 3, 4, 5].map(imageMsg)];
  const dropped = pruneImageBlocks(messages, 2);
  assert.equal(dropped, 3);

  const remaining = messages.flatMap((m) =>
    Array.isArray(m.content) ? m.content.filter((b) => b.type === "image_url") : []
  );
  assert.equal(remaining.length, 2);
  assert.equal(remaining[0].image_url.url, "data:image/png;base64,AAA4");
  assert.equal(remaining[1].image_url.url, "data:image/png;base64,AAA5");

  // Dropped images leave a placeholder behind, so the narrative survives.
  assert.match(messages[1].content[1].text, /earlier screenshot omitted/);
});

test("pruning is a no-op when under the limit", () => {
  const messages = [imageMsg(1), imageMsg(2)];
  assert.equal(pruneImageBlocks(messages, 3), 0);
});

test("action signatures distinguish targets and collapse repeats", () => {
  assert.equal(actionSignature("click", { ref: "3", reason: "a" }), actionSignature("click", { ref: "3", reason: "b" }));
  assert.notEqual(actionSignature("click", { ref: "3" }), actionSignature("click", { ref: "4" }));
  assert.notEqual(actionSignature("type", { text: "a" }), actionSignature("type", { text: "b" }));
});

// --- rendering --------------------------------------------------------------

test("elements list renders refs, tags, and labels", () => {
  const out = formatElementsList([
    { ref: "0", tag: "a", type: "", label: "Learn more" },
    { ref: "1", tag: "input", type: "search", label: "Search" },
  ]);
  assert.equal(out, '[0] <a> Learn more\n[1] <input type=search> Search');
  assert.match(formatElementsList([]), /no interactive elements/);
});

test("page info reports scroll progress and whether more is below", () => {
  const top = formatPageInfo({ url: "https://x.test/", title: "X", scrollY: 0, viewportHeight: 800, pageHeight: 2400 });
  assert.match(top, /URL: https:\/\/x\.test\//);
  assert.match(top, /Scroll: 0% down the page \(more content below: yes\)/);

  const bottom = formatPageInfo({ url: "https://x.test/", title: "X", scrollY: 1600, viewportHeight: 800, pageHeight: 2400 });
  assert.match(bottom, /Scroll: 100% down the page \(more content below: no\)/);

  // A page that fits on one screen shouldn't divide by zero.
  const short = formatPageInfo({ url: "https://x.test/", title: "X", scrollY: 0, viewportHeight: 800, pageHeight: 600 });
  assert.match(short, /Scroll: 0%/);
});

// --- coordinate interpretation ----------------------------------------------

// A 1280x800 CSS viewport on a 2x display: the screenshot is 2560x1600.
const GEOM = { viewportWidth: 1280, viewportHeight: 800, dpr: 2 };

test("screenshot pixels scale down by the device pixel ratio", () => {
  const p = interpretCoordinates(800, 400, GEOM);
  assert.deepEqual(p, { x: 400, y: 200, space: "image" });
});

test("fractions of the viewport are recognised and scaled", () => {
  // The exact pair the Nemotron run emitted on LinkedIn.
  const p = interpretCoordinates(0.215, 0.2058, GEOM);
  assert.equal(p.space, "fraction");
  assert.equal(Math.round(p.x), 275);
  assert.equal(Math.round(p.y), 165);
});

test("numeric strings are accepted", () => {
  assert.deepEqual(interpretCoordinates("800", "400", GEOM), { x: 400, y: 200, space: "image" });
  assert.equal(interpretCoordinates(" 0.5 ", "0.5", GEOM).space, "fraction");
});

test("unusable input returns null rather than clicking somewhere arbitrary", () => {
  for (const [x, y] of [
    [undefined, undefined],
    [null, null],
    ["", ""],
    ["left", "top"],
    [NaN, 10],
    [-5, 10],
    [Infinity, 10],
  ]) {
    assert.equal(interpretCoordinates(x, y, GEOM), null, `${x},${y} should be unusable`);
  }
});

test("coordinates past the viewport edge are clamped, not dropped", () => {
  const p = interpretCoordinates(9999, 9999, GEOM);
  assert.equal(p.space, "clamped");
  assert.ok(p.x < 1280 && p.y < 800);
});

test("without viewport geometry, small values stay literal", () => {
  // No geometry means no way to scale a fraction, so treat as pixels.
  assert.deepEqual(interpretCoordinates(1, 1, {}), { x: 1, y: 1, space: "image" });
});

test("ref hint puts editable fields first and names the tool argument", () => {
  const elements = [
    { ref: "0", tag: "a", label: "Home" },
    { ref: "1", tag: "input", label: "Search" },
    { ref: "2", tag: "button", label: "Post" },
  ];
  const hint = refHint(elements);
  assert.match(hint, /"ref"/);
  assert.ok(hint.indexOf("[1]") < hint.indexOf("[0]"), "the input should be listed before the link");
});

test("ref hint says something useful when there is nothing to click", () => {
  assert.match(refHint([]), /no interactive elements/i);
});

test("ref hint truncates a long list", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ ref: String(i), tag: "a", label: `link ${i}` }));
  assert.match(refHint(many, 5), /and 25 more/);
});

// --- recovering from an invented ref ----------------------------------------

test("a hallucinated ref is matched back to the element the reason describes", () => {
  // Taken from a real run: the model asked for ref 429 against a list of 60.
  const elements = [
    { ref: "0", tag: "a", label: "Home" },
    { ref: "1", tag: "button", label: "Dismiss notification" },
    { ref: "2", tag: "input", label: "Search" },
  ];
  const guess = suggestRef(
    "Clicking the X button on the notification banner to close the 'This post has already been reposted' message.",
    elements
  );
  assert.equal(guess.ref, "1");
});

test("an exact label match beats a label that merely contains the word", () => {
  const elements = [
    { ref: "0", tag: "a", label: "Jobs you may be interested in" },
    { ref: "1", tag: "a", label: "Jobs" },
  ];
  // Listed second, so this only wins on merit rather than on ordering.
  assert.equal(suggestRef("Opening the jobs section to search for jobs", elements).ref, "1");
});

test("more matching words beat fewer", () => {
  const elements = [
    { ref: "0", tag: "a", label: "Messaging" },
    { ref: "1", tag: "button", label: "Dismiss notification banner" },
  ];
  assert.equal(suggestRef("Closing the notification banner", elements).ref, "1");
});

test("ref suggestion declines rather than guessing wildly", () => {
  const elements = [{ ref: "0", tag: "a", label: "Home" }];
  assert.equal(suggestRef("Clicking the button in the top right corner", elements), null);
  assert.equal(suggestRef("", elements), null);
  assert.equal(suggestRef("anything", []), null);
});

// --- element budgeting ------------------------------------------------------

test("form controls and buttons beat nav links when over budget", () => {
  const nav = Array.from({ length: 60 }, (_, i) => ({ tag: "a", label: `nav ${i}`, w: 80, h: 20 }));
  const content = [
    { tag: "input", label: "Search", w: 300, h: 40 },
    { tag: "button", label: "Go", w: 60, h: 40 },
  ];
  const kept = rankAndTrim([...nav, ...content], 10);
  assert.equal(kept.length, 10);
  assert.ok(kept.some((c) => c.label === "Search"), "the search input must survive");
  assert.ok(kept.some((c) => c.label === "Go"), "the submit button must survive");
});

test("ranking preserves DOM order among survivors", () => {
  const candidates = [
    { tag: "a", label: "first", w: 10, h: 10 },
    { tag: "input", label: "second", w: 10, h: 10 },
    { tag: "button", label: "third", w: 10, h: 10 },
  ];
  const kept = rankAndTrim(candidates, 2);
  assert.deepEqual(kept.map((c) => c.label), ["second", "third"]);
});

test("under-budget lists pass through untouched", () => {
  const candidates = [{ tag: "a", label: "only", w: 1, h: 1 }];
  assert.deepEqual(rankAndTrim(candidates, 60), candidates);
});
