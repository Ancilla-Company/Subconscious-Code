import * as vscode from "vscode";
import { EngineClient } from "../engine/client";
import { WSFrame } from "../engine/types";

/**
 * Webview view shown in the Subconscious activity-bar container.
 *
 * Owns the chat UI and the workspace/thread selection state. All chat data is
 * read from and written through the engine — this view holds no database.
 */
export class ChatPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = "subconscious.chat";

  private view?: vscode.WebviewView;
  private currentWorkspace?: string;
  private currentThread?: string;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly client: EngineClient,
  ) {
    // Forward engine events to the webview when they concern the open thread.
    this.client.on("event", (frame: WSFrame) => this.onEngineEvent(frame));
    this.client.on("status", (status: string) => this.post({ type: "status", status }));
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

  // ── Webview → extension ──────────────────────────────────────────────────────
  private async onWebviewMessage(msg: any): Promise<void> {
    try {
      switch (msg.type) {
        case "ready":
          await this.loadWorkspaces();
          await this.loadModels();
          break;
        case "selectWorkspace":
          this.currentWorkspace = msg.uuid;
          this.currentThread = undefined;
          await this.loadThreads(msg.uuid);
          break;
        case "selectThread":
          this.currentThread = msg.uuid;
          await this.loadMessages(msg.uuid);
          break;
        case "newThread":
          await this.newThread();
          break;
        case "send":
          if (this.currentThread && msg.content?.trim()) {
            this.client.sendChat(this.currentThread, msg.content.trim(), msg.modelId);
          }
          break;
      }
    } catch (err: any) {
      this.post({ type: "error", message: String(err?.message ?? err) });
    }
  }

  private async loadWorkspaces(): Promise<void> {
    const workspaces = await this.client.listWorkspaces();
    this.post({ type: "workspaces", workspaces });
    if (!this.currentWorkspace && workspaces[0]) {
      this.currentWorkspace = workspaces[0].uuid;
      await this.loadThreads(this.currentWorkspace);
    }
  }

  private async loadModels(): Promise<void> {
    try {
      const models = await this.client.listModels();
      this.post({ type: "models", models });
    } catch (err: any) {
      // Non-fatal: chat still works with the engine's default model.
      this.post({ type: "models", models: [] });
    }
  }

  private async loadThreads(workspaceUuid: string): Promise<void> {
    const threads = await this.client.listThreads(workspaceUuid);
    this.post({ type: "threads", threads, workspaceUuid });
  }

  private async loadMessages(threadUuid: string): Promise<void> {
    const messages = await this.client.listMessages(threadUuid);
    this.post({ type: "messages", messages, threadUuid });
  }

  async newThread(): Promise<void> {
    if (!this.currentWorkspace) {
      return;
    }
    const thread = await this.client.createThread(this.currentWorkspace, "New Thread");
    this.currentThread = thread.uuid;
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
        this.post({ type: "delta", id: frame.id, delta: frame.data?.delta });
        break;
      case "chat.done":
        this.post({ type: "done", id: frame.id });
        break;
      case "chat.error":
        this.post({ type: "error", message: frame.data?.error ?? "chat error" });
        break;
      case "thread.created":
      case "thread.updated":
        if (this.currentWorkspace && frame.data?.workspace_uuid === this.currentWorkspace) {
          void this.loadThreads(this.currentWorkspace);
        }
        break;
    }
  }

  private post(msg: any): void {
    this.view?.webview.postMessage(msg);
  }

  // ── HTML ──────────────────────────────────────────────────────────────────────
  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "main.js"),
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
  <link href="${styleUri}" rel="stylesheet" />
  <title>Subconscious</title>
