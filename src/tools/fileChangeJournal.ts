// Feature: agent-tools-and-settings — journal of agent-made file changes, for
// in-chat "Show" / "Undo" on a create_file / edit_file tool card.
//
// `create_file` and `edit_file` write atomically and are individually approved, but
// once written there was no way to look at (or take back) a change from the chat
// without asking the model to do it — which costs a whole turn and may not even
// restore the original bytes. This journal records the before/after content of every
// successful mutation so the chat UI can offer both directly:
//
//   - Show — open a diff of the change (or the created file) in the editor.
//   - Undo — restore the file to exactly the bytes it held before the tool ran, or
//            delete it again when the tool created it.
//
// Undo is a PURELY LOCAL operation: it never sends a frame to the engine and never
// appears as a message, so reverting the agent's edit does not perturb the
// conversation or cost tokens. The model is not told; the transcript keeps showing
// what the tool did, with the card marked as reverted.
//
// Entries are held for the session only (they carry full file contents, which have no
// business in persisted extension state). After a window reload the cards remain but
// their changes are no longer undoable — `undo` reports that honestly rather than
// silently doing nothing.

/** A single recorded file mutation. */
export interface FileChangeRecord {
  /** Stable id, referenced by the chat card's Show/Undo buttons. */
  readonly id: string;
  /** The tool that made the change (`create_file` / `edit_file`). */
  readonly toolId: string;
  /** Absolute, canonical path of the affected file. */
  readonly path: string;
  /** The file's contents before the change; `null` when the tool created it. */
  readonly previousContent: string | null;
  /** The contents the tool wrote. */
  readonly newContent: string;
  /** When the change was recorded. */
  readonly at: number;
  /** Set once the change has been reverted, so it is not offered twice. */
  reverted: boolean;
}

/** The details a tool reports when it successfully mutates a file. */
export interface FileChangeInput {
  readonly toolId: string;
  readonly path: string;
  readonly previousContent: string | null;
  readonly newContent: string;
}

/**
 * Notified when a tool mutates a file. Injected into the write tools so they stay
 * free of any journal/vscode dependency and remain unit-testable.
 */
export type FileChangeReporter = (change: FileChangeInput) => void;

/** The filesystem operations an undo needs. Injected so undo is testable. */
export interface UndoFileSystem {
  /** Write UTF-8 text to a file, creating or overwriting it. */
  writeFile(filePath: string, data: string): Promise<void>;
  /** Remove a file; resolves quietly when it is already absent. */
  remove(filePath: string): Promise<void>;
  /** Read a file's contents as UTF-8 text. */
  readFile(filePath: string): Promise<string>;
  /** Whether the path currently exists. */
  exists(filePath: string): Promise<boolean>;
}

/** The outcome of an undo attempt. */
export type UndoResult =
  | { readonly ok: true; readonly path: string; readonly deleted: boolean }
  | { readonly ok: false; readonly reason: string };

/** Maximum number of changes retained (oldest are dropped) to bound memory. */
const MAX_ENTRIES = 200;

/**
 * In-memory record of the file changes the agent has made this session, supporting
 * lookup for "Show" and restoration for "Undo".
 */
export class FileChangeJournal {
  private readonly entries = new Map<string, FileChangeRecord>();
  private counter = 0;

  public constructor(private readonly fs: UndoFileSystem) {}

  /** Record a successful mutation and return its new id. */
  public record(change: FileChangeInput): FileChangeRecord {
    this.counter += 1;
    const record: FileChangeRecord = {
      id: `change-${this.counter}`,
      toolId: change.toolId,
      path: change.path,
      previousContent: change.previousContent,
      newContent: change.newContent,
      at: Date.now(),
      reverted: false,
    };
    this.entries.set(record.id, record);
    this.evictOldest();
    return record;
  }

  /** Look up a recorded change by id. */
  public get(id: string): FileChangeRecord | undefined {
    return this.entries.get(id);
  }

  /**
   * Restore the file to its pre-change state: rewrite the previous bytes, or delete
   * the file when the change created it. Local only — no engine frame is sent.
   *
   * Refuses when the change is unknown (e.g. recorded before a window reload) or was
   * already reverted, so the caller can tell the user rather than silently no-op.
   */
  public async undo(id: string): Promise<UndoResult> {
    const record = this.entries.get(id);
    if (record === undefined) {
      return {
        ok: false,
        reason:
          "This change is no longer undoable (it was made before the window was reloaded).",
      };
    }
    if (record.reverted) {
      return { ok: false, reason: "This change has already been reverted." };
    }

    try {
      if (record.previousContent === null) {
        // The tool created the file: undo removes it again.
        await this.fs.remove(record.path);
        record.reverted = true;
        return { ok: true, path: record.path, deleted: true };
      }
      await this.fs.writeFile(record.path, record.previousContent);
      record.reverted = true;
      return { ok: true, path: record.path, deleted: false };
    } catch (error) {
      return {
        ok: false,
        reason: `Couldn't revert ${record.path}: ${describeError(error)}`,
      };
    }
  }

  /** Drop the oldest entries once the cap is exceeded. */
  private evictOldest(): void {
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.entries.delete(oldest.value);
    }
  }
}

/** Extract a human-readable message from an unknown thrown value. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
