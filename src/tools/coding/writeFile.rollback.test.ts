// Feature: agent-tools-and-settings, Property 17: Failed file operations roll
// back to the pre-operation state.
//
// Validates: Requirements 6.5
//
// For any `create_file` or `edit_file` operation that cannot complete, the target
// file is left in the exact state it held immediately before the operation began,
// and the result carries the failure reason (a typed `execution` ToolError).
//
// The property runs against a REAL temporary directory (created with
// `fs.mkdtempSync` under `os.tmpdir()`): each generated case writes through the
// production `nodeWriteFileSystem` wrapped in a `FaultyFileSystem` that injects a
// mid-operation failure at a chosen stage — either the temp-file write or the
// atomic rename that commits it. Because the rename is the single commit point,
// the target must always be observed to hold either its exact pre-operation bytes
// (edit_file) or to remain absent (create_file). Any partial write, leftover temp
// file adjacent to the target, or corrupted target is therefore genuinely caught.
//
// A non-fast-check baseline first confirms that WITHOUT the injected fault the same
// operations succeed, so the rollback assertions below are not vacuously true.

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import * as fc from "fast-check";

import { DefaultWorkspacePathGuard } from "../pathGuard";
import { isToolExecutionError } from "../errors";
import type { ToolContext } from "../types";
import {
  CreateFileTool,
  EditFileTool,
  nodeWriteFileSystem,
  type WriteFileSystem,
} from "./writeFile";

/** The point in the atomic write at which the injected failure fires. */
type FailStage = "temp-write" | "rename";

/**
 * Wraps a real {@link WriteFileSystem} and injects a deterministic failure at a
 * chosen stage of the temp-and-rename write. Every other operation — including the
 * restore-on-failure writes/removes performed by the tool's rollback — delegates to
 * the underlying real filesystem, so the observed on-disk outcome is genuine.
 */
class FaultyFileSystem implements WriteFileSystem {
  public constructor(
    private readonly inner: WriteFileSystem,
    private readonly stage: FailStage
  ) {}

  public readFile(filePath: string): Promise<string> {
    return this.inner.readFile(filePath);
  }

  public async writeFile(filePath: string, data: string): Promise<void> {
    // Fail only the temp-file write (the adjacent `*.tmp`), never the rollback
    // restore of the original target, so restore-on-failure remains observable.
    if (this.stage === "temp-write" && filePath.endsWith(".tmp")) {
      throw new Error("injected temp-write failure");
    }
    return this.inner.writeFile(filePath, data);
  }

  public async rename(oldPath: string, newPath: string): Promise<void> {
    if (this.stage === "rename") {
      throw new Error("injected rename failure");
    }
    return this.inner.rename(oldPath, newPath);
  }

  public remove(filePath: string): Promise<void> {
    return this.inner.remove(filePath);
  }

  public ensureDir(dirPath: string): Promise<void> {
    return this.inner.ensureDir(dirPath);
  }

  public exists(filePath: string): Promise<boolean> {
    return this.inner.exists(filePath);
  }
}

/** Always-approve diff presenter so an `edit_file` proceeds to the write stage. */
const approveDiff = async (): Promise<boolean> => true;

describe("Property 17: failed file operations roll back to the pre-operation state", () => {
  let baseDir: string;
  let rootDir: string;
  let ctx: ToolContext;
  let counter: number;

  before(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "writefile-rollback-"));
    rootDir = path.join(baseDir, "workspace");
    fs.mkdirSync(rootDir, { recursive: true });

    const guard = new DefaultWorkspacePathGuard(() => [rootDir]);
    ctx = {
      guard,
      profile: undefined,
      signal: new AbortController().signal,
    };
    counter = 0;
  });

  after(() => {
    if (baseDir) {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  /** A fresh, unique target path inside the workspace root for each case. */
  function nextTarget(): string {
    counter += 1;
    return path.join(rootDir, `target-${counter}.txt`);
  }

  /** List `*.tmp` sidecar files adjacent to `target` (must never be left behind). */
  function tempSidecars(target: string): string[] {
    const dir = path.dirname(target);
    const base = path.basename(target);
    return fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(`${base}.`) && name.endsWith(".tmp"));
  }

  it("baseline: without an injected fault the operations succeed and write", async () => {
    const created = nextTarget();
    await new CreateFileTool(nodeWriteFileSystem).execute(
      { path: created, content: "hello" },
      ctx
    );
    assert.strictEqual(fs.readFileSync(created, "utf8"), "hello");

    const edited = nextTarget();
    fs.writeFileSync(edited, "before", "utf8");
    await new EditFileTool(approveDiff, nodeWriteFileSystem).execute(
      { path: edited, content: "after" },
      ctx
    );
    assert.strictEqual(fs.readFileSync(edited, "utf8"), "after");
  });

  it("create_file leaves no file behind when the write fails mid-operation", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.constantFrom<FailStage>("temp-write", "rename"),
        async (content, stage) => {
          const target = nextTarget();
          // Pre-operation state: the target does not exist.
          assert.ok(!fs.existsSync(target));

          const tool = new CreateFileTool(new FaultyFileSystem(nodeWriteFileSystem, stage));

          let threw = false;
          try {
            await tool.execute({ path: target, content }, ctx);
          } catch (error) {
            threw = true;
            assert.ok(
              isToolExecutionError(error),
              "a failed create must throw a typed ToolExecutionError"
            );
            assert.strictEqual(
              error.toolError.kind,
              "execution",
              "the failure reason must be carried as an execution error"
            );
          }

          assert.ok(threw, "the injected fault must make the create fail");
          // Rolled back: the target that did not exist before still does not exist,
          // and no temp sidecar was left adjacent to it.
          assert.ok(
            !fs.existsSync(target),
            "a failed create must leave no file at the target"
          );
          assert.deepStrictEqual(
            tempSidecars(target),
            [],
            "a failed create must leave no temp sidecar behind"
          );
        }
      )
    );
  });

  it("edit_file restores the original content when the write fails mid-operation", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string(),
        fc.string(),
        fc.constantFrom<FailStage>("temp-write", "rename"),
        async (original, proposed, stage) => {
          const target = nextTarget();
          // Pre-operation state: the target holds exactly `original`.
          fs.writeFileSync(target, original, "utf8");

          const tool = new EditFileTool(
            approveDiff,
            new FaultyFileSystem(nodeWriteFileSystem, stage)
          );

          let threw = false;
          try {
            await tool.execute({ path: target, content: proposed }, ctx);
          } catch (error) {
            threw = true;
            assert.ok(
              isToolExecutionError(error),
              "a failed edit must throw a typed ToolExecutionError"
            );
            assert.strictEqual(
              error.toolError.kind,
              "execution",
              "the failure reason must be carried as an execution error"
            );
          }

          assert.ok(threw, "the injected fault must make the edit fail");
          // Rolled back: the target holds exactly its pre-operation bytes, and no
          // temp sidecar was left adjacent to it.
          assert.strictEqual(
            fs.readFileSync(target, "utf8"),
            original,
            "a failed edit must restore the exact pre-operation content"
          );
          assert.deepStrictEqual(
            tempSidecars(target),
            [],
            "a failed edit must leave no temp sidecar behind"
          );
        }
      )
    );
  });
});
