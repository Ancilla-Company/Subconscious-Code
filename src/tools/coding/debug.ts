// Feature: agent-tools-and-settings — the debugger tool (`start_debug`).
//
// Runs a program under the VS Code debugger instead of guessing a terminal command.
// This is the robust way to "run" a project: a launch configuration resolves the
// interpreter / virtual environment through the language extension (e.g. the Python
// extension picks the selected venv), so the agent doesn't have to discover and
// activate environments itself — the recurring failure mode with plain terminal runs.
//
// The tool starts a named launch configuration (from `.vscode/launch.json`) or an
// inline configuration, optionally waits for the session to terminate, and captures
// the debug adapter's `output` events plus the exit code. When the requested
// configuration is unknown it returns the available names so the agent can self-correct.
//
// The VS Code interaction is behind an injectable `DebugController` so the tool logic
// is testable outside the extension host.

import * as vscode from "vscode";

import { ToolExecutionError } from "../errors";
import type { CodingTool, ToolContext, ToolOutput } from "../types";

/** The outcome of a debug run. */
export interface DebugRunResult {
  readonly started: boolean;
  /** Names of available launch configurations (returned when the request is unknown). */
  readonly availableConfigs?: readonly string[];
  readonly sessionName?: string;
  /** Captured program/adapter output when the session was awaited. */
  readonly output?: string;
  /** Process exit code, when reported by the debug adapter. */
  readonly exitCode?: number | null;
  /** True when the session ended (only meaningful when `waitForExit`). */
  readonly terminated?: boolean;
}

/** A request to start a debug session. */
export interface DebugStartRequest {
  readonly root: string;
  /** A named launch configuration, or an inline configuration object. */
  readonly configuration?: string;
  readonly inline?: Record<string, unknown>;
  readonly waitForExit: boolean;
  readonly signal: AbortSignal;
}

/** Drives `vscode.debug`; injected into {@link StartDebugTool} for testability. */
export interface DebugController {
  /** Names of the launch configurations declared for the workspace root. */
  listConfigurations(root: string): string[];
  /** Start a debug session and (optionally) await its termination + output. */
  start(request: DebugStartRequest): Promise<DebugRunResult>;
}

/** Default {@link DebugController} backed by the live `vscode.debug` API. */
export class VsCodeDebugController implements DebugController {
  public listConfigurations(root: string): string[] {
    const folder = this.folderFor(root);
    const launch = vscode.workspace.getConfiguration("launch", folder?.uri ?? null);
    const configs = launch.get<Array<{ name?: string }>>("configurations") ?? [];
    return configs
      .map((c) => (typeof c.name === "string" ? c.name : ""))
      .filter((name) => name.length > 0);
  }

  public async start(request: DebugStartRequest): Promise<DebugRunResult> {
    const folder = this.folderFor(request.root);
    const target: string | vscode.DebugConfiguration =
      request.configuration !== undefined
        ? request.configuration
        : (request.inline as vscode.DebugConfiguration);

    // Capture debug-adapter output/exit for the sessions we start.
    const captured: string[] = [];
    let exitCode: number | null | undefined;
    const tracker = vscode.debug.registerDebugAdapterTrackerFactory("*", {
      createDebugAdapterTracker() {
        return {
          onDidSendMessage(message: { type?: string; event?: string; body?: Record<string, unknown> }) {
            if (message.type === "event" && message.event === "output") {
              const out = message.body?.output;
              if (typeof out === "string") {
                captured.push(out);
              }
            }
            if (message.type === "event" && message.event === "exited") {
              const code = message.body?.exitCode;
              exitCode = typeof code === "number" ? code : null;
            }
          },
        };
      },
    });

    try {
      const started = await vscode.debug.startDebugging(folder, target);
      if (!started) {
        return { started: false };
      }
      const session = vscode.debug.activeDebugSession;
      const sessionName = session?.name;

      if (!request.waitForExit) {
        return { started: true, sessionName };
      }

      await this.awaitTermination(session, request.signal);
      return {
        started: true,
        sessionName,
        output: captured.join(""),
        exitCode: exitCode ?? null,
        terminated: true,
      };
    } finally {
      tracker.dispose();
    }
  }

