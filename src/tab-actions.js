// Browser control without chrome.debugger. Uses chrome.scripting to inject
// small functions into the page (real DOM events, no CDP), and
// chrome.tabs.captureVisibleTab for screenshots. Neither requires the
// "debugger" permission, which some managed/enterprise Chrome installs
// block for unpacked (developer-mode) extensions even though the same
// action works fine through a Chrome-Web-Store-published extension.
//
// Trade-off: clicks/keys are synthetic DOM events (isTrusted: false), not
// OS-level input. That's fine for the overwhelming majority of pages
// (links, buttons, and forms all respond to dispatched events normally).
// A small number of sites with strict bot-detection that specifically
// checks event.isTrusted may behave differently.

const KEY_CODES = {
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  Delete: 46,
  ArrowUp: 38,
  ArrowDown: 40,
  ArrowLeft: 37,
  ArrowRight: 39,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
  " ": 32,
};

// Attribute stamped onto every candidate element during a scan, so a later
// click can re-find the exact node by selector instead of re-deriving it
// from a coordinate that may have gone stale.
const REF_ATTR = "data-nim-ref";

// Hard cap on how many DOM nodes we even consider per frame, so a
// pathological page (a 10k-row table of links) can't stall the scan.
const SCAN_LIMIT = 500;

const BLOCKED_SCHEMES =
  /^(chrome|chrome-extension|chrome-untrusted|edge|about|devtools|javascript|data|file|blob|filesystem|view-source):/i;

export function assertInjectable(url) {
  if (BLOCKED_SCHEMES.test(url || "")) {
    throw new Error("Cannot run on a chrome:// or extension page. Switch to a normal website tab.");
  }
}

// Only http(s) is a legitimate navigation target for the agent. javascript:,
// data:, and file: URLs are script-execution or local-disk-read primitives
// that a prompt-injected model could otherwise be talked into using.
export function assertNavigable(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    throw new Error(`Not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Refusing to navigate to a "${parsed.protocol}" URL. Only http and https are allowed.`);
  }
  return parsed.href;
}

/**
 * Rank and trim a candidate list down to `max` entries.
 *
 * Taking the first N in DOM order means a site with a 60-link mega-nav in
 * the header burns the entire budget before reaching the content the task
 * is actually about. Form controls and buttons are what tasks usually hinge
 * on, so they win ties over links, and larger on-screen targets win over
 * small ones. The surviving set is returned in DOM order so the list still
 * reads top-to-bottom the way the page looks.
 *
 * Pure function, exported for tests.
 */
