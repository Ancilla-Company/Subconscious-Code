// Feature: agent-tools-and-settings — unit tests for `edit_file` diff ordering.
//
// Validates: Requirements 6.2 (and 6.4)
//
// These example-based unit tests assert the ordering guarantee that `edit_file`
// presents the proposed change as a reviewable diff BEFORE any write touches the
// filesystem, and that declining the diff leaves the file completely untouched.
//
// The tool is exercised outside the VS Code host: the diff/confirmation surface is
// supplied as a stub `DiffPresenter` and the filesystem is supplied as an in-memory
// `WriteFileSystem` that records an ordered event log of every operation. The log
// lets each test pin the exact relative order of the diff presentation and the write
// operations (`writeFile`, `rename`) so a regression that writes before (or without)
// presenting the diff is genuinely caught.

import * as assert from "assert";

import type { PathResolution, ToolContext, WorkspacePathGuard } from "../types";
import { isToolExecutionError } from "../errors";
import {
  EditFileTool,
  type DiffReviewRequest,
  type WriteFileSystem,
} from "./writeFile";

/** A recorded filesystem/diff operation, in call order. */
interface Event {
  readonly op: "exists" | "readFile" | "ensureDir" | "writeFile" | "rename" | "remove" | "diff";
  readonly path: string;
}

/**
 * An in-memory {@link WriteFileSystem} that seeds a single existing file and records
 * an ordered log of every operation it performs. Writes and renames mutate the
 * in-memory store so the post-edit contents can be asserted.
 */
class RecordingFileSystem implements WriteFileSystem {
  public readonly events: Event[] = [];
  private readonly files: Map<string, string>;

  public constructor(seed: Record<string, string>) {
    this.files = new Map(Object.entries(seed));
  }

  public get(path: string): string | undefined {
    return this.files.get(path);
  }

  public async readFile(filePath: string): Promise<string> {
    this.events.push({ op: "readFile", path: filePath });
    const value = this.files.get(filePath);
    if (value === undefined) {
      const error: NodeJS.ErrnoException = new Error(`ENOENT: ${filePath}`);
      error.code = "ENOENT";
      throw error;
    }
    return value;
  }

  public async writeFile(filePath: string, data: string): Promise<void> {
    this.events.push({ op: "writeFile", path: filePath });
    this.files.set(filePath, data);
  }

  public async rename(oldPath: string, newPath: string): Promise<void> {
    this.events.push({ op: "rename", path: newPath });
    const value = this.files.get(oldPath);
    if (value !== undefined) {
      this.files.set(newPath, value);
      this.files.delete(oldPath);
    }
  }

  public async remove(filePath: string): Promise<void> {
    this.events.push({ op: "remove", path: filePath });
    this.files.delete(filePath);
  }

  public async ensureDir(dirPath: string): Promise<void> {
    this.events.push({ op: "ensureDir", path: dirPath });
  }

  public async exists(filePath: string): Promise<boolean> {
    this.events.push({ op: "exists", path: filePath });
    return this.files.has(filePath);
  }
}

/** A guard that accepts any path and treats it as its own canonical form. */
const passthroughGuard: WorkspacePathGuard = {
  roots(): string[] {
    return ["/workspace"];
  },
  resolve(inputPath: string): PathResolution {
    return { ok: true, canonicalPath: inputPath, root: "/workspace" };
  },
};

function makeContext(): ToolContext {
  return {
    guard: passthroughGuard,
    profile: undefined,
    signal: new AbortController().signal,
  };
}

describe("edit_file diff ordering (Requirement 6.2)", () => {
  const target = "/workspace/src/app.ts";
  const original = "export const answer = 41;\n";
  const proposed = "export const answer = 42;\n";

  it("presents the diff before performing any write when the edit is approved", async () => {
    const fs = new RecordingFileSystem({ [target]: original });

    let diffSeenBeforeWrite = false;
    const presentDiff = async (request: DiffReviewRequest): Promise<boolean> => {
      fs.events.push({ op: "diff", path: request.path });
      // At the moment the diff is presented, no write op may have occurred yet.
      diffSeenBeforeWrite = !fs.events.some(
        (event) => event.op === "writeFile" || event.op === "rename"
      );
      return true;
    };

    const tool = new EditFileTool(presentDiff, fs);
    const output = await tool.execute({ path: target, content: proposed }, makeContext());

    // The diff was presented, and no write had happened at that point.
    assert.ok(diffSeenBeforeWrite, "diff must be presented before any write");

    const diffIndex = fs.events.findIndex((event) => event.op === "diff");
    const firstWriteIndex = fs.events.findIndex(
      (event) => event.op === "writeFile" || event.op === "rename"
    );
    assert.notStrictEqual(diffIndex, -1, "diff must be presented");
    assert.notStrictEqual(firstWriteIndex, -1, "an approved edit must write");
    assert.ok(diffIndex < firstWriteIndex, "diff must be ordered before the first write");

    // The diff carried the file's true original and proposed contents.
    // (Verified indirectly: the file now holds the proposed content.)
    assert.strictEqual(fs.get(target), proposed);
    assert.strictEqual(output.data?.path, target);
  });

  it("presents the diff with the file's current and proposed contents", async () => {
    const fs = new RecordingFileSystem({ [target]: original });
    let captured: DiffReviewRequest | undefined;

    const presentDiff = async (request: DiffReviewRequest): Promise<boolean> => {
      captured = request;
      return true;
    };

    const tool = new EditFileTool(presentDiff, fs);
    await tool.execute({ path: target, content: proposed }, makeContext());

    assert.ok(captured, "the diff presenter must be invoked");
    assert.strictEqual(captured?.path, target);
    assert.strictEqual(captured?.originalContent, original);
    assert.strictEqual(captured?.proposedContent, proposed);
  });

  it("performs no write and leaves the file untouched when the diff is declined", async () => {
    const fs = new RecordingFileSystem({ [target]: original });

    const presentDiff = async (): Promise<boolean> => false;

    const tool = new EditFileTool(presentDiff, fs);

    await assert.rejects(
      () => tool.execute({ path: target, content: proposed }, makeContext()),
      (error: unknown) => {
        assert.ok(isToolExecutionError(error), "must throw a typed ToolExecutionError");
        assert.strictEqual(error.toolError.kind, "rejected");
        return true;
      }
    );

    // No write or rename occurred, and the file retains its original contents.
    assert.ok(
      !fs.events.some((event) => event.op === "writeFile" || event.op === "rename"),
      "a declined edit must not write"
    );
    assert.strictEqual(fs.get(target), original, "declined edit must leave the file unchanged");
  });
});
