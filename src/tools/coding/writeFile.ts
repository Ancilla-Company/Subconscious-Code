// Feature: agent-tools-and-settings — file-mutating coding tools.
//
// This module implements the two mutating file Coding_Tools:
//
//   - `create_file` — creates a new file with the supplied contents.
//   - `edit_file`   — replaces an existing file's contents, but only after the
//                     proposed change has been presented as a reviewable diff and
//                     approved (Requirement 6.2, 6.4).
//
// Both tools funnel every write through the shared `WorkspacePathGuard` so paths are
// canonicalized and confined to the workspace roots (Requirement 4), and both write
// via a temp-and-rename strategy with restore-on-failure so a mid-operation failure
// always leaves the target file in the exact state it held immediately before the
// operation (Requirement 6.5, Property 17).
//
// Failures are signalled by throwing a `ToolExecutionError` carrying a typed
// `ToolError`, matching the shared error-signalling contract in `../errors`; the
// `ToolHost` maps these into the `tool.result` frame it returns to the engine.
//
// The VS Code diff/confirmation surface is injected as a `DiffPresenter` function so
// `edit_file` can be exercised outside the extension host (unit + property tests).
// The filesystem operations are likewise injected behind a small `WriteFileSystem`
// interface (defaulting to a Node `fs/promises` implementation) so rollback behaviour
// can be exercised with deterministic fault injection.
//
// _Requirements: 6.2, 6.4, 6.5_

import * as fsPromises from "fs/promises";
import * as path from "path";

import { ToolExecutionError } from "../errors";
import type { FileChangeReporter } from "../fileChangeJournal";
import type { CodingTool, ToolContext, ToolOutput } from "../types";

// -----------------------------------------------------------------------------
// Injected collaborators
// -----------------------------------------------------------------------------

/** The proposed change presented to the user for review before an edit is written. */
export interface DiffReviewRequest {
  /** Canonical, workspace-scoped path of the file being edited. */
  readonly path: string;
  /** The file's current on-disk contents. */
  readonly originalContent: string;
  /** The full replacement contents the tool would write if approved. */
  readonly proposedContent: string;
}

/**
 * Presents a reviewable diff for an `edit_file` invocation and resolves to whether
 * the change was approved. Returning `false` (decline) MUST leave the file untouched
 * (Requirement 6.4). Production wiring backs this with the VS Code diff view and a
 * confirmation control; tests supply a stub.
 */
export type DiffPresenter = (request: DiffReviewRequest) => Promise<boolean>;

/**
 * The minimal filesystem surface the write tools depend on. Kept injectable so
 * rollback can be tested with deterministic fault injection; production uses
 * {@link nodeWriteFileSystem}.
 */
export interface WriteFileSystem {
  /** Read a file's contents as UTF-8 text. Rejects if the file does not exist. */
  readFile(filePath: string): Promise<string>;
  /** Write UTF-8 text to a file, creating or overwriting it. */
  writeFile(filePath: string, data: string): Promise<void>;
  /** Atomically rename/replace `oldPath` with `newPath`. */
  rename(oldPath: string, newPath: string): Promise<void>;
  /** Remove a file; MUST resolve quietly when the file is already absent. */
  remove(filePath: string): Promise<void>;
  /** Ensure a directory exists, creating parents as needed. */
  ensureDir(dirPath: string): Promise<void>;
  /** Report whether a path currently exists. */
  exists(filePath: string): Promise<boolean>;
}

