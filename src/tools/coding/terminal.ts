// Feature: agent-tools-and-settings — the terminal-executing coding tools.
//
// This module implements the two terminal Coding_Tools:
//
//   - `run_terminal` — runs a shell command supplied by the engine.
//   - `run_tests`    — runs the project's test command as recorded in the active
//                      Execution_Profile.
//
// Both tools follow the same safety pipeline (Requirement 6.1, 6.6, 10.2–10.4,
// 11.11, 11.13):
//
//   1. Derive the effective command string (from the input for `run_terminal`; from
//      the profile's test `CommandSpec` for `run_tests`).
//   2. Obtain approval through the shared `ApprovalManager`, which decomposes the
//      command into its Command_Segments and — when confirmation is required —
//      presents every segment for approval; declining leaves the workspace untouched
//      and yields a typed `rejected` error (Requirement 10.2–10.4, 6.1).
//   3. Set the command's working directory to a Workspace_Root (Requirement 6.6).
//   4. Apply any environment activation recorded in the Execution_Profile before the
//      command runs (Requirement 11.11); when a required activation cannot be applied
//      the command is aborted with an `activation-failure` error and the profile is
//      left unchanged (Requirement 11.13).
//   5. Run the effective command through the injected `CommandRunner`.
//
// The process-spawning function is an injected `CommandRunner` dependency so tests can
// substitute a deterministic fake command-runner instead of spawning real shell
// processes; the approval surface is likewise the injected `ApprovalManager`. This
// keeps the tool exercisable outside the VS Code host and prevents property tests from
// launching a storm of real shell/conda processes. Production wiring passes
// {@link nodeCommandRunner}.
//
// Failures are signalled by throwing a `ToolExecutionError` carrying a typed
// `ToolError`, matching the shared error-signalling contract in `../errors`; the
// `ToolHost` maps these into the `tool.result` frame it returns to the engine.
//
// _Requirements: 6.1, 6.6, 10.2, 10.3, 10.4, 11.11, 11.13_

import { spawn } from "child_process";

import type { ExecutionProfile } from "../../env/types";
import type {
  ApprovalDecision,
  ApprovalPrompt,
} from "../approvalManager";
import { RUN_TERMINAL_TOOL_ID } from "../approvalManager";
import type { ShellKind } from "../commandDecomposer";
import { ToolExecutionError } from "../errors";
import { BUILTIN_TOOL_DEFINITIONS } from "../registry";
import type {
  CodingTool,
  ToolContext,
  ToolDefinition,
  ToolOutput,
} from "../types";

// -----------------------------------------------------------------------------
// Identifiers
// -----------------------------------------------------------------------------

/** The `run_tests` tool identifier, matching its `ToolDefinition` in the registry. */
export const RUN_TESTS_TOOL_ID = "run_tests";

// -----------------------------------------------------------------------------
// Injected collaborators
// -----------------------------------------------------------------------------

/** A fully-resolved command invocation handed to the {@link CommandRunner}. */
export interface CommandInvocation {
  /** The effective command line, with any environment activation already applied. */
  readonly command: string;
  /** The working directory; always one of the Workspace_Roots (Requirement 6.6). */
  readonly cwd: string;
  /** The target shell whose syntax was used for decomposition. */
  readonly shell: ShellKind;
}

/** The outcome of running a command through a {@link CommandRunner}. */
export interface CommandRunResult {
  /** The process exit code, or `null` when the process was terminated by a signal. */
  readonly exitCode: number | null;
  /** Captured standard output. */
  readonly stdout: string;
  /** Captured standard error. */
  readonly stderr: string;
}

/**
 * Runs a command and resolves with its captured output. Injected into the terminal
 * tools so tests can substitute a deterministic fake that never spawns a real shell
 * process; production uses {@link nodeCommandRunner}.
 */
export type CommandRunner = (
  invocation: CommandInvocation,
  signal: AbortSignal,
) => Promise<CommandRunResult>;

