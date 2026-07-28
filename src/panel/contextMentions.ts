// Feature: chat "#" context mentions — lets the user attach files, folders,
// terminals, diagnostics, the git diff, or the set of open editors to an outgoing
// chat message, similar to Kiro's #File/#Folder/#Terminal/#Problems/#Git Diff
// mentions and Antigravity's "@" context attachments.
//
// This module is the extension-side counterpart to the webview's "#" popup
// (media/main.js): it lists searchable candidates for a category and resolves a
// chosen candidate into a plain-text block that `ChatPanel` inlines into the
// outgoing `chat.send` content, since the wire protocol to the engine carries only
// a single `content` string (see `EngineClient.sendChat`). Resolution happens here
// (not in the webview) so it can use the full `vscode` API and the same read
// bounds as the equivalent Coding_Tools (`read_file`, `get_diagnostics`,
// `get_changes`, `get_workspace_context`).
//
// All reads are scoped to the open workspace folders; nothing here writes to the
// filesystem or executes a mutating command.

import * as fs from "fs";
import * as path from "path";

import * as vscode from "vscode";

import { defaultDiffRunner } from "../tools/coding/parity";
import { DEFAULT_MAX_READ_BYTES } from "../tools/coding/readFile";
import { VsCodeDiagnosticsSource } from "../tools/coding/readOnly";
import { defaultWorkspaceContextReader } from "../tools/coding/workspaceContext";
import type { TerminalOutputTracker, TrackedCommand } from "./terminalOutputTracker";

/** The categories the "#" popup offers, in display order. */
export type MentionCategory =
  | "file"
  | "folder"
  | "terminal"
  | "symbol"
  | "problems"
  | "gitDiff"
  | "openEditors";

/** Directory names skipped while searching for files/folders (mirrors readOnly.ts). */
const EXCLUDED_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "out",
  "dist",
  ".mypy_cache",
  "__pycache__",
]);

/** Cap on candidates returned by a single search request. */
const MAX_SEARCH_RESULTS = 30;

/** A single selectable candidate shown in the "#" popup. */
export interface MentionItem {
  readonly category: MentionCategory;
  /** Stable value the item resolves from (relative path, terminal name, ...). */
  readonly id: string;
  /** Primary label shown in the popup and as the chip text. */
  readonly label: string;
  /** Secondary detail shown in the popup (e.g. the containing folder). */
  readonly description?: string;
}

/** The resolved text block for a chosen mention, inlined into the outgoing message. */
export interface ResolvedMention {
  readonly label: string;
  readonly text: string;
}

/** The four "no further narrowing needed" categories, resolved as a single click. */
const SINGLETON_CATEGORIES: ReadonlySet<MentionCategory> = new Set([
  "problems",
  "gitDiff",
  "openEditors",
]);

export function isSingletonCategory(category: MentionCategory): boolean {
  return SINGLETON_CATEGORIES.has(category);
}

/** Convert a filesystem path to a forward-slashed path relative to `root`. */
function toRelativePosix(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

/** Format `filePath` relative to whichever workspace root contains it, else absolute. */
function relativeToAnyRoot(roots: readonly string[], filePath: string): string {
  for (const root of roots) {
    const rel = path.relative(root, filePath);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
      return rel.split(path.sep).join("/");
    }
  }
  return filePath;
}

/** Current workspace folder filesystem paths. */
function workspaceRoots(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
}

/**
 * Provides search results and resolution for the chat "#" context-mention popup.
 * Every read is bounded and scoped to the open workspace folders.
 */
export class ContextMentionService {
  /**
   * @param terminalOutput Supplies recent shell-integration output for the
   * "#Terminal" mention. Passing `undefined` falls back to reporting only the
   * terminal's name/cwd (no output capture).
   */
  public constructor(private readonly terminalOutput?: TerminalOutputTracker) {}

