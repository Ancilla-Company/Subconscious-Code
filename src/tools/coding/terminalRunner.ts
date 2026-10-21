// Feature: agent-tools-and-settings — integrated-terminal command runner.
//
// A `CommandRunner` (the dependency `RunTerminalTool`/`RunTestsTool` accept) that runs
// commands in a VISIBLE integrated terminal rather than a hidden child process. This
// means commands execute in the user's configured shell profile — including the Python
// extension's automatic virtual-environment activation for new terminals — which is
// exactly the environment that plain `child_process.spawn` misses.
//
// Output and exit codes are captured via VS Code's shell-integration API
// (`Terminal.shellIntegration`, available for common shells on VS Code ≥ 1.93). When
// shell integration is unavailable the command is still sent to the visible terminal,
// but output/exit code cannot be captured — the runner reports that so the agent knows
// to inspect the terminal instead of assuming success.

import * as vscode from "vscode";

import type { ShellKind } from "../commandDecomposer";
import type { CommandInvocation, CommandRunResult, CommandRunner } from "./terminal";
import { stripAnsi } from "./ansi";

/** Name of the reused agent terminal. */
const TERMINAL_NAME = "Subconscious";

/**
 * Detect the {@link ShellKind} whose syntax rules apply to the user's actual default
 * terminal shell (`vscode.env.shell`), so command decomposition/approval and the
 * command line handed to the runner both use the right quoting/chaining rules —
 * rather than assuming PowerShell on every Windows machine, which breaks for users
 * whose default profile is Git Bash, WSL, cmd.exe, or another POSIX-like shell.
 * Falls back to a platform default when the executable can't be recognized.
 */
export function detectShellKind(): ShellKind {
  const shellPath = vscode.env.shell.toLowerCase();
  const exe = shellPath.split(/[\\/]/).pop() ?? shellPath;

  if (exe.includes("powershell") || exe.includes("pwsh")) {
    return "powershell";
  }
  if (exe === "cmd" || exe === "cmd.exe") {
    return "cmd";
  }
  if (
    exe.includes("bash") ||
    exe.includes("zsh") ||
    exe.includes("fish") ||
    exe.includes("sh") ||
    exe.includes("wsl")
  ) {
    return "posix";
  }
  // No recognizable shell reported (e.g. remote/web environments): fall back to a
  // platform-appropriate default rather than guessing wrong.
  return process.platform === "win32" ? "powershell" : "posix";
}

/**
 * Build a {@link CommandRunner} that drives the visible integrated terminal. A single
 * "Subconscious" terminal is reused (recreated if the user closed it), so the
 * user can watch what the agent runs.
 */
export function createVsCodeTerminalRunner(): CommandRunner {
  let terminal: vscode.Terminal | undefined;

  const ensureTerminal = (cwd: string): vscode.Terminal => {
    if (terminal === undefined || terminal.exitStatus !== undefined) {
      terminal = vscode.window.createTerminal({ name: TERMINAL_NAME, cwd });
    }
    return terminal;
  };

  return (invocation: CommandInvocation, signal: AbortSignal): Promise<CommandRunResult> =>
    new Promise<CommandRunResult>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("The command was aborted before it could start."));
        return;
      }

      const term = ensureTerminal(invocation.cwd);
      term.show(true); // reveal without stealing focus

      const integration = term.shellIntegration;
      if (integration === undefined) {
        // No shell integration: run it visibly but we can't capture output/exit code.
        term.sendText(invocation.command, true);
        resolve({
          exitCode: null,
          stdout: "",
          stderr:
            "Command sent to the integrated terminal, but shell integration is " +
            "unavailable so its output and exit code could not be captured. Inspect " +
            "the 'Subconscious' terminal for the result.",
          cwd: invocation.cwd,
        });
        return;
      }

      let settled = false;
      const execution = integration.executeCommand(invocation.command);
      let output = "";

      // Drain the output stream (best-effort; ends when the command completes).
      void (async () => {
        try {
          for await (const chunk of execution.read()) {
            output += chunk;
          }
        } catch {
          // Stream closed; the end event still delivers the exit code.
        }
      })();

      const cleanup = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        endSub.dispose();
        signal.removeEventListener("abort", onAbort);
      };

      const onAbort = (): void => {
        cleanup();
        reject(new Error("The command was aborted before it could complete."));
      };

      const endSub = vscode.window.onDidEndTerminalShellExecution((event) => {
        if (event.execution !== execution) {
          return;
        }
        cleanup();
        // Report the terminal's actual working directory after the command ran (it
        // may have changed the directory itself, e.g. `cd ..`), falling back to the
        // invocation's cwd when shell integration doesn't report one.
        const resultCwd = term.shellIntegration?.cwd?.fsPath ?? invocation.cwd;
        resolve({
          exitCode: event.exitCode ?? null,
          stdout: stripAnsi(output),
          stderr: "",
          cwd: resultCwd,
        });
      });

      signal.addEventListener("abort", onAbort);
    });
}
