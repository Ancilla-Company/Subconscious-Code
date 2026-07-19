// Feature: agent-tools-and-settings — GitHub Copilot parity coding tools.
//
// These three tools bring the catalogue closer to the built-in tool set of the VS Code
// GitHub Copilot coding agent (see research), each mapped onto the Subconscious
// tool-callback contract:
//
//   - `list_code_usages` (Copilot `usages`)   — find where a symbol is defined/used.
//   - `get_changes`      (Copilot `changes`)   — the working-tree git diff.
//   - `run_task`         (Copilot `runTasks`)  — run a configured VS Code task.
//
// Following the pattern established by `readOnly.ts` / `terminal.ts`, each tool's
// VS Code / process interaction is behind an injectable dependency so the mapping into
// `ToolOutput` can be exercised outside the extension host; the default implementation
// wraps the real VS Code API (or `git`). Typed failures are raised as
// `ToolExecutionError` for the `ToolHost` to map into the `tool.result` frame.

import { spawn } from "child_process";

import * as vscode from "vscode";

import { ToolExecutionError } from "../errors";
import type { CodingTool, ToolContext, ToolOutput } from "../types";

// -----------------------------------------------------------------------------
// Shared input helpers (untrusted input — validate defensively, R6.7/6.8)
// -----------------------------------------------------------------------------

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ToolExecutionError({ kind: "validation", message: "Tool input must be an object." });
  }
  return input as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new ToolExecutionError({
      kind: "validation",
      message: `Missing or invalid required string input "${field}".`,
      field,
    });
  }
  return value;
}

function optionalBoolean(record: Record<string, unknown>, field: string): boolean | undefined {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new ToolExecutionError({
      kind: "validation",
      message: `Input "${field}" must be a boolean when provided.`,
      field,
    });
  }
  return value;
}

/** The primary workspace root of the guard, or a `no-workspace` error. */
function primaryRoot(ctx: ToolContext): string {
  const roots = ctx.guard.roots();
  if (roots.length === 0) {
    throw new ToolExecutionError({ kind: "no-workspace", message: "No workspace folder is open." });
  }
  return roots[0];
}

// -----------------------------------------------------------------------------
// list_code_usages
// -----------------------------------------------------------------------------

/** A single usage location produced by {@link ListCodeUsagesTool}. */
export interface CodeUsage {
  readonly uri: string;
  readonly line: number;
  readonly character: number;
}

/** Resolves the usages of a symbol; injected into {@link ListCodeUsagesTool}. */
export interface UsagesProvider {
  find(symbol: string): Promise<CodeUsage[]>;
}

/**
 * Default {@link UsagesProvider}: resolves the symbol through the workspace symbol
 * provider, then collects references at its declaration site via the reference
 * provider — both standard VS Code language-feature commands.
 */
export class VsCodeUsagesProvider implements UsagesProvider {
  public async find(symbol: string): Promise<CodeUsage[]> {
    const symbols =
      (await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        "vscode.executeWorkspaceSymbolProvider",
        symbol,
      )) ?? [];
    const target = symbols.find((entry) => entry.name === symbol) ?? symbols[0];
    if (target === undefined) {
      return [];
    }
    const locations =
      (await vscode.commands.executeCommand<vscode.Location[]>(
        "vscode.executeReferenceProvider",
        target.location.uri,
        target.location.range.start,
      )) ?? [];
    return locations.map((location) => ({
      uri: location.uri.fsPath,
      line: location.range.start.line + 1,
      character: location.range.start.character + 1,
    }));
  }
}

/**
 * `list_code_usages` — finds the definitions and references of a named symbol across
 * the workspace using the active language services. Read-only.
 */
export class ListCodeUsagesTool implements CodingTool {
  public readonly id = "list_code_usages";

  public constructor(private readonly provider: UsagesProvider = new VsCodeUsagesProvider()) {}

  public async execute(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
    const record = asRecord(input);
    const symbol = requireString(record, "symbol");
    primaryRoot(ctx);

    let usages: CodeUsage[];
    try {
      usages = await this.provider.find(symbol);
    } catch (error) {
      throw new ToolExecutionError({
        kind: "execution",
        message: `Failed to resolve usages of "${symbol}": ${(error as Error).message}`,
      });
    }

    const content =
      usages.length === 0
        ? `No usages found for "${symbol}".`
        : usages.map((usage) => `${usage.uri}:${usage.line}:${usage.character}`).join("\n");
    return { content, data: { symbol, usages, count: usages.length } };
  }
}

// -----------------------------------------------------------------------------
// get_changes
// -----------------------------------------------------------------------------

/** Options for a git diff run. */
export interface DiffRequest {
  readonly cwd: string;
  readonly staged: boolean;
  readonly signal: AbortSignal;
}

