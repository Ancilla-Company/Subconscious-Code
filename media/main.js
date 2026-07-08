// @ts-nocheck
(function () {
  const vscode = acquireVsCodeApi();

  const $messages = document.getElementById("messages");
  const $status = document.getElementById("status");
  const $input = document.getElementById("input");
  const $send = document.getElementById("send");
  const $newThread = document.getElementById("new-thread");
  const $wsTrigger = document.getElementById("workspace-trigger");
  const $wsLabel = document.getElementById("workspace-label");
  const $thTrigger = document.getElementById("thread-trigger");
  const $thLabel = document.getElementById("thread-label");
  const $modelTrigger = document.getElementById("model-trigger");
  const $modelLabel = document.getElementById("model-label");
  const $menu = document.getElementById("menu");

  const state = {
    workspaces: [],
    threads: [],
    models: [],
    currentWorkspace: undefined,
    currentThread: undefined,
    currentModel: undefined,
  };

  const rendered = new Set(); // message uuids already shown
  let liveBubble = null; // in-progress assistant bubble {el, text}

  function post(msg) {
    vscode.postMessage(msg);
  }

  // ── Custom dropdown menu ──────────────────────────────────────────────
  const FOLDER_ICON =
    '<path fill="currentColor" d="M1.5 3A1.5 1.5 0 0 1 3 1.5h3.09a1.5 1.5 0 0 1 1.06.44l.91.91H13A1.5 1.5 0 0 1 14.5 4.5v7A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5V3Zm1.5-.5a.5.5 0 0 0-.5.5v8.5a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5H7.75a.5.5 0 0 1-.354-.146l-1.06-1.06a.5.5 0 0 0-.353-.148H3Z"/>';
  const CHAT_ICON =
    '<path fill="currentColor" d="M2.5 2h11A1.5 1.5 0 0 1 15 3.5v6A1.5 1.5 0 0 1 13.5 11H6.7l-3.4 2.85A.5.5 0 0 1 2.5 13.5V11A1.5 1.5 0 0 1 1 9.5v-6A1.5 1.5 0 0 1 2.5 2Zm0 1a.5.5 0 0 0-.5.5v6a.5.5 0 0 0 .5.5h.5v1.93L6.32 10h7.18a.5.5 0 0 0 .5-.5v-6a.5.5 0 0 0-.5-.5h-11Z"/>';
  const MODEL_ICON =
    '<path fill="currentColor" d="M8 1.5 9.6 5l3.9.3-3 2.6.95 3.8L8 9.9l-3.45 1.8L5.5 7.9l-3-2.6L6.4 5 8 1.5Z"/>';

  let openTrigger = null;

  function closeMenu() {
    $menu.hidden = true;
    $menu.innerHTML = "";
    openTrigger = null;
    document.removeEventListener("mousedown", onDocMouseDown, true);
  }

  function onDocMouseDown(e) {
    if (!$menu.contains(e.target) && e.target !== openTrigger && !openTrigger?.contains(e.target)) {
      closeMenu();
    }
  }

  function openMenu(trigger, iconPath, items, currentId, onSelect) {
    if (openTrigger === trigger) {
      closeMenu();
      return;
    }
    $menu.innerHTML = "";
    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "menu-empty";
      empty.textContent = "Nothing here yet";
      $menu.appendChild(empty);
    }
    items.forEach((item) => {
      const el = document.createElement("button");
      el.className = "menu-item" + (item.id === currentId ? " selected" : "");
      el.innerHTML =
        `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">${iconPath}</svg>` +
        `<span class="menu-item-text"></span>`;
      el.querySelector(".menu-item-text").textContent = item.label;
      el.addEventListener("click", () => {
        closeMenu();
        onSelect(item);
      });
      $menu.appendChild(el);
    });

    // Position the menu above the trigger (composer sits at the bottom).
    $menu.hidden = false;
    const rect = trigger.getBoundingClientRect();
    const menuRect = $menu.getBoundingClientRect();
    let left = rect.left;
    const maxLeft = window.innerWidth - menuRect.width - 6;
    if (left > maxLeft) left = Math.max(6, maxLeft);
    $menu.style.left = `${left}px`;
    $menu.style.top = `${rect.top - menuRect.height - 4}px`;

    openTrigger = trigger;
    document.addEventListener("mousedown", onDocMouseDown, true);
  }

  function truncate(text, max) {
    if (!text) return "";
    return text.length > max ? text.slice(0, max - 1) + "…" : text;
  }

  function modelName(m) {
    return m ? (m.model || m.provider || m.id) : "Model";
  }

  function refreshTriggers() {
    const ws = state.workspaces.find((w) => w.uuid === state.currentWorkspace);
    $wsLabel.textContent = ws ? truncate(ws.name, 20) : "Workspace";
    const th = state.threads.find((t) => t.uuid === state.currentThread);
    $thLabel.textContent = th ? truncate(th.title || "Untitled", 24) : "Thread";
    const md = state.models.find((m) => m.id === state.currentModel);
    $modelLabel.textContent = truncate(modelName(md), 22);
  }

  $modelTrigger.addEventListener("click", () => {
    openMenu(
      $modelTrigger,
      MODEL_ICON,
      state.models.map((m) => ({ id: m.id, label: modelName(m) })),
      state.currentModel,
      (item) => {
        state.currentModel = item.id;
        refreshTriggers();
      },
    );
  });

  $wsTrigger.addEventListener("click", () => {
    openMenu(
      $wsTrigger,
      FOLDER_ICON,
      state.workspaces.map((w) => ({ id: w.uuid, label: w.name })),
      state.currentWorkspace,
      (item) => post({ type: "selectWorkspace", uuid: item.id }),
    );
  });

  $thTrigger.addEventListener("click", () => {
    openMenu(
      $thTrigger,
      CHAT_ICON,
      state.threads.map((t) => ({ id: t.uuid, label: t.title || "Untitled" })),
      state.currentThread,
      (item) => post({ type: "selectThread", uuid: item.id }),
    );
  });

  $newThread.addEventListener("click", () => post({ type: "newThread" }));

  // ── Messages ──────────────────────────────────────────────────────────
  function clearMessages() {
    $messages.innerHTML = "";
    rendered.clear();
    liveBubble = null;
  }

  function addBubble(role, content, uuid) {
    if (uuid && rendered.has(uuid)) {
      return null;
    }
    const el = document.createElement("div");
    el.className = `bubble ${role === "user" ? "user" : "agent"}`;
    el.textContent = content;
    $messages.appendChild(el);
    $messages.scrollTop = $messages.scrollHeight;
    if (uuid) {
      rendered.add(uuid);
    }
    return el;
  }

  // ── Extension → webview ──────────────────────────────────────────────
  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "status":
        $status.textContent = msg.status === "connected" ? "" : "Disconnected — reconnecting…";
        break;

      case "workspaces":
        state.workspaces = msg.workspaces || [];
        refreshTriggers();
        break;

      case "models":
        state.models = msg.models || [];
        if (!state.currentModel) {
          const def = state.models.find((m) => m.is_default) || state.models[0];
          state.currentModel = def ? def.id : undefined;
        }
        refreshTriggers();
        break;

      case "threads":
        state.threads = msg.threads || [];
        if (msg.workspaceUuid) {
          state.currentWorkspace = msg.workspaceUuid;
        }
        if (state.threads[0]) {
          state.currentThread = state.threads[0].uuid;
          post({ type: "selectThread", uuid: state.threads[0].uuid });
        } else {
          state.currentThread = undefined;
          clearMessages();
        }
        refreshTriggers();
        break;

      case "messages":
        state.currentThread = msg.threadUuid;
        clearMessages();
        (msg.messages || []).forEach((m) => addBubble(m.role, m.content, m.uuid));
        refreshTriggers();
        break;

      case "message": {
        const m = msg.message;
        if (m.role === "agent" && liveBubble && liveBubble.text === m.content) {
          rendered.add(m.uuid);
          liveBubble = null;
          break;
        }
        addBubble(m.role, m.content, m.uuid);
        break;
      }

      case "delta":
        if (!liveBubble) {
          liveBubble = { el: addBubble("agent", "", null), text: "" };
        }
        liveBubble.text += msg.delta || "";
        liveBubble.el.textContent = liveBubble.text;
        $messages.scrollTop = $messages.scrollHeight;
        break;

      case "done":
        break;

      case "error":
        $status.textContent = `Error: ${msg.message}`;
        break;
    }
  });

  // ── Composer ──────────────────────────────────────────────────────────
  function send() {
    const content = $input.value;
    if (content.trim()) {
      post({ type: "send", content, modelId: state.currentModel });
      $input.value = "";
      autoGrow();
      updateSendState();
    }
  }
  $send.addEventListener("click", send);
  $input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  function autoGrow() {
    $input.style.height = "auto";
    $input.style.height = `${$input.scrollHeight}px`;
  }
  function updateSendState() {
    $send.disabled = !$input.value.trim();
  }
  $input.addEventListener("input", () => {
    autoGrow();
    updateSendState();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && openTrigger) {
      closeMenu();
    }
  });

  updateSendState();
  post({ type: "ready" });
})();
