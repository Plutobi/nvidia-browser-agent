# NIM Browser Agent

A Chrome extension that lets a vision-language model drive your browser: it captures screenshots of the active tab, reads the page's interactive elements, and issues clicks, keystrokes, scrolls, and navigation by injecting small scripts into the page (`chrome.scripting`).

An earlier version used `chrome.debugger` (the Chrome DevTools Protocol). That was switched out because many managed/enterprise Chrome installs block the `debugger` permission for unpacked (developer-mode) extensions specifically, even while allowlisting official Chrome-Web-Store-published extensions for the same capability. The `chrome.scripting` + `captureVisibleTab` approach needs no special permission beyond what a normal content-script extension already uses, so it isn't subject to that restriction. The trade-off: clicks and key presses are synthetic DOM events (`isTrusted: false`) rather than OS-level input, which is fine for the vast majority of pages and could behave differently on sites with strict bot-detection that specifically checks `event.isTrusted`. The old implementation is still in `src/cdp-actions.js`, unused; see the note at the top of that file for what it would take to switch back.

## How it works

1. You give it a task in the side panel ("search for X and open the top result").
2. The background service worker gathers the current page state: URL and title, a screenshot (`chrome.tabs.captureVisibleTab`), and a list of visible interactive elements scanned out of every frame, each stamped with a `data-nim-ref` attribute and given a short reference id.
3. That state plus the task goes to a vision model via its OpenAI-compatible `/v1/chat/completions` endpoint, with a fixed tool list: `click`, `type`, `key`, `select_option`, `hover`, `scroll`, `navigate`, `wait`, `close_tab`, `done`.
4. The model's chosen tool call is executed by injecting a small function into the right frame, which re-finds the target by its stamped attribute and dispatches the corresponding DOM events.
5. Fresh state is gathered and the loop repeats until the model calls `done`, gets stuck, or hits the step limit.

Actions the model marks as consequential pause for a person's Approve/Deny in the panel before running.

## Setup

