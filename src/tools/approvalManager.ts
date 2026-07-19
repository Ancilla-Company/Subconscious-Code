// Feature: agent-tools-and-settings — the approval and autonomy model (ApprovalManager).
//
// The ApprovalManager is the single choke point that decides whether a tool
// invocation runs automatically or must be confirmed by the user, and — when a
// confirmation is required — drives the confirmation UI. It resolves the effective
// decision from the tool's classification, its per-tool Approval_Policy (read from
// the ToolRegistry), and the agent-wide Autonomy_Mode, following the
// classification × policy × autonomy decision table in the design.
//
// Decision table (Requirement 5.2–5.6, 5.9, 6.1, 8.2):
//
//   | Classification | Policy         | Autonomy    | Result |
//   | -------------- | -------------- | ----------- | ------ |
//   | read-only      | always-ask     | any         | prompt |
//   | read-only      | inherit / auto | any         | auto   |
//   | mutating       | auto-approve   | any         | auto   |
//   | mutating       | always-ask     | any         | prompt |
//   | mutating       | inherit        | supervised  | prompt |
//   | mutating       | inherit        | auto        | auto   |
//
// `run_terminal` is mutating and follows the same table, but adds per-segment
// handling: the command string is decomposed and, whenever the base decision would
// run the command without confirmation, each Command_Segment is evaluated against
// the auto-approve allowlist — any uncovered segment forces a prompt (Requirement
// 10.5, 10.6). An undecomposable command always forces whole-string confirmation
// (Requirement 10.7). A successful "allow for this session" grant records the tool
// id so subsequent invocations of that tool skip confirmation for the session
// (Requirement 5.10).
//
// This module is intentionally free of any `vscode` dependency: the confirmation UI
// is injected as a `ConfirmationUI` so the decision logic (`resolve`) and the
// confirmation flow (`requestConfirmation`) can be exercised outside the VS Code
// host. Production wiring passes the `VsCodeConfirmationUI` from
// `./vscodeConfirmationUi`. `resolve` is a pure function of its inputs and the
// manager's current mutable state (mode, session grants, allowlist).
//
// _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.11, 6.1, 8.2, 10.5, 10.6_

import type { CommandDecomposer, ShellKind } from "./commandDecomposer";
import type { ApprovalPolicy, AutonomyMode, ToolDefinition, ToolState } from "./types";

// -----------------------------------------------------------------------------
// Decision + prompt shapes
// -----------------------------------------------------------------------------

/**
 * A confirmation prompt describing a pending mutating action (Requirement 5.8).
 * `toolId` is the stable identifier used for internal correlation and session
 * grants; `toolName` is the human-facing display name shown to the user.
 */
export interface ApprovalPrompt {
  /** Stable tool identifier (used for session grants; not necessarily displayed). */
  readonly toolId: string;
  /** Human-facing tool name shown in the prompt (Requirement 5.8). */
  readonly toolName: string;
  /** The target path or command string the action operates on (Requirement 5.8). */
  readonly target: string;
  /** Resources to be created, modified, or deleted (Requirement 5.8). */
  readonly affectedResources: string[];
  /** Terminal Command_Segments, when the tool is `run_terminal` (Requirement 10.2). */
  readonly segments?: string[];
  /** `false` when a terminal command string could not be decomposed (Requirement 10.7). */
  readonly decomposed: boolean;
}

/**
 * The outcome of resolving an invocation against the decision table:
 * - `auto`         — run without confirmation.
 * - `auto-session` — run without confirmation because an "allow for session" grant
 *                    covers this tool (Requirement 5.10).
 * - `prompt`       — confirmation is required; `prompt` describes the action.
 */
export type ApprovalDecision =
  | { readonly outcome: "auto" }
  | { readonly outcome: "auto-session" }
  | { readonly outcome: "prompt"; readonly prompt: ApprovalPrompt };

// -----------------------------------------------------------------------------
// Injected collaborators
// -----------------------------------------------------------------------------

