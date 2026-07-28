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
  const $configureTools = document.getElementById("configure-tools");
  const $list = document.getElementById("list");
  const $menu = document.getElementById("menu");
  const $contextChips = document.getElementById("context-chips");
  const $mentionMenu = document.getElementById("mention-menu");

  const state = {
    workspaces: [],
    threads: [],
    models: [],
    currentWorkspace: undefined,
    currentThread: undefined,
    currentModel: undefined,
    view: "chat", // "chat" | "workspaces" | "threads"
    // Resolved "#" context attachments queued for the next outgoing message.
    // Each entry is { label, text }; `text` is what's actually sent to the engine.
    contextItems: [],
  };

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

  const rendered = new Set(); // message uuids already shown
  let liveBubble = null; // in-progress assistant bubble {el, text}

  function post(msg) {
    vscode.postMessage(msg);
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
  // Files, Folders, Terminal, Problems, Git Diff, and Open Editors. Picking a
  // searchable category (Files/Folders/Terminal) narrows to a live search;
  // picking a fixed category resolves immediately. A resolved mention becomes a
  // chip above the composer and its text is prepended to the next outgoing
  // message (see the "send" message and ChatPanel.composeMessageWithContext).

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

  const mention = {
    categories: null, // cached list from the extension, fetched once
    open: false,
    mode: "category", // "category" | "items"
    anchorStart: -1, // index of the "#" that opened the current popup
    category: undefined,
    query: "",
    items: [],
    selected: 0,
    searchSeq: 0,
    latestSearchSeq: -1,
    searchTimer: null,
  };

  function closeMentionMenu() {
    mention.open = false;
    mention.anchorStart = -1;
    mention.items = [];
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
    $mentionMenu.innerHTML = "";
    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "menu-empty";
      empty.textContent = mention.mode === "items" ? "No matches" : "No categories";
      $mentionMenu.appendChild(empty);
    }
    rows.forEach((row, idx) => {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "menu-item mention-item" + (idx === mention.selected ? " selected" : "");
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

  function renderCategoryList(filterText) {
    mention.mode = "category";
    const needle = (filterText || "").toLowerCase();
    const cats = (mention.categories || []).filter((c) => c.label.toLowerCase().includes(needle));
    mention.selected = Math.min(mention.selected, Math.max(cats.length - 1, 0));
    renderMentionRows(
      cats.map((c) => ({
        iconKey: c.id,
        label: c.label,
        onPick: () => pickCategory(c),
      })),
    );
  }

  function renderItemsList() {
    mention.mode = "items";
    mention.selected = Math.min(mention.selected, Math.max(mention.items.length - 1, 0));
    renderMentionRows(
      mention.items.map((item) => ({
        iconKey: item.category,
        label: item.label,
        description: item.description,
        onPick: () => pickItem(item),
      })),
    );
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
  }

  function pickCategory(cat) {
    if (!cat.searchable) {
      // Fixed categories (Problems/Git Diff/Open Editors) resolve immediately.
      replaceMentionToken("");
      closeMentionMenu();
      resolveMention({ category: cat.id, id: cat.id, label: cat.label });
      return;
    }
    mention.category = cat.id;
    mention.query = "";
    replaceMentionToken(`#${cat.id}:`);
    mention.anchorStart = $input.value.lastIndexOf(`#${cat.id}:`);
    renderItemsList();
    requestMentionSearch(cat.id, "");
  }

  function pickItem(item) {
    replaceMentionToken("");
    closeMentionMenu();
    resolveMention(item);
  }

  function resolveMention(item) {
    mention.searchSeq += 1;
    post({ type: "mentionResolve", requestId: mention.searchSeq, item });
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
    mention.open = true;
    mention.anchorStart = token.start;

    const colonIdx = token.text.indexOf(":");
    if (colonIdx === -1) {
      requestMentionCategoriesIfNeeded();
      renderCategoryList(token.text);
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
    const rows = mention.mode === "items" ? mention.items : mention.categories || [];
    if (e.key === "ArrowDown") {
      e.preventDefault();
      mention.selected = Math.min(mention.selected + 1, Math.max(rows.length - 1, 0));
      mention.mode === "items" ? renderItemsList() : renderCategoryList(currentCategoryFilter());
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      mention.selected = Math.max(mention.selected - 1, 0);
      mention.mode === "items" ? renderItemsList() : renderCategoryList(currentCategoryFilter());
      return true;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      if (rows.length === 0) {
        closeMentionMenu();
        return false;
      }
      e.preventDefault();
      if (mention.mode === "items") {
        pickItem(mention.items[mention.selected]);
      } else {
        const cats = (mention.categories || []).filter((c) =>
          c.label.toLowerCase().includes(currentCategoryFilter().toLowerCase()),
        );
        if (cats[mention.selected]) pickCategory(cats[mention.selected]);
      }
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

  // ── Context chips (resolved "#" mentions queued for the next message) ────
  function renderContextChips() {
    $contextChips.innerHTML = "";
    $contextChips.hidden = state.contextItems.length === 0;
    state.contextItems.forEach((item, idx) => {
      const chip = document.createElement("span");
      chip.className = "context-chip";
      const label = document.createElement("span");
      label.className = "context-chip-label";
      label.textContent = item.label;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "context-chip-remove";
      remove.setAttribute("aria-label", `Remove ${item.label} from context`);
      remove.textContent = "×";
      remove.addEventListener("click", () => {
        state.contextItems.splice(idx, 1);
        renderContextChips();
      });
      chip.appendChild(label);
      chip.appendChild(remove);
      $contextChips.appendChild(chip);
    });
  }

  // Mirror the Python UI's model label: the alias if set, otherwise
  // "<provider>-<model>", falling back to whatever fields are available.
  function modelName(m) {
    if (!m) return "Model";
    if (m.alias && String(m.alias).trim()) return String(m.alias).trim();
    const provider = (m.provider || "").trim();
    const model = (m.model || "").trim();
    if (provider && model) return `${provider}-${model}`;
    return model || provider || m.id;
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

  if ($configureTools) {
    $configureTools.addEventListener("click", () => post({ type: "openTools" }));
  }

  // ── Messages ──────────────────────────────────────────────────────────
  function clearMessages() {
    $messages.innerHTML = "";
    rendered.clear();
    liveBubble = null;
    toolTiles.clear();
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
    $messages.appendChild(el);
    $messages.scrollTop = $messages.scrollHeight;
    if (uuid) {
      rendered.add(uuid);
    }
    return el;
  }

  // ── Tool-call cards (Copilot-style expandable tiles) ──────────────────
  const toolTiles = new Map(); // callId -> { tile, statusEl, resultSection, resultPre }

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
  function buildToolCard(toolName) {
    const tile = document.createElement("div");
    tile.className = "tool-tile";

    const header = document.createElement("button");
    header.className = "tool-tile-header";
    header.type = "button";
    header.innerHTML =
      `<svg class="tool-tile-ico" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">${TOOL_ICON}</svg>` +
      `<span class="tool-tile-name"></span>` +
      `<span class="tool-tile-status"></span>` +
      `<svg class="chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">${CHEVRON_ICON}</svg>`;
    header.querySelector(".tool-tile-name").textContent = prettyToolName(toolName);

    const body = document.createElement("div");
    body.className = "tool-tile-body";
    body.hidden = true;

    const input = makeToolSection("Input", "");
    const result = makeToolSection("Result", "");
    result.section.hidden = true;
    body.appendChild(input.section);
    body.appendChild(result.section);

    header.addEventListener("click", () => {
      body.hidden = !body.hidden;
      tile.classList.toggle("open", !body.hidden);
    });

    tile.appendChild(header);
    tile.appendChild(body);

    return {
      tile,
      statusEl: header.querySelector(".tool-tile-status"),
      inputPre: input.pre,
      resultSection: result.section,
      resultPre: result.pre,
    };
  }

  function appendTile(card) {
    $messages.appendChild(card.tile);
    $messages.scrollTop = $messages.scrollHeight;
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
    // fresh bubble beneath the card (mirrors Copilot's interleaving).
    liveBubble = null;
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
    // A tool result ends the current text block so any following narration lands
    // in a fresh bubble beneath the card (preserves text ↔ tool ordering).
    liveBubble = null;

    const doc = parseToolDoc(content);
    const name = doc && doc.tool_name ? doc.tool_name : "tool";
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
        createToolTile(msg.callId, msg.tool, msg.input);
        break;

      case "toolEnd":
        endToolTile(msg);
        break;
      case "status":
        $status.textContent = msg.status === "connected" ? "" : "Disconnected — reconnecting…";
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
        break;

      case "message": {
        const m = msg.message;
        if (m.role === "tool" || parseToolDoc(m.content)) {
          renderToolMessage(m.content, m.uuid);
          break;
        }
        if (
          (m.role === "agent" || m.role === "assistant") &&
          liveBubble &&
          liveBubble.text === m.content
        ) {
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
        liveBubble.el.innerHTML = renderMarkdown(liveBubble.text);
        $messages.scrollTop = $messages.scrollHeight;
        break;

      case "done":
        break;

      case "error":
        $status.textContent = `Error: ${msg.message}`;
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
        if (mention.open) renderItemsList();
        break;

      case "mentionResolved":
        state.contextItems.push(msg.resolved);
        renderContextChips();
        break;
    }
  });

  // ── Composer ──────────────────────────────────────────────────────────
  function send() {
    const content = $input.value;
    if (content.trim()) {
      const contextBlocks = state.contextItems.map((item) => item.text);
      post({ type: "send", content, modelId: state.currentModel, contextBlocks });
      state.contextItems = [];
      renderContextChips();
      $input.value = "";
      autoGrow();
      updateSendState();
    }
  }
  $send.addEventListener("click", send);
  $input.addEventListener("keydown", (e) => {
    if (onComposerKeydown(e)) return;
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
    onComposerInput();
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