  /** Search workspace files by fuzzy substring match against the relative path. */
  public async searchFiles(query: string): Promise<MentionItem[]> {
    const trimmed = query.trim();
    let uris: vscode.Uri[];
    try {
      uris = await vscode.workspace.findFiles(
        trimmed.length > 0 ? `**/*${globEscape(trimmed)}*` : "**/*",
        "**/{node_modules,.git,out,dist}/**",
        200,
      );
    } catch {
      return [];
    }
    const items = uris.map((uri) => {
      const rel = vscode.workspace.asRelativePath(uri, false);
      return {
        category: "file" as const,
        id: rel,
        label: path.basename(rel),
        description: path.dirname(rel) === "." ? undefined : path.dirname(rel),
      };
    });
    return items.slice(0, MAX_SEARCH_RESULTS);
  }

  /** Search workspace directories by fuzzy substring match against the relative path. */
  public async searchFolders(query: string): Promise<MentionItem[]> {
    const roots = workspaceRoots();
    const needle = query.trim().toLowerCase();
    const results: MentionItem[] = [];

    for (const root of roots) {
      await this.walkDirs(root, root, 6, (relPath) => {
        if (results.length >= MAX_SEARCH_RESULTS) {
          return false;
        }
        if (needle.length === 0 || relPath.toLowerCase().includes(needle)) {
          results.push({
            category: "folder",
            id: relPath,
            label: path.basename(relPath) || relPath,
            description: path.dirname(relPath) === "." ? undefined : path.dirname(relPath),
          });
        }
        return results.length < MAX_SEARCH_RESULTS;
      });
      if (results.length >= MAX_SEARCH_RESULTS) {
        break;
      }
    }
    return results;
  }

  /** List currently open integrated terminals, optionally filtered by name. */
  public listTerminals(query: string): MentionItem[] {
    const needle = query.trim().toLowerCase();
    return vscode.window.terminals
      .map((terminal) => ({
        category: "terminal" as const,
        id: terminal.name,
        label: terminal.name,
      }))
      .filter((item) => needle.length === 0 || item.label.toLowerCase().includes(needle));
  }

