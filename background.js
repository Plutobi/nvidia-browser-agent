import { runAgent } from "./src/agent.js";
import { resolveSettings, migrateLegacy, DEFAULT_PRESET_ID } from "./src/presets.js";

// Bump this on every edit. Logs immediately on service worker load (not
// inside any function), so opening the console tells you at a glance
// whether Chrome is actually running the code you think it is.
const BUILD = "2026-07-27-12-presets";
console.log(`[NIM Browser Agent] background.js loaded, build ${BUILD}`);

// Open the side panel (a persistent docked panel) when the toolbar icon is
// clicked, instead of a small transient popup that closes the moment you
// click anywhere else.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("[NIM Browser Agent] setPanelBehavior failed:", err));

let running = false;
let stopRequested = false;
let currentTabId = null;
let keepaliveTimer = null;
let activeAbortController = null;
// Whatever sensitive-action confirmation is currently awaiting a person's
// Approve/Deny click in the panel. Only one can be pending at a time since
// the agent loop blocks on it.
let pendingConfirm = null;

// A confirmation nobody ever answers would pin the service worker open
// forever. Deny by default after this long.
const CONFIRM_TIMEOUT_MS = 5 * 60 * 1000;

// Recent event buffer so a reopened panel can replay what already happened
// instead of showing a blank log next to a stale "Running..." status.
const recentLog = [];
function remember(entry) {
  recentLog.push(entry);
  if (recentLog.length > 100) recentLog.shift();
}

// No credential is defined anywhere in source. Shipping a working key means
// it lives in plaintext in every copy of this folder and in any repo it's
// ever pushed to. Set yours on the options page.
chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(null);
  const patch = migrateLegacy(stored);
  if (patch) {
    await chrome.storage.local.set(patch);
    await chrome.storage.local.remove(["apiKey", "model", "baseUrl"]);
  } else if (!stored.presetId) {
    await chrome.storage.local.set({ presetId: DEFAULT_PRESET_ID });
  }
});

function broadcast(msg) {
  if (msg.type === "log") remember(msg.event);
  chrome.runtime.sendMessage(msg).catch(() => {
    // panel may be closed; ignore
  });
}

// MV3 service workers are killed by Chrome after ~30s with no tracked
// activity. Plain setTimeout-based waits inside the agent loop don't count
// as activity, so a long "wait" step or a slow API call can get the whole
// worker torn down mid-task with no error, ever. Pinging a real chrome.* API
// on an interval keeps it alive for the duration of a run.
function startKeepalive(getTabId) {
  stopKeepalive();
  keepaliveTimer = setInterval(() => {
    const id = getTabId();
    if (typeof id === "number") chrome.tabs.get(id).catch(() => {});
  }, 15000);
}
function stopKeepalive() {
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  keepaliveTimer = null;
}

async function getSettings() {
  return resolveSettings(await chrome.storage.local.get(null));
}

// What the panel shows in its header, so a model switch is visible without
// opening settings.
let activeModelLabel = "";

function settleConfirm(approved) {
  if (!pendingConfirm) return;
  const { resolve, timer } = pendingConfirm;
  clearTimeout(timer);
  pendingConfirm = null;
  resolve(approved);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "start") {
    handleStart(msg.task).catch((err) => {
      console.error("[NIM Browser Agent] run failed:", err);
      broadcast({ type: "log", event: { kind: "error", error: err.message } });
      broadcast({ type: "finished", result: { status: "error" } });
    });
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === "stop") {
    stopRequested = true;
    console.log("[NIM Browser Agent] stop requested");
    // Cancel whatever's in flight right now instead of waiting for the
    // current step to finish on its own (which could be up to 90s away).
    if (activeAbortController) activeAbortController.abort();
    // A pending confirmation would otherwise block the loop forever, since
    // nothing else will ever resolve it once the panel closes on stop.
    settleConfirm(false);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === "confirm-response") {
    settleConfirm(!!msg.approved);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === "status") {
    // Async response, so `return true` here is load-bearing: it keeps the
    // message channel open until getSettings resolves.
    (async () => {
      const label = activeModelLabel || (await getSettings()).label;
      sendResponse({ running, tabId: currentTabId, log: recentLog, modelLabel: label });
    })();
    return true;
  }
  return false;
});

