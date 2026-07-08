import * as vscode from "vscode";
import { EngineClient } from "./engine/client";
import { ChatPanel } from "./panel/chatPanel";

let client: EngineClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  client = new EngineClient();
  const panel = new ChatPanel(context.extensionUri, client);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatPanel.viewType, panel),
    vscode.commands.registerCommand("subconscious.reconnect", () => connect(client!)),
    vscode.commands.registerCommand("subconscious.newThread", () => panel.newThread()),
    vscode.commands.registerCommand("subconscious.selectWorkspace", async () => {
      // The picker UI lives in the webview header; this command just focuses it.
      await vscode.commands.executeCommand("subconscious.chat.focus");
    }),
    { dispose: () => client?.dispose() },
  );

  await connect(client);
}

async function connect(c: EngineClient): Promise<void> {
  try {
    await vscode.window.withProgress(
      { location: { viewId: ChatPanel.viewType }, title: "Connecting to Subconscious engine…" },
      () => c.connect(),
    );
  } catch (err: any) {
    vscode.window.showErrorMessage(`Subconscious: ${err?.message ?? err}`);
  }
}

export function deactivate(): void {
  client?.dispose();
}