export function rankAndTrim(candidates, max) {
  if (candidates.length <= max) return candidates.slice();
  const priority = (c) => {
    const tag = (c.tag || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return 3;
    if (tag === "button" || c.role === "button") return 2;
    return 1;
  };
  return candidates
    .map((c, i) => ({ c, i, p: priority(c), area: (c.w || 0) * (c.h || 0) }))
    .sort((a, b) => b.p - a.p || b.area - a.area || a.i - b.i)
    .slice(0, max)
    .sort((a, b) => a.i - b.i)
    .map((entry) => entry.c);
}

// ---------------------------------------------------------------------------
// Injected page functions. Each must be fully self-contained: chrome.scripting
// serializes the function source, so closures over module scope are not
// available inside them.
// ---------------------------------------------------------------------------

function collectCandidates(refAttr, scanLimit) {
  for (const stale of document.querySelectorAll(`[${refAttr}]`)) stale.removeAttribute(refAttr);

  const selector =
    'a[href], button, input, textarea, select, [role="button"], [role="link"], [role="checkbox"], ' +
    '[role="radio"], [role="tab"], [role="menuitem"], [role="switch"], [role="combobox"], ' +
    '[contenteditable="true"], [onclick], [tabindex]';
  const nodes = Array.from(document.querySelectorAll(selector)).slice(0, scanLimit);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const seen = new Set();
  const results = [];

  for (const el of nodes) {
    if (el.tabIndex === -1 && !["A", "BUTTON", "INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)) continue;
    if (el.disabled) continue;
    if (el.type === "hidden") continue;

    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) continue;

    const style = window.getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none" || parseFloat(style.opacity) === 0) continue;

    const cx = Math.round(rect.left + rect.width / 2);
    const cy = Math.round(rect.top + rect.height / 2);
    const key = `${cx},${cy}`;
    if (seen.has(key)) continue;
    seen.add(key);

    let label =
      el.getAttribute("aria-label") ||
      el.getAttribute("placeholder") ||
      el.getAttribute("alt") ||
      el.getAttribute("title") ||
      (el.innerText || "").trim() ||
      el.value ||
      "";
    label = String(label).trim().replace(/\s+/g, " ").slice(0, 60);
    if (!label) label = el.tagName === "IMG" ? "(image)" : "(no label)";

    const localId = String(results.length);
    el.setAttribute(refAttr, localId);

    // Whether this is somewhere text can be typed. Checkboxes, radios, and
    // submit inputs are <input> but take no text, and the real editor on a
    // rich-text widget is often a descendant of the clickable container.
    const NON_TEXT = ["checkbox", "radio", "submit", "button", "reset", "file", "image", "range", "color"];
    const inputType = (el.getAttribute("type") || "text").toLowerCase();
    const editable =
      (el.tagName === "INPUT" && !NON_TEXT.includes(inputType)) ||
      el.tagName === "TEXTAREA" ||
      el.isContentEditable === true ||
      !!el.querySelector('input:not([type=checkbox]):not([type=radio]):not([type=submit]), textarea, [contenteditable="true"]');

    results.push({
      localId,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || "",
      role: el.getAttribute("role") || "",
      label,
      editable,
      x: cx,
      y: cy,
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    });
  }
  return results;
}

// Clicks the element carrying the given stamp. Re-queries by attribute so a
// re-render or a scroll between the scan and the click can't silently
// redirect the click to whatever now happens to sit at those coordinates.
function clickStampedElement(refAttr, localId) {
  const el = document.querySelector(`[${refAttr}="${localId}"]`);
  if (!el) return { ok: false, reason: "gone" };

  let rect = el.getBoundingClientRect();
  if (rect.bottom < 0 || rect.top > window.innerHeight) {
    el.scrollIntoView({ block: "center", behavior: "instant" });
    rect = el.getBoundingClientRect();
  }
  if (rect.width <= 0 || rect.height <= 0) return { ok: false, reason: "not-visible" };

  const x = Math.round(rect.left + rect.width / 2);
  const y = Math.round(rect.top + rect.height / 2);

  // Occlusion check: with a cookie banner or modal over the target, the
  // click lands on the overlay and gets reported as a success. Detect that
  // and say so, so the model can dismiss the overlay first.
  const hit = document.elementFromPoint(x, y);
  if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
    const blockerLabel = (hit.getAttribute("aria-label") || (hit.innerText || "").trim() || hit.tagName)
      .replace(/\s+/g, " ")
      .slice(0, 60);
    return { ok: false, reason: "occluded", blocker: blockerLabel };
  }

  const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
  el.dispatchEvent(new MouseEvent("mouseover", opts));
  el.dispatchEvent(new MouseEvent("mousemove", opts));
  el.dispatchEvent(new MouseEvent("mousedown", opts));

  // Rich-text editors (LinkedIn's post box, most WYSIWYG editors) wrap the
  // real contenteditable/input node inside non-focusable container divs.
  // Clicking the container and calling .focus() on it silently does
  // nothing, document.activeElement stays <body>, and the next "type" call
  // fails. When the clicked element itself isn't focusable/editable, look
  // for the nearest editable descendant (or ancestor, for cases where the
  // click lands on inner text/icons) and focus that instead.
  const isEditable = (node) =>
    node && (node.tagName === "INPUT" || node.tagName === "TEXTAREA" || node.isContentEditable === true);

  let focusTarget = el;
  if (!isEditable(focusTarget)) {
    const nested = el.querySelector('input, textarea, [contenteditable="true"]');
    if (nested) focusTarget = nested;
    else {
      const ancestor = el.closest('[contenteditable="true"]');
      if (ancestor) focusTarget = ancestor;
    }
  }
  if (typeof focusTarget.focus === "function") focusTarget.focus();

  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.dispatchEvent(new MouseEvent("click", opts));
  return { ok: true };
}

function clickAtPoint(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return { ok: false, reason: "nothing-at-point" };
  const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
  el.dispatchEvent(new MouseEvent("mouseover", opts));
  el.dispatchEvent(new MouseEvent("mousemove", opts));
  el.dispatchEvent(new MouseEvent("mousedown", opts));
  const isEditable = (node) =>
    node && (node.tagName === "INPUT" || node.tagName === "TEXTAREA" || node.isContentEditable === true);
  let focusTarget = el;
  if (!isEditable(focusTarget)) {
    const nested = el.querySelector('input, textarea, [contenteditable="true"]');
    if (nested) focusTarget = nested;
    else {
      const ancestor = el.closest('[contenteditable="true"]');
      if (ancestor) focusTarget = ancestor;
    }
  }
  if (typeof focusTarget.focus === "function") focusTarget.focus();
  el.dispatchEvent(new MouseEvent("mouseup", opts));
  el.dispatchEvent(new MouseEvent("click", opts));
  return { ok: true, landedOn: (el.innerText || el.tagName || "").trim().slice(0, 60) };
}

function hoverStampedElement(refAttr, localId) {
  const el = document.querySelector(`[${refAttr}="${localId}"]`);
  if (!el) return { ok: false, reason: "gone" };
  const rect = el.getBoundingClientRect();
  const x = Math.round(rect.left + rect.width / 2);
  const y = Math.round(rect.top + rect.height / 2);
  const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
  el.dispatchEvent(new MouseEvent("pointerover", opts));
  el.dispatchEvent(new MouseEvent("mouseover", opts));
  el.dispatchEvent(new MouseEvent("mousemove", opts));
  return { ok: true };
}

// Shared by both typing paths. `el` is already resolved and focused.
function insertTextInto(el, text, replace) {
  if (el.isContentEditable) {
    if (replace) {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
    document.execCommand("insertText", false, text);
    return { ok: true, target: "contenteditable" };
  }
  if ("value" in el) {
    const proto =
      el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    const setter = descriptor && descriptor.set;
    const next = replace ? text : (el.value || "") + text;
    // React and friends patch the value property on the instance; going
    // through the prototype's native setter is what makes their onChange
    // handlers actually observe the new value.
    if (setter) setter.call(el, next);
    else el.value = next;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, target: el.tagName.toLowerCase() };
  }
  return { ok: false, reason: "not-editable" };
}

// Types into a specific stamped element, focusing it first. This is the
// reliable path: clicking a control and hoping focus lands on the right
// node fails whenever a site reveals its input after the click (LinkedIn's
// search icon does exactly that) or focuses it asynchronously.
function typeIntoStamped(refAttr, localId, text, replace) {
  let el = document.querySelector(`[${refAttr}="${localId}"]`);
  if (!el) return { ok: false, reason: "gone" };

  const isEditable = (node) =>
    node && (node.tagName === "INPUT" || node.tagName === "TEXTAREA" || node.isContentEditable === true);
  if (!isEditable(el)) {
    const nested = el.querySelector('input, textarea, [contenteditable="true"]');
    const ancestor = el.closest('input, textarea, [contenteditable="true"]');
    el = nested || ancestor || el;
  }
  if (!isEditable(el)) return { ok: false, reason: "not-editable" };

  el.scrollIntoView({ block: "center", behavior: "instant" });
  if (typeof el.focus === "function") el.focus();
  return insertTextInto(el, text, replace);
}

// Types into whatever currently holds focus, in whichever frame that is.
// The document.hasFocus() guard keeps this from typing into every frame
// when it runs fanned out across all of them.
function typeIntoFocused(text, replace) {
  if (!document.hasFocus()) return { ok: false, reason: "frame-not-focused" };
  const el = document.activeElement;
  if (!el || el === document.body) return { ok: false, reason: "no-focus" };
  return insertTextInto(el, text, replace);
}

function pressKeyOnFocused(keyName, codeMap, modifiers) {
  const el = document.activeElement || document.body;
  const keyCode = codeMap[keyName] || (keyName.length === 1 ? keyName.toUpperCase().charCodeAt(0) : 0);
  const mods = modifiers || [];
  const opts = {
    key: keyName,
    code: keyName,
    keyCode,
    which: keyCode,
    bubbles: true,
    cancelable: true,
    ctrlKey: mods.includes("Control"),
    shiftKey: mods.includes("Shift"),
    altKey: mods.includes("Alt"),
    metaKey: mods.includes("Meta"),
  };
  const downAccepted = el.dispatchEvent(new KeyboardEvent("keydown", opts));
  el.dispatchEvent(new KeyboardEvent("keypress", opts));
  el.dispatchEvent(new KeyboardEvent("keyup", opts));
  // Enter inside a single-line input commonly submits the form. Only do
  // that when the page didn't already preventDefault the keydown, which is
  // how SPAs signal they're handling Enter themselves.
  let submitted = false;
  if (
    keyName === "Enter" &&
    downAccepted &&
    !mods.length &&
    el.tagName === "INPUT" &&
    el.form &&
    typeof el.form.requestSubmit === "function"
  ) {
    el.form.requestSubmit();
    submitted = true;
  }
  return { ok: true, submitted };
}

function selectOptionOnStamped(refAttr, localId, value) {
  const el = document.querySelector(`[${refAttr}="${localId}"]`);
  if (!el) return { ok: false, reason: "gone" };
  if (el.tagName !== "SELECT") return { ok: false, reason: "not-a-select" };
  const wanted = String(value).toLowerCase();
  const options = Array.from(el.options);
  const match =
    options.find((o) => o.value.toLowerCase() === wanted) ||
    options.find((o) => (o.text || "").trim().toLowerCase() === wanted) ||
    options.find((o) => (o.text || "").toLowerCase().includes(wanted));
  if (!match) {
    return { ok: false, reason: "no-option", options: options.map((o) => o.text).slice(0, 25) };
  }
  el.value = match.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, selected: match.text };
}

