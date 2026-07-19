// Host (integration) test configuration for the Subconscious Code extension.
//
// Pure modules (registry, path guard, command decomposer, approval resolver,
// config round-trip, etc.) run outside the VS Code host via Mocha — see
// `.mocharc.json` and `scripts/run-unit-tests.js`.
//
// Tests that need the live extension host (view registration, engine RPC
// wiring, `vscode.*` APIs) are named `*.vscode.test.ts` and run here through
// `@vscode/test-electron`, driven by `@vscode/test-cli` (the `vscode-test`
// binary). Filter with `--label`, `--grep`, or `--run` per the CLI.
import { defineConfig } from "@vscode/test-cli";

export default defineConfig({
  label: "host",
  files: "out/**/*.vscode.test.js",
  version: "stable",
  mocha: {
    ui: "bdd",
    color: true,
    timeout: 60000,
    require: ["out/test/setup.js"],
  },
});