/** Default {@link WriteFileSystem} backed by Node's `fs/promises`. */
export const nodeWriteFileSystem: WriteFileSystem = {
  async readFile(filePath: string): Promise<string> {
    return fsPromises.readFile(filePath, "utf8");
  },
  async writeFile(filePath: string, data: string): Promise<void> {
    await fsPromises.writeFile(filePath, data, "utf8");
  },
  async rename(oldPath: string, newPath: string): Promise<void> {
    await fsPromises.rename(oldPath, newPath);
  },
  async remove(filePath: string): Promise<void> {
    try {
      await fsPromises.unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  },
  async ensureDir(dirPath: string): Promise<void> {
    await fsPromises.mkdir(dirPath, { recursive: true });
  },
  async exists(filePath: string): Promise<boolean> {
    try {
      await fsPromises.access(filePath);
      return true;
    } catch {
      return false;
    }
  },
};

// -----------------------------------------------------------------------------
// Shared input handling and path safety
// -----------------------------------------------------------------------------

/** The validated shape of a `create_file` / `edit_file` input. */
interface WriteInput {
  readonly path: string;
  readonly content: string;
}

/**
 * Defensively narrow the untrusted engine-supplied input to a {@link WriteInput}.
 * Although the `ToolHost` validates against the tool's schema before dispatch, tool
 * inputs are treated as untrusted at every layer (Requirement 6.7): a shape mismatch
 * here throws a typed `validation` error naming the offending field.
 */
function parseWriteInput(input: unknown): WriteInput {
  if (typeof input !== "object" || input === null) {
    throw new ToolExecutionError({
      kind: "validation",
      message: "Input must be an object with 'path' and 'content'.",
      field: "input",
    });
  }
  const record = input as Record<string, unknown>;

  if (typeof record.path !== "string" || record.path.length === 0) {
    throw new ToolExecutionError({
      kind: "validation",
      message: "The 'path' input is required and must be a non-empty string.",
      field: "path",
    });
  }
  if (typeof record.content !== "string") {
    throw new ToolExecutionError({
      kind: "validation",
      message: "The 'content' input is required and must be a string.",
      field: "content",
    });
  }

  return { path: record.path, content: record.content };
}

/**
 * Resolve and scope-check a supplied path through the shared guard, translating a
 * guard rejection into the matching typed error (Requirement 4.2, 4.4). No file is
 * touched when this throws.
 */
function resolveWritablePath(ctx: ToolContext, inputPath: string): string {
  const resolution = ctx.guard.resolve(inputPath);
  if (!resolution.ok) {
    if (resolution.error === "no-workspace") {
      throw new ToolExecutionError({
        kind: "no-workspace",
        message: "No workspace folder is open; file operations are unavailable.",
      });
    }
    throw new ToolExecutionError({
      kind: "out-of-scope",
      message: `The path '${inputPath}' resolves outside every workspace root.`,
    });
  }
  return resolution.canonicalPath;
}

// -----------------------------------------------------------------------------
// Atomic write with restore-on-failure
// -----------------------------------------------------------------------------

/** Build a unique temp path adjacent to the target so the rename stays on-device. */
function temporaryPathFor(canonicalPath: string): string {
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  return `${canonicalPath}.${suffix}.tmp`;
}

/**
 * Write `content` to `canonicalPath` atomically, restoring the pre-operation state on
 * any failure (Requirement 6.5, Property 17).
 *
 * Strategy: capture whether the target already exists and its current bytes, write the
 * new content to an adjacent temp file, then atomically rename the temp file over the
 * target. Because the rename is the single commit point, the target holds either its
 * original contents or the fully written new contents — never a partial write. On any
 * error the temp file is removed and the target is returned to its captured state
 * (original bytes restored, or removed if it did not previously exist).
 */
async function writeAtomically(
  fs: WriteFileSystem,
  canonicalPath: string,
  content: string,
): Promise<void> {
  await fs.ensureDir(path.dirname(canonicalPath));

  const existedBefore = await fs.exists(canonicalPath);
  const originalContent = existedBefore ? await fs.readFile(canonicalPath) : null;

  const tempPath = temporaryPathFor(canonicalPath);
  try {
    await fs.writeFile(tempPath, content);
    await fs.rename(tempPath, canonicalPath);
  } catch (error) {
    await rollback(fs, canonicalPath, tempPath, existedBefore, originalContent);
    throw new ToolExecutionError({
      kind: "execution",
      message: `Failed to write '${canonicalPath}': ${describeError(error)}`,
    });
  }
}

/**
 * Best-effort restoration of the pre-operation state. The temp file is always removed;
 * the target is restored to its original bytes when it previously existed, otherwise
 * removed. Rollback failures are swallowed so the original operation's error surfaces.
 */
async function rollback(
  fs: WriteFileSystem,
  canonicalPath: string,
  tempPath: string,
  existedBefore: boolean,
  originalContent: string | null,
): Promise<void> {
  try {
    await fs.remove(tempPath);
  } catch {
    // Ignore: a leftover temp file must not mask the original failure.
  }

  try {
    if (existedBefore && originalContent !== null) {
      await fs.writeFile(canonicalPath, originalContent);
    } else {
      await fs.remove(canonicalPath);
    }
  } catch {
    // Ignore: best-effort restore; the atomic rename means the on-disk target was
    // never left partially written.
  }
}

/** Extract a human-readable message from an unknown thrown value. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// -----------------------------------------------------------------------------
// create_file
// -----------------------------------------------------------------------------

/**
 * `create_file` — create a new file in the workspace with the supplied contents.
 *
 * The path is scope-checked through the guard; creation refuses to clobber an existing
 * file (returning a typed `execution` error and leaving it unchanged) and writes
 * atomically so a failed creation leaves no partial file behind.
 */
export class CreateFileTool implements CodingTool {
  public readonly id = "create_file";

  private readonly fs: WriteFileSystem;
  private readonly reportChange?: FileChangeReporter;

  public constructor(
    fs: WriteFileSystem = nodeWriteFileSystem,
    reportChange?: FileChangeReporter,
  ) {
    this.fs = fs;
    this.reportChange = reportChange;
  }

  public async execute(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
    const { path: inputPath, content } = parseWriteInput(input);
    const canonicalPath = resolveWritablePath(ctx, inputPath);

    if (await this.fs.exists(canonicalPath)) {
      throw new ToolExecutionError({
        kind: "execution",
        message: `Cannot create '${canonicalPath}': a file already exists at that path.`,
      });
    }

    await writeAtomically(this.fs, canonicalPath, content);

    // Report the change so the chat card can offer Show/Undo. `previousContent` is
    // null because the file did not exist — undoing a creation deletes it again.
    this.reportChange?.({
      toolId: this.id,
      path: canonicalPath,
      previousContent: null,
      newContent: content,
    });

    return {
      content: `Created file ${canonicalPath} (${content.length} characters).`,
      data: { path: canonicalPath, bytesWritten: content.length },
    };
  }
}

// -----------------------------------------------------------------------------
// edit_file
// -----------------------------------------------------------------------------

/**
 * `edit_file` — replace an existing file's contents, presenting the proposed change as
 * a reviewable diff BEFORE anything is written (Requirement 6.2). Declining the diff
 * leaves the file untouched and yields a typed `rejected` error (Requirement 6.4); on
 * approval the replacement is written atomically with restore-on-failure.
 *
 * The diff/confirmation surface is injected so the tool is testable outside the host.
 */
export class EditFileTool implements CodingTool {
  public readonly id = "edit_file";

  private readonly presentDiff: DiffPresenter;
  private readonly fs: WriteFileSystem;
  private readonly reportChange?: FileChangeReporter;

  public constructor(
    presentDiff: DiffPresenter,
    fs: WriteFileSystem = nodeWriteFileSystem,
    reportChange?: FileChangeReporter,
  ) {
    this.presentDiff = presentDiff;
    this.fs = fs;
    this.reportChange = reportChange;
  }

  public async execute(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
    const { path: inputPath, content } = parseWriteInput(input);
    const canonicalPath = resolveWritablePath(ctx, inputPath);

    if (!(await this.fs.exists(canonicalPath))) {
      throw new ToolExecutionError({
        kind: "execution",
        message: `Cannot edit '${canonicalPath}': no file exists at that path.`,
      });
    }

    const originalContent = await this.fs.readFile(canonicalPath);

    // Present the diff for review BEFORE any write occurs (Requirement 6.2).
    const approved = await this.presentDiff({
      path: canonicalPath,
      originalContent,
      proposedContent: content,
    });

    if (!approved) {
      // Declined: the file is left exactly as it was (Requirement 6.4).
      throw new ToolExecutionError({
        kind: "rejected",
        message: `The proposed edit to '${canonicalPath}' was declined; the file was left unchanged.`,
      });
    }

    await writeAtomically(this.fs, canonicalPath, content);

    // Report the change so the chat card can offer Show (diff the two versions) and
    // Undo (restore exactly these previous bytes).
    this.reportChange?.({
      toolId: this.id,
      path: canonicalPath,
      previousContent: originalContent,
      newContent: content,
    });

    return {
      content: `Edited file ${canonicalPath} (${content.length} characters).`,
      data: { path: canonicalPath, bytesWritten: content.length },
    };
  }
}
