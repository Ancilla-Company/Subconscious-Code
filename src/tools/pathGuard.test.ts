// Feature: agent-tools-and-settings, Property 11: File paths are accepted iff
// they resolve inside a workspace root.
//
// Validates: Requirements 4.1, 4.2, 4.3, 4.4
//
// `DefaultWorkspacePathGuard.resolve` — after normalizing `.`/`..` and resolving
// symbolic links to their canonical target — must succeed iff the canonical path
// falls within some workspace root, and otherwise return an `out-of-scope` error.
// When no workspace root is open it must return `no-workspace`. In the rejection
// case the guard performs no file operation (it is a pure resolver).
//
// These properties run against REAL temporary directories (created with
// `fs.mkdtempSync` under `os.tmpdir()`) so the symlink/canonicalization behaviour
// is exercised for real, then cleaned up afterwards. Expected outcomes are fixed
// by construction (each generated case is tagged inside/escape) rather than by
// re-deriving the guard's own logic, so a scope-check bug is genuinely caught.

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import * as fc from "fast-check";

import { DefaultWorkspacePathGuard } from "./pathGuard";
import type { WorkspaceRootsProvider } from "./pathGuard";

/** Returns true when `child` is `parent` itself or lies beneath it. */
function isWithin(child: string, parent: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

describe("Property 11: file paths are accepted iff they resolve inside a workspace root", () => {
  let baseDir: string;
  let rootDir: string;
  let root2Dir: string;
  let outsideDir: string;
  let realRoot: string;
  let realRoot2: string;
  const secretContent = "top-secret-outside-content";

  // Symlink fixtures (may be unavailable on Windows without privilege).
  let symlinkSupported = false;
  let linkInside: string; // rootDir/link-in -> rootDir/a  (target inside root)
  let linkOutside: string; // rootDir/link-out -> outsideDir (target outside root)

  before(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "pathguard-"));
    rootDir = path.join(baseDir, "workspace");
    root2Dir = path.join(baseDir, "workspace2");
    outsideDir = path.join(baseDir, "outside");

    fs.mkdirSync(path.join(rootDir, "a", "b"), { recursive: true });
    fs.mkdirSync(path.join(rootDir, "sub"), { recursive: true });
    fs.mkdirSync(path.join(root2Dir, "x"), { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), secretContent);

    // Canonicalized roots (tmpdir itself may be a symlink on some platforms).
    realRoot = fs.realpathSync.native(rootDir);
    realRoot2 = fs.realpathSync.native(root2Dir);

    linkInside = path.join(rootDir, "link-in");
    linkOutside = path.join(rootDir, "link-out");
    try {
      fs.symlinkSync(path.join(rootDir, "a"), linkInside, "dir");
      fs.symlinkSync(outsideDir, linkOutside, "dir");
      symlinkSupported = true;
    } catch {
      symlinkSupported = false;
    }
  });

  after(() => {
    if (baseDir) {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("accepts paths whose canonical form lies inside a root and rejects those that escape", () => {
    const provider: WorkspaceRootsProvider = () => [rootDir];
    const guard = new DefaultWorkspacePathGuard(provider);

    // Relative descent (no `..`): always stays inside the single root.
    const insideRelative = fc
      .array(fc.constantFrom("a", "b", "sub", ".", "nested"), { maxLength: 5 })
      .map((segs) => ({
        kind: "inside" as const,
        input: ["." as string, ...segs].join("/"),
      }));

    // Absolute path built under the root: inside regardless of existence.
    const insideAbsolute = fc
      .array(fc.constantFrom("a", "b", "sub", "x", "new"), { maxLength: 4 })
      .map((segs) => ({
        kind: "inside" as const,
        input: path.join(rootDir, ...segs),
      }));

    // Relative traversal that climbs out of the root via `..`.
    const escapeRelative = fc
      .record({
        ups: fc.integer({ min: 1, max: 4 }),
        tail: fc.constantFrom("outside", "outside/secret.txt", "foo", "x/y"),
      })
      .map(({ ups, tail }) => ({
        kind: "escape" as const,
        input: [...new Array(ups).fill(".."), tail].join("/"),
      }));

    // Absolute path built under a sibling directory outside every root.
    const escapeAbsolute = fc
      .array(fc.constantFrom("secret.txt", "foo", "x", "y"), { maxLength: 3 })
      .map((segs) => ({
        kind: "escape" as const,
        input: path.join(outsideDir, ...segs),
      }));

    fc.assert(
      fc.property(
        fc.oneof(insideRelative, insideAbsolute, escapeRelative, escapeAbsolute),
        (testCase) => {
          const result = guard.resolve(testCase.input);
          if (testCase.kind === "inside") {
            assert.strictEqual(
              result.ok,
              true,
              `expected acceptance for ${testCase.input}`
            );
            if (result.ok) {
              assert.strictEqual(result.root, realRoot);
              assert.ok(
                isWithin(result.canonicalPath, realRoot),
                `canonical ${result.canonicalPath} not within ${realRoot}`
              );
            }
          } else {
            assert.strictEqual(
              result.ok,
              false,
              `expected rejection for ${testCase.input}`
            );
            if (!result.ok) {
              assert.strictEqual(result.error, "out-of-scope");
            }
          }
        }
      )
    );
  });

  it("selects the matching root when multiple workspace roots are open", () => {
    const provider: WorkspaceRootsProvider = () => [rootDir, root2Dir];
    const guard = new DefaultWorkspacePathGuard(provider);

    const inRoot1 = fc
      .array(fc.constantFrom("a", "b", "sub"), { maxLength: 3 })
      .map((segs) => ({ root: realRoot, input: path.join(rootDir, ...segs) }));
    const inRoot2 = fc
      .array(fc.constantFrom("x", "y"), { maxLength: 3 })
      .map((segs) => ({ root: realRoot2, input: path.join(root2Dir, ...segs) }));

    fc.assert(
      fc.property(fc.oneof(inRoot1, inRoot2), (testCase) => {
        const result = guard.resolve(testCase.input);
        assert.strictEqual(result.ok, true, `expected acceptance for ${testCase.input}`);
        if (result.ok) {
          assert.strictEqual(result.root, testCase.root);
          assert.ok(isWithin(result.canonicalPath, testCase.root));
        }
      })
    );
  });

  it("returns no-workspace for any path when no root is open", () => {
    const provider: WorkspaceRootsProvider = () => [];
    const guard = new DefaultWorkspacePathGuard(provider);

    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.constantFrom(rootDir, outsideDir, "./a", "../b", "/etc/passwd")
        ),
        (input) => {
          const result = guard.resolve(input);
          assert.strictEqual(result.ok, false);
          if (!result.ok) {
            assert.strictEqual(result.error, "no-workspace");
          }
        }
      )
    );
  });

  it("performs no file operation when rejecting an out-of-scope path", () => {
    const provider: WorkspaceRootsProvider = () => [rootDir];
    const guard = new DefaultWorkspacePathGuard(provider);
    const secretPath = path.join(outsideDir, "secret.txt");

    fc.assert(
      fc.property(
        fc
          .array(fc.constantFrom("ghost", "phantom", "nope"), { maxLength: 3 })
          .map((segs) => path.join(outsideDir, "missing", ...segs, "x.txt")),
        (input) => {
          const before = fs.readFileSync(secretPath, "utf8");
          const result = guard.resolve(input);
          assert.strictEqual(result.ok, false);
          if (!result.ok) {
            assert.strictEqual(result.error, "out-of-scope");
          }
          // The rejected target was never created and the sibling file is intact.
          assert.strictEqual(fs.existsSync(input), false);
          assert.strictEqual(fs.readFileSync(secretPath, "utf8"), before);
        }
      )
    );
  });

  it("follows symlinks to their canonical target before checking scope", function () {
    if (!symlinkSupported) {
      this.skip();
      return;
    }
    const provider: WorkspaceRootsProvider = () => [rootDir];
    const guard = new DefaultWorkspacePathGuard(provider);

    fc.assert(
      fc.property(
        fc.oneof(
          // A symlink whose target is inside the root resolves inside.
          fc
            .constantFrom("", "file.txt", "deeper/leaf")
            .map((tail) => ({
              kind: "inside" as const,
              input: tail ? path.join(linkInside, tail) : linkInside,
            })),
          // A symlink whose target is outside the root escapes scope.
          fc
            .constantFrom("", "secret.txt", "nested/leaf")
            .map((tail) => ({
              kind: "escape" as const,
              input: tail ? path.join(linkOutside, tail) : linkOutside,
            }))
        ),
        (testCase) => {
          const result = guard.resolve(testCase.input);
          if (testCase.kind === "inside") {
            assert.strictEqual(result.ok, true, `expected inside for ${testCase.input}`);
            if (result.ok) {
              assert.ok(isWithin(result.canonicalPath, realRoot));
            }
          } else {
            assert.strictEqual(result.ok, false, `expected escape for ${testCase.input}`);
            if (!result.ok) {
              assert.strictEqual(result.error, "out-of-scope");
            }
          }
        }
      )
    );
  });
});