/** Produces a git diff; injected into {@link GetChangesTool}. */
export type DiffRunner = (request: DiffRequest) => Promise<string>;

/** Default {@link DiffRunner}: runs `git diff [--staged]` in the workspace root. */
export const defaultDiffRunner: DiffRunner = (request) =>
  new Promise<string>((resolve, reject) => {
    const args = ["diff", "--no-color"];
    if (request.staged) {
      args.push("--staged");
    }
    const child = spawn("git", args, { cwd: request.cwd });
    let stdout = "";
    let stderr = "";
    const onAbort = (): void => {
      child.kill();
    };
    request.signal.addEventListener("abort", onAbort);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => {
      request.signal.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.on("close", (code) => {
      request.signal.removeEventListener("abort", onAbort);
      if (code === 0 || code === null) {
        resolve(stdout);
      } else {
        reject(new Error(stderr.trim() || `git diff exited with code ${code}`));
      }
    });
  });

/**
 * `get_changes` — returns the working-tree (or staged) git diff for the workspace, so
 * the agent can review pending changes without re-reading every file. Read-only.
 */
export class GetChangesTool implements CodingTool {
  public readonly id = "get_changes";

  public constructor(private readonly runner: DiffRunner = defaultDiffRunner) {}

  public async execute(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
    const record = asRecord(input);
    const staged = optionalBoolean(record, "staged") ?? false;
    const cwd = primaryRoot(ctx);

    let diff: string;
    try {
      diff = await this.runner({ cwd, staged, signal: ctx.signal });
    } catch (error) {
      if (ctx.signal.aborted) {
        throw new ToolExecutionError({ kind: "timeout", message: "git diff was aborted." });
      }
      throw new ToolExecutionError({
        kind: "execution",
        message: `Failed to compute changes: ${(error as Error).message}`,
      });
    }

    const content = diff.trim().length === 0 ? "No changes." : diff;
    return { content, data: { staged, empty: diff.trim().length === 0 } };
  }
}

// -----------------------------------------------------------------------------
// run_task
// -----------------------------------------------------------------------------

/** The outcome of a task run. */
export interface TaskRunResult {
  readonly found: boolean;
  readonly exitCode?: number;
}

/** Runs a named VS Code task; injected into {@link RunTaskTool}. */
export interface TaskRunner {
  run(name: string, signal: AbortSignal): Promise<TaskRunResult>;
}

/**
 * Default {@link TaskRunner}: fetches the workspace's configured tasks, runs the one
 * matching by name, and resolves with its process exit code.
 */
export class VsCodeTaskRunner implements TaskRunner {
  public async run(name: string, signal: AbortSignal): Promise<TaskRunResult> {
    const tasks = await vscode.tasks.fetchTasks();
    const task = tasks.find((candidate) => candidate.name === name);
    if (task === undefined) {
      return { found: false };
    }
    const execution = await vscode.tasks.executeTask(task);
    return new Promise<TaskRunResult>((resolve) => {
      const disposables: vscode.Disposable[] = [];
      const finish = (exitCode?: number): void => {
        for (const disposable of disposables) {
          disposable.dispose();
        }
        resolve({ found: true, exitCode });
      };
      disposables.push(
        vscode.tasks.onDidEndTaskProcess((event) => {
          if (event.execution === execution) {
            finish(event.exitCode);
          }
        }),
      );
      const onAbort = (): void => {
        execution.terminate();
        finish(undefined);
      };
      signal.addEventListener("abort", onAbort);
      disposables.push({ dispose: () => signal.removeEventListener("abort", onAbort) });
    });
  }
}

/**
 * `run_task` — runs a configured VS Code task by name (e.g. a build or lint task).
 * Mutating: a task can build, modify, or otherwise change the workspace.
 */
export class RunTaskTool implements CodingTool {
  public readonly id = "run_task";

  public constructor(private readonly runner: TaskRunner = new VsCodeTaskRunner()) {}

  public async execute(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
    const record = asRecord(input);
    const name = requireString(record, "task");
    primaryRoot(ctx);

    let result: TaskRunResult;
    try {
      result = await this.runner.run(name, ctx.signal);
    } catch (error) {
      throw new ToolExecutionError({
        kind: "execution",
        message: `Failed to run task "${name}": ${(error as Error).message}`,
      });
    }

    if (!result.found) {
      throw new ToolExecutionError({
        kind: "execution",
        message: `No task named "${name}" is configured in this workspace.`,
      });
    }

    const code = result.exitCode;
    const content =
      code === undefined
        ? `Task "${name}" finished.`
        : `Task "${name}" finished with exit code ${code}.`;
    return { content, data: { task: name, exitCode: code ?? null } };
  }
}