/**
 * The minimal `ApprovalManager` surface the terminal tools depend on: resolve a
 * decision for a command and, when confirmation is required, drive the confirmation
 * UI. `ApprovalManager` satisfies this structurally, and it stays injectable so the
 * approval flow can be exercised with a fake outside the host.
 */
export interface TerminalApprover {
  resolve(def: ToolDefinition, input: unknown): ApprovalDecision;
  requestConfirmation(prompt: ApprovalPrompt): Promise<boolean>;
}

// -----------------------------------------------------------------------------
// Default (production) command runner
// -----------------------------------------------------------------------------

/**
 * Default {@link CommandRunner} backed by Node's `child_process.spawn`, running the
 * command through the platform shell. The ambient abort signal is forwarded to the
 * child so a tool timeout terminates the process.
 *
 * Security note: the command originates from the engine and has already passed
 * per-segment approval before this runner is invoked; it is executed in a
 * Workspace_Root with the caller's environment.
 */
export const nodeCommandRunner: CommandRunner = (
  invocation: CommandInvocation,
  signal: AbortSignal,
): Promise<CommandRunResult> =>
  new Promise<CommandRunResult>((resolve, reject) => {
    const child = spawn(invocation.command, {
      cwd: invocation.cwd,
      shell: true,
      signal,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error: Error) => {
      reject(error);
    });
    child.on("close", (code: number | null) => {
      resolve({ exitCode: code, stdout, stderr });
    });
  });

// -----------------------------------------------------------------------------
// Shared helpers (pure)
// -----------------------------------------------------------------------------

/** Choose a platform-appropriate shell for decomposition/execution. */
function defaultShell(): ShellKind {
  return process.platform === "win32" ? "powershell" : "posix";
}

/** Look up a built-in tool definition by id, or throw if it is missing. */
function builtinDefinition(id: string): ToolDefinition {
  const def = BUILTIN_TOOL_DEFINITIONS.find((candidate) => candidate.id === id);
  if (def === undefined) {
    throw new Error(`Missing built-in tool definition for "${id}".`);
  }
  return def;
}

/**
 * The outcome of resolving the environment activation to apply before a command.
 * `none` ⇒ no activation is required; `apply` ⇒ prefix the given activation command;
 * `failure` ⇒ an activation is required but could not be applied (Requirement 11.13).
 */
type ActivationResolution =
  | { readonly kind: "none" }
  | { readonly kind: "apply"; readonly command: string }
  | { readonly kind: "failure"; readonly reason: string };

/**
 * Resolve the environment activation recorded for the active profile. The first
 * detected technology whose environment requires activation (kind other than
 * `none`) governs: a recorded, non-empty activation command is applied
 * (Requirement 11.11); a required activation with no recorded command cannot be
 * applied and is reported as a failure (Requirement 11.13).
 */
function resolveActivation(
  profile: ExecutionProfile | undefined,
): ActivationResolution {
  if (profile === undefined) {
    return { kind: "none" };
  }
  for (const technology of profile.technologies) {
    const environment = technology.environment;
    if (environment === undefined || environment.kind === "none") {
      continue;
    }
    const activationCommand = environment.activationCommand;
    if (
      typeof activationCommand === "string" &&
      activationCommand.trim().length > 0
    ) {
      return { kind: "apply", command: activationCommand };
    }
    return {
      kind: "failure",
      reason: `The ${environment.kind} environment for ${technology.language} requires activation, but no activation command is recorded in the execution profile.`,
    };
  }
  return { kind: "none" };
}

/** Chain an activation command before the target command using the shell sequencer. */
function withActivation(activationCommand: string, command: string): string {
  return `${activationCommand} && ${command}`;
}

/** Narrow an unknown value to a plain record for safe field access. */
function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ToolExecutionError({
      kind: "validation",
      message: "Tool input must be an object.",
    });
  }
  return input as Record<string, unknown>;
}