/** The user's response to a confirmation prompt. */
export type ConfirmationOutcome = "approve" | "approve-for-session" | "decline";

/**
 * The confirmation UI surface. Injected so the manager stays free of `vscode` and
 * can be tested outside the host. `confirm` resolves with the user's choice; a
 * dismissed prompt resolves to `decline`.
 */
export interface ConfirmationUI {
  confirm(prompt: ApprovalPrompt): Promise<ConfirmationOutcome>;
}

/**
 * The minimal ToolRegistry surface the manager reads to obtain a tool's effective
 * Approval_Policy. `ToolRegistry` satisfies this structurally.
 */
export interface ApprovalPolicyView {
  stateOf(id: string): ToolState;
}

/**
 * The auto-approve allowlist evaluated per Command_Segment for terminal commands
 * (Requirement 10.5, 10.6). When no allowlist is "in play" (none configured), a
 * terminal command whose base decision is auto runs without per-segment checks.
 */
export interface TerminalAllowlist {
  /** Whether the given Command_Segment is covered (auto-approvable). */
  covers(segment: string): boolean;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Default confirmation timeout: a dismissed/unanswered prompt declines (Requirement 5.11). */
export const CONFIRMATION_TIMEOUT_MS = 300_000;

/** The identifier of the terminal tool that receives per-segment handling. */
export const RUN_TERMINAL_TOOL_ID = "run_terminal";

/** Default autonomy posture (Requirement 9.2). */
const DEFAULT_MODE: AutonomyMode = "supervised";

/** Choose a sensible default shell for command decomposition from the platform. */
function defaultShell(): ShellKind {
  return process.platform === "win32" ? "powershell" : "posix";
}

// -----------------------------------------------------------------------------
// Options
// -----------------------------------------------------------------------------

/** Construction options for {@link ApprovalManager}. */
export interface ApprovalManagerOptions {
  /** Source of each tool's effective Approval_Policy (typically the ToolRegistry). */
  readonly policyView: ApprovalPolicyView;
  /** UI used to obtain confirmation; injected for testability. */
  readonly confirmationUi: ConfirmationUI;
  /** Decomposes terminal command strings into Command_Segments. */
  readonly decomposer: CommandDecomposer;
  /** Initial autonomy mode; defaults to `supervised`. */
  readonly initialMode?: AutonomyMode;
  /** Target shell for decomposition; defaults to a platform-appropriate shell. */
  readonly shell?: ShellKind;
  /** Auto-approve allowlist for terminal segments; omit for none "in play". */
  readonly terminalAllowlist?: TerminalAllowlist;
  /** Confirmation timeout in milliseconds; defaults to {@link CONFIRMATION_TIMEOUT_MS}. */
  readonly confirmationTimeoutMs?: number;
  /** The id of the terminal tool; defaults to {@link RUN_TERMINAL_TOOL_ID}. */
  readonly terminalToolId?: string;
}

// -----------------------------------------------------------------------------
// ApprovalManager
// -----------------------------------------------------------------------------

/**
 * Resolves whether a tool call runs automatically or needs confirmation, and drives
 * the confirmation UI when needed. All mutating execution passes through here; tools
 * never decide their own approval.
 */
export class ApprovalManager {
  private readonly policyView: ApprovalPolicyView;
  private readonly confirmationUi: ConfirmationUI;
  private readonly decomposer: CommandDecomposer;
  private readonly shell: ShellKind;
  private readonly confirmationTimeoutMs: number;
  private readonly terminalToolId: string;

  private currentMode: AutonomyMode;
  private allowlist: TerminalAllowlist | undefined;

  /** Tool ids granted "allow for this session"; cleared only by disposal/restart. */
  private readonly sessionGrants = new Set<string>();

