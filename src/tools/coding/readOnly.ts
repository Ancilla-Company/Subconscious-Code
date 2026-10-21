// Feature: agent-tools-and-settings — read-only coding tools.
//
// This module implements four of the Read_Only_Tools from the catalogue (Requirement
// 1.1, 1.4): `list_directory`, `search_files`, `get_diagnostics`, and `fetch_web`.
// Each implements the shared `CodingTool` contract (`execute(input, ctx) =>
// Promise<ToolOutput>`) and signals typed failures by throwing a
// `ToolExecutionError`, exactly as `read_file` does — the `ToolHost` maps the carried
// `ToolError` into the `tool.result` frame and keeps the WebSocket open.
//
// **Note:** a `grep_search` tool previously lived here but was removed — a hand-rolled
// recursive file-content walk is not cross-platform reliable (binary/encoding
// heuristics, symlink loops, `.gitignore` handling all differ across OSes) and
// duplicates what the terminal tool's OS-appropriate search commands (`grep`/
// `findstr`) or VS Code's own search already do correctly. Use `run_terminal` or
// `search_files` instead.
//
// File-path tools (`list_directory` and the optional path of `get_diagnostics`)
// resolve every supplied path through `ToolContext.guard` (`WorkspacePathGuard`) so
// the workspace-scope rules (Requirement 4) are enforced in exactly one place; an
// out-of-scope or no-workspace resolution is surfaced as the matching typed error and
// no filesystem read is attempted.
//
// `get_diagnostics` wraps `vscode.languages.getDiagnostics` behind an injectable
// `DiagnosticsSource` so the mapping into `ToolOutput` can be exercised outside the
// VS Code host. `fetch_web` fetches an HTTPS URL only (the scheme is validated before
// any request), behind an injectable `WebFetcher`.
//
// None of these tools mutates the workspace or system; they read state only.
//
// _Requirements: 1.1_

import * as fs from "fs";
import * as path from "path";

import * as vscode from "vscode";

import { ToolExecutionError } from "../errors";
import type {
  CodingTool,
  ToolContext,
  ToolOutput,
  WorkspacePathGuard,
} from "../types";

// -----------------------------------------------------------------------------
// Bounds
// -----------------------------------------------------------------------------

/** Directory names skipped while walking the workspace for {@link ListDirectoryTool}. */
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

/** Default cap on the number of paths `search_files` returns. */
const DEFAULT_SEARCH_MAX_RESULTS = 1000;

/** Maximum number of characters `fetch_web` returns before flagging truncation. */
const MAX_FETCH_CHARS = 5 * 1024 * 1024;

// -----------------------------------------------------------------------------
// Input helpers (untrusted input — validate defensively, Requirement 6.7/6.8)
// -----------------------------------------------------------------------------

/** Narrow untrusted `input` to a plain object, or raise a validation error. */
function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new ToolExecutionError({
      kind: "validation",
      message: "Tool input must be an object.",
    });
  }
  return input as Record<string, unknown>;
}

/** Require a non-empty string field, or raise a validation error naming it. */
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

/** Read an optional string field, or raise a validation error on the wrong type. */
function optionalString(
  record: Record<string, unknown>,
  field: string
): string | undefined {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ToolExecutionError({
      kind: "validation",
      message: `Input "${field}" must be a string when provided.`,
      field,
    });
  }
  return value;
}

/** Read an optional non-negative integer field, or raise a validation error. */
function optionalInteger(
  record: Record<string, unknown>,
  field: string
): number | undefined {
  const value = record[field];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new ToolExecutionError({
      kind: "validation",
      message: `Input "${field}" must be a non-negative integer when provided.`,
      field,
    });
  }
  return value;
}

/**
 * Resolve `inputPath` through the workspace guard, raising the matching typed error
 * (`out-of-scope` / `no-workspace`) when the path is rejected so that no filesystem
 * read is attempted (Requirement 4.2, 4.3, 4.4).
 */
function resolveWithinWorkspace(
  guard: WorkspacePathGuard,
  inputPath: string
): { canonicalPath: string; root: string } {
  const resolution = guard.resolve(inputPath);
  if (!resolution.ok) {
    throw new ToolExecutionError({
      kind: resolution.error,
      message:
        resolution.error === "no-workspace"
          ? "No workspace folder is open."
          : `Path "${inputPath}" resolves outside every workspace root.`,
    });
  }
  return { canonicalPath: resolution.canonicalPath, root: resolution.root };
}

