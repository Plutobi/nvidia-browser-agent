const taskEl = document.getElementById("task");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const statusEl = document.getElementById("statusLine");
const chatEl = document.getElementById("chat");
const settingsBtn = document.getElementById("settingsBtn");
const modelLineEl = document.getElementById("modelLine");

settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
modelLineEl.addEventListener("click", () => chrome.runtime.openOptionsPage());

function setModelLabel(label) {
  modelLineEl.textContent = label || "no model configured";
  modelLineEl.title = label ? `${label} — click to change` : "Click to choose a model";
}

// The panel is a persistent side panel, so it can be sitting open while the
// model gets changed in the options page. Reflect that immediately instead
// of showing a stale label until the next run.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.presetId || changes.customModel || changes.customBaseUrl) refreshStatus();
});

function addMessage(text, { cls = "", detail = "" } = {}) {
  const row = document.createElement("div");
  row.className = `msg ${cls}`;

  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = "N";

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;

  if (detail) {
    const detailEl = document.createElement("span");
    detailEl.className = "action-detail";
    detailEl.textContent = detail;
    bubble.appendChild(detailEl);
  }

  row.appendChild(avatar);
  row.appendChild(bubble);
  chatEl.appendChild(row);
  chatEl.scrollTop = chatEl.scrollHeight;
  return row;
}

function addSystemNote(text) {
  const div = document.createElement("div");
  div.className = "system-note";
  div.textContent = text;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
}

let thinkingEl = null;
function showThinking() {
  removeThinking();
  thinkingEl = addMessage("…", { cls: "thinking" });
}
function removeThinking() {
  if (thinkingEl) {
    thinkingEl.remove();
    thinkingEl = null;
  }
}

// Short technical detail shown under the narration bubble, for transparency
// without cluttering the main chat-style message.
function actionDetail(name, args) {
  switch (name) {
    case "click":
      if (args.ref !== undefined && args.ref !== null && args.ref !== "") return `click ref [${args.ref}]`;
      if (args.x === undefined || args.y === undefined) return "click (no target given)";
      return `click (${args.x}, ${args.y})`;
    case "type": {
      const where = args.ref !== undefined && args.ref !== null && args.ref !== "" ? ` into ref [${args.ref}]` : "";
      return `${args.replace ? "replace with" : "type"} "${args.text}"${where}`;
    }
    case "key":
      return [...(args.modifiers || []), args.key].join("+").replace(/^/, "key ");
    case "select_option":
      return `select "${args.value}" in ref [${args.ref}]`;
    case "hover":
      return `hover ref [${args.ref}]`;
    case "scroll":
      return `scroll ${args.deltaY}`;
    case "navigate":
      return `navigate ${args.url}`;
    case "wait":
      return `wait ${args.ms}ms`;
    case "close_tab":
      return "close tab";
    default:
      return JSON.stringify(args);
  }
}

// Renders the Approve/Deny prompt for a sensitive action inside its own
// chat bubble. Clicking either button reports back to background.js, which
// unblocks the agent loop that's waiting on it.
//
// `resolved` is set when replaying history into a reopened panel: an
// already-answered prompt still belongs in the transcript, with its buttons
// inert, so it doesn't look like it's still waiting on someone.
function addConfirmPrompt(event, { resolved = false } = {}) {
  const row = addMessage((event.args && event.args.reason) || `Confirm: ${event.name}`, {
    cls: "confirm",
    detail: actionDetail(event.name, event.args || {}),
  });
  const bubble = row.querySelector(".bubble");

  const actions = document.createElement("div");
  actions.className = "confirm-actions";

  const approveBtn = document.createElement("button");
  approveBtn.textContent = "Approve";
  approveBtn.className = "approveBtn";

  const denyBtn = document.createElement("button");
  denyBtn.textContent = "Deny";
  denyBtn.className = "denyBtn";

  const respond = (approved) => {
    approveBtn.disabled = true;
    denyBtn.disabled = true;
    chrome.runtime.sendMessage({ type: "confirm-response", approved });
  };
  approveBtn.addEventListener("click", () => respond(true));
  denyBtn.addEventListener("click", () => respond(false));
  if (resolved) {
    approveBtn.disabled = true;
    denyBtn.disabled = true;
  }

  actions.appendChild(approveBtn);
  actions.appendChild(denyBtn);
  bubble.appendChild(actions);
  chatEl.scrollTop = chatEl.scrollHeight;
}

