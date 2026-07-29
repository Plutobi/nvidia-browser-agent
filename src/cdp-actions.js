// UNUSED. Kept as a switch-back option for unmanaged machines that want
// real OS-level input instead of synthetic DOM events. Nothing imports it.
//
// To actually use it you must first add "debugger" to `permissions` in
// manifest.json, otherwise every call here throws immediately. It also
// predates the current TabController interface: it has no captureElements,
// clickRef, getPageInfo, hoverRef, selectOption, or waitForLoad, so
// agent.js would need those filled in before it could be swapped back.
//
// Thin wrapper around chrome.debugger (Chrome DevTools Protocol) for the
// low-level actions the agent can take: screenshot, click, type, key press,
// scroll, and navigate. One debugger session is attached per target tab.

const PROTOCOL_VERSION = "1.3";

// Minimal keycode table for the special keys the agent is likely to send.
// CDP wants both the DOM `key` string and a Windows virtual key code.
const KEY_TABLE = {
  Enter: { keyCode: 13, code: "Enter" },
  Tab: { keyCode: 9, code: "Tab" },
  Escape: { keyCode: 27, code: "Escape" },
  Backspace: { keyCode: 8, code: "Backspace" },
  Delete: { keyCode: 46, code: "Delete" },
  ArrowUp: { keyCode: 38, code: "ArrowUp" },
  ArrowDown: { keyCode: 40, code: "ArrowDown" },
  ArrowLeft: { keyCode: 37, code: "ArrowLeft" },
  ArrowRight: { keyCode: 39, code: "ArrowRight" },
  Home: { keyCode: 36, code: "Home" },
  End: { keyCode: 35, code: "End" },
  PageUp: { keyCode: 33, code: "PageUp" },
  PageDown: { keyCode: 34, code: "PageDown" },
  " ": { keyCode: 32, code: "Space" },
};

// chrome.debugger's callbacks can, in practice, simply never fire (a stuck
// or orphaned debugger session from a previous run, a crashed renderer,
// etc.), leaving an awaited promise pending forever with no error and no
// way to tell. Every CDP call below is wrapped with a hard timeout so that
// failure mode becomes a visible error instead of infinite silence.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms waiting for ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export class CdpSession {
  constructor(tabId) {
    this.tabId = tabId;
    this.target = { tabId };
    this.attached = false;
  }

  async attach() {
    if (this.attached) return;

    // Defensive cleanup: if a previous run on this tab left a debugger
    // session orphaned (e.g. the service worker was killed mid-task), a
    // fresh attach() can hang indefinitely with no error. Best-effort detach
    // first so we're always attaching from a clean state.
    try {
      console.log("[NIM Browser Agent] pre-attach: clearing any existing debugger session on tab", this.tabId);
      await withTimeout(this._send("pre-detach", () => chrome.debugger.detach(this.target)), 3000, "pre-attach detach");
    } catch (e) {
      // Nothing was attached, or it timed out; either way, proceed to attach.
    }

    console.log("[NIM Browser Agent] attaching debugger to tab", this.tabId);
    await withTimeout(
      this._send("attach", () => chrome.debugger.attach(this.target, PROTOCOL_VERSION)),
      10000,
      "chrome.debugger.attach"
    );
    console.log("[NIM Browser Agent] debugger attached");
    this.attached = true;
    // Detach cleanly if the user closes the DevTools banner / tab.
    chrome.debugger.onDetach.addListener((source) => {
      if (source.tabId === this.tabId) this.attached = false;
    });
  }

  async detach() {
    if (!this.attached) return;
    try {
      await withTimeout(this._send("detach", () => chrome.debugger.detach(this.target)), 5000, "chrome.debugger.detach");
    } catch (e) {
      // already detached, ignore
    }
    this.attached = false;
  }

  _send(_label, fn) {
    return new Promise((resolve, reject) => {
      try {
        fn((result) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(result);
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  sendCommand(method, params = {}) {
    const raw = new Promise((resolve, reject) => {
      chrome.debugger.sendCommand(this.target, method, params, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(result);
        }
      });
    });
    return withTimeout(raw, 15000, `CDP ${method}`);
  }

  async screenshot() {
    console.log("[NIM Browser Agent] capturing screenshot");
    const { data } = await this.sendCommand("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
    });
    console.log("[NIM Browser Agent] screenshot captured,", data.length, "base64 chars");
    return `data:image/png;base64,${data}`;
  }

  async getViewportSize() {
    const layout = await this.sendCommand("Page.getLayoutMetrics", {});
    const viewport = layout.cssVisualViewport || layout.visualViewport || layout.layoutViewport;
    return { width: Math.round(viewport.clientWidth), height: Math.round(viewport.clientHeight) };
  }

  async click(x, y, button = "left") {
    const common = { x, y, button, clickCount: 1 };
    await this.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", ...common });
    await this.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", ...common });
  }

  async typeText(text) {
    await this.sendCommand("Input.insertText", { text });
  }

  async pressKey(keyName) {
    const entry = KEY_TABLE[keyName];
    if (entry) {
      const base = {
        key: keyName,
        code: entry.code,
        windowsVirtualKeyCode: entry.keyCode,
        nativeVirtualKeyCode: entry.keyCode,
      };
      await this.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", ...base });
      await this.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", ...base });
      return;
    }
    // Single printable character: dispatch as a char + insertText for reliability.
    if (keyName.length === 1) {
      await this.sendCommand("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: keyName,
        text: keyName,
      });
      await this.sendCommand("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: keyName,
      });
      return;
    }
    throw new Error(`Unsupported key: ${keyName}`);
  }

  async scroll(deltaY = 0, deltaX = 0) {
    const { width, height } = await this.getViewportSize();
    const x = Math.round(width / 2);
    const y = Math.round(height / 2);
    await this.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX,
      deltaY,
    });
  }

  async navigate(url) {
    await this.sendCommand("Page.navigate", { url });
  }
}
