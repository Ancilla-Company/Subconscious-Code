// Feature: agent-tools-and-settings — the Configure Tools editor-area page.
//
// `ToolsPanel` presents the coding-tool catalogue as a full editor-area webview panel
// (a "virtual page"), mirroring the GitHub Copilot "Configure Tools" surface, rather
// than a cramped Activity Bar view. It is a singleton: opening it again reveals the
// existing panel instead of stacking duplicates. It is opened by the
// `subconscious.configureTools` command — from the Command Palette, or from the
// chat view's title bar.
//
// All tools logic lives in the host-independent `ToolsController`; this class only owns
// the `vscode.WebviewPanel` lifecycle and HTML shell (strict CSP + nonce, reusing
// `media/tools.js` and `media/main.css`), following the existing webview conventions.

import * as vscode from "vscode";

import type { EngineClient } from "../engine/client";
import type { ToolRegistry } from "../tools/registry";
import { ToolsController, type InboundMessage } from "./toolsController";

export class ToolsPanel {
  /** Command that opens (or reveals) the Configure Tools page. */
  public static readonly viewType = "subconscious.configureToolsPanel";

  private static current?: ToolsPanel;

  private readonly controller: ToolsController;
  private readonly disposables: vscode.Disposable[] = [];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    registry: ToolRegistry,
    client: EngineClient,
  ) {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
    };
    // Separate light/dark icons so the tab icon stays visible in every theme.
    panel.iconPath = {
      light: vscode.Uri.joinPath(extensionUri, "media", "icon-tools-light.svg"),
      dark: vscode.Uri.joinPath(extensionUri, "media", "icon-tools-dark.svg"),
    };
    panel.webview.html = this.html(panel.webview, extensionUri);

    this.controller = new ToolsController(registry, client, (msg) =>
      this.panel.webview.postMessage(msg),
    );

    this.disposables.push(
      panel.webview.onDidReceiveMessage((msg: InboundMessage) =>
        this.controller.handleMessage(msg),
      ),
      panel.onDidDispose(() => this.dispose()),
    );
  }

  /** Open the Configure Tools page, revealing the existing one if already open. */
  public static show(
    extensionUri: vscode.Uri,
    registry: ToolRegistry,
    client: EngineClient,
  ): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (ToolsPanel.current !== undefined) {
      ToolsPanel.current.panel.reveal(column);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      ToolsPanel.viewType,
      "Subconscious Tools",
      column,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    ToolsPanel.current = new ToolsPanel(panel, extensionUri, registry, client);
  }

  private dispose(): void {
    ToolsPanel.current = undefined;
    this.controller.dispose();
    for (const d of this.disposables.splice(0)) {
      d.dispose();
    }
    this.panel.dispose();
  }

  private html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "media", "tools.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "media", "main.css"),
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
  <title>Subconscious Tools</title>
</head>
<body class="tools-page">
  <div class="tools-page-inner">
    <header class="tools-page-header">
      <h1 class="tools-page-title">Tools</h1>
      <p class="tools-page-subtitle">Select the tools available to the agent. Changes apply to every chat session.</p>
      <div id="disconnected" class="disconnected-banner" hidden>
        Disconnected from engine — changes are saved locally and applied on reconnect.
      </div>
    </header>
    <main id="tools" class="tools-list" aria-label="Agent tools"></main>
    <div id="empty" class="empty-state" hidden>No tools are available.</div>
  </div>
  <div id="menu" class="menu" hidden></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/** Generate a CSP nonce for the inline script tag. */
function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
