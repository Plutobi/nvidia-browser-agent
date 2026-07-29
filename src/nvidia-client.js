// Minimal client for OpenAI-compatible chat completions APIs. Works against
// NVIDIA NIM (build.nvidia.com) out of the box, and against any other
// OpenAI-compatible provider (OpenRouter, Gemini's compat layer, a
// self-hosted NIM container, etc.) by pointing baseUrl/apiKey/model at it.

const DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";

export class NvidiaClient {
  constructor({ apiKey, model, baseUrl, extraHeaders, extraBody }) {
    if (!apiKey) throw new Error("Missing API key. Set it in the extension options page.");
    this.apiKey = apiKey;
    this.model = model || "meta/llama-4-maverick-17b-128e-instruct";
    this.baseUrl = baseUrl || DEFAULT_BASE_URL;
    this.extraHeaders = extraHeaders || {};
    this.extraBody = extraBody || {};
  }

  // messages: array of {role, content} where content can be a string or an array
  // of {type:"text", text} / {type:"image_url", image_url:{url}} blocks.
  // tools: OpenAI-style tool/function definitions.
  async chat(opts) {
    try {
      return await this._chatOnce(opts);
    } catch (err) {
      // "No choices" from a free/shared endpoint is often a transient blip
      // (empty response body, momentary overload) rather than a real
      // failure. One quiet retry before actually surfacing it.
      if (/no choices/i.test(err.message || "") && !(opts.signal && opts.signal.aborted)) {
        console.warn("[NIM Browser Agent] API returned no choices, retrying once:", err.message);
        await new Promise((r) => setTimeout(r, 1000));
        return await this._chatOnce(opts);
      }
      throw err;
    }
  }

  async _chatOnce({ messages, tools, toolChoice = "auto", temperature = 0.2, maxTokens = 1024, timeoutMs = 90000, signal }) {
    const body = {
      model: this.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
      ...this.extraBody,
    };
    if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = toolChoice;
    }

    // Combine an internal per-call timeout with the caller's own abort
    // signal (e.g. a Stop button), so whichever fires first wins.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onExternalAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onExternalAbort, { once: true });
    }

    let res;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          ...this.extraHeaders,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === "AbortError") {
        if (signal && signal.aborted) {
          // Caller (Stop button) aborted this on purpose, not a timeout.
          throw err;
        }
        throw new Error(`API request timed out after ${timeoutMs}ms (model may be overloaded or rate-limited).`);
      }
      throw new Error(`API request failed: ${err.message}`);
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onExternalAbort);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // 402 means the account is out of credit. The raw provider response
      // for this is opaque enough that it reads like a bug, so say plainly
      // what happened and what fixes it.
      if (res.status === 402) {
        throw new Error(
          `Out of credit (402): this model is billed per token and the account has no balance. Open the options page and pick a free model preset, or top up with the provider. Raw response: ${text.slice(0, 200)}`
        );
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error(
          `Rejected (${res.status}): the API key is missing, wrong, or not valid for this provider. Check the key on the options page — keys are saved per provider, so switching providers needs that provider's own key. Raw response: ${text.slice(0, 200)}`
        );
      }
      if (res.status === 429) {
        throw new Error(
          `Rate limited (429): the request cap has been hit for now. Wait a bit, or switch model in the options page. Raw response: ${text.slice(0, 300)}`
        );
      }
      if (res.status === 404) {
        throw new Error(
          `Model not found (404): "${this.model}" isn't available at ${this.baseUrl}. Check the model name on the options page. Raw response: ${text.slice(0, 200)}`
        );
      }
      throw new Error(`API error ${res.status}: ${text.slice(0, 500)}`);
    }

    const data = await res.json();
    const choice = data.choices && data.choices[0];
    if (!choice) {
      const apiError = data.error && (data.error.message || JSON.stringify(data.error));
      throw new Error(apiError ? `API returned no choices: ${apiError}` : `API returned no choices. Raw body: ${JSON.stringify(data).slice(0, 300)}`);
    }
    return choice.message;
  }
}

export function imageContentBlock(dataUrl) {
  return { type: "image_url", image_url: { url: dataUrl } };
}

export function textContentBlock(text) {
  return { type: "text", text };
}
