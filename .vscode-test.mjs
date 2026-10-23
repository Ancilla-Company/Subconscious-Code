// Test configuration for the Subconscious Code extension, read by `vscode-test`
// (@vscode/test-cli) and by the "Extension Test Runner" extension (ms-vscode.extension-test-runner),
// which turns every entry below into a node of the Testing panel (grouped by `label`).
//
//   host  - `*.vscode.test.js`: needs the real extension host (`vscode.*` APIs, view registration).
//   unit  - every pure-module test, run inside the VS Code host through the same runner. The canonical,
//           fast runner stays plain Node: `npm run test:unit` (scripts/run-unit-tests.js). This entry exists
//           so the Testing panel can run/debug/watch them with one click; both run the same compiled files.
//   live  - `*.live.test.js`: end-to-end against a RUNNING stack (task "Live: Start stack"). They skip with a
//           clear message when no stack is reachable, so the entry is always safe to run.
//
// CLI: `npx vscode-test --label host|unit|live` (downloads a VS Code build into .vscode-test/, git-ignored).
// The compiled output in `out/` must be fresh: the `npm: watch` task (tsc -watch) keeps it so while the panel
// is used; `npm run pretest:*` compiles once for the CLI scripts.
import { defineConfig } from "@vscode/test-cli";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

/** Absolute paths of the compiled pure-module tests (not host, not live), recomputed on every load. */
function unitFiles() {
  try {
    return readdirSync(join(root, "out"), { recursive: true })
      .map(String)
      .filter(
        (f) =>
          f.endsWith(".test.js") &&
          !f.endsWith(".vscode.test.js") &&
          !f.endsWith(".live.test.js"),
      )
      .map((f) => join(root, "out", f));
  } catch {
    return []; // not compiled yet; the panel/CLI run the compile task first
  }
}

const mocha = (timeout, extra = {}) => ({
  ui: "bdd",
  color: true,
  timeout,
  require: [join(root, "out", "test", "setup.js")],
  ...extra,
});

export default defineConfig([
  {
    label: "host",
    files: "out/**/*.vscode.test.js",
    version: "stable",
    mocha: mocha(60000),
  },
  {
    label: "unit",
    // absolute paths are used as-is by test-cli; an empty list simply finds no tests
    files: unitFiles(),
    version: "stable",
    mocha: mocha(20000),
  },
  {
    label: "live",
    files: "out/test/live/**/*.live.test.js",
    version: "stable",
    // no setup.js: the live tests install their own `vscode` shim (src/test/live/liveStack.ts)
    mocha: { ui: "bdd", color: true, timeout: 60000 },
  },
]);
