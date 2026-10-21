import * as vscode from "vscode";
import { EngineClient } from "../engine/client";
import { WSFrame } from "../engine/types";
import type { ToolEvent } from "../tools/host";
import {
  ContextMentionService,
  isSingletonCategory,
  type MentionCategory,
  type MentionItem,
} from "./contextMentions";
import type { TerminalOutputTracker } from "./terminalOutputTracker";
import type { ConfirmationOutcome } from "../tools/approvalManager";
import type { UndoResult } from "../tools/fileChangeJournal";

/**
 * The "Show" / "Undo" actions offered on a create_file/edit_file tool card. Both are
 * purely local: `show` opens a diff/file in the editor and `undo` restores the file
 * from the change journal. Neither sends anything to the engine, so taking back the
 * agent's edit doesn't cost a turn or alter the transcript.
 */
export interface FileChangeActions {
  show(changeId: string): Promise<void>;
  undo(changeId: string): Promise<UndoResult>;
}

/**
 * Webview view shown in the Subconscious activity-bar container.
 *
 * Owns the chat UI and the workspace/thread selection state. All chat data is
 * read from and written through the engine — this view holds no database.
 * 
 * Also handles in-chat confirmation dialogues for tool approvals.
 */
export class ChatPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = "subconscious.chat";

  /** workspaceState keys for the persisted workspace/thread selection. */
  private static readonly WS_KEY = "subconscious.chat.workspace";
  private static readonly TH_KEY = "subconscious.chat.thread";

  private view?: vscode.WebviewView;
  private currentWorkspace?: string;
  private currentThread?: string;
  /** Resolves "#" context-mention searches/selections for the composer popup. */
  private readonly mentions: ContextMentionService;
  
  /**
   * Callback to handle confirmation responses from the webview.
   * Set by the ToolHost when it creates the VsCodeConfirmationUI.
   */
  public confirmationResponseHandler?: (requestId: string, outcome: ConfirmationOutcome) => void;

  /**
   * Pending in-chat "apply this edit?" dialogues (from `edit_file`'s diff review),
   * keyed by request id. Rendered as an inline card in the message stream — never a
   * modal `showInformationMessage` alert — with Apply/Discard buttons the user clicks
   * in place.
   */
  private readonly diffConfirmations = new Map<string, (approved: boolean) => void>();
  private diffRequestIdCounter = 0;

  /**
   * Handles the "Show" / "Undo" buttons on a create_file/edit_file tool card. Both are
   * local editor/filesystem operations — no engine frame is sent for either.
   */
  public fileChangeActions?: FileChangeActions;

  /**
   * Correlation id of the turn currently in flight, and the thread it belongs to.
   * `chat.delta`/`chat.done`/`chat.error` frames are only forwarded to the webview
   * when they belong to the thread that is actually open, so switching threads
   * mid-turn can't spill one conversation's streaming reply into another's view.
   */
  private activeTurnId?: string;
  private activeTurnThread?: string;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly client: EngineClient,
    private readonly memento: vscode.Memento,
    terminalOutput?: TerminalOutputTracker,
  ) {
    this.mentions = new ContextMentionService(terminalOutput);
    // Restore the last workspace/thread so a full reload or extension restart returns
    // to where the user left off (the webview is also kept alive on hide/show via
    // retainContextWhenHidden, which covers the common switch-away/back case).
    this.currentWorkspace = this.memento.get<string>(ChatPanel.WS_KEY);
    this.currentThread = this.memento.get<string>(ChatPanel.TH_KEY);

    // Forward engine events to the webview when they concern the open thread.
    this.client.on("event", (frame: WSFrame) => this.onEngineEvent(frame));
    this.client.on("status", (status: string) => {
      this.post({ type: "status", status });
      // The webview's initial "ready" load can race ahead of the engine connection
      // (workspaces/models then fail silently). Re-hydrate once connected.
      if (status === "connected") {
        void this.restore();
      }
    });
  }

  /** Persist the current workspace/thread selection so it survives reloads. */
  private persistSelection(): void {
    void this.memento.update(ChatPanel.WS_KEY, this.currentWorkspace);
    void this.memento.update(ChatPanel.TH_KEY, this.currentThread);
  }

  /**
   * (Re-)hydrate the webview: models, workspaces, the selected workspace's threads,
   * and the selected thread's messages — restoring the persisted selection when it is
   * still valid, otherwise falling back to the first workspace / most-recent thread.
   * Never throws (a not-yet-connected engine simply retries on the next connect).
   */
  private async restore(): Promise<void> {
    try {
      await this.loadModels();
      const workspaces = await this.client.listWorkspaces();
      this.post({ type: "workspaces", workspaces });

      const wsUuid =
        this.currentWorkspace !== undefined &&
        workspaces.some((w) => w.uuid === this.currentWorkspace)
          ? this.currentWorkspace
          : workspaces[0]?.uuid;
      if (wsUuid === undefined) {
        return;
      }
      this.currentWorkspace = wsUuid;

      const selected = await this.loadThreads(wsUuid);
      this.currentThread = selected;
      this.persistSelection();
      if (selected !== undefined) {
        await this.loadMessages(selected);
      }
    } catch {
      // Not connected yet / transient — the next connect triggers another restore.
    }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.html = this.html(view.webview);

    view.webview.onDidReceiveMessage((msg) => this.onWebviewMessage(msg));
  }

  /**
   * Whether the chat view is currently visible (its container is expanded and, when
   * it lives in the activity bar, that container is the active one) — distinct from
   * whether the whole editor window has focus. Used by `VsCodeConfirmationUI` to
   * decide whether a pending approval also needs a native notification, since a
   * user could have the window focused but be looking at a different view/panel.
   */
  public isVisible(): boolean {
    return this.view?.visible ?? false;
  }

  // ── Webview → extension ──────────────────────────────────────────────────────
  private async onWebviewMessage(msg: any): Promise<void> {
    try {
      switch (msg.type) {
        case "ready":
          await this.restore();
          break;
        case "selectWorkspace":
          this.currentWorkspace = msg.uuid;
          this.currentThread = undefined;
          this.persistSelection();
          await this.loadThreads(msg.uuid);
          break;
        case "selectThread":
          this.currentThread = msg.uuid;
          this.persistSelection();
          await this.loadMessages(msg.uuid);
          break;
        case "newThread":
          await this.newThread();
          break;
        case "send":
          if (this.currentThread && msg.content?.trim()) {
            // The resolved "#" mention context is sent alongside the message rather
            // than prepended into it, so the transcript shows the user's own words
            // and not the inlined contents of everything they attached.
            this.activeTurnId = this.client.sendChat(
              this.currentThread,
              msg.content.trim(),
              msg.modelId,
              normalizeContextBlocks(msg.contextBlocks),
            );
            this.activeTurnThread = this.currentThread;
          }
          break;
        case "refreshModels":
          await this.loadModels();
          break;
        case "openTools":
          await vscode.commands.executeCommand("subconscious.configureTools");
          break;
        case "mentionCategories":
          this.post({ type: "mentionCategories", categories: MENTION_CATEGORIES });
          break;
        case "mentionSearch":
          await this.handleMentionSearch(msg.requestId, msg.category, msg.query ?? "");
          break;
        case "mentionResolve":
          await this.handleMentionResolve(msg.requestId, msg.item);
          break;
        case "confirmationResponse":
          // User responded to an in-chat confirmation prompt
          if (this.confirmationResponseHandler && msg.requestId && msg.outcome) {
            this.confirmationResponseHandler(msg.requestId, msg.outcome);
          }
          break;
        case "diffConfirmationResponse": {
          // User clicked Apply/Discard on an in-chat "review this edit" dialogue.
          const resolve = this.diffConfirmations.get(msg.requestId);
          if (resolve) {
            this.diffConfirmations.delete(msg.requestId);
            resolve(msg.approved === true);
          }
          break;
        }
        case "showFileChange":
          // "Show" on a create_file/edit_file card. Local only — no engine traffic.
          await this.fileChangeActions?.show(msg.changeId);
          break;
        case "undoFileChange": {
          // "Undo" on a create_file/edit_file card. Restores the file directly; the
          // engine is deliberately NOT told, so reverting an edit costs no tokens and
          // adds nothing to the transcript.
          const result = await this.fileChangeActions?.undo(msg.changeId);
          this.post({
            type: "fileChangeUndone",
            changeId: msg.changeId,
            ok: result?.ok === true,
            message: result?.ok === true ? undefined : result?.reason,
          });
          break;
        }
        case "stop":
          // Stop button: cancel the in-flight turn on the engine.
          this.client.cancelChat(this.activeTurnId);
          break;
      }
    } catch (err: any) {
      this.post({ type: "error", message: String(err?.message ?? err) });
    }
  }

  /**
   * Search for "#" mention candidates in a category, replying with the same
   * `requestId` so the webview can discard stale results from a fast-typing user.
   */
  private async handleMentionSearch(
    requestId: number,
    category: MentionCategory,
    query: string,
  ): Promise<void> {
    let items: MentionItem[] = [];
    switch (category) {
      case "file":
        items = await this.mentions.searchFiles(query);
        break;
      case "folder":
        items = await this.mentions.searchFolders(query);
        break;
      case "terminal":
        items = this.mentions.listTerminals(query);
        break;
      case "symbol":
        items = await this.mentions.searchSymbols(query);
        break;
      default:
        // Singleton categories (Problems / Git Diff / Open Editors) have no
        // sub-search: the popup lists them directly without a nested search step.
        items = [];
        break;
    }
    this.post({ type: "mentionResults", requestId, category, items });
  }

  /** Resolve a chosen mention into its inlined text block and hand it back. */
  private async handleMentionResolve(requestId: number, item: MentionItem): Promise<void> {
    try {
      const resolved = await this.mentions.resolve(item);
      this.post({ type: "mentionResolved", requestId, resolved });
    } catch (err: any) {
      this.post({
        type: "mentionResolved",
        requestId,
        resolved: {
          label: item.label,
          text: `[Context — ${item.label}]\n(failed to resolve: ${String(err?.message ?? err)})`,
        },
      });
    }
  }

  private async loadModels(): Promise<void> {
    try {
      const all = await this.client.listModels();
      // Models the engine says are not chat models (transcription, TTS, ...)
      // stay out of the picker; unknown capabilities count as chat.
      const models = all.filter((m) => m.capabilities?.chat !== false);
      this.post({ type: "models", models });
    } catch (err: any) {
      // Non-fatal: chat still works with the engine's default model.
      this.post({ type: "models", models: [] });
    }
  }

  /**
   * Load the threads for a workspace and post them, hinting which thread the webview
   * should select: the current (restored) thread when it is still present, otherwise
   * `undefined` so the webview opens the most-recent thread. Returns the resolved
   * selected thread uuid (or `undefined`).
   */
  private async loadThreads(workspaceUuid: string): Promise<string | undefined> {
    const threads = await this.client.listThreads(workspaceUuid);
    const selectedThread =
      this.currentThread !== undefined &&
      threads.some((t) => t.uuid === this.currentThread)
        ? this.currentThread
        : undefined;
    this.post({ type: "threads", threads, workspaceUuid, selectedThread });
    return selectedThread;
  }

  private async loadMessages(threadUuid: string): Promise<void> {
    const messages = await this.client.listMessages(threadUuid);
    this.post({ type: "messages", messages, threadUuid });
  }

  /**
   * Surface a tool-call start/end to the chat webview, which renders it as an
   * expandable card in the message stream (Copilot-style tool activity).
   */
  showToolActivity(event: ToolEvent): void {
    if (event.phase === "start") {
      this.post({
        type: "toolStart",
        callId: event.callId,
        tool: event.tool,
        input: safeStringify(event.input),
      });
    } else {
      this.post({
        type: "toolEnd",
        callId: event.callId,
        tool: event.tool,
        ok: event.ok,
        errorKind: event.errorKind,
        summary: event.summary,
        detail: event.detail,
        // Present for a successful create_file/edit_file: lets the card render its
        // Show / Undo buttons for the change this call made.
        change: event.change,
      });
    }
  }

  /**
   * Present an "apply this edit?" dialogue inline in the chat and resolve when the
   * user clicks Apply or Discard. Used by `edit_file`'s diff presenter so the
   * confirmation is an in-chat dialogue rather than a modal alert; the actual diff
   * itself is still shown via `vscode.diff` (a native VS Code editor view, not an
   * alert box) before this resolves.
   */
  async confirmDiff(toolName: string, relativePath: string): Promise<boolean> {
    const requestId = String(++this.diffRequestIdCounter);
    this.post({ type: "diffConfirmationRequest", requestId, toolName, path: relativePath });
    return new Promise<boolean>((resolve) => {
      this.diffConfirmations.set(requestId, resolve);
    });
  }

  async newThread(): Promise<void> {
    if (!this.currentWorkspace) {
      return;
    }
    const thread = await this.client.createThread(this.currentWorkspace, "New Thread");
    this.currentThread = thread.uuid;
    this.persistSelection();
    // loadThreads sends the selected-thread hint (the new thread), so the webview
    // adopts it without re-requesting; we then push its (empty) message list.
    await this.loadThreads(this.currentWorkspace);
    await this.loadMessages(thread.uuid);
  }

  // ── Engine → extension → webview ───────────────────────────────────────────────
  private onEngineEvent(frame: WSFrame): void {
    switch (frame.type) {
      case "message.created":
        if (frame.data?.thread_uuid === this.currentThread) {
          this.post({ type: "message", message: frame.data });
        }
        break;
      case "chat.delta":
        if (this.belongsToOpenThread(frame)) {
          this.post({ type: "delta", id: frame.id, delta: frame.data?.delta });
        }
        break;
      case "chat.done":
        if (this.belongsToOpenThread(frame)) {
          this.post({
            type: "done",
            id: frame.id,
            cancelled: frame.data?.cancelled === true,
            usage: frame.data?.usage,
            durationMs: frame.data?.duration_ms,
          });
        }
        this.clearActiveTurn(frame.id);
        break;
      case "chat.error":
        if (this.belongsToOpenThread(frame)) {
          this.post({
            type: "error",
            message: frame.data?.error ?? "chat error",
            usage: frame.data?.usage,
            durationMs: frame.data?.duration_ms,
            timeout: frame.data?.timeout === true,
          });
        }
        this.clearActiveTurn(frame.id);
        break;
      case "thread.created":
      case "thread.updated":
        if (this.currentWorkspace && frame.data?.workspace_uuid === this.currentWorkspace) {
          void this.loadThreads(this.currentWorkspace);
        }
        break;
    }
  }

  /**
   * Whether a streaming/terminal chat frame belongs to the thread currently open, so
   * only that thread's turn is rendered.
   *
   * The engine stamps `thread_uuid` on these frames; when it is absent (an older
   * engine) we fall back to the thread we sent this correlation id for, and finally
   * to accepting the frame rather than silently dropping a reply.
   */
  private belongsToOpenThread(frame: WSFrame): boolean {
    const frameThread = frame.data?.thread_uuid;
    if (typeof frameThread === "string") {
      return frameThread === this.currentThread;
    }
    if (frame.id !== undefined && frame.id === this.activeTurnId) {
      return this.activeTurnThread === this.currentThread;
    }
    return true;
  }

  /** Forget the in-flight turn once it has terminated. */
  private clearActiveTurn(id: string | undefined): void {
    if (id === undefined || id === this.activeTurnId) {
      this.activeTurnId = undefined;
      this.activeTurnThread = undefined;
    }
  }

  /**
   * Post a message to the webview. Public so VsCodeConfirmationUI can post
   * confirmation requests.
   */
  public post(msg: any): void {
    this.view?.webview.postMessage(msg);
  }

  // ── HTML ──────────────────────────────────────────────────────────────────────
  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "main.js"),
    );
    const highlightUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "highlight-bundle.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "main.css"),
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}?v=${nonce}" rel="stylesheet" />
  <title>Subconscious</title>