/** Raise `no-workspace` when the guard exposes no workspace roots. */
function requireRoots(guard: WorkspacePathGuard): string[] {
  const roots = guard.roots();
  if (roots.length === 0) {
    throw new ToolExecutionError({
      kind: "no-workspace",
      message: "No workspace folder is open.",
    });
  }
  return roots;
}

/** Throw an `execution` error if the ambient timeout has already aborted. */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ToolExecutionError({
      kind: "timeout",
      message: "The tool was aborted before completing.",
    });
  }
}

/** Convert a filesystem path to a forward-slashed path relative to `root`. */
function toRelativePosix(root: string, filePath: string): string {
  return path.relative(root, filePath).split(path.sep).join("/");
}

// -----------------------------------------------------------------------------
// list_directory
// -----------------------------------------------------------------------------

/** A single entry produced by {@link ListDirectoryTool}. */
export interface DirectoryEntry {
  readonly name: string;
  readonly path: string;
  readonly type: "file" | "directory" | "symlink" | "other";
}

/**
 * `list_directory` — lists the files and subdirectories of a workspace directory.
 * The target directory is resolved through the workspace guard; an optional `depth`
 * recurses into subdirectories. Read-only: no entry is created or modified.
 */
export class ListDirectoryTool implements CodingTool {
  public readonly id = "list_directory";

  public async execute(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
    const record = asRecord(input);
    const inputPath = requireString(record, "path");
    const depth = optionalInteger(record, "depth") ?? 0;

    const { canonicalPath } = resolveWithinWorkspace(ctx.guard, inputPath);

    let rootStat: fs.Stats;
    try {
      rootStat = await fs.promises.stat(canonicalPath);
    } catch (error) {
      throw new ToolExecutionError({
        kind: "execution",
        message: `Cannot access directory "${inputPath}": ${(error as Error).message}`,
      });
    }
    if (!rootStat.isDirectory()) {
      throw new ToolExecutionError({
        kind: "validation",
        message: `Path "${inputPath}" is not a directory.`,
        field: "path",
      });
    }

    const entries: DirectoryEntry[] = [];
    await this.walk(canonicalPath, canonicalPath, depth, ctx.signal, entries);

    const content = entries
      .map((entry) => (entry.type === "directory" ? `${entry.path}/` : entry.path))
      .join("\n");

    return { content, data: { entries } };
  }

  /** Recursively collect directory entries relative to `base`, up to `depth`. */
  private async walk(
    base: string,
    dir: string,
    depth: number,
    signal: AbortSignal,
    out: DirectoryEntry[]
  ): Promise<void> {
    throwIfAborted(signal);

    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (error) {
      throw new ToolExecutionError({
        kind: "execution",
        message: `Cannot read directory: ${(error as Error).message}`,
      });
    }

    const sorted = [...dirents].sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of sorted) {
      throwIfAborted(signal);
      const full = path.join(dir, dirent.name);
      const type = ListDirectoryTool.classify(dirent);
      out.push({
        name: dirent.name,
        path: toRelativePosix(base, full),
        type,
      });
      if (type === "directory" && depth > 0 && !EXCLUDED_DIRECTORIES.has(dirent.name)) {
        await this.walk(base, full, depth - 1, signal, out);
      }
    }
  }

  /** Classify a directory entry into the reported entry type. */
  private static classify(dirent: fs.Dirent): DirectoryEntry["type"] {
    if (dirent.isDirectory()) {
      return "directory";
    }
    if (dirent.isSymbolicLink()) {
      return "symlink";
    }
    if (dirent.isFile()) {
      return "file";
    }
    return "other";
  }
}

// -----------------------------------------------------------------------------
// search_files
// -----------------------------------------------------------------------------

/**
 * `search_files` — finds workspace files whose paths match a glob/fuzzy query, using
 * `vscode.workspace.findFiles`. The ambient timeout is bridged to a VS Code
 * cancellation token. Read-only: only paths are returned.
 */
export class SearchFilesTool implements CodingTool {
  public readonly id = "search_files";