  public constructor(options: ApprovalManagerOptions) {
    this.policyView = options.policyView;
    this.confirmationUi = options.confirmationUi;
    this.decomposer = options.decomposer;
    this.shell = options.shell ?? defaultShell();
    this.confirmationTimeoutMs =
      options.confirmationTimeoutMs ?? CONFIRMATION_TIMEOUT_MS;
    this.terminalToolId = options.terminalToolId ?? RUN_TERMINAL_TOOL_ID;
    this.currentMode = options.initialMode ?? DEFAULT_MODE;
    this.allowlist = options.terminalAllowlist;
  }

  /** The current agent-wide autonomy posture (Requirement 5.1). */
  public get mode(): AutonomyMode {
    return this.currentMode;
  }

  /**
   * Set the agent-wide autonomy mode. The new mode applies to every subsequent
   * `resolve` call (Requirement 5.1, 8.2).
   */
  public setAutonomyMode(mode: AutonomyMode): void {
    this.currentMode = mode;
  }

  /**
   * Configure (or clear) the auto-approve allowlist evaluated per terminal segment
   * (Requirement 10.5, 10.6). Passing `undefined` removes the allowlist from play.
   */
  public setTerminalAllowlist(allowlist: TerminalAllowlist | undefined): void {
    this.allowlist = allowlist;
  }

  /**
   * Record an "allow for this session" grant so subsequent invocations of `toolId`
   * resolve without confirmation for the remainder of the session (Requirement 5.10).
   */
  public grantForSession(toolId: string): void {
    this.sessionGrants.add(toolId);
  }

  /** Whether a session grant currently covers `toolId`. */
  public hasSessionGrant(toolId: string): boolean {
    return this.sessionGrants.has(toolId);
  }

  /**
   * Resolve whether an invocation of `def` with `input` runs automatically or needs
   * confirmation, per the classification × policy × autonomy decision table. This is
   * a pure function of `def`, `input`, and the manager's current mode, session
   * grants, and allowlist; it performs no I/O and drives no UI.
   *
   * @returns an {@link ApprovalDecision}. When `prompt`, the caller drives
   *          {@link requestConfirmation} with the returned prompt.
   */
  public resolve(def: ToolDefinition, input: unknown): ApprovalDecision {
    // A session grant short-circuits every other rule (Requirement 5.10).
    if (this.sessionGrants.has(def.id)) {
      return { outcome: "auto-session" };
    }

    const policy = this.policyView.stateOf(def.id).approvalPolicy;

    if (this.isTerminalTool(def)) {
      return this.resolveTerminal(def, input, policy);
    }

    if (this.baseDecisionIsPrompt(def, policy)) {
      return { outcome: "prompt", prompt: this.buildPrompt(def, input) };
    }
    return { outcome: "auto" };
  }