</head>
<body>
  <main id="messages" class="messages"></main>
  <div id="status" class="status"></div>
  <footer class="composer">
    <div class="composer-box">
      <textarea id="input" rows="1" placeholder="Message Subconscious…"></textarea>
      <div class="toolbar">
        <div class="pickers">
          <button id="model-trigger" class="picker" aria-haspopup="true" title="Model">
            <svg class="ico" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M8 1.5 9.6 5l3.9.3-3 2.6.95 3.8L8 9.9l-3.45 1.8L5.5 7.9l-3-2.6L6.4 5 8 1.5Z"/></svg>
            <span id="model-label" class="picker-text">Model</span>
            <svg class="chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M3.2 5.5a.5.5 0 0 1 .707 0L8 9.593l4.093-4.093a.5.5 0 1 1 .707.707l-4.446 4.446a.5.5 0 0 1-.708 0L3.2 6.207a.5.5 0 0 1 0-.707Z"/></svg>
          </button>
        </div>
        <button id="send" class="send-btn" title="Send" aria-label="Send">
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M8 2.5a.5.5 0 0 1 .354.146l4 4a.5.5 0 0 1-.708.708L8.5 4.207V13a.5.5 0 0 1-1 0V4.207L4.354 7.354a.5.5 0 1 1-.708-.708l4-4A.5.5 0 0 1 8 2.5Z"/></svg>
        </button>
      </div>
    </div>
    <div class="selectors">
      <button id="workspace-trigger" class="picker" aria-haspopup="true" title="Workspace">
        <svg class="ico" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M1.5 3A1.5 1.5 0 0 1 3 1.5h3.09a1.5 1.5 0 0 1 1.06.44l.91.91H13A1.5 1.5 0 0 1 14.5 4.5v7A1.5 1.5 0 0 1 13 13H3a1.5 1.5 0 0 1-1.5-1.5V3Zm1.5-.5a.5.5 0 0 0-.5.5v8.5a.5.5 0 0 0 .5.5h10a.5.5 0 0 0 .5-.5v-7a.5.5 0 0 0-.5-.5H7.75a.5.5 0 0 1-.354-.146l-1.06-1.06a.5.5 0 0 0-.353-.148H3Z"/></svg>
        <span id="workspace-label" class="picker-text">Workspace</span>
        <svg class="chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M3.2 5.5a.5.5 0 0 1 .707 0L8 9.593l4.093-4.093a.5.5 0 1 1 .707.707l-4.446 4.446a.5.5 0 0 1-.708 0L3.2 6.207a.5.5 0 0 1 0-.707Z"/></svg>
      </button>
      <button id="thread-trigger" class="picker" aria-haspopup="true" title="Thread">
        <svg class="ico" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M2.5 2h11A1.5 1.5 0 0 1 15 3.5v6A1.5 1.5 0 0 1 13.5 11H6.7l-3.4 2.85A.5.5 0 0 1 2.5 13.5V11A1.5 1.5 0 0 1 1 9.5v-6A1.5 1.5 0 0 1 2.5 2Zm0 1a.5.5 0 0 0-.5.5v6a.5.5 0 0 0 .5.5h.5v1.93L6.32 10h7.18a.5.5 0 0 0 .5-.5v-6a.5.5 0 0 0-.5-.5h-11Z"/></svg>
        <span id="thread-label" class="picker-text">Thread</span>
        <svg class="chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path fill="currentColor" d="M3.2 5.5a.5.5 0 0 1 .707 0L8 9.593l4.093-4.093a.5.5 0 1 1 .707.707l-4.446 4.446a.5.5 0 0 1-.708 0L3.2 6.207a.5.5 0 0 1 0-.707Z"/></svg>
      </button>
      <button id="new-thread" class="icon-btn" title="New thread" aria-label="New thread">
        <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M8 3.5a.5.5 0 0 1 .5.5v3.5H12a.5.5 0 0 1 0 1H8.5V12a.5.5 0 0 1-1 0V8.5H4a.5.5 0 0 1 0-1h3.5V4a.5.5 0 0 1 .5-.5Z"/></svg>
      </button>
    </div>
  </footer>
  <div id="menu" class="menu" hidden></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