// Scrolls whatever is actually scrollable under the middle of the viewport.
// Plain window.scrollBy does nothing on app shells that scroll an inner div,
// which covers most modern web apps.
function scrollSmart(dy) {
  const cx = Math.round(window.innerWidth / 2);
  const cy = Math.round(window.innerHeight / 2);
  let el = document.elementFromPoint(cx, cy);
  while (el && el !== document.body && el !== document.documentElement) {
    const style = window.getComputedStyle(el);
    const scrollable = /(auto|scroll|overlay)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 1;
    if (scrollable) {
      const before = el.scrollTop;
      el.scrollTop = before + dy;
      if (el.scrollTop !== before) return { scrolled: "element" };
    }
    el = el.parentElement;
  }
  const before = window.scrollY;
  window.scrollBy({ top: dy, behavior: "instant" });
  return { scrolled: window.scrollY !== before ? "window" : "none" };
}

function readPageInfo() {
  const doc = document.scrollingElement || document.documentElement;
  const active = document.activeElement;
  return {
    url: location.href,
    title: document.title,
    scrollY: Math.round(window.scrollY),
    viewportWidth: Math.round(window.innerWidth),
    viewportHeight: Math.round(window.innerHeight),
    pageHeight: Math.round(doc ? doc.scrollHeight : window.innerHeight),
    dpr: window.devicePixelRatio || 1,
    focus:
      active && active !== document.body
        ? {
            tag: active.tagName.toLowerCase(),
            type: (active.getAttribute("type") || "").toLowerCase(),
            inForm: !!(active.form || active.closest("form")),
            label: (active.getAttribute("aria-label") || active.getAttribute("placeholder") || "")
              .trim()
              .slice(0, 60),
          }
        : null,
  };
}

