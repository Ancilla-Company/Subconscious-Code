// @ts-nocheck
// Feature: agent-tools-and-settings — Settings_View webview client.
//
// Renders the agent settings surface and bridges edits back to the extension:
//   - Autonomy_Mode segmented control (Requirement 8.2)
//   - default-enabled tool toggles (Requirement 8.1)
//   - Custom_Instructions textarea with live count + max-length notice on the
//     extension's rejection message (Requirement 8.3, 8.4)
//   - default-model dropdown fed by the engine model list, with an unavailable
//     notice when the list could not be retrieved (Requirement 8.5, 8.6, 8.7)
//   - the Execution_Profile editor supporting undetermined and manually added
//     entries, saved back to the extension (Requirement 11.7, 11.8, 11.10, 11.12)
//
// Only DOM built from theme-token CSS classes is used (Requirement 8.8, 11.14).
(function () {
  const vscode = acquireVsCodeApi();

  const $conn = document.getElementById("conn");
  const $configError = document.getElementById("config-error");
  const $autonomy = document.getElementById("autonomy");
  const $tools = document.getElementById("tools");
  const $ci = document.getElementById("custom-instructions");
  const $ciCount = document.getElementById("ci-count");
  const $ciMax = document.getElementById("ci-max");
  const $ciNotice = document.getElementById("ci-notice");
  const $model = document.getElementById("model");
  const $modelNotice = document.getElementById("model-notice");
  const $profile = document.getElementById("profile");
  const $addTech = document.getElementById("add-tech");
  const $saveProfile = document.getElementById("save-profile");

  let maxInstructionsLength = 10000;
  // The last value the extension confirmed as persisted; used to revert an overflow.
  let lastAcceptedInstructions = "";
  // Debounce handle for custom-instructions persistence.
  let ciTimer = null;

  const COMMAND_KEYS = ["run", "test", "debug", "build"];
  const ENV_KINDS = ["none", "venv", "conda"];

  function post(msg) {
    vscode.postMessage(msg);
  }

  // ── Autonomy ────────────────────────────────────────────────────────────────
  function setAutonomy(mode) {
    for (const seg of $autonomy.querySelectorAll(".segment")) {
      const active = seg.dataset.mode === mode;
      seg.classList.toggle("active", active);
      seg.setAttribute("aria-checked", active ? "true" : "false");
    }
  }

  $autonomy.addEventListener("click", (e) => {
    const seg = e.target.closest(".segment");
    if (!seg) return;
    const mode = seg.dataset.mode;
    setAutonomy(mode);
    post({ type: "setAutonomyMode", mode });
  });

  // ── Default-enabled tools ─────────────────────────────────────────────────────
  function renderTools(tools) {
    $tools.innerHTML = "";
    if (!tools || tools.length === 0) {
      const empty = document.createElement("div");
      empty.className = "settings-hint";
      empty.textContent = "No tools available.";
      $tools.appendChild(empty);
      return;
    }
    tools.forEach((tool) => {
      const row = document.createElement("div");
      row.className = "tool-row";

      const info = document.createElement("div");
      info.className = "tool-info";
      const name = document.createElement("div");
      name.className = "tool-name";
      name.textContent = tool.displayName;
      info.appendChild(name);
      const cat = document.createElement("div");
      cat.className = "tool-desc";
      cat.textContent = tool.category;
      info.appendChild(cat);
      row.appendChild(info);

      const toggle = document.createElement("label");
      toggle.className = "toggle";
      toggle.title = "Enabled by default";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "toggle-input";
      checkbox.checked = !!tool.enabled;
      checkbox.setAttribute("aria-label", `Enable ${tool.displayName}`);
      checkbox.addEventListener("change", () => {
        post({ type: "setToolEnabled", id: tool.id, enabled: checkbox.checked });
      });
      const track = document.createElement("span");
      track.className = "toggle-track";
      toggle.appendChild(checkbox);
      toggle.appendChild(track);
      row.appendChild(toggle);

      $tools.appendChild(row);
    });
  }

  // ── Custom instructions ───────────────────────────────────────────────────────
  function updateCount() {
    const len = $ci.value.length;
    $ciCount.textContent = `${len} / ${maxInstructionsLength}`;
    $ciCount.classList.toggle("over", len > maxInstructionsLength);
  }

  $ci.addEventListener("input", () => {
    updateCount();
    // Clear a stale notice as soon as the user edits again.
    $ciNotice.hidden = true;
    if (ciTimer) clearTimeout(ciTimer);
    ciTimer = setTimeout(() => {
      post({ type: "setCustomInstructions", value: $ci.value });
    }, 300);
  });

  // ── Default model ───────────────────────────────────────────────────────────
  function modelLabel(m) {
    const base = m.model || m.id;
    return m.provider ? `${m.provider} · ${base}` : base;
  }

  function renderModels(models, available, defaultModelId) {
    $model.innerHTML = "";
    $modelNotice.hidden = !!available;
    $model.disabled = !available || !models || models.length === 0;

    const none = document.createElement("option");
    none.value = "";
    none.textContent = available ? "Engine default" : "Unavailable";
    $model.appendChild(none);

    (models || []).forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = modelLabel(m);
      if (m.id === defaultModelId) opt.selected = true;
      $model.appendChild(opt);
    });

    if (!defaultModelId) none.selected = true;
  }

  $model.addEventListener("change", () => {
    post({ type: "setDefaultModel", modelId: $model.value || null });
  });

  // ── Execution profile ─────────────────────────────────────────────────────────
  // Editable in-memory model mirrored to the DOM; serialized on save.
  let techModel = [];

  function emptyTech() {
    return {
      language: "",
      runtime: "",
      environment: { kind: "none", activationCommand: "", interpreterPath: "" },
      commands: {
        run: { command: "", determined: false },
        test: { command: "", determined: false },
        debug: { command: "", determined: false },
        build: { command: "", determined: false },
      },
    };
  }

  function coerceTech(t) {
    const env = t.environment || {};
    const commands = t.commands || {};
    const cmd = (c) => ({
      command: c && typeof c.command === "string" ? c.command : "",
      determined: !!(c && c.determined),
    });
    return {
      language: t.language || "",
      runtime: t.runtime || "",
      environment: {
        kind: ENV_KINDS.includes(env.kind) ? env.kind : "none",
        activationCommand: env.activationCommand || "",
        interpreterPath: env.interpreterPath || "",
      },
      commands: {
        run: cmd(commands.run),
        test: cmd(commands.test),
        debug: cmd(commands.debug),
        build: cmd(commands.build),
      },
    };
  }

  function labelField(labelText, control) {
    const wrap = document.createElement("label");
    wrap.className = "field";
    const span = document.createElement("span");
    span.className = "field-label";
    span.textContent = labelText;
    wrap.appendChild(span);
    wrap.appendChild(control);
    return wrap;
  }

  function textInput(value, placeholder, onInput) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "settings-input";
    input.value = value || "";
    if (placeholder) input.placeholder = placeholder;
    input.addEventListener("input", () => onInput(input.value));
    return input;
  }

  function renderProfile() {
    $profile.innerHTML = "";
    if (techModel.length === 0) {
      const empty = document.createElement("div");
      empty.className = "settings-hint";
      empty.textContent =
        "No technologies detected. Add one to record run/test/debug/build commands.";
      $profile.appendChild(empty);
      return;
    }

    techModel.forEach((tech, idx) => {
      const card = document.createElement("div");
      card.className = "profile-tech";

      const head = document.createElement("div");
      head.className = "profile-tech-head";
      head.appendChild(
        labelField(
          "Language",
          textInput(tech.language, "e.g. python", (v) => {
            tech.language = v;
          })
        )
      );
      head.appendChild(
        labelField(
          "Runtime",
          textInput(tech.runtime, "optional", (v) => {
            tech.runtime = v;
          })
        )
      );
      const remove = document.createElement("button");
      remove.className = "settings-btn secondary remove-tech";
      remove.type = "button";
      remove.textContent = "Remove";
      remove.addEventListener("click", () => {
        techModel.splice(idx, 1);
        renderProfile();
      });
      head.appendChild(remove);
      card.appendChild(head);

      // Environment activation.
      const envRow = document.createElement("div");
      envRow.className = "profile-env";
      const kindSelect = document.createElement("select");
      kindSelect.className = "settings-select";
      ENV_KINDS.forEach((k) => {
        const opt = document.createElement("option");
        opt.value = k;
        opt.textContent = k === "none" ? "No environment" : k;
        if (k === tech.environment.kind) opt.selected = true;
        kindSelect.appendChild(opt);
      });
      kindSelect.addEventListener("change", () => {
        tech.environment.kind = kindSelect.value;
      });
      envRow.appendChild(labelField("Environment", kindSelect));
      envRow.appendChild(
        labelField(
          "Activation command",
          textInput(tech.environment.activationCommand, "e.g. conda activate myenv", (v) => {
            tech.environment.activationCommand = v;
          })
        )
      );
      envRow.appendChild(
        labelField(
          "Interpreter path",
          textInput(tech.environment.interpreterPath, "optional", (v) => {
            tech.environment.interpreterPath = v;
          })
        )
      );
      card.appendChild(envRow);

      // Commands.
      COMMAND_KEYS.forEach((key) => {
        const spec = tech.commands[key];
        const control = textInput(
          spec.command,
          spec.determined ? "" : "undetermined — supply a command",
          (v) => {
            spec.command = v;
          }
        );
        if (!spec.determined && !spec.command) {
          control.classList.add("undetermined");
        }
        const field = labelField(key.charAt(0).toUpperCase() + key.slice(1), control);
        field.classList.add("command-field");
        card.appendChild(field);
      });

      $profile.appendChild(card);
    });
  }

  function serializeProfile() {
    return {
      technologies: techModel.map((tech) => ({
        language: tech.language,
        runtime: tech.runtime,
        environment: {
          kind: tech.environment.kind,
          activationCommand: tech.environment.activationCommand,
          interpreterPath: tech.environment.interpreterPath,
        },
        commands: {
          run: { command: tech.commands.run.command },
          test: { command: tech.commands.test.command },
          debug: { command: tech.commands.debug.command },
          build: { command: tech.commands.build.command },
        },
      })),
    };
  }

  $addTech.addEventListener("click", () => {
    techModel.push(emptyTech());
    renderProfile();
  });

  $saveProfile.addEventListener("click", () => {
    post({ type: "saveProfile", profile: serializeProfile() });
  });

  // ── Extension → webview ───────────────────────────────────────────────────────
  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "init":
        maxInstructionsLength = msg.maxInstructionsLength || maxInstructionsLength;
        $ciMax.textContent = String(maxInstructionsLength);
        setAutonomy(msg.autonomyMode);
        renderTools(msg.tools);
        lastAcceptedInstructions = msg.customInstructions || "";
        $ci.value = lastAcceptedInstructions;
        updateCount();
        $configError.hidden = !msg.configError;
        break;
      case "toolStates":
        renderTools(msg.tools);
        break;
      case "models":
        renderModels(msg.models, msg.available, msg.defaultModelId);
        break;
      case "status":
        $conn.hidden = !!msg.connected;
        break;
      case "customInstructionsSaved":
        lastAcceptedInstructions = msg.value;
        $ciNotice.hidden = true;
        break;
      case "customInstructionsRejected":
        // Revert to the retained previous value and show the max-length notice.
        lastAcceptedInstructions = typeof msg.value === "string" ? msg.value : lastAcceptedInstructions;
        $ci.value = lastAcceptedInstructions;
        updateCount();
        $ciNotice.hidden = false;
        break;
      case "profile":
        techModel = (msg.profile && Array.isArray(msg.profile.technologies)
          ? msg.profile.technologies
          : []
        ).map(coerceTech);
        renderProfile();
        break;
      case "error":
        // Surface unexpected extension-side errors inline in the model notice slot.
        break;
    }
  });

  post({ type: "ready" });
})();
