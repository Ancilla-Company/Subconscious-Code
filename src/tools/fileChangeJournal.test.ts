// Unit tests for `FileChangeJournal` — the in-chat Show/Undo backing store.
//
// These are pure-module tests (no `vscode`, no real filesystem): the journal is driven
// against an in-memory `UndoFileSystem`, so undo semantics can be verified exactly.
//
// Covers: undoing an edit restores the previous bytes; undoing a creation deletes the
// file; an unknown or already-reverted change is refused with a reason rather than
// silently no-op'ing; a filesystem failure is reported and does NOT mark the change
// reverted (so the user can retry).

import * as assert from "assert";

import { FileChangeJournal, type UndoFileSystem } from "./fileChangeJournal";

// -----------------------------------------------------------------------------
// In-memory filesystem double
// -----------------------------------------------------------------------------

class FakeFs implements UndoFileSystem {
  public readonly files = new Map<string, string>();
  public failWith?: string;

  public constructor(initial: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(initial)) {
      this.files.set(k, v);
    }
  }

  public async writeFile(filePath: string, data: string): Promise<void> {
    if (this.failWith !== undefined) {
      throw new Error(this.failWith);
    }
    this.files.set(filePath, data);
  }

  public async remove(filePath: string): Promise<void> {
    if (this.failWith !== undefined) {
      throw new Error(this.failWith);
    }
    this.files.delete(filePath);
  }

  public async readFile(filePath: string): Promise<string> {
    const found = this.files.get(filePath);
    if (found === undefined) {
      throw new Error(`ENOENT: ${filePath}`);
    }
    return found;
  }

  public async exists(filePath: string): Promise<boolean> {
    return this.files.has(filePath);
  }
}

const PATH = "/workspace/project/src/main.ts";

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("FileChangeJournal", () => {
  it("restores the previous contents when undoing an edit", async () => {
    const fs = new FakeFs({ [PATH]: "edited" });
    const journal = new FileChangeJournal(fs);

    const record = journal.record({
      toolId: "edit_file",
      path: PATH,
      previousContent: "original",
      newContent: "edited",
    });

    const result = await journal.undo(record.id);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(fs.files.get(PATH), "original", "the pre-edit bytes must be restored");
    if (result.ok) {
      assert.strictEqual(result.deleted, false);
    }
  });

  it("deletes the file again when undoing a creation", async () => {
    const fs = new FakeFs({ [PATH]: "brand new" });
    const journal = new FileChangeJournal(fs);

    const record = journal.record({
      toolId: "create_file",
      path: PATH,
      previousContent: null,
      newContent: "brand new",
    });

    const result = await journal.undo(record.id);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(fs.files.has(PATH), false, "a created file must be removed again");
    if (result.ok) {
      assert.strictEqual(result.deleted, true);
    }
  });

  it("refuses an unknown change with a reason", async () => {
    const journal = new FileChangeJournal(new FakeFs());

    const result = await journal.undo("change-does-not-exist");

    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.ok(result.reason.length > 0, "a refusal must explain itself");
    }
  });

  it("refuses to revert the same change twice", async () => {
    const fs = new FakeFs({ [PATH]: "edited" });
    const journal = new FileChangeJournal(fs);
    const record = journal.record({
      toolId: "edit_file",
      path: PATH,
      previousContent: "original",
      newContent: "edited",
    });

    const first = await journal.undo(record.id);
    assert.strictEqual(first.ok, true);

    // Simulate the user editing the file after the revert; a second undo must not
    // clobber that work.
    fs.files.set(PATH, "my own later edit");
    const second = await journal.undo(record.id);

    assert.strictEqual(second.ok, false);
    assert.strictEqual(fs.files.get(PATH), "my own later edit");
  });

  it("reports a filesystem failure and leaves the change retryable", async () => {
    const fs = new FakeFs({ [PATH]: "edited" });
    const journal = new FileChangeJournal(fs);
    const record = journal.record({
      toolId: "edit_file",
      path: PATH,
      previousContent: "original",
      newContent: "edited",
    });

    fs.failWith = "EACCES: permission denied";
    const failed = await journal.undo(record.id);
    assert.strictEqual(failed.ok, false);
    if (!failed.ok) {
      assert.match(failed.reason, /permission denied/);
    }

    // Not marked reverted, so retrying after the cause is fixed still works.
    fs.failWith = undefined;
    const retried = await journal.undo(record.id);
    assert.strictEqual(retried.ok, true);
    assert.strictEqual(fs.files.get(PATH), "original");
  });

  it("keeps separate records for concurrent changes to different files", async () => {
    const other = "/workspace/project/src/other.ts";
    const fs = new FakeFs({ [PATH]: "a2", [other]: "b2" });
    const journal = new FileChangeJournal(fs);

    const first = journal.record({
      toolId: "edit_file",
      path: PATH,
      previousContent: "a1",
      newContent: "a2",
    });
    const second = journal.record({
      toolId: "edit_file",
      path: other,
      previousContent: "b1",
      newContent: "b2",
    });

    assert.notStrictEqual(first.id, second.id, "each change needs its own id");

    await journal.undo(second.id);
    assert.strictEqual(fs.files.get(other), "b1");
    assert.strictEqual(fs.files.get(PATH), "a2", "undoing one change must not touch another");
  });
});