function setRunning(isRunning) {
  startBtn.disabled = isRunning;
  stopBtn.disabled = !isRunning;
  taskEl.disabled = isRunning;
  statusEl.textContent = isRunning ? "Running…" : "";
  if (!isRunning) removeThinking();
}

function renderEvent(event, opts = {}) {
  switch (event.kind) {
    case "thinking":
      showThinking();
      break;
    case "action":
      removeThinking();
      addMessage(event.args && event.args.reason ? event.args.reason : `${event.name}(...)`, {
        cls: "action",
        detail: actionDetail(event.name, event.args || {}),
      });
      break;
    case "no-tool-call":
      removeThinking();
      addMessage(event.text || "(replied without an action)", { cls: "note" });
      break;
    case "nudge":
      removeThinking();
      addSystemNote(`Repeated the same action, nudging it to try something else…`);
      break;
    case "note":
      removeThinking();
      addSystemNote(event.text);
      break;
    case "confirm-request":
      removeThinking();
      addConfirmPrompt(event, { resolved: !!opts.resolved });
      break;
    case "confirm-approved":
      addSystemNote("Approved. Continuing…");
      break;
    case "confirm-denied":
      addSystemNote("Declined.");
      break;
    case "stuck":
      removeThinking();
      addMessage(`Gave up: repeated "${event.name}" with no progress.`, { cls: "error" });
      break;
    case "error":
      removeThinking();
      addMessage(event.error, { cls: "error" });
      break;
    case "done":
      removeThinking();
      addMessage(event.summary || "Done.", { cls: "done" });
      break;
    case "stopped":
      removeThinking();
      addSystemNote("Stopped by user.");
      break;
    case "max-steps":
      removeThinking();
      addSystemNote("Reached max step limit.");
      break;
    default:
      addSystemNote(JSON.stringify(event));
  }
}

startBtn.addEventListener("click", () => {
  const task = taskEl.value.trim();
  if (!task) {
    statusEl.textContent = "Enter a task first.";
    return;
  }
  chatEl.innerHTML = "";
  thinkingEl = null;
  addMessage(task, { cls: "task" });
  setRunning(true);
  chrome.runtime.sendMessage({ type: "start", task }, (resp) => {
    if (chrome.runtime.lastError) {
      addMessage(chrome.runtime.lastError.message, { cls: "error" });
      setRunning(false);
    }
  });
});

stopBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "stop" });
  statusEl.textContent = "Stopping…";
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "started") {
    setRunning(true);
    if (msg.modelLabel) setModelLabel(msg.modelLabel);
  } else if (msg.type === "log") {
    renderEvent(msg.event);
  } else if (msg.type === "finished") {
    setRunning(false);
    if (msg.result && msg.result.status === "error") {
      statusEl.textContent = "Error, see log.";
    } else {
      statusEl.textContent = "Finished.";
    }
  }
});

// Reflect current state if the panel is reopened mid-run, and replay
// whatever already happened so a stuck "Running..." isn't paired with a
// blank log. An approval prompt that was already answered replays with its
// buttons inert; one that's still waiting replays live, which is how you
// recover from closing the panel on top of a pending confirmation.
function refreshStatus() {
  chrome.runtime.sendMessage({ type: "status" }, (resp) => {
    if (chrome.runtime.lastError || !resp) return;
    setModelLabel(resp.modelLabel);
    if (Array.isArray(resp.log) && resp.log.length) {
      chatEl.innerHTML = "";
      thinkingEl = null;
      const answered = new Set(
        resp.log
          .filter((e) => e.kind === "confirm-approved" || e.kind === "confirm-denied")
          .map((e) => e.step)
      );
      resp.log.forEach((event) => renderEvent(event, { resolved: answered.has(event.step) }));
    }
    setRunning(!!resp.running);
  });
}

refreshStatus();
