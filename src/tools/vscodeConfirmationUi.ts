// Feature: agent-tools-and-settings — VS Code confirmation UI for the ApprovalManager.
//
// This is the concrete `ConfirmationUI` used in production. It is kept in its own
// module so `approvalManager.ts` stays free of any `vscode` dependency and can be
// exercised outside the extension host. The ApprovalManager owns the confirmation
// timeout (Requirement 5.11); this surface only renders the confirmation UI and maps
// the user's button choice to a `ConfirmationOutcome`.
//
// The prompt is presented ENTIRELY as an **in-chat dialogue** (posted to the chat
// webview, rendered inline in the message stream) — never as a modal
// `showInformationMessage`/`showWarningMessage` alert. It names the tool, the target
// path/command string, and the affected resources, and — for a decomposed terminal
// command — lists every Command_Segment (Requirement 5.8, 10.2). When a command could
// not be decomposed the dialogue states so explicitly (Requirement 10.7). A cancelled
// confirmation maps to `decline` (Requirement 5.11 is enforced by the manager's
// timeout; cancellation is an immediate decline).
//
// A native VS Code notification (`window.showInformationMessage`, non-modal — a
// dismissible toast, not a blocking alert) is shown ONLY when the editor window is
// not currently focused/active (`vscode.window.state.focused` is false), so the user
// is alerted to a pending approval without being interrupted while they're already
// looking at the chat. Clicking it focuses the chat view; leaving it alone still lets
// the in-chat dialogue wait for a response.
//
// _Requirements: 5.7, 5.8, 5.10, 6.1, 10.2, 10.7_

import * as vscode from "vscode";

import type {
  ApprovalPrompt,
  ConfirmationOutcome,
  ConfirmationUI,
} from "./approvalManager";

/**
 * A {@link ConfirmationUI} that posts confirmation requests to the chat webview
 * and awaits the user's response. Renders the prompt inline in the chat and shows
 * a desktop notification when the IDE is not active.
 */
export class VsCodeConfirmationUI implements ConfirmationUI {
  private readonly responsePromises = new Map<
    string,
    {
      resolve: (outcome: ConfirmationOutcome) => void;
      reject: (err: Error) => void;
    }
  >();
  private requestIdCounter = 0;

  /**
   * @param postToChat  Function to post a message to the chat webview.
   *                    Should be bound to the ChatPanel's post method.
   * @param isChatVisible Optional check for whether the chat view itself is
   *                    currently visible (e.g. `ChatPanel.isVisible.bind(chat)`).
   *                    Combined with the window's own focus state so a notification
   *                    is also shown when the window is focused but the user is
   *                    looking at a different view/panel. Omit to fall back to
   *                    window-focus only.
   */
  public constructor(
    private readonly postToChat: (message: any) => void,
    private readonly isChatVisible?: () => boolean,
  ) {}

  public async confirm(prompt: ApprovalPrompt): Promise<ConfirmationOutcome> {
    const requestId = String(++this.requestIdCounter);

    // Post the confirmation request to the chat webview — this IS the confirmation
    // UI; it is rendered inline in the message stream, never as a modal alert.
    this.postToChat({
      type: "confirmationRequest",
      requestId,
      prompt: {
        toolId: prompt.toolId,
        toolName: prompt.toolName,
        target: prompt.target,
        affectedResources: prompt.affectedResources,
        segments: prompt.segments,
        decomposed: prompt.decomposed,
      },
    });

    // Only nudge with a native (non-modal, dismissible) VS Code notification when the
    // editor window isn't focused OR the chat view itself isn't currently visible —
    // in either case the user has no other way to notice a pending approval. When
    // the window is focused AND the chat is visible, the in-chat dialogue alone is
    // sufficient and an extra notification would just be noise/an unwanted alert.
    const chatVisible = this.isChatVisible?.() ?? true;
    if (!vscode.window.state.focused || !chatVisible) {
      void vscode.window
        .showInformationMessage(`Subconscious needs approval: ${prompt.toolName}`, "Show Chat")
        .then((choice) => {
          if (choice === "Show Chat") {
            void vscode.commands.executeCommand("subconscious.chat.focus");
          }
        });
    }

    // Return a promise that resolves when handleConfirmationResponse is called.
    return new Promise<ConfirmationOutcome>((resolve, reject) => {
      this.responsePromises.set(requestId, { resolve, reject });
    });
  }

  /**
   * Handle a confirmation response from the webview.
   * Called by the ChatPanel when the user clicks Approve/Decline/etc.
   */
  public handleConfirmationResponse(
    requestId: string,
    outcome: ConfirmationOutcome,
  ): void {
    const handlers = this.responsePromises.get(requestId);
    if (handlers) {
      this.responsePromises.delete(requestId);
      handlers.resolve(outcome);
    }
  }

  /**
   * Cancel a pending confirmation (e.g., on timeout).
   */
  public cancelConfirmation(requestId: string): void {
    const handlers = this.responsePromises.get(requestId);
    if (handlers) {
      this.responsePromises.delete(requestId);
      handlers.resolve("decline");
    }
  }

  /**
   * Cancel all pending confirmations (e.g., on extension disposal).
   */
  public cancelAll(): void {
    for (const handlers of this.responsePromises.values()) {
      handlers.resolve("decline");
    }
    this.responsePromises.clear();
  }
}