  public async execute(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
    const record = asRecord(input);
    const query = requireString(record, "query");
    const maxResults = optionalInteger(record, "maxResults") ?? DEFAULT_SEARCH_MAX_RESULTS;

    requireRoots(ctx.guard);
    throwIfAborted(ctx.signal);

    const tokenSource = new vscode.CancellationTokenSource();
    const onAbort = (): void => tokenSource.cancel();
    ctx.signal.addEventListener("abort", onAbort);

    let uris: vscode.Uri[];
    try {
      // Request one extra result so truncation can be detected reliably.
      uris = await vscode.workspace.findFiles(
        query,
        undefined,
        maxResults + 1,
        tokenSource.token
      );
    } catch (error) {
      throw new ToolExecutionError({
        kind: "execution",
        message: `File search failed: ${(error as Error).message}`,
      });
    } finally {
      ctx.signal.removeEventListener("abort", onAbort);
      tokenSource.dispose();
    }

    throwIfAborted(ctx.signal);

    const truncated = uris.length > maxResults;
    const paths = uris
      .slice(0, maxResults)
      .map((uri) => vscode.workspace.asRelativePath(uri, false));

    return {
      content: paths.join("\n"),
      truncated,
      data: { paths, truncated },
    };
  }
}

// -----------------------------------------------------------------------------
// get_diagnostics
// -----------------------------------------------------------------------------

/** A VS Code diagnostic reduced to a plain, host-independent shape. */
export interface DiagnosticLike {
  readonly message: string;
  /** VS Code severity ordinal: 0 error, 1 warning, 2 information, 3 hint. */
  readonly severity: number;
  readonly source?: string;
  readonly code?: string | number;
  readonly range: {
    readonly start: { readonly line: number; readonly character: number };
    readonly end: { readonly line: number; readonly character: number };
  };
}

/** Diagnostics grouped by the resource they belong to. */
export interface DiagnosticEntry {
  readonly uri: string;
  readonly diagnostics: readonly DiagnosticLike[];
}

/**
 * Source of diagnostics, injected into {@link GetDiagnosticsTool}. The production
 * implementation wraps `vscode.languages.getDiagnostics`; tests supply a fake so the
 * mapping into `ToolOutput` can be verified outside the VS Code host.
 */
export interface DiagnosticsSource {
  /** All diagnostics, or those for a single resolved file path when supplied. */
  collect(resolvedPath?: string): readonly DiagnosticEntry[];
}

/** Human-readable labels for the VS Code severity ordinals. */
const SEVERITY_LABELS: Readonly<Record<number, string>> = {
  0: "error",
  1: "warning",
  2: "information",
  3: "hint",
};

/** Reduce a `vscode.Diagnostic.code` to a plain string/number, or omit it. */
function normalizeCode(
  code: vscode.Diagnostic["code"]
): string | number | undefined {
  if (typeof code === "string" || typeof code === "number") {
    return code;
  }
  if (code !== undefined && code !== null && typeof code === "object") {
    return typeof code.value === "number" ? code.value : String(code.value);
  }
  return undefined;
}

/** Map a `vscode.Diagnostic` to the host-independent {@link DiagnosticLike}. */
function toDiagnosticLike(diagnostic: vscode.Diagnostic): DiagnosticLike {
  return {
    message: diagnostic.message,
    severity: diagnostic.severity,
    source: diagnostic.source,
    code: normalizeCode(diagnostic.code),
    range: {
      start: {
        line: diagnostic.range.start.line,
        character: diagnostic.range.start.character,
      },
      end: {
        line: diagnostic.range.end.line,
        character: diagnostic.range.end.character,
      },
    },
  };
}

/** Default {@link DiagnosticsSource} backed by `vscode.languages.getDiagnostics`. */
export class VsCodeDiagnosticsSource implements DiagnosticsSource {
  public collect(resolvedPath?: string): readonly DiagnosticEntry[] {
    if (resolvedPath !== undefined) {
      const uri = vscode.Uri.file(resolvedPath);
      const diagnostics = vscode.languages.getDiagnostics(uri);
      return [{ uri: uri.fsPath, diagnostics: diagnostics.map(toDiagnosticLike) }];
    }
    return vscode.languages
      .getDiagnostics()
      .map(([uri, diagnostics]) => ({
        uri: uri.fsPath,
        diagnostics: diagnostics.map(toDiagnosticLike),
      }));
  }
}

/**
 * `get_diagnostics` — retrieves compile/lint/type diagnostics reported by VS Code,
 * for a single file (when `path` is supplied and resolves within the workspace) or
 * for the whole workspace. Structured diagnostics are placed in `ToolOutput.data`;
 * `content` carries a human-readable summary. Read-only.
 */
export class GetDiagnosticsTool implements CodingTool {
  public readonly id = "get_diagnostics";

