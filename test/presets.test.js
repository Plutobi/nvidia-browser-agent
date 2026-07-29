import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PRESETS,
  getPreset,
  keyHostFor,
  matchPreset,
  resolveSettings,
  migrateLegacy,
  DEFAULT_MAX_STEPS,
} from "../src/presets.js";

const OR = "https://openrouter.ai/api/v1";
const NIM = "https://integrate.api.nvidia.com/v1";

test("every preset is well formed and ids are unique", () => {
  const ids = new Set();
  for (const p of PRESETS) {
    assert.ok(p.id && p.label && p.note, `${p.id} missing fields`);
    assert.equal(ids.has(p.id), false, `duplicate id ${p.id}`);
    ids.add(p.id);
    if (p.id !== "custom") {
      assert.ok(p.baseUrl && p.model, `${p.id} needs baseUrl and model`);
      assert.doesNotThrow(() => new URL(p.baseUrl));
    }
  }
  assert.ok(getPreset("openrouter-gemini-flash-lite"), "the Gemini preset must exist");
});

test("key host groups providers, so same-provider models share a credential", () => {
  const nemotron = getPreset("openrouter-nemotron");
  const gemini = getPreset("openrouter-gemini-flash-lite");
  assert.equal(keyHostFor(nemotron.baseUrl), keyHostFor(gemini.baseUrl));
  assert.notEqual(keyHostFor(nemotron.baseUrl), keyHostFor(getPreset("nvidia-maverick").baseUrl));
  assert.equal(keyHostFor("not a url"), "unknown");
});

test("switching between the two OpenRouter presets carries the key over", () => {
  const stored = {
    presetId: "openrouter-nemotron",
    apiKeysByHost: { "openrouter.ai": "sk-or-test" },
  };
  const before = resolveSettings(stored);
  assert.equal(before.model, "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free");
  assert.equal(before.apiKey, "sk-or-test");

  const after = resolveSettings({ ...stored, presetId: "openrouter-gemini-flash-lite" });
  assert.equal(after.model, "google/gemini-2.5-flash-lite");
  assert.equal(after.baseUrl, OR);
  assert.equal(after.apiKey, "sk-or-test", "the same OpenRouter key must carry over");
});

test("switching to a different provider does not leak the other provider's key", () => {
  const resolved = resolveSettings({
    presetId: "nvidia-maverick",
    apiKeysByHost: { "openrouter.ai": "sk-or-test" },
  });
  assert.equal(resolved.baseUrl, NIM);
  assert.equal(resolved.apiKey, "");
});

test("a key cleared to empty string stays cleared", () => {
  const resolved = resolveSettings({
    presetId: "openrouter-nemotron",
    apiKeysByHost: { "openrouter.ai": "" },
    apiKey: "sk-or-legacy-leftover",
    baseUrl: OR,
  });
  assert.equal(resolved.apiKey, "", "an explicitly cleared key must not fall back to the legacy field");
});

test("custom preset uses its own fields", () => {
  const resolved = resolveSettings({
    presetId: "custom",
    customBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    customModel: "gemini-2.5-flash-lite",
    apiKeysByHost: { "generativelanguage.googleapis.com": "AIza-test" },
  });
  assert.equal(resolved.model, "gemini-2.5-flash-lite");
  assert.equal(resolved.apiKey, "AIza-test");
  assert.match(resolved.label, /custom/);
});

test("empty storage resolves to the default preset with no key", () => {
  const resolved = resolveSettings({});
  assert.equal(resolved.presetId, "openrouter-nemotron");
  assert.equal(resolved.apiKey, "");
  assert.equal(resolved.maxSteps, DEFAULT_MAX_STEPS);
});

test("maxSteps survives, and a junk value falls back", () => {
  assert.equal(resolveSettings({ maxSteps: 40 }).maxSteps, 40);
  assert.equal(resolveSettings({ maxSteps: 0 }).maxSteps, DEFAULT_MAX_STEPS);
});

// --- migration from the old flat schema -------------------------------------

test("a legacy install keeps its key and lands on the matching preset", () => {
  const legacy = {
    apiKey: "sk-or-legacy",
    baseUrl: OR,
    model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    maxSteps: 30,
  };
  const patch = migrateLegacy(legacy);
  assert.equal(patch.presetId, "openrouter-nemotron");
  assert.equal(patch.apiKeysByHost["openrouter.ai"], "sk-or-legacy");

  const resolved = resolveSettings({ ...legacy, ...patch });
  assert.equal(resolved.apiKey, "sk-or-legacy");
  assert.equal(resolved.maxSteps, 30);
});

test("a legacy install on an unrecognised model migrates to the custom preset", () => {
  const patch = migrateLegacy({
    apiKey: "key-123",
    baseUrl: "https://example.test/v1",
    model: "some/other-model",
  });
  assert.equal(patch.presetId, "custom");
  assert.equal(patch.customModel, "some/other-model");
  assert.equal(patch.customBaseUrl, "https://example.test/v1");
  assert.equal(patch.apiKeysByHost["example.test"], "key-123");
});

test("migration is a no-op once already migrated, and on empty storage", () => {
  assert.equal(migrateLegacy({ presetId: "openrouter-nemotron" }), null);
  assert.equal(migrateLegacy({}), null);
});

test("matchPreset recognises known pairs and rejects unknown ones", () => {
  assert.equal(matchPreset(OR, "google/gemini-2.5-flash-lite").id, "openrouter-gemini-flash-lite");
  assert.equal(matchPreset(OR, "made/up"), null);
});