// ---------------------------------------------------------------------------

export class TabController {
  constructor(tabId, windowId, { onNote } = {}) {
    this.tabId = tabId;
    this.windowId = windowId;
    this.lastElements = [];
    this.lastPageInfo = null;
    this.closed = false;
    this.onNote = onNote || (() => {});
    this._onTabCreated = null;
    this._onTabRemoved = null;
  }

  async attach() {
    const tab = await chrome.tabs.get(this.tabId);
    assertInjectable(tab.url);
    this.windowId = tab.windowId;

    // Clicking a target="_blank" link (every other search result) opens a
    // new tab and leaves the agent driving the old one, blind, forever.
    // Follow the child tab instead.
    this._onTabCreated = (created) => {
      if (created.openerTabId !== this.tabId) return;
      this.onNote(`A new tab opened; following it (${created.url || created.pendingUrl || "about:blank"}).`);
      this.tabId = created.id;
      this.windowId = created.windowId;
      this.closed = false;
    };
    this._onTabRemoved = (removedId) => {
      if (removedId === this.tabId) this.closed = true;
    };
    chrome.tabs.onCreated.addListener(this._onTabCreated);
    chrome.tabs.onRemoved.addListener(this._onTabRemoved);

    console.log("[NIM Browser Agent] tab controller ready (no debugger permission needed)");
  }