/** Format a completed command's captured output into a `ToolOutput`. */
function formatResult(
  invocation: CommandInvocation,
  result: CommandRunResult,
): ToolOutput {
  const parts: string[] = [];
  if (result.stdout.length > 0) {
    parts.push(result.stdout);
  }
  if (result.stderr.length > 0) {
    parts.push(result.stderr);
  }
  const content =
    parts.length > 0
      ? parts.join("\n")
      : `Command completed with exit code ${String(result.exitCode)}.`;

  return {
    content,
    data: {
      command: invocation.command,
      cwd: invocation.cwd,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    },
  };
}

// -----------------------------------------------------------------------------
// Shared execution engine for the terminal tools
// -----------------------------------------------------------------------------

/** Construction options shared by the terminal tools. */
export interface TerminalToolOptions {
  /** Approval surface used to decompose and confirm the command. */
  readonly approval: TerminalApprover;
  /** Injected command-runner; defaults to {@link nodeCommandRunner}. */
  readonly runner?: CommandRunner;
  /** Target shell for decomposition/execution; defaults to a platform shell. */
  readonly shell?: ShellKind;
}

/**
 * Run the shared terminal safety pipeline for `command`: obtain approval through the
 * `ApprovalManager` (per-segment when confirmation is required), select a
 * Workspace_Root as the working directory, apply any required environment activation,
 * and finally run the effective command through the injected runner.
 *
 * `approvalDef` is the definition passed to `ApprovalManager.resolve`; its category is
 * coerced to `terminal` so both `run_terminal` and `run_tests` receive per-segment
 * decomposition and confirmation while keeping their own id (for session grants) and
 * display name (for the prompt).
 */