  /**
   * Search workspace-wide code symbols (functions, classes, methods, ...) via the
   * language server behind `vscode.executeWorkspaceSymbolProvider`. Requires a
   * non-empty query — most symbol providers return nothing (or everything) for an
   * empty string, so an empty query short-circuits to no results rather than a
   * misleadingly large/random list.
   */
  public async searchSymbols(query: string): Promise<MentionItem[]> {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      return [];
    }
    let symbols: vscode.SymbolInformation[] | undefined;
    try {
      symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
        "vscode.executeWorkspaceSymbolProvider",
        trimmed,
      );
    } catch {
      return [];
    }
    if (!symbols || symbols.length === 0) {
      return [];
    }
    const roots = workspaceRoots();
    return symbols.slice(0, MAX_SEARCH_RESULTS).map((symbol, index) => {
      const relPath =
        symbol.location.uri.scheme === "file"
          ? relativeToAnyRoot(roots, symbol.location.uri.fsPath)
          : symbol.location.uri.toString();
      const line = symbol.location.range.start.line + 1;
      return {
        category: "symbol" as const,
        // Encode enough to resolve later without a second search round-trip: the
        // symbol's URI, containing-symbol kind label, and start position.
        id: JSON.stringify({
          index,
          uri: symbol.location.uri.toString(),
          line: symbol.location.range.start.line,
          character: symbol.location.range.start.character,
          endLine: symbol.location.range.end.line,
          endCharacter: symbol.location.range.end.character,
        }),
        label: symbol.name,
        description: `${vscode.SymbolKind[symbol.kind]} · ${relPath}:${line}`,
      };
    });
  }

  /** Resolve a chosen mention into the text block inlined into the outgoing message. */
  public async resolve(item: MentionItem): Promise<ResolvedMention> {
    switch (item.category) {
      case "file":
        return this.resolveFile(item.id);
      case "folder":
        return this.resolveFolder(item.id);
      case "terminal":
        return this.resolveTerminal(item.id);
      case "symbol":
        return this.resolveSymbol(item.id, item.label);
      case "problems":
        return this.resolveProblems();
      case "gitDiff":
        return this.resolveGitDiff();
      case "openEditors":
        return this.resolveOpenEditors();
      default: {
        const unreachable: never = item.category;
        throw new Error(`Unsupported mention category: ${String(unreachable)}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async walkDirs(
    base: string,
    dir: string,
    depthRemaining: number,
    onDir: (relPath: string) => boolean,
  ): Promise<void> {
    if (depthRemaining < 0) {
      return;
    }
    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      if (!dirent.isDirectory() || EXCLUDED_DIRECTORIES.has(dirent.name)) {
        continue;
      }
      const full = path.join(dir, dirent.name);
      const rel = toRelativePosix(base, full);
      if (!onDir(rel)) {
        return;
      }
      await this.walkDirs(base, full, depthRemaining - 1, onDir);
    }
  }

  private async resolveFile(relPath: string): Promise<ResolvedMention> {
    const roots = workspaceRoots();
    const absolute = path.isAbsolute(relPath) ? relPath : path.join(roots[0] ?? "", relPath);
    let content: string;
    let truncated = false;
    try {
      const buffer = await fs.promises.readFile(absolute);
      truncated = buffer.byteLength > DEFAULT_MAX_READ_BYTES;
      content = (truncated ? buffer.subarray(0, DEFAULT_MAX_READ_BYTES) : buffer).toString(
        "utf8",
      );
    } catch (error) {
      content = `(could not read file: ${(error as Error).message})`;
    }
    const lang = path.extname(relPath).replace(/^\./, "");
    const note = truncated ? "\n(truncated)" : "";
    return {
      label: relPath,
      text: `[Context — File: ${relPath}]\n\`\`\`${lang}\n${content}${note}\n\`\`\``,
    };
  }

  private async resolveFolder(relPath: string): Promise<ResolvedMention> {
    const roots = workspaceRoots();
    const absolute = path.isAbsolute(relPath) ? relPath : path.join(roots[0] ?? "", relPath);
    let entries: string[];
    try {
      const dirents = await fs.promises.readdir(absolute, { withFileTypes: true });
      entries = dirents
        .filter((entry) => !EXCLUDED_DIRECTORIES.has(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
    } catch (error) {
      entries = [`(could not list folder: ${(error as Error).message})`];
    }
    return {
      label: `${relPath}/`,
      text: `[Context — Folder: ${relPath}]\n${entries.join("\n")}`,
    };
  }

  private resolveTerminal(name: string): ResolvedMention {
    const terminal = vscode.window.terminals.find((candidate) => candidate.name === name);
    if (terminal === undefined) {
      return {
        label: name,
        text: `[Context — Terminal: ${name}]\n(terminal is no longer open)`,
      };
    }
    const cwd = terminal.shellIntegration?.cwd?.fsPath;
    const lines = [`Terminal name: ${name}`];
    if (cwd !== undefined) {
      lines.push(`Working directory: ${cwd}`);
    }

    const history = this.terminalOutput?.historyFor(terminal);
    if (history === undefined || history.length === 0) {
      lines.push(
        terminal.shellIntegration === undefined
          ? "(Shell integration is not active in this terminal, so recent output cannot be captured. Use run_terminal to run a command and capture its output.)"
          : "(No commands have been observed in this terminal yet.)",
      );
      return { label: name, text: `[Context — Terminal: ${name}]\n${lines.join("\n")}` };
    }

    // Most recent commands last; show the few most recent, most-recent first.
    const recent = history.slice(-5).reverse();
    lines.push("", "Recent commands (most recent first):");
    for (const command of recent) {
      lines.push("", `$ ${command.commandLine ?? "(command line unknown)"}`);
      if (!command.done) {
        lines.push("(still running)");
        continue;
      }
      lines.push(`(exit code: ${command.exitCode ?? "unknown"})`);
      const output = command.output.trim();
      if (output.length > 0) {
        lines.push(output);
      }
    }

    return { label: name, text: `[Context — Terminal: ${name}]\n${lines.join("\n")}` };
  }

  /** Resolve a code symbol mention by re-fetching its containing definition text. */
  private async resolveSymbol(encodedId: string, label: string): Promise<ResolvedMention> {
    let decoded: {
      uri: string;
      line: number;
      character: number;
      endLine: number;
      endCharacter: number;
    };
    try {
      decoded = JSON.parse(encodedId);
    } catch {
      return { label, text: `[Context — Symbol: ${label}]\n(could not resolve symbol location)` };
    }

    const uri = vscode.Uri.parse(decoded.uri);
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch (error) {
      return {
        label,
        text: `[Context — Symbol: ${label}]\n(failed to open ${uri.toString()}: ${(error as Error).message})`,
      };
    }

    const start = new vscode.Position(decoded.line, decoded.character);
    const end = new vscode.Position(decoded.endLine, decoded.endCharacter);
    // Symbol ranges from workspace-symbol providers are frequently just the name
    // token, not the full body — extend to the enclosing line range so the model
    // sees real code rather than a single identifier.
    const startLine = Math.max(0, start.line);
    const endLine = Math.min(document.lineCount - 1, Math.max(end.line, start.line));
    const range = new vscode.Range(
      new vscode.Position(startLine, 0),
      document.lineAt(endLine).range.end,
    );
    const content = document.getText(range);
    const relPath = vscode.workspace.asRelativePath(document.uri, false);
    const lang = path.extname(relPath).replace(/^\./, "");

    return {
      label,
      text: `[Context — Symbol: ${label} (${relPath}:${startLine + 1})]\n\`\`\`${lang}\n${content}\n\`\`\``,
    };
  }

  private resolveProblems(): ResolvedMention {
    const activeUri = vscode.window.activeTextEditor?.document.uri;
    const source = new VsCodeDiagnosticsSource();
    const entries = source.collect(activeUri?.scheme === "file" ? activeUri.fsPath : undefined);
    const total = entries.reduce((sum, entry) => sum + entry.diagnostics.length, 0);
    if (total === 0) {
      return { label: "Problems", text: "[Context — Problems]\nNo diagnostics reported." };
    }
    const lines: string[] = [];
    for (const entry of entries) {
      for (const diagnostic of entry.diagnostics) {
        const position = `${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}`;
        lines.push(`${entry.uri}:${position}: ${diagnostic.message}`);
      }
    }
    return { label: "Problems", text: `[Context — Problems]\n${lines.join("\n")}` };
  }

  private async resolveGitDiff(): Promise<ResolvedMention> {
    const roots = workspaceRoots();
    if (roots.length === 0) {
      return { label: "Git Diff", text: "[Context — Git Diff]\nNo workspace folder is open." };
    }
    const controller = new AbortController();
    let diff: string;
    try {
      diff = await defaultDiffRunner({ cwd: roots[0], staged: false, signal: controller.signal });
    } catch (error) {
      diff = `(failed to compute diff: ${(error as Error).message})`;
    }
    const content = diff.trim().length === 0 ? "No changes." : diff;
    return { label: "Git Diff", text: `[Context — Git Diff]\n${content}` };
  }

  private resolveOpenEditors(): ResolvedMention {
    const ctx = defaultWorkspaceContextReader();
    const files = [ctx.activeFile, ...ctx.openFiles].filter(
      (value): value is string => typeof value === "string",
    );
    const unique = [...new Set(files)];
    const content = unique.length === 0 ? "No files are open." : unique.join("\n");
    return { label: "Open Editors", text: `[Context — Open Editors]\n${content}` };
  }
}

/** Escape glob-significant characters in free text used inside a wildcard-wrapped glob. */
function globEscape(text: string): string {
  return text.replace(/[[\]{}()!?]/g, "");
}
