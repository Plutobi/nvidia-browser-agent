import {
  PRESETS,
  getPreset,
  keyHostFor,
  resolveSettings,
  migrateLegacy,
  DEFAULT_MAX_STEPS,
} from "./src/presets.js";

const presetEl = document.getElementById("preset");
const presetNoteEl = document.getElementById("presetNote");
const customFieldsEl = document.getElementById("customFields");
const customModelEl = document.getElementById("customModel");
const customBaseUrlEl = document.getElementById("customBaseUrl");
const apiKeyEl = document.getElementById("apiKey");
const keyHostEl = document.getElementById("keyHost");
const maxStepsEl = document.getElementById("maxSteps");
const savedEl = document.getElementById("saved");

for (const preset of PRESETS) {
  const opt = document.createElement("option");
  opt.value = preset.id;
  opt.textContent = preset.label;
  presetEl.appendChild(opt);
}

// Keys already on file, held in memory so switching presets in the dropdown
// can show the right one without a storage round trip per change.
let keysByHost = {};

function currentBaseUrl() {
  const preset = getPreset(presetEl.value);
  if (!preset) return "";
  return preset.id === "custom" ? customBaseUrlEl.value.trim() : preset.baseUrl;
}

// Reflect the selected preset: show or hide the custom fields, swap in the
// key saved for that provider, and say which host the key belongs to.
function syncToPreset() {
  const preset = getPreset(presetEl.value);
  presetNoteEl.textContent = preset ? preset.note : "";
  customFieldsEl.hidden = !preset || preset.id !== "custom";

  const host = keyHostFor(currentBaseUrl());
  keyHostEl.textContent = host === "unknown" ? "this provider" : host;
  apiKeyEl.value = Object.prototype.hasOwnProperty.call(keysByHost, host) ? keysByHost[host] : "";
}

// Remember whatever is typed against the host it was typed for, so switching
// presets mid-edit doesn't lose it.
function stashCurrentKey() {
  const host = keyHostFor(currentBaseUrl());
  if (host !== "unknown") keysByHost[host] = apiKeyEl.value.trim();
}

presetEl.addEventListener("mousedown", stashCurrentKey);
presetEl.addEventListener("change", syncToPreset);
apiKeyEl.addEventListener("input", stashCurrentKey);
customBaseUrlEl.addEventListener("change", () => {
  stashCurrentKey();
  syncToPreset();
});

async function load() {
  const stored = await chrome.storage.local.get(null);

  // Upgrade the older flat {apiKey, model, baseUrl} schema in place, so an
  // existing install keeps its key and lands on the matching preset.
  const patch = migrateLegacy(stored);
  if (patch) {
    await chrome.storage.local.set(patch);
    Object.assign(stored, patch);
  }

  const resolved = resolveSettings(stored);
  keysByHost = { ...(stored.apiKeysByHost || {}) };
  if (resolved.apiKey && !Object.prototype.hasOwnProperty.call(keysByHost, resolved.keyHost)) {
    keysByHost[resolved.keyHost] = resolved.apiKey;
  }

  presetEl.value = resolved.presetId;
  customModelEl.value = stored.customModel || (resolved.presetId === "custom" ? resolved.model : "");
  customBaseUrlEl.value = stored.customBaseUrl || (resolved.presetId === "custom" ? resolved.baseUrl : "");
  maxStepsEl.value = resolved.maxSteps || DEFAULT_MAX_STEPS;
  syncToPreset();
}

document.getElementById("saveBtn").addEventListener("click", async () => {
  stashCurrentKey();

  await chrome.storage.local.set({
    presetId: presetEl.value,
    apiKeysByHost: keysByHost,
    customModel: customModelEl.value.trim(),
    customBaseUrl: customBaseUrlEl.value.trim(),
    maxSteps: parseInt(maxStepsEl.value, 10) || DEFAULT_MAX_STEPS,
  });
  // Drop the legacy flat fields so they can't shadow the preset later.
  await chrome.storage.local.remove(["apiKey", "model", "baseUrl"]);

  const resolved = resolveSettings(await chrome.storage.local.get(null));
  savedEl.textContent = resolved.apiKey
    ? `Saved — using ${resolved.model}`
    : "Saved. No API key set for this provider yet.";
  savedEl.className = resolved.apiKey ? "ok" : "req";
  setTimeout(() => {
    savedEl.textContent = "";
  }, 4000);
});

load();