// Blocks the agent loop until the panel sends back "confirm-response".
// onStep already broadcasts the "confirm-request" log event that drives the
// Approve/Deny buttons in the UI; this just waits for the answer. Rejects on
// abort so a Stop mid-prompt unwinds the loop the same way it does anywhere
// else, and denies on timeout so an unanswered prompt can't wedge the run.
function requestConfirmation(signal) {
  return new Promise((resolve, reject) => {
    if (stopRequested || (signal && signal.aborted)) {
      resolve(false);
      return;
    }
    // A stale prompt should never outlive the step that created it.
    settleConfirm(false);

    const timer = setTimeout(() => {
      console.warn("[NIM Browser Agent] confirmation timed out; denying by default");
      settleConfirm(false);
    }, CONFIRM_TIMEOUT_MS);

    const onAbort = () => {
      clearTimeout(timer);
      pendingConfirm = null;
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });

    pendingConfirm = {
      timer,
      resolve: (approved) => {
        if (signal) signal.removeEventListener("abort", onAbort);
        resolve(approved);
      },
    };
  });
}

async function handleStart(task) {
  if (running) throw new Error("Agent is already running.");
  const settings = await getSettings();
  if (!settings.apiKey) {
    throw new Error("No API key set. Open the extension options page (gear icon) and add one.");
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) throw new Error("No active tab found.");
  if (/^chrome(-extension)?:\/\//.test(tab.url || "")) {
    throw new Error("Cannot run on a chrome:// or extension page. Switch to a normal website tab.");
  }

  currentTabId = tab.id;
  running = true;
  stopRequested = false;
  activeModelLabel = settings.label;
  recentLog.length = 0;
  broadcast({ type: "started", tabId: tab.id, modelLabel: settings.label });
  broadcast({ type: "log", event: { kind: "note", text: `Using ${settings.model}.` } });
  console.log("[NIM Browser Agent] starting run", { task, model: settings.model, baseUrl: settings.baseUrl });

  const isOpenRouter = settings.baseUrl.includes("openrouter.ai");
  const extraHeaders = isOpenRouter
    ? { "HTTP-Referer": chrome.runtime.getURL(""), "X-Title": "NIM Browser Agent" }
    : {};
  // Some models on OpenRouter (the Nemotron default among them) are
  // "reasoning" models that think at length before answering unless told
  // not to, which can blow past any reasonable timeout on a free/shared
  // endpoint. Per OpenRouter's docs, "enabled" is only documented for
  // turning reasoning ON with defaults; the documented way to fully disable
  // it is effort: "none". Harmless on models that don't think by default.
  const extraBody = isOpenRouter ? { reasoning: { effort: "none", exclude: true } } : {};

  startKeepalive(() => currentTabId);
  activeAbortController = new AbortController();
  const signal = activeAbortController.signal;
  try {
    const result = await runAgent({
      tabId: tab.id,
      windowId: tab.windowId,
      task,
      apiKey: settings.apiKey,
      model: settings.model,
      baseUrl: settings.baseUrl,
      extraHeaders,
      extraBody,
      maxSteps: settings.maxSteps,
      onStep: (event) => {
        console.log("[NIM Browser Agent] step:", event);
        broadcast({ type: "log", event });
      },
      shouldStop: () => stopRequested,
      abortSignal: signal,
      confirmAction: () => requestConfirmation(signal),
    });
    console.log("[NIM Browser Agent] run finished:", result);
    broadcast({ type: "finished", result });
  } finally {
    stopKeepalive();
    settleConfirm(false);
    activeAbortController = null;
    running = false;
    currentTabId = null;
    activeModelLabel = "";
  }
}
