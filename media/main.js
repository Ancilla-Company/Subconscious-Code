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
  const $list = document.getElementById("list");
  const $menu = document.getElementById("menu");
  const $mentionMenu = document.getElementById("mention-menu");
  const $agentState = document.getElementById("agent-state");
  const $agentStateLabel = document.getElementById("agent-state-label");
  const $inputHighlights = document.getElementById("input-highlights");

  const state = {
    workspaces: [],
    threads: [],
    models: [],
    currentWorkspace: undefined,
    currentThread: undefined,
    currentModel: undefined,
    view: "chat", // "chat" | "workspaces" | "threads"
  };

  // Resolved "#" mentions live INLINE in the composer text itself (Kiro/Antigravity
  // style — "Can you check #main.ts for bugs" reads like a normal sentence) rather
  // than as separate chips pinned above the composer. `mentionContextByToken` maps
  // the exact inline text inserted for a mention (e.g. "#main.ts") to the full
  // context block sent to the engine for it; `pendingMentionTokens` correlates an
  // in-flight `mentionResolve` request back to the token that was already inserted
  // into the textarea at pick time (the label is known immediately — only the full
  // context content requires a round trip to the extension).
  const mentionContextByToken = new Map();
  const pendingMentionTokens = new Map();

  // Set when the user picks a workspace from the list, so the arriving thread list is
  // shown (most-recent thread selected) rather than auto-opening the top thread.
  let navToThreadListOnLoad = false;

  // Restore webview-owned UI state (the selected model) across full reloads. The
  // workspace/thread selection is restored by the extension from workspaceState, and
  // the live DOM is kept across hide/show via retainContextWhenHidden.
  const savedUi = vscode.getState() || {};
  if (savedUi.currentModel) {
    state.currentModel = savedUi.currentModel;
  }

  function persistUiState() {
    vscode.setState({ currentModel: state.currentModel });
  }

  // ── Working/idle indicator + send/stop button ───────────────────────────
  // Mirrors Kiro's "is the agent doing something right now?" cue: a pulsing dot +
  // label next to the model picker. "Working" covers the whole turn (from send
  // until chat.done/chat.error), not just streaming text, so it also stays lit
  // while a tool call is running with no text in flight.
  //
  // The same state drives the composer's primary button: while the agent is working
  // it becomes a stop button that cancels the turn, and it reverts to send when the
  // turn ends.
  let agentWorking = false;

  function setAgentWorking(working, label) {
    agentWorking = working;
    $agentState.hidden = false;
    $agentState.classList.toggle("working", working);
    $agentStateLabel.textContent = label || (working ? "Working…" : "Idle");
    updateSendState();
  }

  const rendered = new Set(); // message uuids already shown
  let liveBubble = null; // in-progress assistant bubble {el, text}

  // Assistant bubbles that were streamed live (via chat.delta) and have since been
  // "sealed" — i.e. a tool card, confirmation card, or error card ended that text
  // block — but whose persisted `assistant` message hasn't arrived yet.
  //
  // This exists because the engine streams narration as `chat.delta` and only
  // persists it as an `assistant` row LATER, when the following tool call resolves
  // (or when the turn ends). The persisted row then arrives as its own
  // `message.created` event. Meanwhile the extension's own ToolHost renders the
  // tool card as soon as the tool STARTS — which is before the engine has persisted
  // the preceding narration. So the ordering on the wire is:
  //
  //   chat.delta(narration) … → toolStart (seals the bubble) → toolEnd
  //     → message.created(assistant = that same narration)
  //
  // Nulling the live bubble on `toolStart` therefore used to leave the arriving
  // persisted narration with nothing to reconcile against, so it rendered a SECOND
  // copy of text the user could already see — every assistant message appeared
  // twice. Sealing instead of discarding lets that persisted row adopt the bubble
  // that's already on screen (claiming its uuid) while still starting a fresh bubble
  // for any text that comes after the card.
  const sealedBubbles = [];

  /**
   * End the current streamed text block so subsequent deltas start a fresh bubble,
   * keeping the rendered element around so its persisted `assistant` message can
   * adopt it instead of rendering a duplicate.
   */
  function sealLiveBubble() {
    if (liveBubble) {
      sealedBubbles.push(liveBubble);
      liveBubble = null;
    }
  }

  /**
   * Try to reconcile an arriving persisted assistant/agent message with a bubble
   * that is already on screen from live streaming. Returns true when the message was
   * adopted (and so must NOT be rendered again).
   *
   * Matching is by exact text against the live bubble first, then against the oldest
   * sealed bubble (the engine persists narration blocks in order). As a last resort
   * the oldest sealed bubble is adopted and its content refreshed from the persisted
   * row — the persisted text is authoritative, and adopting is always better than
   * showing the same reply twice.
   */
  function adoptStreamedBubble(content, uuid) {
    if (liveBubble && liveBubble.text === content) {
      if (uuid) rendered.add(uuid);
      rerenderBubble(liveBubble, content);
      liveBubble = null;
      return true;
    }
    const exactIdx = sealedBubbles.findIndex((b) => b.text === content);
    if (exactIdx !== -1) {
      const [bubble] = sealedBubbles.splice(exactIdx, 1);
      if (uuid) rendered.add(uuid);
      rerenderBubble(bubble, content);
      return true;
    }
    if (sealedBubbles.length > 0) {
      // Inexact (e.g. the engine trimmed/normalised the text it stored): adopt the
      // oldest sealed bubble and let the persisted content win.
      const bubble = sealedBubbles.shift();
      if (uuid) rendered.add(uuid);
      rerenderBubble(bubble, content);
      return true;
    }
    return false;
  }

  /**
   * Replace a bubble's rendered markdown with `content`, preserving any end-of-turn
   * footer already attached to it. `chat.done` and the persisted `assistant` row are
   * sent by different engine tasks, so the footer is often added BEFORE the row that
   * adopts the bubble arrives — a plain innerHTML overwrite would silently delete it.
   */
  function rerenderBubble(bubble, content) {
    const footer = bubble.el.querySelector(":scope > .turn-footer");
    bubble.el.innerHTML = renderMarkdown(content);
    // Keep the copy button's source text in step with what's now displayed.
    bubble.text = content;
    if (footer) {
      bubble.el.appendChild(footer);
    }
  }

  function post(msg) {
    vscode.postMessage(msg);
  }

  // ── Scroll-position-preserving auto-scroll ─────────────────────────────
  // New content (a streamed delta, a finished bubble, a tool card) should only pull
  // the view down to the newest message when the user was already at (or very near)
  // the bottom — mirrors how every chat UI (Kiro, Copilot, Slack, ...) behaves.
  // Appending while the user has scrolled up to review earlier messages must NOT
  // yank them back down to the bottom. The "was at bottom" check must happen BEFORE
  // the new content is appended (appending always grows scrollHeight, so checking
  // afterwards would almost always read as "not at bottom").
  const AUTO_SCROLL_THRESHOLD_PX = 48;

  function isScrolledToBottom() {
    return $messages.scrollHeight - $messages.scrollTop - $messages.clientHeight <= AUTO_SCROLL_THRESHOLD_PX;
  }

  /**
   * Run `mutate` (which appends/updates content in `$messages`), preserving the
   * user's scroll position unless they were already at the bottom, in which case the
   * view follows the new content down. Every append site in this file goes through
   * this helper instead of unconditionally setting `scrollTop`.
   */
  function withPreservedScroll(mutate) {
    const wasAtBottom = isScrolledToBottom();
    mutate();
    if (wasAtBottom) {
      $messages.scrollTop = $messages.scrollHeight;
    }
  }

  // ── Markdown rendering (agent bubbles) ─────────────────────────────────
  // A minimal, self-contained Markdown → HTML renderer. All text is HTML-escaped
  // before any markup is applied, so the model's raw output can never inject tags,
  // attributes, or scripts — only the whitelisted elements built below are emitted.
  // This keeps rendering safe under the webview's strict CSP without pulling in a
  // markdown dependency.

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Inline formatting: code spans, bold, italic, and safe (http/https/mailto) links.
  function renderInline(text) {
    let s = escapeHtml(text);

    // Pull out inline code spans first so their contents are immune to further
    // inline substitution (e.g. asterisks inside `*args`).
    const spans = [];
    s = s.replace(/`([^`]+)`/g, (_m, code) => {
      spans.push(code);
      return `\u0000${spans.length - 1}\u0000`;
    });

    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "<em>$1</em>");
    s = s.replace(/(?<![\w_])_([^_\n]+)_(?![\w_])/g, "<em>$1</em>");
    s = s.replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
      (_m, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`,
    );

    s = s.replace(/\u0000(\d+)\u0000/g, (_m, idx) => `<code class="md-code">${spans[Number(idx)]}</code>`);
    return s;
  }

  // ── Fenced code blocks: syntax highlighting + language title bar ──────
  // Friendly display names for common fence-info-string language tags (falls back to
  // capitalizing the raw tag, or "Plain Text" when the fence has none).
  const LANG_LABELS = {
    bash: "Bash",
    sh: "Shell",
    shell: "Shell",
    zsh: "Zsh",
    c: "C",
    cpp: "C++",
    "c++": "C++",
    csharp: "C#",
    cs: "C#",
    css: "CSS",
    diff: "Diff",
    dockerfile: "Dockerfile",
    docker: "Dockerfile",
    go: "Go",
    golang: "Go",
    html: "HTML",
    htm: "HTML",
    ini: "INI",
    java: "Java",
    javascript: "JavaScript",
    js: "JavaScript",
    jsx: "JavaScript",
    json: "JSON",
    kotlin: "Kotlin",
    lua: "Lua",
    markdown: "Markdown",
    md: "Markdown",
    php: "PHP",
    plaintext: "Plain Text",
    text: "Plain Text",
    txt: "Plain Text",
    powershell: "PowerShell",
    ps1: "PowerShell",
    pwsh: "PowerShell",
    python: "Python",
    py: "Python",
    r: "R",
    ruby: "Ruby",
    rb: "Ruby",
    rust: "Rust",
    scss: "SCSS",
    sql: "SQL",
    swift: "Swift",
    typescript: "TypeScript",
    ts: "TypeScript",
    tsx: "TypeScript",
    xml: "XML",
    svg: "XML",
    yaml: "YAML",
    yml: "YAML",
  };

  function languageLabel(lang) {
    if (!lang) return "Plain Text";
    const key = lang.toLowerCase();
    return LANG_LABELS[key] || lang.charAt(0).toUpperCase() + lang.slice(1);
  }

  // Highlight `code` with the vendored highlight.js bundle (media/highlight-bundle.js,
  // exposed as window.hljs — see build:media). Falls back to plain escaped text if the
  // bundle hasn't loaded, the requested language isn't registered, or highlighting
  // throws for any reason; never blocks rendering the message.
  function highlightCode(code, lang) {
    const hljs = window.hljs;
    if (!hljs) {
      return { html: escapeHtml(code), lang: lang || "" };
    }
    try {
      if (lang && hljs.getLanguage(lang.toLowerCase())) {
        const result = hljs.highlight(code, { language: lang.toLowerCase(), ignoreIllegals: true });
        return { html: result.value, lang };
      }
      if (!lang) {
        // No fence language given: try auto-detection over the registered language
        // set so the title bar can still show a specific name (e.g. "Python").
        const result = hljs.highlightAuto(code);
        if (result && result.language) {
          return { html: result.value, lang: result.language };
        }
      }
    } catch (e) {
      // Fall through to plain escaped text below.
    }
    return { html: escapeHtml(code), lang: lang || "" };
  }

  // Split highlight.js's output HTML into one HTML fragment per source line, closing
  // every currently-open <span> at each line break and reopening it on the next line
  // so each line is independently well-formed (a naive split on "\n" would leave tags
  // unbalanced whenever a scope, e.g. a block comment or multi-line string, spans more
  // than one line). This is what lets each line get its own table row/line number
  // without breaking token colors that cross line boundaries.
  function splitHighlightedIntoLines(html) {
    const openTags = [];
    const lines = [];
    let current = "";
    let i = 0;
    while (i < html.length) {
      const ch = html[i];
      if (ch === "<") {
        const close = html.indexOf(">", i);
        if (close === -1) {
          current += html.slice(i);
          break;
        }
        const tag = html.slice(i, close + 1);
        if (tag.startsWith("</")) {
          openTags.pop();
        } else {
          openTags.push(tag);
        }
        current += tag;
        i = close + 1;
        continue;
      }
      if (ch === "\n") {
        current += "</span>".repeat(openTags.length);
        lines.push(current);
        current = openTags.join("");
        i++;
        continue;
      }
      current += ch;
      i++;
    }
    lines.push(current);
    return lines;
  }

  function renderCodeBlock(code, lang) {
    const { html, lang: resolvedLang } = highlightCode(code, lang);
    const label = escapeHtml(languageLabel(resolvedLang));
    const lines = splitHighlightedIntoLines(html);
    const rows = lines
      .map(
        (lineHtml, idx) =>
          `<tr class="md-code-row">` +
          `<td class="md-line-no">${idx + 1}</td>` +
          `<td class="md-line-code"><code class="hljs">${lineHtml}</code></td>` +
          `</tr>`,
      )
      .join("");
    return (
      `<div class="md-codeblock">` +
      `<div class="md-codeblock-title">${label}</div>` +
      `<div class="md-code-block"><table class="md-code-table"><tbody>${rows}</tbody></table></div>` +
      `</div>`
    );
  }

  // Block-level parsing: fenced code, headers, rules, blockquotes, lists, paragraphs.
  function renderMarkdown(src) {
    const lines = String(src == null ? "" : src).replace(/\r\n/g, "\n").split("\n");
    const blank = (l) => /^\s*$/.test(l);
    // Fences may be indented (e.g. when the model nests a code block inside a
    // list item); detection, opening, and closing must all tolerate leading
    // whitespace, otherwise an indented fence falls through to paragraph
    // handling and the literal ```lang / ``` markers are shown as text.
    const isFence = (l) => /^\s*```/.test(l);
    const isHeader = (l) => /^#{1,6}\s+/.test(l);
    const isRule = (l) => /^(-{3,}|\*{3,}|_{3,})\s*$/.test(l);
    const isQuote = (l) => /^>\s?/.test(l);
    const isUList = (l) => /^[-*+]\s+/.test(l);
    const isOList = (l) => /^\d+[.)]\s+/.test(l);

    let html = "";
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      const fence = /^(\s*)```(\w*)\s*$/.exec(line);
      if (fence) {
        const indent = fence[1].length;
        const lang = fence[2];
        const code = [];
        i++;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
          // Strip the fence's own indentation from each code line so an
          // indented (e.g. list-nested) block isn't rendered with spurious
          // leading spaces, while deeper indentation inside the block is kept.
          code.push(indent > 0 ? lines[i].replace(new RegExp(`^\\s{0,${indent}}`), "") : lines[i]);
          i++;
        }
        i++; // closing fence
        html += renderCodeBlock(code.join("\n"), lang);
        continue;
      }

      if (blank(line)) {
        i++;
        continue;
      }

      const header = /^(#{1,6})\s+(.*)$/.exec(line);
      if (header) {
        const level = header[1].length;
        html += `<h${level} class="md-h">${renderInline(header[2])}</h${level}>`;
        i++;
        continue;
      }

      if (isRule(line)) {
        html += `<hr class="md-hr" />`;
        i++;
        continue;
      }

      if (isQuote(line)) {
        const quoted = [];
        while (i < lines.length && isQuote(lines[i])) {
          quoted.push(lines[i].replace(/^>\s?/, ""));
          i++;
        }
        html += `<blockquote class="md-quote">${renderMarkdown(quoted.join("\n"))}</blockquote>`;
        continue;
      }

      if (isUList(line)) {
        const items = [];
        while (i < lines.length && isUList(lines[i])) {
          items.push(lines[i].replace(/^[-*+]\s+/, ""));
          i++;
        }
        html += `<ul class="md-list">${items.map((it) => `<li>${renderInline(it)}</li>`).join("")}</ul>`;
        continue;
      }

      if (isOList(line)) {
        const items = [];
        while (i < lines.length && isOList(lines[i])) {
          items.push(lines[i].replace(/^\d+[.)]\s+/, ""));
          i++;
        }
        html += `<ol class="md-list">${items.map((it) => `<li>${renderInline(it)}</li>`).join("")}</ol>`;
        continue;
      }

      const para = [];
      while (
        i < lines.length &&
        !blank(lines[i]) &&
        !isFence(lines[i]) &&
        !isHeader(lines[i]) &&
        !isRule(lines[i]) &&
        !isQuote(lines[i]) &&
        !isUList(lines[i]) &&
        !isOList(lines[i])
      ) {
        para.push(lines[i]);
        i++;
      }
      html += `<p class="md-p">${para.map(renderInline).join("<br>")}</p>`;
    }
    return html;
  }

  // Pretty-print a string if (and only if) it parses as JSON; used for tool card
  // input/output text that arrives as a compact JSON string rather than an object.
  function prettyIfJson(text) {
    if (typeof text !== "string") return text;
    const trimmed = text.trim();
    if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) return text;
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch (e) {
      return text;
    }
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

  function openMenu(trigger, items, currentId, onSelect) {
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

  // ── "#" context-mention popup ──────────────────────────────────────────
  // Typing "#" in the composer opens a popup (Kiro/Antigravity-style) offering
  // Files, Folders, Terminal, Problems, Git Diff, and Open Editors. Continuing to
  // type searches straight away (default category: Files) while STILL offering the
  // matching categories to select, so a filename can be looked up without picking a
  // category first; "#category:query" scopes the search to that one category, and a
  // fixed category (Problems/Git Diff/Open Editors) resolves immediately.
  //
  // A resolved mention is inserted INLINE into the composer text (e.g.
  // "check #main.ts for bugs") and highlighted via the mirrored backdrop layer (see
  // syncMentionHighlights). Its resolved context travels to the engine in the
  // `chat.send` frame's own `context_blocks` field — never inlined into the message —
  // so the transcript shows the user's words, not the attached file contents.

  const CAT_ICONS = {
    file: '<path fill="currentColor" d="M4 1.5h5.4L12.5 4.6V13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2.5a1 1 0 0 1 1-1Zm5 .9V4.5h2.1L9 2.4Z"/>',
    folder: FOLDER_ICON,
    terminal:
      '<path fill="currentColor" d="M1.5 3A1 1 0 0 1 2.5 2h11a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V3Zm2 2.1 2.6 2.4-2.6 2.4.7.75 3.4-3.15L4.2 4.35l-.7.75Zm4.3 5.9h4v-.9h-4v.9Z"/>',
    symbol:
      '<path fill="currentColor" d="M5.7 2.1a.6.6 0 0 1 .77.35l3.9 10.4a.6.6 0 0 1-.35.77l-.94.35a.6.6 0 0 1-.77-.35l-3.9-10.4a.6.6 0 0 1 .35-.77l.94-.35Zm-3.4 3.1 2.1 2-2.1 2 .78.78L5.7 7.2 3.08 4.42l-.78.78Zm9.4 0 2.1 2-2.1 2 .78.78L14.1 7.2l-2.62-2.78-.78.78Z"/>',
    problems:
      '<path fill="currentColor" d="M8 1.5 14.5 13H1.5L8 1.5Zm0 3.9-4 6.9h8l-4-6.9ZM7.5 9h1v1.1h-1V9Zm0-3.2h1V8.2h-1V5.8Z"/>',
    gitDiff:
      '<path fill="currentColor" d="M4 2.2a1.8 1.8 0 1 1 0 3.6.6.6 0 0 0-.6.6v3.2a.6.6 0 0 0 .6.6 1.8 1.8 0 1 1 0 3.6 1.8 1.8 0 0 1-.9-3.36V5.96A1.8 1.8 0 0 1 4 2.2Zm8 5.5a1.8 1.8 0 1 1-1.8 1.8c0-.2.03-.4.09-.58L8.7 7.4a.6.6 0 0 1 .58-1h1.94A1.8 1.8 0 0 1 12 7.7Z"/>',
    openEditors:
      '<path fill="currentColor" d="M2.5 3h8A1 1 0 0 1 11.5 4v6a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Zm2 6.5h6A1 1 0 0 0 11.5 12v0h-8v0a1 1 0 0 0 1 1.5Z"/>',
  };

  /**
   * The category searched when the user just types "#something" without naming a
   * category. Files are overwhelmingly the common case, so typing a filename starts
   * finding it immediately rather than requiring "#file:" first.
   */
  const DEFAULT_MENTION_SEARCH_CATEGORY = "file";

  const mention = {
    categories: null, // cached list from the extension, fetched once
    open: false,
    // "category" — bare "#", choose a category
    // "mixed"    — "#text", live search results + matching categories
    // "items"    — "#category:query", results for that category
    mode: "category",
    anchorStart: -1, // index of the "#" that opened the current popup
    category: undefined,
    query: "",
    items: [],
    rows: [], // the rows currently rendered (drives keyboard navigation)
    selected: 0,
    searchSeq: 0,
    latestSearchSeq: -1,
    searchTimer: null,
  };

  /** Build the inline text inserted into the composer for a resolved mention. */
  function mentionInlineToken(label) {
    return `#${label}`;
  }

  // ── Composer mention highlighting ──────────────────────────────────────
  // A <textarea> can't style ranges of its own text, so the inline "#mentions" are
  // highlighted by mirroring the composer's content into a backdrop div positioned
  // exactly behind it (identical font/padding/wrapping via CSS), with the mention
  // spans wrapped in a highlight element. The textarea keeps its own transparent
  // background so the backdrop shows through, and its caret/selection/editing
  // behaviour is completely untouched.

  /**
   * Longest-first so a longer mention (e.g. "#src/main.ts") is matched before a
   * shorter one that prefixes it (e.g. "#src"), avoiding a partial highlight.
   */
  function knownMentionTokens() {
    return [...mentionContextByToken.keys()].sort((a, b) => b.length - a.length);
  }

  /** Rebuild the highlight backdrop to match the composer's current text. */
  function syncMentionHighlights() {
    if (!$inputHighlights) return;
    const value = $input.value;
    const tokens = knownMentionTokens();

    let html = "";
    let i = 0;
    outer: while (i < value.length) {
      if (value[i] === "#") {
        for (const token of tokens) {
          if (value.startsWith(token, i)) {
            html += `<mark class="mention-hl">${escapeHtml(token)}</mark>`;
            i += token.length;
            continue outer;
          }
        }
      }
      html += escapeHtml(value[i]);
      i += 1;
    }
    // A trailing newline needs a trailing space to keep the mirrored block's height
    // in step with the textarea's.
    $inputHighlights.innerHTML = `${html}&nbsp;`;
    $inputHighlights.scrollTop = $input.scrollTop;
  }

  function closeMentionMenu() {
    mention.open = false;
    mention.mode = "category";
    mention.anchorStart = -1;
    mention.items = [];
    mention.rows = [];
    mention.selected = 0;
    if (mention.searchTimer) {
      clearTimeout(mention.searchTimer);
      mention.searchTimer = null;
    }
    $mentionMenu.hidden = true;
    $mentionMenu.innerHTML = "";
  }

  function positionMentionMenu() {
    $mentionMenu.hidden = false;
    const rect = $input.getBoundingClientRect();
    const menuRect = $mentionMenu.getBoundingClientRect();
    let left = rect.left;
    const maxLeft = window.innerWidth - menuRect.width - 6;
    if (left > maxLeft) left = Math.max(6, maxLeft);
    $mentionMenu.style.left = `${left}px`;
    $mentionMenu.style.top = `${rect.top - menuRect.height - 6}px`;
  }

  function renderMentionRows(rows) {
    // The rendered rows are the single source of truth for keyboard navigation, so
    // Arrow/Enter behave identically in every mode (categories, live search results,
    // or the two mixed together).
    mention.rows = rows;
    mention.selected = Math.min(mention.selected, Math.max(rows.length - 1, 0));
    $mentionMenu.innerHTML = "";
    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "menu-empty";
      empty.textContent = mention.mode === "category" ? "No categories" : "No matches";
      $mentionMenu.appendChild(empty);
    }
    rows.forEach((row, idx) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className =
        "menu-item mention-item" +
        (idx === mention.selected ? " selected" : "") +
        (row.isCategory ? " mention-item-category" : "");
      const icon = CAT_ICONS[row.iconKey] || CAT_ICONS.file;
      const text = document.createElement("span");
      text.className = "menu-item-text";
      text.textContent = row.label;
      el.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">${icon}</svg>`;
      el.appendChild(text);
      if (row.description) {
        const desc = document.createElement("span");
        desc.className = "mention-item-desc";
        desc.textContent = row.description;
        el.appendChild(desc);
      }
      el.addEventListener("mousedown", (e) => {
        e.preventDefault(); // keep focus in the textarea
        row.onPick();
      });
      $mentionMenu.appendChild(el);
    });
    positionMentionMenu();
  }

  /** Rows for the categories whose label matches `filterText`. */
  function categoryRows(filterText) {
    const needle = (filterText || "").toLowerCase();
    return (mention.categories || [])
      .filter((c) => c.label.toLowerCase().includes(needle))
      .map((c) => ({
        iconKey: c.id,
        label: c.label,
        isCategory: true,
        onPick: () => pickCategory(c),
      }));
  }

  /** Rows for the current live search results. */
  function itemRows() {
    return mention.items.map((item) => ({
      iconKey: item.category,
      label: item.label,
      description: item.description,
      onPick: () => pickItem(item),
    }));
  }

  /** Bare "#": the category chooser. */
  function renderCategoryList(filterText) {
    mention.mode = "category";
    renderMentionRows(categoryRows(filterText));
  }

  /**
   * "#<text>" with no explicit category: keep offering the matching categories to
   * pick from AND search straight away, so typing narrows to real results instead of
   * dead-ending on "No categories". Search hits come first (they're what the user is
   * usually after once they start typing a name), with any category matches beneath.
   */
  function renderMixedList(filterText) {
    mention.mode = "mixed";
    renderMentionRows([...itemRows(), ...categoryRows(filterText)]);
  }

  /** "#category:query": results for that category only. */
  function renderItemsList() {
    mention.mode = "items";
    renderMentionRows(itemRows());
  }

  /** Re-render whichever list is currently showing (e.g. when results arrive). */
  function renderCurrentMentionList() {
    if (mention.mode === "items") {
      renderItemsList();
    } else if (mention.mode === "mixed") {
      renderMixedList(currentCategoryFilter());
    } else {
      renderCategoryList(currentCategoryFilter());
    }
  }

  function requestMentionCategoriesIfNeeded() {
    if (mention.categories === null) {
      post({ type: "mentionCategories" });
    }
  }

  function requestMentionSearch(category, query) {
    mention.searchSeq += 1;
    const requestId = mention.searchSeq;
    mention.latestSearchSeq = requestId;
    post({ type: "mentionSearch", requestId, category, query });
  }

  function debouncedSearch(category, query) {
    if (mention.searchTimer) clearTimeout(mention.searchTimer);
    mention.searchTimer = setTimeout(() => requestMentionSearch(category, query), 120);
  }

  // Replace the "#..." token currently under the caret (from mention.anchorStart to
  // the caret) with `replacement`, and move the caret to just after it.
  function replaceMentionToken(replacement) {
    const value = $input.value;
    const caret = $input.selectionStart;
    const before = value.slice(0, mention.anchorStart);
    const after = value.slice(caret);
    $input.value = before + replacement + after;
    const newCaret = before.length + replacement.length;
    $input.setSelectionRange(newCaret, newCaret);
    autoGrow();
    updateSendState();
    syncMentionHighlights();
  }

  function pickCategory(cat) {
    if (!cat.searchable) {
      // Fixed categories (Problems/Git Diff/Open Editors) resolve immediately and
      // are inserted inline as "#Problems", "#Git Diff", etc. — read like part of
      // the sentence rather than sitting in a chip row above the composer.
      insertMentionInline(cat.label, { category: cat.id, id: cat.id, label: cat.label });
      closeMentionMenu();
      return;
    }
    mention.category = cat.id;
    mention.query = "";
    mention.selected = 0;
    // Drop any results from the previous (default-category) search so the list isn't
    // briefly showing file hits under a freshly-chosen Folders/Terminal category.
    mention.items = [];
    replaceMentionToken(`#${cat.id}:`);
    mention.anchorStart = $input.value.lastIndexOf(`#${cat.id}:`);
    renderItemsList();
    requestMentionSearch(cat.id, "");
  }

  function pickItem(item) {
    insertMentionInline(item.label, item);
    closeMentionMenu();
  }

  /**
   * Insert the mention's inline text at the current token position (replacing the
   * "#category:query" being typed) immediately — the user sees "#main.ts " land in
   * their sentence right away — then resolve its full context content in the
   * background. The resolved context is looked up by the exact inline text at send
   * time, so the composer's text is the single source of truth for what gets sent;
   * no separate chip list needs to stay in sync with edits to the text.
   */
  function insertMentionInline(label, item) {
    const token = mentionInlineToken(label);
    // Register the token before inserting so the highlight backdrop can style it
    // immediately, rather than only once the context round trip resolves.
    if (!mentionContextByToken.has(token)) {
      mentionContextByToken.set(token, "");
    }
    replaceMentionToken(`${token} `);
    mention.searchSeq += 1;
    const requestId = mention.searchSeq;
    pendingMentionTokens.set(requestId, token);
    post({ type: "mentionResolve", requestId, item });
  }

  // Find the "#token" (no whitespace) ending at the caret, if any. Returns
  // { start, text } or null when the caret isn't inside a mention token.
  function findMentionToken() {
    const value = $input.value;
    const caret = $input.selectionStart;
    let i = caret - 1;
    while (i >= 0 && !/\s/.test(value[i]) && value[i] !== "#") i--;
    if (i < 0 || value[i] !== "#") return null;
    return { start: i, text: value.slice(i + 1, caret) };
  }

  function onComposerInput() {
    const token = findMentionToken();
    if (!token) {
      if (mention.open) closeMentionMenu();
      return;
    }
    const reopened = !mention.open || mention.anchorStart !== token.start;
    mention.open = true;
    mention.anchorStart = token.start;
    if (reopened) {
      // A fresh mention token: don't carry the previous popup's highlighted row or
      // stale results over into it.
      mention.selected = 0;
      mention.items = [];
    }

    const colonIdx = token.text.indexOf(":");
    if (colonIdx === -1) {
      requestMentionCategoriesIfNeeded();
      if (token.text.length === 0) {
        // Bare "#": offer the categories.
        mention.items = [];
        renderCategoryList("");
        return;
      }
      // "#something": search as the user types (in addition to still offering the
      // matching categories to select), so they never have to pick a category first
      // just to look a file up by name.
      mention.category = DEFAULT_MENTION_SEARCH_CATEGORY;
      mention.query = token.text;
      renderMixedList(token.text);
      debouncedSearch(DEFAULT_MENTION_SEARCH_CATEGORY, token.text);
      return;
    }

    const catPart = token.text.slice(0, colonIdx);
    const queryPart = token.text.slice(colonIdx + 1);
    const known = (mention.categories || []).find((c) => c.id === catPart);
    if (!known || !known.searchable) {
      // Not (yet) a recognized searchable category prefix — show category matches.
      requestMentionCategoriesIfNeeded();
      renderCategoryList(catPart);
      return;
    }
    mention.category = catPart;
    mention.query = queryPart;
    if (mention.mode !== "items") renderItemsList();
    debouncedSearch(catPart, queryPart);
  }

  function onComposerKeydown(e) {
    if (!mention.open) return false;
    const rows = mention.rows || [];
    if (e.key === "ArrowDown") {
      e.preventDefault();
      mention.selected = Math.min(mention.selected + 1, Math.max(rows.length - 1, 0));
      renderCurrentMentionList();
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      mention.selected = Math.max(mention.selected - 1, 0);
      renderCurrentMentionList();
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      if (rows.length === 0) {
        closeMentionMenu();
        return false;
      }
      e.preventDefault();
      const row = rows[mention.selected];
      if (row) row.onPick();
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeMentionMenu();
      return true;
    }
    return false;
  }

  function currentCategoryFilter() {
    const token = findMentionToken();
    return token ? token.text : "";
  }

  // The model's display name (not its provider).
  function modelName(m) {
    if (!m) return "Model";
    // The engine's model catalog sends `name` (the model's own name). Never fall
    // back to `provider` on its own: that is what showed "openai" instead of the
    // model. Older engines send alias/model, which are still understood.
    const name = String(m.name || "").trim();
    if (name) return name;
    if (m.alias && String(m.alias).trim()) return String(m.alias).trim();
    const model = String(m.model || "").trim();
    if (model) return model;
    return String(m.id || "Model");
  }

  function refreshTriggers() {
    const ws = state.workspaces.find((w) => w.uuid === state.currentWorkspace);
    $wsLabel.textContent = ws ? truncate(ws.name, 20) : "Workspace";
    const th = state.threads.find((t) => t.uuid === state.currentThread);
    $thLabel.textContent = th ? truncate(th.title || "Untitled", 24) : "Thread";
    const md = state.models.find((m) => m.id === state.currentModel);
    const name = md ? modelName(md) : undefined;
    // The selected model's name is the picker label and its tooltip; falls back to a
    // placeholder only when no model is selected yet.
    $modelLabel.textContent = name ? truncate(name, 22) : "Model";
    $modelTrigger.title = name ? `Model: ${name}` : "Select a model";
  }

  function modelMenuItems() {
    return state.models.map((m) => ({ id: m.id, label: modelName(m) }));
  }

  function onModelPick(item) {
    state.currentModel = item.id;
    persistUiState();
    refreshTriggers();
  }

  $modelTrigger.addEventListener("click", () => {
    const willOpen = openTrigger !== $modelTrigger;
    openMenu($modelTrigger, modelMenuItems(), state.currentModel, onModelPick);
    // Fetch the latest model list each time the picker opens so models added on
    // the engine appear without reconnecting.
    if (willOpen) post({ type: "refreshModels" });
  });

  // ── Workspace / thread tabs ───────────────────────────────────────────
  // The selectors are toggle tabs: clicking shows the workspace/thread list in place
  // of the chat; clicking the active one returns to the current thread.
  function setActiveTab() {
    $wsTrigger.classList.toggle("active", state.view === "workspaces");
    $thTrigger.classList.toggle("active", state.view === "threads");
    $wsTrigger.setAttribute("aria-pressed", String(state.view === "workspaces"));
    $thTrigger.setAttribute("aria-pressed", String(state.view === "threads"));
  }

  function setView(view) {
    state.view = view;
    $messages.hidden = view !== "chat";
    $list.hidden = view === "chat";
    setActiveTab();
    if (view === "workspaces") renderWorkspaceList();
    else if (view === "threads") renderThreadList();
  }

  function makeListRow(iconPath, label, selected) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "list-row" + (selected ? " selected" : "");
    row.innerHTML =
      `<svg class="ico" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">${iconPath}</svg>` +
      `<span class="list-row-text"></span>`;
    row.querySelector(".list-row-text").textContent = label;
    return row;
  }

  function renderList(title, items, emptyText, iconPath, isSelected, onPick) {
    $list.innerHTML = "";
    const heading = document.createElement("div");
    heading.className = "list-section-title";
    heading.textContent = title;
    $list.appendChild(heading);
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "list-empty";
      empty.textContent = emptyText;
      $list.appendChild(empty);
      return;
    }
    items.forEach((item) => {
      const row = makeListRow(iconPath, item.label, isSelected(item));
      row.addEventListener("click", () => onPick(item));
      $list.appendChild(row);
    });
    $list.scrollTop = 0;
  }

  function renderWorkspaceList() {
    renderList(
      "Workspaces",
      state.workspaces.map((w) => ({ id: w.uuid, label: w.name || "Untitled" })),
      "No workspaces yet.",
      FOLDER_ICON,
      (item) => item.id === state.currentWorkspace,
      (item) => selectWorkspaceFromList(item.id),
    );
  }

  function renderThreadList() {
    renderList(
      "Threads",
      state.threads.map((t) => ({ id: t.uuid, label: t.title || "Untitled" })),
      "No threads in this workspace yet.",
      CHAT_ICON,
      (item) => item.id === state.currentThread,
      (item) => openThread(item.id),
    );
  }

  // Selecting a workspace loads its threads, then jumps to the thread list with the
  // most recent thread selected (handled when the "threads" message arrives).
  function selectWorkspaceFromList(uuid) {
    navToThreadListOnLoad = true;
    state.currentWorkspace = uuid;
    post({ type: "selectWorkspace", uuid });
    refreshTriggers();
  }

  // Opening a thread loads its messages and returns to the chat view.
  function openThread(uuid) {
    state.currentThread = uuid;
    post({ type: "selectThread", uuid });
    setView("chat");
    refreshTriggers();
  }

  $wsTrigger.addEventListener("click", () => {
    setView(state.view === "workspaces" ? "chat" : "workspaces");
  });

  $thTrigger.addEventListener("click", () => {
    setView(state.view === "threads" ? "chat" : "threads");
  });

  $newThread.addEventListener("click", () => post({ type: "newThread" }));

  // ── Messages ──────────────────────────────────────────────────────────
  function clearMessages() {
    $messages.innerHTML = "";
    rendered.clear();
    liveBubble = null;
    sealedBubbles.length = 0;
    toolTiles.clear();
    finishedLiveToolCallsByName.clear();
    fileChangeCards.clear();
  }

  function addBubble(role, content, uuid) {
    if (uuid && rendered.has(uuid)) {
      return null;
    }
    // Skip persisted/created messages with no visible content — the engine emits
    // intermediate empty agent rows between tool steps, which would otherwise render
    // as thin empty bubbles. The streaming placeholder (uuid === null) is unaffected.
    if (uuid && (!content || !String(content).trim())) {
      rendered.add(uuid);
      return null;
    }
    const el = document.createElement("div");
    el.className = `bubble ${role === "user" ? "user" : "agent"}`;
    if (role === "user") {
      el.textContent = content;
    } else {
      // Agent output is native LLM markdown; render it (escaped + whitelisted markup,
      // see renderMarkdown) rather than showing raw asterisks/backticks/etc.
      el.innerHTML = renderMarkdown(content);
    }
    withPreservedScroll(() => $messages.appendChild(el));
    if (uuid) {
      rendered.add(uuid);
    }
    return el;
  }

  // ── Tool-call cards (Copilot-style expandable tiles) ──────────────────
  const toolTiles = new Map(); // callId -> { tile, statusEl, resultSection, resultPre }

  // De-duplication for a known server-side issue: a tool call executed through the
  // extension's own ToolHost is rendered live as a "running"→"completed" card via
  // toolStart/toolEnd (keyed by the ToolDispatcher's correlation id). The SAME call
  // is separately persisted by the engine as a `role="tool"` message once its
  // pydantic-ai FunctionToolResultEvent fires, and arrives moments later as its own
  // `message.created` event — with an UNRELATED tool_call_id, so nothing correlates
  // the two automatically. Without this queue, that persisted-message event would
  // render a second, independent card for the exact same call (this is purely a UI
  // artifact: the database only ever holds the one persisted row).
  //
  // Fix: track just-finished live tiles in completion order, per tool name. When the
  // persisted tool-message event for that same tool name arrives shortly after, it is
  // matched to the already-rendered live card (which already shows the same input/
  // result) instead of appending a duplicate. toolEnd always reaches the webview
  // before the corresponding persisted message.created (the extension emits toolEnd
  // synchronously before replying tool.result, which is what unblocks the engine's
  // FunctionToolResultEvent that leads to the persisted row), so FIFO-per-tool-name
  // matching is reliable. After a thread reload (no live tiles), this queue is empty
  // and persisted tool rows render normally — exactly once.
  //
  // We now match by both tool name AND the callId from the persisted message to handle
  // multiple calls of the same tool type in one turn correctly.
  const finishedLiveToolCallsByName = new Map(); // tool name -> array of { callId }

  // Cards showing Show/Undo controls, keyed by change id, so the extension's reply to
  // an undo request can update the button and mark the card reverted.
  const fileChangeCards = new Map();

  function claimFinishedLiveToolCall(toolName, callId) {
    const queue = finishedLiveToolCallsByName.get(toolName);
    if (!queue || queue.length === 0) return null;
    
    // Find and remove the entry with matching callId
    const idx = queue.findIndex(entry => entry.callId === callId);
    if (idx === -1) {
      // No exact match, fall back to FIFO behavior
      return queue.shift();
    }
    // Remove the matched entry and return it
    const [entry] = queue.splice(idx, 1);
    // Clean up empty queue
    if (queue.length === 0) {
      finishedLiveToolCallsByName.delete(toolName);
    } else {
      finishedLiveToolCallsByName.set(toolName, queue);
    }
    return entry;
  }

  const TOOL_ICON =
    '<path fill="currentColor" d="M11.5 1.5a3.5 3.5 0 0 0-3.4 4.35L1.9 12a1.4 1.4 0 0 0 0 2l.1.1a1.4 1.4 0 0 0 2 0l6.15-6.2A3.5 3.5 0 0 0 14.5 4.5l-2 2-1.4-.35-.35-1.4 2-2a3.5 3.5 0 0 0-1.25-1.25Z"/>';
  const CHEVRON_ICON =
    '<path fill="currentColor" d="M3.2 5.5a.5.5 0 0 1 .707 0L8 9.593l4.093-4.093a.5.5 0 1 1 .707.707l-4.446 4.446a.5.5 0 0 1-.708 0L3.2 6.207a.5.5 0 0 1 0-.707Z"/>';

  function prettyToolName(id) {
    return String(id || "tool")
      .replace(/^mcp\./, "")
      .replace(/[_.]/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function makeToolSection(label, text) {
    const section = document.createElement("div");
    section.className = "tool-tile-section";
    const labelEl = document.createElement("div");
    labelEl.className = "tool-tile-label";
    labelEl.textContent = label;
    const pre = document.createElement("pre");
    pre.className = "tool-tile-pre";
    pre.textContent = text;
    section.appendChild(labelEl);
    section.appendChild(pre);
    return { section, pre };
  }

  // Build a collapsed tool card (shared by live tool calls and persisted tool rows).
  //
  // The header is a row rather than a single button so file-mutating tools can carry
  // their own Show / Undo controls without those clicks toggling the card open.
  function buildToolCard(toolName) {
    const tile = document.createElement("div");
    tile.className = "tool-tile";

    const header = document.createElement("div");
    header.className = "tool-tile-header";

    const toggle = document.createElement("button");
    toggle.className = "tool-tile-toggle";
    toggle.type = "button";
    toggle.innerHTML =
      `<svg class="tool-tile-ico" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">${TOOL_ICON}</svg>` +
      `<span class="tool-tile-name"></span>` +
      `<span class="tool-tile-status"></span>` +
      `<svg class="chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">${CHEVRON_ICON}</svg>`;
    toggle.querySelector(".tool-tile-name").textContent = prettyToolName(toolName);

    const actions = document.createElement("div");
    actions.className = "tool-tile-actions";

    header.appendChild(toggle);
    header.appendChild(actions);

    const body = document.createElement("div");
    body.className = "tool-tile-body";
    body.hidden = true;

    const input = makeToolSection("Input", "");
    const result = makeToolSection("Result", "");
    result.section.hidden = true;
    body.appendChild(input.section);
    body.appendChild(result.section);

    toggle.addEventListener("click", () => {
      body.hidden = !body.hidden;
      tile.classList.toggle("open", !body.hidden);
    });

    tile.appendChild(header);
    tile.appendChild(body);

    return {
      tile,
      actions,
      statusEl: toggle.querySelector(".tool-tile-status"),
      inputPre: input.pre,
      resultSection: result.section,
      resultPre: result.pre,
    };
  }

  /**
   * Add the "Show" and "Undo" controls to a create_file/edit_file card.
   *
   * Both are handled entirely by the extension — Show opens a diff (or the created
   * file) in the editor, Undo restores the file from the change journal. Neither sends
   * anything to the engine, so reverting the agent's edit costs no tokens and doesn't
   * add anything to the conversation.
   */
  function addFileChangeActions(card, change) {
    if (!card.actions || !change || !change.id) return;
    card.actions.innerHTML = "";

    const show = document.createElement("button");
    show.type = "button";
    show.className = "tool-tile-action";
    show.textContent = change.created ? "Show file" : "Show diff";
    show.title = change.path || "";
    show.addEventListener("click", (e) => {
      e.stopPropagation();
      post({ type: "showFileChange", changeId: change.id });
    });

    const undo = document.createElement("button");
    undo.type = "button";
    undo.className = "tool-tile-action";
    undo.textContent = "Undo";
    undo.title = change.created
      ? `Delete ${change.path} again`
      : `Restore ${change.path} to its previous contents`;
    undo.addEventListener("click", (e) => {
      e.stopPropagation();
      undo.disabled = true;
      undo.textContent = "Undoing…";
      post({ type: "undoFileChange", changeId: change.id });
    });

    card.actions.appendChild(show);
    card.actions.appendChild(undo);
    // Remembered so the reply to `undoFileChange` can update the right card.
    fileChangeCards.set(change.id, { card, undo });
  }

  // Track which live tool calls we've seen (for de-duplication with persisted tool messages)
  // Keyed by tool name to handle multiple calls of the same type in one turn
  const finishedLiveToolCalls = new Map(); // callId -> toolName

  function appendTile(card) {
    withPreservedScroll(() => $messages.appendChild(card.tile));
  }

  function toDisplayText(value) {
    if (value === null || value === undefined) return "(none)";
    if (typeof value === "string") return prettyIfJson(value);
    try {
      return JSON.stringify(value, null, 2);
    } catch (e) {
      return String(value);
    }
  }

  // A live tool call (from the ToolHost via toolStart/toolEnd).
  function createToolTile(callId, tool, inputText) {
    // Starting a tool ends the current streaming bubble so following text lands in a
    // fresh bubble beneath the card (mirrors Copilot's interleaving). The bubble is
    // SEALED rather than discarded so the narration's persisted `assistant` message
    // (which the engine only writes once this tool resolves) adopts it instead of
    // rendering a second copy.
    sealLiveBubble();
    const card = buildToolCard(tool);
    card.tile.classList.add("running");
    card.statusEl.textContent = "Running…";
    card.inputPre.textContent = inputText ? prettyIfJson(inputText) : "(no input)";
    appendTile(card);
    toolTiles.set(callId, card);
    return card;
  }

  function endToolTile(msg) {
    let card = toolTiles.get(msg.callId);
    if (!card) {
      card = buildToolCard(msg.tool);
      appendTile(card);
      toolTiles.set(msg.callId, card);
    }
    card.tile.classList.remove("running");
    card.tile.classList.add(msg.ok ? "success" : "error");
    card.statusEl.textContent = msg.ok
      ? "Completed"
      : msg.errorKind
        ? `Failed · ${msg.errorKind}`
        : "Failed";
    card.resultPre.textContent = prettyIfJson(msg.detail || msg.summary || "(no output)");
    card.resultSection.hidden = false;

    // A successful create_file/edit_file carries the change it made — offer Show/Undo.
    if (msg.change) {
      addFileChangeActions(card, msg.change);
    }

    // Record this finished live card so the persisted `role="tool"` message for the
    // same call (arriving moments later, with an unrelated tool_call_id) is matched
    // to it instead of rendering a duplicate card — see the queue's comment above.
    const queue = finishedLiveToolCallsByName.get(msg.tool) || [];
    queue.push({ callId: msg.callId });
    finishedLiveToolCallsByName.set(msg.tool, queue);
  }

  // Parse a tool row's content into its { tool_name, input, output, outcome }
  // document. Returns null unless it is the structured tool JSON the engine writes,
  // so ordinary JSON messages aren't misclassified as tool calls.
  function parseToolDoc(content) {
    if (typeof content !== "string") return null;
    const trimmed = content.trim();
    if (!trimmed.startsWith("{")) return null;
    let doc;
    try {
      doc = JSON.parse(trimmed);
    } catch (e) {
      return null;
    }
    if (
      doc &&
      typeof doc === "object" &&
      !Array.isArray(doc) &&
      typeof doc.tool_name === "string" &&
      ("output" in doc || "input" in doc || "tool_call_id" in doc || "outcome" in doc)
    ) {
      return doc;
    }
    return null;
  }

  // A tool interaction row, whose content is the JSON
  // { tool_name, tool_call_id, outcome, input, output } written by the engine.
  function renderToolMessage(content, uuid) {
    if (uuid && rendered.has(uuid)) return;

    const doc = parseToolDoc(content);
    const name = doc && doc.tool_name ? doc.tool_name : "tool";
    const callId = doc && doc.tool_call_id ? doc.tool_call_id : null;

    // This exact call may already have a live card on screen (started/finished via
    // toolStart/toolEnd moments earlier) — reuse it instead of appending a duplicate.
    // See finishedLiveToolCallsByName's comment for why this is safe.
    if (claimFinishedLiveToolCall(name, callId) !== null) {
      if (uuid) rendered.add(uuid);
      return;
    }

    // A tool result ends the current text block so any following narration lands
    // in a fresh bubble beneath the card (preserves text ↔ tool ordering).
    sealLiveBubble();

    const outcome = doc && doc.outcome ? String(doc.outcome) : "";
    const ok = outcome ? outcome.toLowerCase() === "success" : true;

    const card = buildToolCard(name);
    card.tile.classList.add(ok ? "success" : "error");
    card.statusEl.textContent = outcome
      ? outcome.charAt(0).toUpperCase() + outcome.slice(1)
      : "Completed";
    card.inputPre.textContent = doc ? toDisplayText(doc.input) : "(no input)";
    card.resultPre.textContent = doc ? toDisplayText(doc.output) : prettyIfJson(content);
    card.resultSection.hidden = false;
    appendTile(card);
    if (uuid) rendered.add(uuid);
  }

  // Route a message row to a tool card (role "tool" or tool-shaped JSON) or a bubble.
  function renderMessageRow(m) {
    if (m.role === "tool" || parseToolDoc(m.content)) {
      renderToolMessage(m.content, m.uuid);
    } else {
      addBubble(m.role, m.content, m.uuid);
    }
  }

  // ── Extension → webview ──────────────────────────────────────────────
  window.addEventListener("message", (event) => {
    const msg = event.data;
    switch (msg.type) {
      case "toolStart":
        setAgentWorking(true, `Running ${prettyToolName(msg.tool)}…`);
        createToolTile(msg.callId, msg.tool, msg.input);
        break;

      case "toolEnd":
        endToolTile(msg);
        setAgentWorking(true); // the turn continues (narration or another tool call)
        break;
      case "status":
        $status.textContent = msg.status === "connected" ? "" : "Disconnected — reconnecting…";
        if (msg.status !== "connected") {
          setAgentWorking(false);
        }
        break;

      case "workspaces":
        state.workspaces = msg.workspaces || [];
        refreshTriggers();
        if (state.view === "workspaces") renderWorkspaceList();
        break;

      case "models": {
        state.models = msg.models || [];
        const hasCurrent =
          state.currentModel && state.models.some((m) => m.id === state.currentModel);
        if (!hasCurrent) {
          const def = state.models.find((m) => m.is_default) || state.models[0];
          state.currentModel = def ? def.id : undefined;
        }
        persistUiState();
        refreshTriggers();
        // If the model picker is open, rebuild it in place with the fresh list.
        if (openTrigger === $modelTrigger) {
          closeMenu();
          openMenu($modelTrigger, modelMenuItems(), state.currentModel, onModelPick);
        }
        break;
      }

      case "threads": {
        state.threads = msg.threads || [];
        if (msg.workspaceUuid) {
          state.currentWorkspace = msg.workspaceUuid;
        }
        // When the extension restores a specific thread it sends `selectedThread` and
        // pushes that thread's messages itself — adopt it without re-requesting.
        const restoreUuid =
          msg.selectedThread &&
          state.threads.some((t) => t.uuid === msg.selectedThread)
            ? msg.selectedThread
            : undefined;
        if (restoreUuid) {
          state.currentThread = restoreUuid;
          if (state.view === "threads") renderThreadList();
        } else if (state.threads[0]) {
          // The engine returns threads most-recent first; the top one is "selected".
          state.currentThread = state.threads[0].uuid;
          if (navToThreadListOnLoad) {
            navToThreadListOnLoad = false;
            setView("threads");
          } else {
            post({ type: "selectThread", uuid: state.threads[0].uuid });
            if (state.view === "threads") renderThreadList();
          }
        } else {
          state.currentThread = undefined;
          clearMessages();
          if (navToThreadListOnLoad) {
            navToThreadListOnLoad = false;
            setView("threads");
          }
        }
        refreshTriggers();
        break;
      }

      case "messages":
        state.currentThread = msg.threadUuid;
        clearMessages();
        (msg.messages || []).forEach((m) => renderMessageRow(m));
        refreshTriggers();
        // Loading a thread's transcript is a clean slate: never leave a previous
        // turn's "working" state showing against a freshly-loaded conversation.
        setAgentWorking(false);
        break;

      case "message": {
        const m = msg.message;
        if (m.role === "tool" || parseToolDoc(m.content)) {
          renderToolMessage(m.content, m.uuid);
          break;
        }
        // An assistant/agent row the user has ALREADY seen stream in live: adopt the
        // on-screen bubble rather than appending a second copy of the same reply.
        if (
          (m.role === "agent" || m.role === "assistant") &&
          adoptStreamedBubble(m.content, m.uuid)
        ) {
          break;
        }
        addBubble(m.role, m.content, m.uuid);
        break;
      }

      case "delta":
        setAgentWorking(true, "Working…");
        if (!liveBubble) {
          liveBubble = { el: addBubble("agent", "", null), text: "" };
        }
        liveBubble.text += msg.delta || "";
        withPreservedScroll(() => {
          liveBubble.el.innerHTML = renderMarkdown(liveBubble.text);
        });
        break;

      case "done":
        // Footnote the turn with what it cost and how long it took, then seal (don't
        // discard) the final streamed bubble: the engine persists the trailing
        // narration and sends `chat.done` from different tasks, so the persisted
        // `assistant` row can still arrive after this — it needs a bubble to adopt, or
        // it would render a duplicate of the reply just streamed. Sealing also
        // guarantees the next turn's deltas start a fresh bubble.
        finishTurn({ usage: msg.usage, durationMs: msg.durationMs, cancelled: msg.cancelled });
        setAgentWorking(false);
        break;

      case "error":
        // Footnote whatever the turn managed before failing, so a partial reply still
        // reports its cost/duration and stays copyable.
        if (msg.usage || msg.durationMs != null) {
          finishTurn({ usage: msg.usage, durationMs: msg.durationMs });
        }
        // Rendered inline in the message stream (like every other message) rather
        // than in the static status bar: a status-bar error sits in a fixed spot
        // below the message list, so once the conversation fills the panel it's
        // pushed out past the composer and easy to miss. An inline card scrolls
        // with the conversation and always appears right where the error occurred.
        renderErrorCard(msg.message, msg.timeout);
        setAgentWorking(false);
        break;

      case "mentionCategories":
        mention.categories = msg.categories || [];
        if (mention.open && mention.mode === "category") {
          renderCategoryList(currentCategoryFilter());
        }
        break;

      case "mentionResults":
        if (msg.requestId !== mention.latestSearchSeq) break; // stale reply
        mention.items = msg.items || [];
        mention.selected = 0;
        if (mention.open) renderCurrentMentionList();
        break;

      case "mentionResolved": {
        // Correlate back to the exact inline text that was already inserted into the
        // composer at pick time (falls back to the resolved label if the request id
        // wasn't tracked, e.g. after a reload).
        const token = pendingMentionTokens.get(msg.requestId) ?? mentionInlineToken(msg.resolved.label);
        pendingMentionTokens.delete(msg.requestId);
        mentionContextByToken.set(token, msg.resolved.text);
        syncMentionHighlights();
        break;
      }

      case "fileChangeUndone": {
        const entry = fileChangeCards.get(msg.changeId);
        if (entry) {
          if (msg.ok) {
            entry.undo.textContent = "Reverted";
            entry.undo.disabled = true;
            entry.card.tile.classList.add("reverted");
            fileChangeCards.delete(msg.changeId);
          } else {
            // Re-enable so the user can retry, and say why it didn't work.
            entry.undo.textContent = "Undo";
            entry.undo.disabled = false;
            if (msg.message) renderErrorCard(msg.message);
          }
        } else if (!msg.ok && msg.message) {
          renderErrorCard(msg.message);
        }
        break;
      }

      case "confirmationRequest":
        renderConfirmationCard(msg.requestId, msg.prompt);
        break;

      case "diffConfirmationRequest":
        renderDiffConfirmationCard(msg.requestId, msg.toolName, msg.path);
        break;
    }
  });

  // ── In-chat confirmation dialogues (tool approvals + diff review) ─────
  // Rendered inline in the message stream, never as a native modal alert, so the
  // agent's pending approvals read like part of the conversation.
  const WARNING_ICON =
    '<path fill="currentColor" d="M8 1.5 14.5 13H1.5L8 1.5Zm0 3.9-4 6.9h8l-4-6.9ZM7.5 9h1v1.1h-1V9Zm0-3.2h1V8.2h-1V5.8Z"/>';

  function makeConfirmationButton(label, variant, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `confirm-btn confirm-btn-${variant}`;
    btn.textContent = label;
    btn.addEventListener("click", onClick);
    return btn;
  }

  /** Render a tool-approval dialogue (from VsCodeConfirmationUI) inline in the chat. */
  function renderConfirmationCard(requestId, prompt) {
    sealLiveBubble();

    const card = document.createElement("div");
    card.className = "confirm-card";

    const head = document.createElement("div");
    head.className = "confirm-card-head";
    head.innerHTML =
      `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">${WARNING_ICON}</svg>` +
      `<span>${escapeHtml(prompt.toolName)} needs approval</span>`;
    card.appendChild(head);

    if (prompt.target) {
      const target = document.createElement("div");
      target.className = "confirm-card-target";
      target.textContent = prompt.target;
      card.appendChild(target);
    }

    if (!prompt.decomposed) {
      const note = document.createElement("div");
      note.className = "confirm-card-note";
      note.textContent = "This command could not be broken into individual steps, so the entire command line is being confirmed as one.";
      card.appendChild(note);
    } else if (Array.isArray(prompt.segments) && prompt.segments.length > 1) {
      const list = document.createElement("ul");
      list.className = "confirm-card-segments";
      prompt.segments.forEach((seg) => {
        const li = document.createElement("li");
        li.textContent = seg;
        list.appendChild(li);
      });
      card.appendChild(list);
    }

    const actions = document.createElement("div");
    actions.className = "confirm-card-actions";
    const respond = (outcome) => {
      actions.remove();
      const resolved = document.createElement("div");
      resolved.className = "confirm-card-resolved";
      resolved.textContent =
        outcome === "decline" ? "Declined" : outcome === "approve-for-session" ? "Approved for this session" : "Approved";
      card.appendChild(resolved);
      post({ type: "confirmationResponse", requestId, outcome });
    };
    actions.appendChild(makeConfirmationButton("Decline", "secondary", () => respond("decline")));
    actions.appendChild(makeConfirmationButton("Allow for session", "secondary", () => respond("approve-for-session")));
    actions.appendChild(makeConfirmationButton("Approve", "primary", () => respond("approve")));
    card.appendChild(actions);

    withPreservedScroll(() => $messages.appendChild(card));
  }

  // ── End-of-turn footnote (tokens · duration · copy) ────────────────────
  const COPY_ICON =
    '<path fill="currentColor" d="M5.5 1.5A1.5 1.5 0 0 0 4 3v8A1.5 1.5 0 0 0 5.5 12.5h5A1.5 1.5 0 0 0 12 11V3a1.5 1.5 0 0 0-1.5-1.5h-5ZM5 3a.5.5 0 0 1 .5-.5h5A.5.5 0 0 1 11 3v8a.5.5 0 0 1-.5.5h-5A.5.5 0 0 1 5 11V3Zm-2 .5v8.25A2.25 2.25 0 0 0 5.25 14h4.25v-1H5.25A1.25 1.25 0 0 1 4 11.75V3.5H3Z"/>';

  /**
   * Abbreviate a token count by magnitude: 942 → "942", 12_300 → "12.3k",
   * 4_500_000 → "4.5M". One decimal place, and no trailing ".0".
   */
  function formatCount(n) {
    const value = Number(n) || 0;
    if (value < 1000) return String(Math.round(value));
    const units = [
      { limit: 1e12, suffix: "T" },
      { limit: 1e9, suffix: "B" },
      { limit: 1e6, suffix: "M" },
      { limit: 1e3, suffix: "k" },
    ];
    for (const { limit, suffix } of units) {
      if (value >= limit) {
        const scaled = value / limit;
        // Keep a decimal only while it adds precision (9.4k, but 941k not 941.2k).
        const text = scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1).replace(/\.0$/, "");
        return `${text}${suffix}`;
      }
    }
    return String(Math.round(value));
  }

  /** Format a turn's wall-clock duration: 840 → "0.8s", 74_000 → "1m 14s". */
  function formatDuration(ms) {
    const total = Math.max(0, Number(ms) || 0);
    if (total < 1000) return `${total}ms`;
    const seconds = total / 1000;
    if (seconds < 60) return `${seconds.toFixed(1)}s`;
    const mins = Math.floor(seconds / 60);
    const rem = Math.round(seconds % 60);
    if (mins < 60) return `${mins}m ${rem}s`;
    const hours = Math.floor(mins / 60);
    return `${hours}h ${mins % 60}m`;
  }

  /**
   * Copy `text` to the clipboard. Webviews can't always reach the async clipboard
   * API, so fall back to a hidden textarea + execCommand.
   */
  function copyToClipboard(text) {
    const fallback = () => {
      const scratch = document.createElement("textarea");
      scratch.value = text;
      scratch.setAttribute("aria-hidden", "true");
      scratch.style.position = "fixed";
      scratch.style.opacity = "0";
      document.body.appendChild(scratch);
      scratch.select();
      try {
        document.execCommand("copy");
      } catch (e) {
        /* nothing more we can do */
      }
      document.body.removeChild(scratch);
      $input.focus();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(fallback);
      return;
    }
    fallback();
  }

  /**
   * Attach the end-of-turn footnote to a finished assistant bubble: what the turn
   * cost, how long it took, and a button to copy the reply.
   *
   * The copied text is the rendered reply only. Attached file/folder context is never
   * part of a message any more (it travels to the engine in its own field and mentions
   * appear inline as just "#name"), so nothing here can leak inlined file contents
   * into the clipboard.
   */
  function attachTurnFooter(bubble, stats) {
    if (!bubble || !bubble.el || bubble.el.querySelector(":scope > .turn-footer")) return;

    const footer = document.createElement("div");
    footer.className = "turn-footer";

    const parts = [];
    const total = stats && stats.usage ? Number(stats.usage.total_tokens) || 0 : 0;
    if (total > 0) {
      const inTok = Number(stats.usage.input_tokens) || 0;
      const outTok = Number(stats.usage.output_tokens) || 0;
      const detail =
        inTok > 0 || outTok > 0 ? ` (${formatCount(inTok)} in · ${formatCount(outTok)} out)` : "";
      parts.push(`${formatCount(total)} tokens${detail}`);
    }
    if (stats && stats.durationMs != null) {
      parts.push(formatDuration(stats.durationMs));
    }
    if (stats && stats.cancelled) {
      parts.push("stopped");
    }

    const meta = document.createElement("span");
    meta.className = "turn-footer-meta";
    meta.textContent = parts.join(" · ");
    footer.appendChild(meta);

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "turn-footer-copy";
    copy.title = "Copy message";
    copy.setAttribute("aria-label", "Copy message");
    copy.innerHTML = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">${COPY_ICON}</svg>`;
    copy.addEventListener("click", () => {
      copyToClipboard(bubble.text || bubble.el.textContent || "");
      copy.classList.add("copied");
      copy.title = "Copied";
      setTimeout(() => {
        copy.classList.remove("copied");
        copy.title = "Copy message";
      }, 1200);
    });
    footer.appendChild(copy);

    bubble.el.appendChild(footer);
  }

  /**
   * Footnote the turn that just ended. The reply the user is looking at is either the
   * still-live bubble or the most recently sealed one.
   */
  function finishTurn(stats) {
    const bubble = liveBubble || sealedBubbles[sealedBubbles.length - 1];
    // Seal first so the next turn starts a fresh bubble (see sealLiveBubble).
    sealLiveBubble();
    attachTurnFooter(bubble, stats);
  }

  /** Render a chat/turn error inline in the message stream (never in a fixed bar). */
  function renderErrorCard(message, isTimeout = false) {
    sealLiveBubble();
    const card = document.createElement("div");
    card.className = "error-card" + (isTimeout ? " timeout-error" : "");
    
    const head = document.createElement("div");
    head.className = "error-card-head";
    head.innerHTML =
      `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">${WARNING_ICON}</svg>` +
      `<span></span>`;
    head.querySelector("span").textContent = isTimeout 
      ? "Timeout waiting for model response"
      : message || "An error occurred.";
    
    card.appendChild(head);
    
    if (isTimeout) {
      const note = document.createElement("div");
      note.className = "error-card-note";
      note.textContent = "The model did not respond within the configured timeout period. Tool calls are not affected by this timeout.";
      card.appendChild(note);
    }
    
    withPreservedScroll(() => $messages.appendChild(card));
  }

  /** Render an "apply this edit?" dialogue (from edit_file's diff presenter). */
  function renderDiffConfirmationCard(requestId, toolName, path) {
    sealLiveBubble();

    const card = document.createElement("div");
    card.className = "confirm-card";

    const head = document.createElement("div");
    head.className = "confirm-card-head";
    head.innerHTML =
      `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">${WARNING_ICON}</svg>` +
      `<span>Apply the proposed edit?</span>`;
    card.appendChild(head);

    const target = document.createElement("div");
    target.className = "confirm-card-target";
    target.textContent = path;
    card.appendChild(target);

    const actions = document.createElement("div");
    actions.className = "confirm-card-actions";
    const respond = (approved) => {
      actions.remove();
      const resolved = document.createElement("div");
      resolved.className = "confirm-card-resolved";
      resolved.textContent = approved ? "Applied" : "Discarded";
      card.appendChild(resolved);
      post({ type: "diffConfirmationResponse", requestId, approved });
    };
    actions.appendChild(makeConfirmationButton("Discard", "secondary", () => respond(false)));
    actions.appendChild(makeConfirmationButton("Apply", "primary", () => respond(true)));
    card.appendChild(actions);

    withPreservedScroll(() => $messages.appendChild(card));
  }

  // ── Composer ──────────────────────────────────────────────────────────
  function send() {
    const content = $input.value;
    if (content.trim()) {
      // Resolve every inline "#token" that's still present in the sent text (in
      // encounter order) to its full context block. A token whose mention the user
      // deleted from the sentence before sending is simply not included — the
      // composer's text is the single source of truth.
      const contextBlocks = [];
      for (const [token, text] of mentionContextByToken) {
        // `text` is empty for a mention whose context round trip hasn't resolved yet
        // (the token is registered at insert time so it highlights immediately).
        if (text && content.includes(token)) {
          contextBlocks.push(text);
        }
      }
      post({ type: "send", content, modelId: state.currentModel, contextBlocks });
      mentionContextByToken.clear();
      // A new turn starts: the previous turn's rows have settled, so drop any
      // still-unadopted sealed bubbles rather than letting this turn's replies
      // reconcile against them.
      liveBubble = null;
      sealedBubbles.length = 0;
      $input.value = "";
      autoGrow();
      updateSendState();
      syncMentionHighlights();
      setAgentWorking(true, "Sending…");
    }
  }
  /** Ask the engine to stop the in-flight turn (the button's "stop" mode). */
  function stopAgent() {
    setAgentWorking(true, "Stopping…");
    post({ type: "stop" });
  }

  $send.addEventListener("click", () => {
    if (agentWorking) {
      stopAgent();
    } else {
      send();
    }
  });
  $input.addEventListener("keydown", (e) => {
    if (onComposerKeydown(e)) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      // Enter never stops a running turn — that needs a deliberate button press.
      if (!agentWorking) send();
    }
  });

  function autoGrow() {
    $input.style.height = "auto";
    $input.style.height = `${$input.scrollHeight}px`;
  }
  function updateSendState() {
    if (agentWorking) {
      // Stop mode: always actionable, regardless of whether anything is typed.
      $send.classList.add("stopping");
      $send.disabled = false;
      $send.title = "Stop";
      $send.setAttribute("aria-label", "Stop the agent");
      return;
    }
    $send.classList.remove("stopping");
    $send.disabled = !$input.value.trim();
    $send.title = "Send";
    $send.setAttribute("aria-label", "Send");
  }
  $input.addEventListener("input", () => {
    autoGrow();
    updateSendState();
    syncMentionHighlights();
    onComposerInput();
  });
  // Keep the mirrored highlight backdrop aligned when the composer scrolls (the
  // textarea scrolls independently once it hits its max height).
  $input.addEventListener("scroll", () => {
    if ($inputHighlights) {
      $inputHighlights.scrollTop = $input.scrollTop;
    }
  });
  $input.addEventListener("blur", () => {
    // Defer so a mousedown-selected mention row still registers its pick first.
    setTimeout(() => closeMentionMenu(), 0);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && openTrigger) {
      closeMenu();
    }
  });

  updateSendState();
  post({ type: "ready" });
})();