  /** Resolve the workspace folder matching a root path. */
  private folderFor(root: string): vscode.WorkspaceFolder | undefined {
    return (vscode.workspace.workspaceFolders ?? []).find(
      (f) => f.uri.fsPath === root,
    );
  }

  /** Resolve when the given debug session terminates (or the signal aborts). */
  private awaitTermination(
    session: vscode.DebugSession | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise<void>((resolve) => {
      const sub = vscode.debug.onDidTerminateDebugSession((ended) => {
        if (session === undefined || ended.id === session.id) {
          cleanup();
          resolve();
        }
      });
      const onAbort = (): void => {
        cleanup();
        resolve();
      };
      const cleanup = (): void => {
        sub.dispose();
        signal.removeEventListener("abort", onAbort);
      };
      signal.addEventListener("abort", onAbort);
    });
  }
}

/** Narrow untrusted input to a plain object. */
function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ToolExecutionError({ kind: "validation", message: "Tool input must be an object." });
  }
  return input as Record<string, unknown>;
}

/**
 * `start_debug` — start a VS Code debug session for a launch configuration (or an
 * inline configuration), optionally waiting for it to finish and returning its output.
 */
export class StartDebugTool implements CodingTool {
  public readonly id = "start_debug";

  public constructor(
    private readonly controller: DebugController = new VsCodeDebugController(),
  ) {}

  public async execute(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
    const record = asRecord(input);
    const roots = ctx.guard.roots();
    if (roots.length === 0) {
      throw new ToolExecutionError({
        kind: "no-workspace",
        message: "No workspace folder is open; cannot start a debug session.",
      });
    }
    const root = ctx.profile?.root && roots.includes(ctx.profile.root) ? ctx.profile.root : roots[0];

    const configuration =
      typeof record.configuration === "string" && record.configuration.length > 0
        ? record.configuration
        : undefined;
    const inline =
      typeof record.inline === "object" && record.inline !== null && !Array.isArray(record.inline)
        ? (record.inline as Record<string, unknown>)
        : undefined;
    const waitForExit = record.waitForExit === true;

    // Nothing to run: report the available configurations so the agent can choose one.
    if (configuration === undefined && inline === undefined) {
      const available = this.controller.listConfigurations(root);
      return {
        content:
          available.length > 0
            ? `Specify a launch configuration to debug. Available: ${available.join(", ")}.`
            : "No launch configurations are defined in .vscode/launch.json, and no inline configuration was provided.",
        data: { started: false, availableConfigs: available },
      };
    }

    // A named configuration that doesn't exist: surface the valid names.
    if (configuration !== undefined) {
      const available = this.controller.listConfigurations(root);
      if (!available.includes(configuration)) {
        return {
          content: `No launch configuration named "${configuration}". Available: ${
            available.length > 0 ? available.join(", ") : "(none)"
          }.`,
          data: { started: false, availableConfigs: available },
        };
      }
    }

    let result: DebugRunResult;
    try {
      result = await this.controller.start({
        root,
        configuration,
        inline,
        waitForExit,
        signal: ctx.signal,
      });
    } catch (error) {
      throw new ToolExecutionError({
        kind: "execution",
        message: `Failed to start debugging: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }

    if (!result.started) {
      throw new ToolExecutionError({
        kind: "execution",
        message: "The debug session did not start (the configuration may be invalid).",
      });
    }

    const label = result.sessionName ?? configuration ?? "session";
    const lines = [`Debug session '${label}' started.`];
    if (result.terminated) {
      lines.push(
        result.exitCode === null || result.exitCode === undefined
          ? "Session terminated."
          : `Session terminated with exit code ${result.exitCode}.`,
      );
      if (result.output && result.output.trim().length > 0) {
        lines.push("", result.output.trim());
      }
    }

    return {
      content: lines.join("\n"),
      data: {
        started: true,
        sessionName: result.sessionName ?? null,
        terminated: result.terminated ?? false,
        exitCode: result.exitCode ?? null,
      },
    };
  }
}
