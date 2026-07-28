// Feature: chat "#Terminal" context mention — live/recent terminal output capture.
//
// `contextMentions.ts`'s `resolveTerminal` previously reported only the terminal's
// name and cwd, explicitly noting that "live scrollback is not accessible via the
// VS Code API" — but recent output IS accessible via the same shell-integration API
// (`Terminal.shellIntegration`, VS Code ≥1.93) already used by `terminalRunner.ts`
// for the visible-terminal `CommandRunner`. This tracker listens for shell-execution
// start/end across every terminal window-wide and retains a bounded ring buffer of
// each terminal's most recent commands and captured output, so a "#Terminal" mention
// can surface what actually happened in that terminal — not just its identity.
//
// This is read-only and passive: it only observes terminal activity that is already
// happening (started by the user or by `run_terminal`/`run_tests`); it never sends
// input to a terminal itself.

import * as vscode from "vscode";

import { stripAnsi } from "../tools/coding/ansi";

/** One captured command's lifecycle within a tracked terminal. */
export interface TrackedCommand {
  /**
   * The command line, when the shell integration script reported one. May be
   * refined (become more accurate) once the command ends.
   */
  commandLine: string | undefined;
  /** Captured, ANSI-stripped output; empty while the command is still running. */
  output: string;
  /** `undefined` while running; the shell-reported exit code once it ends. */
  exitCode: number | null | undefined;
  /** Whether this command has finished (`onDidEndTerminalShellExecution` fired). */
  done: boolean;
}

/** Bounded per-terminal history: most recent commands, oldest first. */
interface TerminalHistory {
  commands: TrackedCommand[];
}

/** Maximum commands retained per terminal before the oldest is evicted. */
const MAX_COMMANDS_PER_TERMINAL = 20;

/** Maximum captured output bytes retained per command (mirrors read_file's bound). */
const MAX_OUTPUT_CHARS = 200_000;

/**
 * Tracks recent shell-integration command activity across all integrated terminals
 * so the "#Terminal" context mention can report real output instead of just the
 * terminal's name/cwd. A single instance should be created at activation and
 * disposed with the extension.
 */
export class TerminalOutputTracker implements vscode.Disposable {
  private readonly histories = new Map<vscode.Terminal, TerminalHistory>();
  private readonly executionCommands = new Map<
    vscode.TerminalShellExecution,
    TrackedCommand
  >();
  private readonly disposables: vscode.Disposable[] = [];

  public constructor() {
    this.disposables.push(
      vscode.window.onDidStartTerminalShellExecution((event) =>
        this.onStart(event),
      ),
      vscode.window.onDidEndTerminalShellExecution((event) => this.onEnd(event)),
      vscode.window.onDidCloseTerminal((terminal) => {
        this.histories.delete(terminal);
      }),
    );
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.histories.clear();
    this.executionCommands.clear();
  }

  /**
   * The tracked command history for `terminal`, most recent last, or `undefined`
   * when nothing has been observed for it yet (e.g. shell integration never
   * activated, or no command has run since the tracker was created).
   */
  public historyFor(terminal: vscode.Terminal): readonly TrackedCommand[] | undefined {
    return this.histories.get(terminal)?.commands;
  }

  private onStart(event: vscode.TerminalShellExecutionStartEvent): void {
    const history = this.historyFor_(event.terminal);
    const tracked: TrackedCommand = {
      commandLine: safeCommandLineValue(event.execution),
      output: "",
      exitCode: undefined,
      done: false,
    };
    history.commands.push(tracked);
    if (history.commands.length > MAX_COMMANDS_PER_TERMINAL) {
      history.commands.shift();
    }
    this.executionCommands.set(event.execution, tracked);

    // Drain the output stream as it arrives; `read()` must be called immediately
    // after start to avoid missing data (per the API's own documentation).
    void (async () => {
      try {
        for await (const chunk of event.execution.read()) {
          if (tracked.output.length < MAX_OUTPUT_CHARS) {
            tracked.output += chunk;
          }
        }
      } catch {
        // Stream closed/unsupported; onEnd still fires with the exit code.
      }
    })();
  }

  private onEnd(event: vscode.TerminalShellExecutionEndEvent): void {
    const tracked = this.executionCommands.get(event.execution);
    this.executionCommands.delete(event.execution);
    if (tracked === undefined) {
      return;
    }
    tracked.done = true;
    tracked.exitCode = event.exitCode ?? null;
    // The command line can become more accurate once the execution ends.
    tracked.commandLine = safeCommandLineValue(event.execution) ?? tracked.commandLine;
    tracked.output = stripAnsi(tracked.output).slice(0, MAX_OUTPUT_CHARS);
  }

  private historyFor_(terminal: vscode.Terminal): TerminalHistory {
    let history = this.histories.get(terminal);
    if (history === undefined) {
      history = { commands: [] };
      this.histories.set(terminal, history);
    }
    return history;
  }
}

/** Read a command's line value defensively; some shells never report one. */
function safeCommandLineValue(execution: vscode.TerminalShellExecution): string | undefined {
  const value = execution.commandLine?.value;
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
