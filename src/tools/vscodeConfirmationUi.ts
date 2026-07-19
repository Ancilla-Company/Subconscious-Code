// Feature: agent-tools-and-settings — VS Code confirmation UI for the ApprovalManager.
//
// This is the concrete `ConfirmationUI` used in production. It is kept in its own
// module so `approvalManager.ts` stays free of any `vscode` dependency and can be
// exercised outside the extension host. The ApprovalManager owns the confirmation
// timeout (Requirement 5.11); this surface only renders the modal and maps the
// user's button choice to a `ConfirmationOutcome`.
//
// The prompt is presented as a modal warning so the agent cannot silently mutate the
// workspace: it names the tool, the target path/command string, and the affected
// resources, and — for a decomposed terminal command — lists every Command_Segment
// (Requirement 5.8, 10.2). When a command could not be decomposed the modal states
// so explicitly (Requirement 10.7). A dismissed modal maps to `decline` (Requirement
// 5.11 is enforced by the manager's timeout; dismissal is an immediate decline).
//
// _Requirements: 5.7, 5.8, 5.10, 6.1, 10.2, 10.7_

import * as vscode from "vscode";

import type {
  ApprovalPrompt,
  ConfirmationOutcome,
  ConfirmationUI,
} from "./approvalManager";

/** Modal button label: approve this single invocation. */
const APPROVE_LABEL = "Approve";
/** Modal button label: approve every future invocation of this tool this session. */
const APPROVE_SESSION_LABEL = "Allow for this Session";

/**
 * A {@link ConfirmationUI} backed by `vscode.window.showWarningMessage`. Renders a
 * modal describing the pending action and maps the chosen button to an outcome.
 */
export class VsCodeConfirmationUI implements ConfirmationUI {
  public async confirm(prompt: ApprovalPrompt): Promise<ConfirmationOutcome> {
    const detail = buildDetail(prompt);
    const choice = await vscode.window.showWarningMessage(
      `Allow ${prompt.toolName} to run?`,
      { modal: true, detail },
      APPROVE_LABEL,
      APPROVE_SESSION_LABEL,
    );

    if (choice === APPROVE_LABEL) {
      return "approve";
    }
    if (choice === APPROVE_SESSION_LABEL) {
      return "approve-for-session";
    }
    // Escape/dismiss (undefined) ⇒ declined (Requirement 5.7).
    return "decline";
  }
}

/**
 * Compose the modal detail text from the prompt: the target, the affected resources
 * or command segments, and a note when a terminal command could not be decomposed.
 */
function buildDetail(prompt: ApprovalPrompt): string {
  const lines: string[] = [];

  if (prompt.target.length > 0) {
    lines.push(`Target: ${prompt.target}`);
  }

  if (prompt.segments !== undefined && prompt.segments.length > 0) {
    if (!prompt.decomposed) {
      lines.push(
        "This command could not be decomposed into individual commands and will run as a single string:",
      );
    } else {
      lines.push("Commands to run:");
    }
    for (const segment of prompt.segments) {
      lines.push(`  • ${segment}`);
    }
  } else if (prompt.affectedResources.length > 0) {
    lines.push("Affected resources:");
    for (const resource of prompt.affectedResources) {
      lines.push(`  • ${resource}`);
    }
  }

  return lines.join("\n");
}