</head>
<body>
  <main id="content" class="content">
    <div id="messages" class="messages"></div>
    <div id="list" class="list-view" hidden></div>
  </main>
  <div id="status" class="status"></div>
  <footer class="composer">
    <div class="composer-box">
      <div class="input-wrap">
        <div id="input-highlights" class="input-highlights" aria-hidden="true"></div>
        <textarea id="input" rows="1" placeholder="Message Subconscious… (# to mention a file, folder, etc.)"></textarea>
      </div>
      <div class="toolbar">
        <div class="pickers">
          <span id="agent-state" class="agent-state" hidden>
            <span class="agent-state-dot"></span>
            <span id="agent-state-label">Idle</span>
          </span>
          <button id="model-trigger" class="picker model-picker" aria-haspopup="true" title="Model">
            <span id="model-label" class="picker-text">Model</span>
            <svg class="chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M3.2 5.5a.5.5 0 0 1 .707 0L8 9.593l4.093-4.093a.5.5 0 1 1 .707.707l-4.446 4.446a.5.5 0 0 1-.708 0L3.2 6.207a.5.5 0 0 1 0-.707Z"/></svg>
          </button>
        </div>
        <button id="send" class="send-btn" title="Send" aria-label="Send">
          <svg class="send-icon" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M8 2.5a.5.5 0 0 1 .354.146l4 4a.5.5 0 0 1-.708.708L8.5 4.207V13a.5.5 0 0 1-1 0V4.207L4.354 7.354a.5.5 0 1 1-.708-.708l4-4A.5.5 0 0 1 8 2.5Z"/></svg>
          <svg class="stop-icon" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><rect fill="currentColor" x="4" y="4" width="8" height="8" rx="1.5"/></svg>
        </button>
      </div>
    </div>
    <div class="selectors">
      <button id="workspace-trigger" class="picker selector-tab" title="Workspaces" aria-pressed="false">
        <svg class="ico" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M1.5 3A1.5 1.5 0 0 1 3 1.5h3.09a1.5 1.5 0 0 1 1.06.44l.91.91H13A1.5 1.5 0 0 1 14.5 4.5v7A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5V3Zm1.5-.5a.5.5 0 0 0-.5.5v8.5a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5H7.75a.5.5 0 0 1-.354-.146l-1.06-1.06a.5.5 0 0 0-.353-.148H3Z"/></svg>
        <span id="workspace-label" class="picker-text">Workspace</span>
      </button>
      <button id="thread-trigger" class="picker selector-tab" title="Threads" aria-pressed="false">
        <svg class="ico" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M2.5 2h11A1.5 1.5 0 0 1 15 3.5v6A1.5 1.5 0 0 1 13.5 11H6.7l-3.4 2.85A.5.5 0 0 1 2.5 13.5V11A1.5 1.5 0 0 1 1 9.5v-6A1.5 1.5 0 0 1 2.5 2Zm0 1a.5.5 0 0 0-.5.5v6a.5.5 0 0 0 .5.5h.5v1.93L6.32 10h7.18a.5.5 0 0 0 .5-.5v-6a.5.5 0 0 0-.5-.5h-11Z"/></svg>
        <span id="thread-label" class="picker-text">Thread</span>
      </button>
      <button id="new-thread" class="icon-btn" title="New thread" aria-label="New thread">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 3.5a.5.5 0 0 1 .5.5v3.5H12a.5.5 0 0 1 0 1H8.5V12a.5.5 0 0 1-1 0V8.5H4a.5.5 0 0 1 0-1h3.5V4a.5.5 0 0 1 .5-.5Z"/></svg>
      </button>
    </div>
  </footer>
  <div id="menu" class="menu" hidden></div>
  <div id="mention-menu" class="menu mention-menu" hidden></div>
  <script nonce="${nonce}" src="${highlightUri}?v=${nonce}"></script>
  <script nonce="${nonce}" src="${scriptUri}?v=${nonce}"></script>