  /**
   * Drive the confirmation UI for `prompt`, applying the confirmation timeout: a
   * dismissed or unanswered prompt is treated as a decline (Requirement 5.11). When
   * the user chooses "allow for this session", the grant is recorded and `true` is
   * returned (Requirement 5.10).
   *
   * @returns `true` when the action is approved, `false` when declined/timed out.
   */
  public async requestConfirmation(prompt: ApprovalPrompt): Promise<boolean> {
    const outcome = await this.withTimeout(this.confirmationUi.confirm(prompt));
    if (outcome === "approve-for-session") {
      this.grantForSession(prompt.toolId);
      return true;
    }
    return outcome === "approve";
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private isTerminalTool(def: ToolDefinition): boolean {
    return def.id === this.terminalToolId || def.category === "terminal";
  }

  /**
   * The base (non-terminal) decision: `true` ⇒ prompt, `false` ⇒ auto, per the
   * decision table. `always-ask` always prompts; `auto-approve` never prompts;
   * `inherit` prompts only for mutating tools under `supervised`.
   */
  private baseDecisionIsPrompt(def: ToolDefinition, policy: ApprovalPolicy): boolean {
    if (policy === "always-ask") {
      return true;
    }
    if (policy === "auto-approve") {
      return false;
    }
    // policy === "inherit"
    if (def.classification === "read-only") {
      return false;
    }
    return this.currentMode === "supervised";
  }

  /**
   * Resolve a `run_terminal` invocation. Decomposes the command; an undecomposable
   * command forces whole-string confirmation (Requirement 10.7). When the base
   * decision would run without confirmation, each segment is checked against the
   * allowlist (when one is in play) and any uncovered segment forces a prompt
   * (Requirement 10.5, 10.6). Otherwise every segment is listed for confirmation
   * (Requirement 6.1, 10.2).
   */
  private resolveTerminal(
    def: ToolDefinition,
    input: unknown,
    policy: ApprovalPolicy,
  ): ApprovalDecision {
    const command = extractCommand(input);
    const decomposition = this.decomposer.decompose(command, this.shell);

    if (!decomposition.ok) {
      // Undecomposable ⇒ confirm the entire string, flagged as not decomposed.
      return {
        outcome: "prompt",
        prompt: {
          toolId: def.id,
          toolName: def.displayName,
          target: command,
          affectedResources: [command],
          segments: [command],
          decomposed: false,
        },
      };
    }

    const segments = decomposition.segments;
    const promptDecision: ApprovalDecision = {
      outcome: "prompt",
      prompt: {
        toolId: def.id,
        toolName: def.displayName,
        target: command,
        affectedResources: [...segments],
        segments: [...segments],
        decomposed: true,
      },
    };

    if (this.baseDecisionIsPrompt(def, policy)) {
      return promptDecision;
    }

    // Base decision is auto: gate on the per-segment allowlist when one is in play.
    if (this.allowlist !== undefined) {
      const allCovered = segments.every((segment) =>
        this.allowlist!.covers(segment),
      );
      return allCovered ? { outcome: "auto" } : promptDecision;
    }

    return { outcome: "auto" };
  }

  /** Build a confirmation prompt for a non-terminal mutating/read-only tool. */
  private buildPrompt(def: ToolDefinition, input: unknown): ApprovalPrompt {
    return {
      toolId: def.id,
      toolName: def.displayName,
      target: describeTarget(def, input),
      affectedResources: describeResources(def, input),
      decomposed: true,
    };
  }

  /**
   * Race `pending` against the confirmation timeout. If the timeout elapses first,
   * resolve to `decline` (Requirement 5.11).
   */
  private withTimeout(
    pending: Promise<ConfirmationOutcome>,
  ): Promise<ConfirmationOutcome> {
    return new Promise<ConfirmationOutcome>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          resolve("decline");
        }
      }, this.confirmationTimeoutMs);
      // Do not keep the event loop alive solely for this timer.
      if (typeof timer.unref === "function") {
        timer.unref();
      }
      pending.then(
        (outcome) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(outcome);
          }
        },
        () => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve("decline");
          }
        },
      );
    });
  }
}

// -----------------------------------------------------------------------------
// Input inspection helpers (pure)
// -----------------------------------------------------------------------------

/** Read the `command` string from a terminal tool's input, or "" when absent. */
function extractCommand(input: unknown): string {
  if (isRecord(input) && typeof input.command === "string") {
    return input.command;
  }
  return "";
}

/**
 * Describe the target a tool operates on for the confirmation prompt (Requirement
 * 5.8): the command for terminal tools, otherwise a recognized path/url/query field.
 */
function describeTarget(def: ToolDefinition, input: unknown): string {
  if (!isRecord(input)) {
    return "";
  }
  if (def.category === "terminal") {
    return typeof input.command === "string" ? input.command : "";
  }
  for (const key of ["path", "url", "query"] as const) {
    const value = input[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return "";
}

/**
 * Describe the resources a mutating tool creates, modifies, or deletes for the
 * confirmation prompt (Requirement 5.8). Read-only tools affect nothing.
 */
function describeResources(def: ToolDefinition, input: unknown): string[] {
  if (def.classification !== "mutating" || !isRecord(input)) {
    return [];
  }
  if (typeof input.path === "string") {
    return [input.path];
  }
  return [];
}

/** Narrow an unknown value to a plain record for safe field access. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
