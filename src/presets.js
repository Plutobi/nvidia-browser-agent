// Provider/model presets, shared by the options page and the service worker.
//
// The point of this file is that switching models should be one click and
// should not make you re-enter a key you already typed. Keys are stored per
// API host rather than per preset, so every model behind the same provider
// shares one credential and swapping between them touches nothing else.

export const DEFAULT_MAX_STEPS = 25;

export const PRESETS = [
  {
    id: "openrouter-nemotron",
    label: "Nemotron 3 Nano Omni — free (OpenRouter)",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    note: "Free, no credit balance needed. Reasoning model, so extended thinking is turned off to stay inside the request timeout.",
  },
  {
    id: "openrouter-gemini-flash-lite",
    label: "Gemini 2.5 Flash Lite — paid (OpenRouter)",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "google/gemini-2.5-flash-lite",
    note: "Billed per token, roughly a cent per task, and needs credit on the OpenRouter account. Shares the key with the free preset above.",
  },
  {
    id: "nvidia-maverick",
    label: "Llama 4 Maverick — paid (NVIDIA NIM)",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    model: "meta/llama-4-maverick-17b-128e-instruct",
    note: "Needs an nvapi- key from build.nvidia.com.",
  },
  {
    id: "custom",
    label: "Custom…",
    baseUrl: "",
    model: "",
    note: "Any OpenAI-compatible endpoint. Must be vision-capable and support tool calling.",
  },
];

export const DEFAULT_PRESET_ID = "openrouter-nemotron";

export function getPreset(id) {
  return PRESETS.find((p) => p.id === id) || null;
}

/**
 * The storage key under which a credential lives. Grouping by host is what
 * makes the two OpenRouter presets share one key.
 */
export function keyHostFor(baseUrl) {
  try {
    return new URL(baseUrl).host.toLowerCase();
  } catch (e) {
    return "unknown";
  }
}

/** Find the preset matching a loose baseUrl/model pair, for migrating flat settings. */
export function matchPreset(baseUrl, model) {
  return (
    PRESETS.find(
      (p) => p.id !== "custom" && p.baseUrl === baseUrl && p.model === model
    ) || null
  );
}

function isSet(value) {
  return value !== undefined && value !== null;
}

/**
 * Turn whatever is in chrome.storage.local into the concrete settings a run
 * needs. Handles three shapes: the current preset-based schema, the older
 * flat {apiKey, model, baseUrl} schema, and empty storage.
 *
 * An API key stored as "" means the person deliberately cleared it, so it
 * stays cleared. Only a genuinely absent value falls back.
 *
 * Pure function, exported for tests.
 */
export function resolveSettings(stored = {}) {
  const preset = getPreset(stored.presetId);

  let baseUrl;
  let model;
  let presetId;

  if (!preset) {
    // Legacy or first-run: derive from the flat fields, then work out which
    // preset (if any) that corresponds to.
    baseUrl = stored.baseUrl || getPreset(DEFAULT_PRESET_ID).baseUrl;
    model = stored.model || getPreset(DEFAULT_PRESET_ID).model;
    presetId = (matchPreset(baseUrl, model) || { id: "custom" }).id;
  } else if (preset.id === "custom") {
    baseUrl = stored.customBaseUrl || stored.baseUrl || getPreset(DEFAULT_PRESET_ID).baseUrl;
    model = stored.customModel || stored.model || getPreset(DEFAULT_PRESET_ID).model;
    presetId = "custom";
  } else {
    baseUrl = preset.baseUrl;
    model = preset.model;
    presetId = preset.id;
  }

  const host = keyHostFor(baseUrl);
  const keys = stored.apiKeysByHost || {};
  let apiKey;
  if (Object.prototype.hasOwnProperty.call(keys, host)) {
    apiKey = keys[host];
  } else if (isSet(stored.apiKey) && keyHostFor(stored.baseUrl || baseUrl) === host) {
    // Legacy single-key storage, but only when it belongs to this host.
    apiKey = stored.apiKey;
  } else {
    apiKey = "";
  }

  const matched = getPreset(presetId);
  return {
    presetId,
    label: matched && matched.id !== "custom" ? matched.label : `${model} (custom)`,
    baseUrl,
    model,
    apiKey: apiKey || "",
    keyHost: host,
    maxSteps: isSet(stored.maxSteps) ? stored.maxSteps || DEFAULT_MAX_STEPS : DEFAULT_MAX_STEPS,
  };
}

/**
 * One-time upgrade from the flat schema to the preset schema. Returns the
 * patch to write, or null when there's nothing to migrate.
 *
 * Pure function, exported for tests.
 */
export function migrateLegacy(stored = {}) {
  if (stored.presetId) return null;
  if (!isSet(stored.apiKey) && !isSet(stored.baseUrl) && !isSet(stored.model)) return null;

  const resolved = resolveSettings(stored);
  const patch = {
    presetId: resolved.presetId,
    apiKeysByHost: {
      ...(stored.apiKeysByHost || {}),
      [resolved.keyHost]: resolved.apiKey,
    },
  };
  if (resolved.presetId === "custom") {
    patch.customBaseUrl = resolved.baseUrl;
    patch.customModel = resolved.model;
  }
  return patch;
}