</body>
</html>`;
  }
}

/** The "#" popup's top-level category list, in display order. */
const MENTION_CATEGORY_LABELS: ReadonlyArray<{ id: MentionCategory; label: string }> = [
  { id: "file", label: "Files" },
  { id: "folder", label: "Folders" },
  { id: "terminal", label: "Terminal" },
  { id: "symbol", label: "Code Symbol" },
  { id: "problems", label: "Problems" },
  { id: "gitDiff", label: "Git Diff" },
  { id: "openEditors", label: "Open Editors" },
];

/** The category list sent to the webview, each flagged with whether it needs a search step. */
const MENTION_CATEGORIES = MENTION_CATEGORY_LABELS.map((entry) => ({
  ...entry,
  searchable: !isSingletonCategory(entry.id),
}));

/**
 * Narrow the webview-supplied context blocks to a clean `string[]` for the
 * `chat.send` frame's `context_blocks` field. The engine prompts the model with
 * these ahead of the user's message but persists only the message itself, so
 * attached file contents never appear in the chat transcript.
 */
function normalizeContextBlocks(contextBlocks: unknown): string[] {
  if (!Array.isArray(contextBlocks)) {
    return [];
  }
  return contextBlocks.filter(
    (block): block is string => typeof block === "string" && block.trim().length > 0,
  );
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}

/** Pretty-print an arbitrary tool input for display; never throws. */
function safeStringify(value: unknown): string {
  if (typeof value === "string") {
    return prettyIfJson(value);
  }
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * If `text` parses as JSON, return it re-serialized with indentation so tool cards
 * show readable JSON instead of a single unbroken line; otherwise return it unchanged.
 */
function prettyIfJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0 || (trimmed[0] !== "{" && trimmed[0] !== "[")) {
    return text;
  }
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return text;
  }
}
