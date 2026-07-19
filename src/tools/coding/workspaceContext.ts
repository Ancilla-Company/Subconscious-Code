// Feature: agent-tools-and-settings — the workspace/IDE meta tool.
//
// `get_workspace_context` answers "where am I building?" for the agent. It reports the
// open workspace folder(s) and their absolute paths, whether the window is a multi-root
// workspace, the active editor file, the other open files, and the editor name/version
// and platform. It is read-only and takes no input.
//
// The VS Code interaction is behind an injectable `WorkspaceContextReader` so the
// output formatting is testable outside the extension host; the default reader wraps
// the `vscode` workspace/window/env APIs.

import * as os from "os";

import * as vscode from "vscode";

import type { CodingTool, ToolOutput } from "../types";

/** A single open workspace folder. */
export interface WorkspaceRootInfo {
  readonly name: string;
  readonly path: string;
}

/** The raw IDE/workspace context, independent of `vscode` for testability. */
export interface WorkspaceContextData {
  readonly roots: readonly WorkspaceRootInfo[];
  /** Absolute path of the active editor file, if any. */
  readonly activeFile?: string;
  /** Absolute paths of other open editor files. */
  readonly openFiles: readonly string[];
  /** The editor product name (e.g. "Visual Studio Code"). */
  readonly appName: string;
  /** The editor version string. */
  readonly ideVersion: string;
  /** The OS platform (e.g. "win32", "darwin", "linux"). */
  readonly platform: string;
}

/** Collects the current {@link WorkspaceContextData}. Injected for testability. */
export type WorkspaceContextReader = () => WorkspaceContextData;

/** Default reader backed by the live `vscode` APIs. */
export const defaultWorkspaceContextReader: WorkspaceContextReader = () => {
  const roots: WorkspaceRootInfo[] = (vscode.workspace.workspaceFolders ?? []).map(
    (folder) => ({ name: folder.name, path: folder.uri.fsPath }),
  );

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const activeFile =
    activeUri !== undefined && activeUri.scheme === "file"
      ? activeUri.fsPath
      : undefined;

  const openFiles = vscode.workspace.textDocuments
    .filter((doc) => doc.uri.scheme === "file" && !doc.isUntitled)
    .map((doc) => doc.uri.fsPath)
    .filter((path) => path !== activeFile);

  return {
    roots,
    ...(activeFile !== undefined ? { activeFile } : {}),
    openFiles: [...new Set(openFiles)],
    appName: vscode.env.appName,
    ideVersion: vscode.version,
    platform: os.platform(),
  };
};

/**
 * `get_workspace_context` — a read-only meta tool describing the IDE/workspace the
 * agent is operating in. Takes no input.
 */
export class GetWorkspaceContextTool implements CodingTool {
  public readonly id = "get_workspace_context";

  public constructor(
    private readonly read: WorkspaceContextReader = defaultWorkspaceContextReader,
  ) {}

  public async execute(): Promise<ToolOutput> {
    const ctx = this.read();

    const lines: string[] = [];
    if (ctx.roots.length === 0) {
      lines.push("No workspace folder is open.");
    } else if (ctx.roots.length === 1) {
      lines.push(`Workspace: ${ctx.roots[0].name} (${ctx.roots[0].path})`);
    } else {
      lines.push(`Multi-root workspace (${ctx.roots.length} folders):`);
      for (const root of ctx.roots) {
        lines.push(`  - ${root.name}: ${root.path}`);
      }
    }
    lines.push(`Active file: ${ctx.activeFile ?? "(none)"}`);
    if (ctx.openFiles.length > 0) {
      lines.push(`Open files: ${ctx.openFiles.join(", ")}`);
    }
    lines.push(`Editor: ${ctx.appName} ${ctx.ideVersion} on ${ctx.platform}`);

    return {
      content: lines.join("\n"),
      data: {
        roots: ctx.roots,
        primaryRoot: ctx.roots[0]?.path ?? null,
        multiRoot: ctx.roots.length > 1,
        activeFile: ctx.activeFile ?? null,
        openFiles: ctx.openFiles,
        appName: ctx.appName,
        ideVersion: ctx.ideVersion,
        platform: ctx.platform,
      },
    };
  }
}