  /** @param source Injectable diagnostics source; defaults to the VS Code wrapper. */
  public constructor(
    private readonly source: DiagnosticsSource = new VsCodeDiagnosticsSource()
  ) {}

  public async execute(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
    const record = asRecord(input);
    const inputPath = optionalString(record, "path");

    let resolvedPath: string | undefined;
    if (inputPath !== undefined && inputPath.length > 0) {
      resolvedPath = resolveWithinWorkspace(ctx.guard, inputPath).canonicalPath;
    }

    const entries = this.source.collect(resolvedPath);
    const total = entries.reduce((sum, entry) => sum + entry.diagnostics.length, 0);

    const lines: string[] = [];
    for (const entry of entries) {
      for (const diagnostic of entry.diagnostics) {
        const label = SEVERITY_LABELS[diagnostic.severity] ?? "diagnostic";
        const position = `${diagnostic.range.start.line + 1}:${
          diagnostic.range.start.character + 1
        }`;
        const origin = diagnostic.source !== undefined ? ` [${diagnostic.source}]` : "";
        lines.push(`${entry.uri}:${position}: ${label}${origin}: ${diagnostic.message}`);
      }
    }

    const content =
      total === 0 ? "No diagnostics reported." : lines.join("\n");

    return {
      content,
      data: { diagnostics: entries, count: total },
    };
  }
}

// -----------------------------------------------------------------------------
// fetch_web
// -----------------------------------------------------------------------------

/** The result of an HTTPS fetch performed by a {@link WebFetcher}. */
export interface WebFetchResult {
  readonly status: number;
  readonly contentType?: string;
  readonly body: string;
  readonly truncated: boolean;
}

/** Fetches an HTTPS URL. Injected into {@link FetchWebTool} for testability. */
export type WebFetcher = (url: string, signal: AbortSignal) => Promise<WebFetchResult>;

/**
 * Default {@link WebFetcher} using the global `fetch`. The body is read as text and
 * capped at {@link MAX_FETCH_CHARS} characters, flagging truncation when clipped.
 */
export const defaultWebFetcher: WebFetcher = async (
  url: string,
  signal: AbortSignal
): Promise<WebFetchResult> => {
  const response = await fetch(url, { signal, redirect: "follow" });
  const contentTypeHeader = response.headers.get("content-type");
  const raw = await response.text();
  const truncated = raw.length > MAX_FETCH_CHARS;
  return {
    status: response.status,
    contentType: contentTypeHeader ?? undefined,
    body: truncated ? raw.slice(0, MAX_FETCH_CHARS) : raw,
    truncated,
  };
};

/**
 * `fetch_web` — retrieves the contents of a remote HTTPS URL for the agent to read.
 * The scheme is validated to be `https:` before any request is made; non-HTTPS or
 * malformed URLs are rejected as validation errors. Read-only: this tool performs a
 * single outbound GET and never mutates the workspace.
 *
 * Security note: this fetches whatever HTTPS URL the engine supplies; the HTTPS-only
 * restriction guards against plaintext exfiltration but callers should treat fetched
 * content as untrusted data.
 */
export class FetchWebTool implements CodingTool {
  public readonly id = "fetch_web";

  /** @param fetcher Injectable fetcher; defaults to the global-`fetch` implementation. */
  public constructor(private readonly fetcher: WebFetcher = defaultWebFetcher) {}

  public async execute(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
    const record = asRecord(input);
    const rawUrl = requireString(record, "url");

    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      throw new ToolExecutionError({
        kind: "validation",
        message: `Input "url" is not a valid URL.`,
        field: "url",
      });
    }
    if (parsed.protocol !== "https:") {
      throw new ToolExecutionError({
        kind: "validation",
        message: `Input "url" must use the https scheme (received "${parsed.protocol}").`,
        field: "url",
      });
    }

    let result: WebFetchResult;
    try {
      result = await this.fetcher(parsed.toString(), ctx.signal);
    } catch (error) {
      if (ctx.signal.aborted) {
        throw new ToolExecutionError({
          kind: "timeout",
          message: "The web request was aborted before completing.",
        });
      }
      throw new ToolExecutionError({
        kind: "execution",
        message: `Failed to fetch "${parsed.toString()}": ${(error as Error).message}`,
      });
    }

    return {
      content: result.body,
      truncated: result.truncated,
      data: {
        url: parsed.toString(),
        status: result.status,
        contentType: result.contentType,
        truncated: result.truncated,
      },
    };
  }
}
