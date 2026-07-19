// Feature: agent-tools-and-settings — the `read_file` Coding_Tool.
//
// Reads the contents of a workspace file. The supplied path is resolved through the
// shared `WorkspacePathGuard` so reads are confined to the open workspace roots
// (Requirement 4.1–4.4): an out-of-scope path yields an `out-of-scope` error and a
// closed workspace yields a `no-workspace` error, both surfaced as a thrown
// `ToolExecutionError` for the `ToolHost` to map into a `tool.result`.
//
// The read is byte-bounded: content is truncated to at most the configured maximum
// read size, and `ToolOutput.truncated` is set exactly when the file's byte length
// exceeds that maximum (Requirement 4.5). The maximum is configurable via the tool's
// options, defaulting to 10,485,760 bytes and clamped to the 1,024–104,857,600 byte
// range.
//
// _Requirements: 4.5_

import * as fs from "fs";

import { ToolExecutionError } from "../errors";
import type { CodingTool, ToolContext, ToolOutput } from "../types";

/** The `read_file` tool identifier, matching its `ToolDefinition` in the registry. */
export const READ_FILE_TOOL_ID = "read_file";

/** Default maximum read size in bytes (Requirement 4.5). */
export const DEFAULT_MAX_READ_BYTES = 10_485_760;

/** Lower bound of the configurable maximum read size, in bytes (Requirement 4.5). */
export const MIN_MAX_READ_BYTES = 1_024;

/** Upper bound of the configurable maximum read size, in bytes (Requirement 4.5). */
export const MAX_MAX_READ_BYTES = 104_857_600;

/** Construction options for {@link ReadFileTool}. */
export interface ReadFileToolOptions {
  /**
   * Maximum number of bytes returned before truncation. Clamped to the
   * [{@link MIN_MAX_READ_BYTES}, {@link MAX_MAX_READ_BYTES}] range; defaults to
   * {@link DEFAULT_MAX_READ_BYTES} when omitted.
   */
  readonly maxReadBytes?: number;
}

/**
 * Clamp a requested maximum read size into the supported range. A non-finite request
 * (NaN/±Infinity) falls back to the default; otherwise the value is floored and
 * bounded to [{@link MIN_MAX_READ_BYTES}, {@link MAX_MAX_READ_BYTES}].
 */
export function clampMaxReadBytes(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_MAX_READ_BYTES;
  }
  const floored = Math.floor(requested);
  if (floored < MIN_MAX_READ_BYTES) {
    return MIN_MAX_READ_BYTES;
  }
  if (floored > MAX_MAX_READ_BYTES) {
    return MAX_MAX_READ_BYTES;
  }
  return floored;
}

/** Narrowed shape of the validated `read_file` input. */
interface ReadFileInput {
  readonly path: string;
}

/**
 * Defensively narrow the untrusted input to a `{ path: string }` shape. The
 * `ToolHost` validates inputs against the tool's JSON schema before dispatch
 * (Requirement 6.7, 6.8); this guard protects the tool if invoked directly and
 * produces a `validation` error naming the offending field.
 */
function parseInput(input: unknown): ReadFileInput {
  if (typeof input !== "object" || input === null) {
    throw new ToolExecutionError({
      kind: "validation",
      message: "read_file input must be an object with a string 'path'.",
      field: "path",
    });
  }
  const path = (input as { path?: unknown }).path;
  if (typeof path !== "string" || path.length === 0) {
    throw new ToolExecutionError({
      kind: "validation",
      message: "read_file requires a non-empty string 'path'.",
      field: "path",
    });
  }
  return { path };
}

/**
 * The `read_file` Coding_Tool: a guarded, byte-bounded file reader.
 */
export class ReadFileTool implements CodingTool {
  public readonly id = READ_FILE_TOOL_ID;

  private readonly maxReadBytes: number;

  public constructor(options: ReadFileToolOptions = {}) {
    this.maxReadBytes = clampMaxReadBytes(options.maxReadBytes);
  }

  /** The effective maximum read size after clamping (exposed for wiring/tests). */
  public get maxBytes(): number {
    return this.maxReadBytes;
  }

  /**
   * Resolve the path through the guard, read the file, and return its content
   * truncated to at most the configured maximum read size, flagging truncation when
   * the file's byte length exceeds that maximum (Requirement 4.5).
   */
  public async execute(input: unknown, ctx: ToolContext): Promise<ToolOutput> {
    const { path: inputPath } = parseInput(input);

    const resolution = ctx.guard.resolve(inputPath);
    if (!resolution.ok) {
      throw new ToolExecutionError({
        kind: resolution.error,
        message:
          resolution.error === "no-workspace"
            ? "No workspace folder is open; cannot read files."
            : `Path is outside the workspace scope: ${inputPath}`,
      });
    }

    let buffer: Buffer;
    try {
      buffer = await fs.promises.readFile(resolution.canonicalPath);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new ToolExecutionError({
        kind: "execution",
        message: `Failed to read file: ${reason}`,
      });
    }

    if (ctx.signal.aborted) {
      throw new ToolExecutionError({
        kind: "timeout",
        message: "read_file was aborted before it could complete.",
      });
    }

    const truncated = buffer.byteLength > this.maxReadBytes;
    const slice = truncated ? buffer.subarray(0, this.maxReadBytes) : buffer;
    const content = slice.toString("utf8");

    return truncated ? { content, truncated: true } : { content };
  }
}
