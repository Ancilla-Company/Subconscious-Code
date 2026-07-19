// Workspace path safety — the single choke point for file-path scoping.
//
// `DefaultWorkspacePathGuard` implements the shared `WorkspacePathGuard` contract
// (declared in `./types`). It normalizes relative traversal (`.` / `..`), resolves
// symbolic links on every existing path component to their canonical target, and
// rejects any path whose canonical form escapes every workspace root. When no root
// is open it reports `no-workspace`.
//
// The guard is intentionally free of any `vscode` dependency: the current workspace
// roots are supplied by an injected provider so the module can be exercised against
// temporary directories outside the VS Code host. Production wiring passes a provider
// backed by `vscode.workspace.workspaceFolders`.
//
// _Requirements: 4.1, 4.2, 4.3, 4.4_

import * as fs from "fs";
import * as path from "path";

import type { PathResolution, WorkspacePathGuard } from "./types";

/** Supplies the current workspace folder filesystem paths. */
export type WorkspaceRootsProvider = () => readonly string[];

/**
 * Canonicalize a filesystem path by resolving symbolic links on every existing
 * component to their real target. Because the target of a file operation (e.g.
 * `create_file`) need not yet exist, the longest existing prefix is canonicalized
 * via {@link fs.realpathSync} and the remaining not-yet-existing components are
 * appended to the resolved prefix. This guarantees that a symlinked intermediate
 * directory is followed to its real target before the scope check runs
 * (Requirement 4.1, 4.3).
 */
function canonicalize(target: string): string {
  const resolved = path.resolve(target);
  let current = resolved;
  const trailing: string[] = [];

  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      if (trailing.length === 0) {
        return real;
      }
      const suffix = trailing.slice().reverse();
      return path.join(real, ...suffix);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        // Reached the filesystem root and nothing along the path exists; fall back
        // to the fully normalized (but un-canonicalized) path.
        return resolved;
      }
      trailing.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Return true when `child` is `parent` itself or lies beneath it. Uses
 * {@link path.relative} so the comparison honours platform path semantics
 * (including case-insensitivity on Windows).
 */
function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

/**
 * Concrete {@link WorkspacePathGuard}. All file tools resolve their paths through a
 * single instance so the scoping rules are enforced in exactly one place.
 */
export class DefaultWorkspacePathGuard implements WorkspacePathGuard {
  private readonly rootsProvider: WorkspaceRootsProvider;

  public constructor(rootsProvider: WorkspaceRootsProvider) {
    this.rootsProvider = rootsProvider;
  }

  /** Current workspace folder filesystem paths (Requirement 4.1). */
  public roots(): string[] {
    return [...this.rootsProvider()];
  }

  /**
   * Resolve `inputPath` against the workspace roots. Relative paths are resolved
   * against each root in turn; absolute paths are checked against every root. The
   * candidate is canonicalized (normalizing `.`/`..` and following symlinks on every
   * existing component) before the scope check. Succeeds with the canonical path and
   * matching root when the result lies within a root; otherwise reports
   * `out-of-scope`. Reports `no-workspace` when no root is open (Requirement 4.2–4.4).
   */
  public resolve(inputPath: string): PathResolution {
    const rawRoots = this.rootsProvider();
    if (rawRoots.length === 0) {
      return { ok: false, error: "no-workspace" };
    }

    const canonicalRoots = rawRoots.map((root) => canonicalize(root));

    for (let index = 0; index < rawRoots.length; index += 1) {
      const base = rawRoots[index];
      const candidate = path.isAbsolute(inputPath)
        ? inputPath
        : path.resolve(base, inputPath);
      const canonicalPath = canonicalize(candidate);
      const canonicalRoot = canonicalRoots[index];

      if (isWithin(canonicalPath, canonicalRoot)) {
        return { ok: true, canonicalPath, root: canonicalRoot };
      }
    }

    return { ok: false, error: "out-of-scope" };
  }
}
