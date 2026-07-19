// @ts-nocheck
// Feature: agent-tools-and-settings — Tools_View webview client.
//
// Renders the Coding_Tool catalogue grouped by category (the extension sends the tools
// already ordered by category then display name), with a per-tool enabled toggle and
// an approval-policy picker reusing the shared `.menu` / `.picker` vocabulary. Edits
// are posted to the extension, which persists them and echoes back the authoritative
// state; a failed persistence sends a `revert` message that restores the control and
// shows an inline error.
(function () {
  const vscode = acquireVsCodeApi();

  const $tools = document.getElementById("tools");
  const $empty = document.getElementById("empty");
  const $disconnected = document.getElementById("disconnected");
  const $menu = document.getElementById("menu");

  const POLICY_LABELS = {
    inherit: "Inherit",
    "always-ask": "Always ask",
    "auto-approve": "Auto-approve",
  };
  const POLICY_ORDER = ["inherit", "always-ask", "auto-approve"];

  function post(msg) {
    vscode.postMessage(msg);
  }

  // ── Popup menu (shared vocabulary) ───────────────────────────────────────────
  let openTrigger = null;

  function closeMenu() {
    $menu.hidden = true;
    $menu.innerHTML = "";
    openTrigger = null;
    document.removeEventListener("mousedown", onDocMouseDown, true);
  }

  function onDocMouseDown(e) {
    if (
      !$menu.contains(e.target) &&
      e.target !== openTrigger &&
      !(openTrigger && openTrigger.contains(e.target))
    ) {
      closeMenu();
    }
  }

  function openMenu(trigger, items, currentId, onSelect) {
    if (openTrigger === trigger) {
      closeMenu();
      return;
    }
    $menu.innerHTML = "";
    items.forEach((item) => {
      const el = document.createElement("button");
      el.className = "menu-item" + (item.id === currentId ? " selected" : "");
      const text = document.createElement("span");
      text.className = "menu-item-text";
      text.textContent = item.label;
      el.appendChild(text);
      el.addEventListener("click", () => {
        closeMenu();
        onSelect(item);
      });
      $menu.appendChild(el);
    });

    $menu.hidden = false;
    const rect = trigger.getBoundingClientRect();
    const menuRect = $menu.getBoundingClientRect();
    let left = rect.left;
    const maxLeft = window.innerWidth - menuRect.width - 6;
    if (left > maxLeft) left = Math.max(6, maxLeft);
    let top = rect.bottom + 4;
    if (top + menuRect.height > window.innerHeight - 6) {
      top = Math.max(6, rect.top - menuRect.height - 4);
    }
    $menu.style.left = `${left}px`;
    $menu.style.top = `${top}px`;

    openTrigger = trigger;
    document.addEventListener("mousedown", onDocMouseDown, true);
  }

  // ── Rendering ─────────────────────────────────────────────────────────────────
  // Row elements keyed by tool id, so `revert` can update a single control in place.
  const rows = new Map();

  function policyLabel(policy) {
    return POLICY_LABELS[policy] || policy;
  }

  function makeRow(tool) {
    const row = document.createElement("div");
    row.className = "tool-row";
    row.dataset.id = tool.id;

    const info = document.createElement("div");
    info.className = "tool-info";

    const name = document.createElement("div");
    name.className = "tool-name";
    name.textContent = tool.displayName;
    info.appendChild(name);

    const desc = document.createElement("div");
    desc.className = "tool-desc";
    desc.textContent = tool.description;
    info.appendChild(desc);

    const error = document.createElement("div");
    error.className = "tool-error";
    error.hidden = true;
    info.appendChild(error);

    row.appendChild(info);

    const controls = document.createElement("div");
    controls.className = "tool-controls";

    // Approval-policy picker (pill dropdown).
    const policyBtn = document.createElement("button");
    policyBtn.className = "picker tool-policy";
    policyBtn.type = "button";
    policyBtn.setAttribute("aria-haspopup", "true");
    policyBtn.title = "Approval policy";
    const policyText = document.createElement("span");
    policyText.className = "picker-text";
    policyText.textContent = policyLabel(tool.approvalPolicy);
    policyBtn.appendChild(policyText);
    policyBtn.addEventListener("click", () => {
      openMenu(
        policyBtn,
        POLICY_ORDER.map((p) => ({ id: p, label: POLICY_LABELS[p] })),
        row.dataset.policy,
        (item) => post({ type: "setPolicy", id: tool.id, policy: item.id }),
      );
    });
    controls.appendChild(policyBtn);

    // Enabled toggle.
    const toggle = document.createElement("label");
    toggle.className = "toggle";
    toggle.title = "Enabled";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "toggle-input";
    checkbox.setAttribute("aria-label", `Enable ${tool.displayName}`);
    checkbox.addEventListener("change", () => {
      post({ type: "setEnabled", id: tool.id, enabled: checkbox.checked });
    });
    const track = document.createElement("span");
    track.className = "toggle-track";
    toggle.appendChild(checkbox);
    toggle.appendChild(track);
    controls.appendChild(toggle);

    row.appendChild(controls);

    rows.set(tool.id, {
      row,
      checkbox,
      policyText,
      error,
    });
    applyState(tool.id, tool.enabled, tool.approvalPolicy);
    return row;
  }

  function applyState(id, enabled, policy) {
    const entry = rows.get(id);
    if (!entry) return;
    entry.checkbox.checked = enabled;
    entry.policyText.textContent = policyLabel(policy);
    entry.row.dataset.policy = policy;
    entry.row.classList.toggle("disabled", !enabled);
  }

  function showError(id, message) {
    const entry = rows.get(id);
    if (!entry) return;
    entry.error.textContent = message;
    entry.error.hidden = false;
  }

  function renderGroup(group) {
    const section = document.createElement("section");
    section.className = "tool-group";

    const header = document.createElement("div");
    header.className = "tool-group-header";
    const title = document.createElement("span");
    title.className = "tool-group-title";
    title.textContent = group.label;
    header.appendChild(title);
    const count = document.createElement("span");
    count.className = "tool-group-count";
    const enabled = group.tools.filter((t) => t.enabled).length;
    count.textContent = `${enabled}/${group.tools.length}`;
    header.appendChild(count);
    section.appendChild(header);

    if (group.tools.length === 0) {
      const none = document.createElement("div");
      none.className = "tool-group-empty";
      none.textContent = "No tools provided.";
      section.appendChild(none);
      return section;
    }

    let currentCategory = null;
    group.tools.forEach((tool) => {
      // Category sub-headers only add value inside the built-in group.
      if (group.builtin && tool.category !== currentCategory) {
        currentCategory = tool.category;
        const sub = document.createElement("div");
        sub.className = "tool-category";
        sub.textContent = tool.categoryLabel;
        section.appendChild(sub);
      }
      section.appendChild(makeRow(tool));
    });
    return section;
  }

  function render(groups) {
    closeMenu();
    rows.clear();
    $tools.innerHTML = "";

    const total = (groups || []).reduce((n, g) => n + g.tools.length, 0);
    if (total === 0) {
      $tools.hidden = true;
      $empty.hidden = false;
      return;
    }
    $tools.hidden = false;
    $empty.hidden = true;

    (groups || []).forEach((group) => $tools.appendChild(renderGroup(group)));
  }

  function setConnected(connected) {
    $disconnected.hidden = !!connected;
  }

  // ── Extension → webview ───────────────────────────────────────────────────────
  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "tools":
        render(msg.groups);
        setConnected(msg.connected);
        break;
      case "status":
        setConnected(msg.connected);
        break;
      case "revert":
        applyState(msg.id, msg.enabled, msg.approvalPolicy);
        showError(msg.id, msg.message);
        break;
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && openTrigger) {
      closeMenu();
    }
  });

  post({ type: "ready" });
})();