  async detach() {
    if (this._onTabCreated) chrome.tabs.onCreated.removeListener(this._onTabCreated);
    if (this._onTabRemoved) chrome.tabs.onRemoved.removeListener(this._onTabRemoved);
    this._onTabCreated = null;
    this._onTabRemoved = null;
  }

  assertLive() {
    if (this.closed) throw new Error("The tab the agent was driving has been closed.");
  }

  // Runs `func` in the page. `frameId` targets a specific frame (used for
  // elements that live inside an iframe); omitting it means the top frame.
  // `allFrames` fans out and returns one injection result per frame.
  async exec(func, args = [], { frameId, allFrames = false } = {}) {
    this.assertLive();
    const target = { tabId: this.tabId };
    if (typeof frameId === "number") target.frameIds = [frameId];
    else if (allFrames) target.allFrames = true;

    const injections = await chrome.scripting.executeScript({ target, func, args });
    if (allFrames) return injections || [];
    const first = injections && injections[0];
    return first ? first.result : undefined;
  }

  async getPageInfo() {
    const info = await this.exec(readPageInfo);
    this.lastPageInfo = info || null;
    return this.lastPageInfo;
  }

  // captureVisibleTab grabs the *active* tab of the window, which is not
  // necessarily the tab the agent is driving. If the person switches tabs
  // mid-run, the agent would otherwise see page A while clicking page B.
  // Make the target tab active first, then capture.
  async screenshot() {
    this.assertLive();
    const tab = await chrome.tabs.get(this.tabId);
    this.windowId = tab.windowId;
    if (!tab.active) {
      await chrome.tabs.update(this.tabId, { active: true });
      await new Promise((r) => setTimeout(r, 150));
    }

    // captureVisibleTab is rate-limited (~2/sec); retry on that specific error.
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await chrome.tabs.captureVisibleTab(this.windowId, { format: "png" });
      } catch (err) {
        lastErr = err;
        if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/i.test(err.message || "")) {
          await new Promise((r) => setTimeout(r, 600));
          continue;
        }
        throw err;
      }
    }
    throw lastErr || new Error("Screenshot failed after 3 attempts.");
  }

  // Scans every frame for visible interactive elements and stamps each one
  // with a DOM attribute, so clickRef() can re-find the exact node later.
  // Refs are assigned globally across frames; the controller remembers which
  // frame each came from so the click is dispatched in the right document.
  async captureElements(max = 60) {
    const perFrame = await this.exec(collectCandidates, [REF_ATTR, SCAN_LIMIT], { allFrames: true });
    const candidates = [];
    for (const injection of perFrame || []) {
      if (!injection || !Array.isArray(injection.result)) continue;
      for (const c of injection.result) candidates.push({ ...c, frameId: injection.frameId });
    }
    const kept = rankAndTrim(candidates, max);
    this.lastElements = kept.map((c, i) => ({ ...c, ref: String(i) }));
    return this.lastElements;
  }

  findRef(ref) {
    const entry = this.lastElements.find((e) => e.ref === String(ref));
    if (!entry) {
      throw new Error(
        `No element with ref "${ref}" in the current elements list (it may be stale; a fresh list is sent with every screenshot).`
      );
    }
    return entry;
  }

  async clickRef(ref) {
    const entry = this.findRef(ref);
    const res = await this.exec(clickStampedElement, [REF_ATTR, entry.localId], { frameId: entry.frameId });
    if (!res || res.ok) return;
    if (res.reason === "occluded") {
      throw new Error(
        `That element is covered by something else on the page ("${res.blocker}"), so the click wouldn't reach it. Dismiss the overlay first, then try again.`
      );
    }
    if (res.reason === "gone") {
      throw new Error(
        "That element no longer exists; the page changed. Look at the new screenshot and pick a current ref."
      );
    }
    throw new Error(`Could not click ref "${ref}" (${res.reason}).`);
  }

  async hoverRef(ref) {
    const entry = this.findRef(ref);
    const res = await this.exec(hoverStampedElement, [REF_ATTR, entry.localId], { frameId: entry.frameId });
    if (res && !res.ok) throw new Error(`Could not hover ref "${ref}" (${res.reason}).`);
  }

  async selectOption(ref, value) {
    const entry = this.findRef(ref);
    const res = await this.exec(selectOptionOnStamped, [REF_ATTR, entry.localId, value], {
      frameId: entry.frameId,
    });
    if (res && res.ok) return res.selected;
    if (res && res.reason === "no-option") {
      throw new Error(`No option matching "${value}". Available options: ${(res.options || []).join(", ")}`);
    }
    throw new Error(`Could not select an option on ref "${ref}" (${res ? res.reason : "unknown"}).`);
  }

  // Takes CSS pixel coordinates. Working out which coordinate space the
  // model meant happens in agent.js (interpretCoordinates), because models
  // disagree wildly about it: some give screenshot pixels, some give
  // fractions of the viewport.
  async clickAt(cssX, cssY) {
    const res = await this.exec(clickAtPoint, [Math.round(cssX), Math.round(cssY)]);
    if (res && !res.ok) throw new Error(`Nothing is at (${Math.round(cssX)}, ${Math.round(cssY)}) on the page.`);
    return res;
  }

  /**
   * Types text. Given a `ref`, focuses that element first, which is the
   * reliable path. Without one, falls back to whatever holds focus,
   * searched across every frame — the focused element frequently lives in
   * an iframe, where a top-frame-only activeElement lookup returns the
   * <iframe> node and reports "nothing to type into".
   */
  async typeText(text, { replace = false, ref } = {}) {
    if (ref !== undefined && ref !== null && ref !== "") {
      const entry = this.findRef(ref);
      const res = await this.exec(typeIntoStamped, [REF_ATTR, entry.localId, text, !!replace], {
        frameId: entry.frameId,
      });
      if (res && res.ok) return;
      if (res && res.reason === "not-editable") {
        throw new Error(
          `Ref "${ref}" (${entry.label}) is not a text field, so there's nothing to type into. Pick the input itself from the elements list.`
        );
      }
      throw new Error(`Could not type into ref "${ref}" (${res ? res.reason : "unknown"}).`);
    }

    const injections = await this.exec(typeIntoFocused, [text, !!replace], { allFrames: true });
    if ((injections || []).some((i) => i && i.result && i.result.ok)) return;

    const fields = this.lastElements.filter((e) => e.editable).slice(0, 8);
    const hint = fields.length
      ? ` Pass "ref" to type straight into a field, no click needed. Text fields on this screen: ${fields
          .map((e) => `[${e.ref}] ${e.label}`)
          .join(", ")}.`
      : " No text fields are visible on this screen right now.";
    throw new Error(`Nothing is focused, so there is nowhere to type.${hint}`);
  }

  async pressKey(keyName, modifiers = []) {
    return this.exec(pressKeyOnFocused, [keyName, KEY_CODES, modifiers]);
  }

  async scroll(deltaY = 0) {
    const res = await this.exec(scrollSmart, [deltaY]);
    if (res && res.scrolled === "none") {
      throw new Error("Nothing scrolled; the page or container is already at the end in that direction.");
    }
  }

  async navigate(url) {
    const safe = assertNavigable(url);
    await chrome.tabs.update(this.tabId, { url: safe });
    await this.waitForLoad();
  }

  // Fixed sleeps after navigation are a coin flip on a slow page. Poll the
  // tab's own load status instead, with a ceiling so a page that never
  // finishes loading (long-polling, a hung resource) can't stall the run.
  async waitForLoad(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.closed) return;
      let tab;
      try {
        tab = await chrome.tabs.get(this.tabId);
      } catch (e) {
        return;
      }
      if (tab.status === "complete") {
        assertInjectable(tab.url);
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  // Closing the tab is a browser-chrome action, not something a page's DOM
  // can do (there's no element for it; the screenshot only shows page
  // content, never Chrome's own tab strip). Handled via the tabs API.
  async closeTab() {
    this.assertLive();
    await chrome.tabs.remove(this.tabId);
    this.closed = true;
  }
}