async function executeCommand(
  command: string,
  ownDef: ToolDefinition,
  ctx: ToolContext,
  approval: TerminalApprover,
  runner: CommandRunner,
  shell: ShellKind,
): Promise<ToolOutput> {
  // A Workspace_Root must exist before any terminal command can run (Requirement 6.6).
  const roots = ctx.guard.roots();
  if (roots.length === 0) {
    throw new ToolExecutionError({
      kind: "no-workspace",
      message: "No workspace folder is open; cannot run terminal commands.",
    });
  }

  // 1–2. Decompose + obtain per-segment approval (Requirement 6.1, 10.2–10.4).
  const approvalDef: ToolDefinition = { ...ownDef, category: "terminal" };
  const decision = approval.resolve(approvalDef, { command });
  if (decision.outcome === "prompt") {
    const approved = await approval.requestConfirmation(decision.prompt);
    if (!approved) {
      // Declined: no Command_Segment runs and the workspace is unchanged.
      const segments = decision.prompt.segments ?? [command];
      throw new ToolExecutionError({
        kind: "rejected",
        message: `Execution of the command was declined; no command was run: ${command}`,
        segment: segments[0],
      });
    }
  }

  // 3. Working directory is a Workspace_Root (Requirement 6.6).
  const cwd = selectWorkspaceRoot(ctx, roots);

  // 4. Apply any recorded environment activation (Requirement 11.11, 11.13).
  const activation = resolveActivation(ctx.profile);
  if (activation.kind === "failure") {
    // Abort without running; the profile is left unchanged (Requirement 11.13).
    throw new ToolExecutionError({
      kind: "activation-failure",
      message: activation.reason,
    });
  }
  const effectiveCommand =
    activation.kind === "apply"
      ? withActivation(activation.command, command)
      : command;

  // 5. Run the effective command through the injected runner.
  if (ctx.signal.aborted) {
    throw new ToolExecutionError({
      kind: "timeout",
      message: "The command was aborted before it could start.",
    });
  }

  const invocation: CommandInvocation = { command: effectiveCommand, cwd, shell };
  let result: CommandRunResult;
  try {
    result = await runner(invocation, ctx.signal);
  } catch (error) {
    if (ctx.signal.aborted) {
      throw new ToolExecutionError({
        kind: "timeout",
        message: "The command was aborted before it could complete.",
      });
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new ToolExecutionError({
      kind: "execution",
      message: `Failed to run command: ${reason}`,
    });
  }

  return formatResult(invocation, result);
}

/**
 * Select the Workspace_Root to use as the working directory (Requirement 6.6),
 * preferring the active profile's root when it is one of the open roots.
 */
function selectWorkspaceRoot(ctx: ToolContext, roots: string[]): string {
  const profileRoot = ctx.profile?.root;
  if (profileRoot !== undefined && roots.includes(profileRoot)) {
    return profileRoot;
  }
  return roots[0];
}

// -----------------------------------------------------------------------------
// run_terminal
// -----------------------------------------------------------------------------

/**
 * `run_terminal` — run a shell command supplied by the engine, gated by per-segment
 * approval and confined to a Workspace_Root.
 */
export class RunTerminalTool implements CodingTool {
  public readonly id = RUN_TERMINAL_TOOL_ID;

  private readonly approval: TerminalApprover;
  private readonly runner: CommandRunner;
  private readonly shell: ShellKind;
  private readonly definition: ToolDefinition;

  public constructor(options: TerminalToolOptions) {
    this.approval = options.approval;
    this.runner = options.runner ?? nodeCommandRunner;
    this.shell = options.shell ?? defaultShell();
    this.definition = builtinDefinition(RUN_TERMINAL_TOOL_ID);
  }

  public async execute(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
    const record = asRecord(input);
    const command = record.command;
    if (typeof command !== "string" || command.trim().length === 0) {
      throw new ToolExecutionError({
        kind: "validation",
        message: "run_terminal requires a non-empty string 'command'.",
        field: "command",
      });
    }

    return executeCommand(
      command,
      this.definition,
      ctx,
      this.approval,
      this.runner,
      this.shell,
    );
  }
}

// -----------------------------------------------------------------------------
// run_tests
// -----------------------------------------------------------------------------

/**
 * Derive the project's test command from the active Execution_Profile: the first
 * detected technology with a determined test `CommandSpec` governs. Returns `null`
 * when no determined test command is recorded.
 */
function deriveTestCommand(profile: ExecutionProfile | undefined): string | null {
  if (profile === undefined) {
    return null;
  }
  for (const technology of profile.technologies) {
    const test = technology.commands.test;
    if (test !== undefined && test.determined && test.command !== null) {
      return test.command;
    }
  }
  return null;
}

/**
 * `run_tests` — run the project's test command as recorded in the active
 * Execution_Profile, under the same terminal safety rules as `run_terminal`. An
 * optional `testFilter` is appended to the recorded test command.
 */
export class RunTestsTool implements CodingTool {
  public readonly id = RUN_TESTS_TOOL_ID;

  private readonly approval: TerminalApprover;
  private readonly runner: CommandRunner;
  private readonly shell: ShellKind;
  private readonly definition: ToolDefinition;

  public constructor(options: TerminalToolOptions) {
    this.approval = options.approval;
    this.runner = options.runner ?? nodeCommandRunner;
    this.shell = options.shell ?? defaultShell();
    this.definition = builtinDefinition(RUN_TESTS_TOOL_ID);
  }

  public async execute(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
    const record = asRecord(input);
    const testFilter = record.testFilter;
    if (testFilter !== undefined && typeof testFilter !== "string") {
      throw new ToolExecutionError({
        kind: "validation",
        message: "run_tests 'testFilter' must be a string when provided.",
        field: "testFilter",
      });
    }

    const baseCommand = deriveTestCommand(ctx.profile);
    if (baseCommand === null) {
      throw new ToolExecutionError({
        kind: "execution",
        message:
          "No test command is recorded in the execution profile; configure one in the settings view before running tests.",
      });
    }

    const command =
      typeof testFilter === "string" && testFilter.trim().length > 0
        ? `${baseCommand} ${testFilter}`
        : baseCommand;

    return executeCommand(
      command,
      this.definition,
      ctx,
      this.approval,
      this.runner,
      this.shell,
    );
  }
}