1. Get an API key — [build.nvidia.com](https://build.nvidia.com) (open any model page, "Get API Key") or [openrouter.ai/keys](https://openrouter.ai/keys).
2. Pick a **vision-capable, tool-calling-capable** model. Not every model supports both; check the model card.
3. Load the extension:
   - Open `chrome://extensions`
   - Enable **Developer mode** (top right)
   - Click **Load unpacked** and select this `nvidia-browser-agent` folder
4. Click the extension icon → gear icon → pick a model preset and enter your API key. Save. **No key ships with the extension**, so this step is required before the first run.
5. Open the side panel on any normal website tab (not `chrome://` pages — scripts can't be injected there), type a task, click **Start**.

### Switching models

The options page has a preset dropdown:

| Preset | Endpoint | Model | Cost |
| --- | --- | --- | --- |
| Nemotron 3 Nano Omni | OpenRouter | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | free |
| Gemini 2.5 Flash Lite | OpenRouter | `google/gemini-2.5-flash-lite` | ~1¢/task, needs credit |
| Llama 4 Maverick | NVIDIA NIM | `meta/llama-4-maverick-17b-128e-instruct` | paid |
| Custom… | anything OpenAI-compatible | whatever you type | — |

API keys are stored **per provider host**, so the two OpenRouter presets share one key and flipping between them is a dropdown change plus Save. Moving to a different provider prompts for that provider's key and leaves the first one on file, so switching back needs no re-entry. The side panel header shows which model is about to run and doubles as a shortcut into settings.

Any model you pick has to be **vision-capable and support tool calling**. Plenty of models have one without the other.

The extension adds OpenRouter's recommended `HTTP-Referer`/`X-Title` headers automatically when the base URL points at `openrouter.ai`, and sends `reasoning: { effort: "none" }` there so a reasoning model can't think past the request timeout. That's a no-op for models that don't think by default, Gemini Flash Lite among them.

Settings from before the preset system (a flat `apiKey`/`model`/`baseUrl` trio) migrate automatically on first load: the key moves to its provider host and the install lands on whichever preset matches, or on Custom.

## Files

```
manifest.json           MV3 manifest — permissions, background worker, side panel, options
background.js           Settings, run lifecycle, keepalive, approval routing
src/agent.js            Core loop: observe -> LLM tool call -> execute -> repeat
src/tab-actions.js      chrome.scripting + captureVisibleTab controller
src/cdp-actions.js      chrome.debugger wrapper — unused legacy, see file header
src/nvidia-client.js    OpenAI-compatible chat completions client
src/presets.js          Model presets, per-provider key storage, settings migration
popup.html/js/css       Task input, start/stop, live chat-style action log
options.html/js         API key, model, base URL, max steps
test/                   Unit tests for the pure helpers (node --test)
```

Run the tests with `npm test` (no dependencies; uses Node's built-in test runner).

## Design notes

**Element refs over pixel coordinates.** The model is shown a numbered list of the interactive elements on screen and clicks by reference. Each element is stamped with a `data-nim-ref` attribute during the scan, and the click re-queries by that attribute, so a re-render or scroll between the scan and the click can't silently redirect the click to whatever now sits at those coordinates. Raw x/y is available as a fallback for canvas-drawn UI.

**Occlusion detection.** Before clicking, the injected script checks that the element is what's actually at its own center point. A cookie banner or modal covering the target produces an explicit "that element is covered by X" error rather than a click that lands on the overlay and reports success.

**Frames.** The element scan fans out across all frames and each ref remembers which frame it came from, so embedded forms and widgets are reachable.

**Scrolling.** `scroll` walks up from the middle of the viewport looking for a scrollable container before falling back to the window, since most app shells scroll an inner div.

**New tabs.** Clicking a `target="_blank"` link opens a tab the agent would otherwise be blind to. The controller watches `chrome.tabs.onCreated` and follows child tabs.

**Context size.** Every step appends a full base64 PNG. Only the last three screenshots are kept in the message history; older ones are replaced with a text placeholder, which keeps a 25-step run from re-uploading 25 images on its final call.

**Typing by ref.** `type` takes a `ref` and focuses that field itself. Click-then-type is unreliable on sites that reveal or focus their input after the click — LinkedIn's search icon does exactly that — and a top-frame-only `activeElement` lookup returns the `<iframe>` node when focus is inside a frame. Both are handled.

**Small-model guardrails.** Weak models misbehave in predictable ways, and each has a specific countermeasure rather than a prompt plea:

- *Coordinates in the wrong space.* `interpretCoordinates` reads fractions of the viewport, screenshot pixels, and out-of-range values, converting all three to CSS pixels.
- *Invented refs.* A ref that isn't on the page is rejected before dispatch, and the error names the valid range plus a best guess at the intended element, matched from the model's own stated reason.
- *Task drift.* The task is restated after the untrusted-content fence on every turn, since models given a long history start servicing whatever banner is in front of them.
- *Repetition.* Identical consecutive actions get one nudge, then the run ends rather than burning the step budget.

## Security

**Prompt injection is the main risk.** The agent reads text from arbitrary websites and acts on it. A page can contain text designed to redirect the agent. Mitigations in place:

- Page content (URL, title, element labels) is fenced in the prompt and explicitly labelled untrusted data, with a system rule to never treat it as instructions.
- `navigate` accepts http/https only; `javascript:`, `data:`, `file:`, and `chrome://` URLs are refused.
- Navigation to a different origin carrying a long query string or fragment — the classic exfiltration shape — requires approval.

None of this is airtight. Treat the approval prompts as the real control, and don't run the agent on a tab logged into something you'd mind it acting in.

**The approval gate** covers: anything the model flags itself, clicks on buttons whose label matches a narrow list of consequential words, typing into a password field, pressing Enter inside a form (which submits it), and the exfiltration-shaped navigation above. The wordlist is deliberately narrow — `accept`, `agree`, `sign`, and `cancel` fire on cookie banners and dialog dismissals, and a prompt that appears on every third click trains people to approve without reading.

**The API key** is stored in `chrome.storage.local`, unencrypted, scoped to this browser profile. No key is committed to the source.

## Limitations

- Coordinate fallback clicks depend on the model reading pixel positions off the screenshot, so accuracy there depends on the model's vision quality.
- No page-text reading tool yet. The element list gives labels for interactive things only; body copy has to be read off the screenshot.
- Clicks and key presses are synthetic DOM events, not OS-level input.
- Only one task runs at a time per extension instance.
- Shadow DOM is not traversed by the element scan.
- Cost and rate limits are whatever your provider allows — each step sends one screenshot.
