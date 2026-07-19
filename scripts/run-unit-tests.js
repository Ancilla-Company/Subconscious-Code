// Node-level runner for pure-module unit and property tests.
//
// Pure modules are tested outside the VS Code host (see design.md). This
// wrapper drives Mocha programmatically so the workspace testing standards are
// honoured regardless of which filtering flag the caller uses:
//
//   npm test                                  # run every pure-module test
//   npm test -- --silent                      # minimal-verbosity reporter
//   npm test -- --grep "Property 27"          # Mocha-style filter
//   npm test -- --testNamePattern "Property"  # Jest-style filter (alias)
//   npm test -- -t "decompose"                # short alias
//
// Host/integration tests (named `*.vscode.test.ts`) run separately through
// `@vscode/test-electron` via `npm run test:host`.
"use strict";

const path = require("path");
const fs = require("fs");
const Mocha = require("mocha");

const OUT_DIR = path.resolve(__dirname, "..", "out");
const SETUP_FILE = path.join(OUT_DIR, "test", "setup.js");

/**
 * Minimal argument parsing. Supports `--flag value` and `--flag=value`.
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const parsed = { silent: false, grep: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const takeValue = (inline) => {
      if (inline !== undefined) {
        return inline;
      }
      const next = argv[i + 1];
      i++;
      return next;
    };
    const [name, inlineValue] = arg.startsWith("--")
      ? arg.slice(2).split(/=(.*)/s)
      : [arg, undefined];

    if (arg === "--silent" || arg === "--quiet") {
      parsed.silent = true;
    } else if (name === "grep" || name === "testNamePattern") {
      parsed.grep = takeValue(inlineValue);
    } else if (arg === "-g" || arg === "-t") {
      parsed.grep = takeValue(undefined);
    }
  }
  return parsed;
}

/**
 * Recursively collect compiled test files, excluding host tests that must run
 * inside the VS Code extension host.
 * @param {string} dir
 * @param {string[]} acc
 */
function collectTestFiles(dir, acc) {
  if (!fs.existsSync(dir)) {
    return acc;
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTestFiles(full, acc);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".test.js") &&
      !entry.name.endsWith(".vscode.test.js")
    ) {
      acc.push(full);
    }
  }
  return acc;
}

function main() {
  if (!fs.existsSync(OUT_DIR)) {
    console.error(
      "Compiled output not found. Run `npm run compile` before testing."
    );
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));

  const mocha = new Mocha({
    ui: "bdd",
    color: true,
    timeout: 20000,
    reporter: args.silent ? "min" : "spec",
  });

  if (args.grep) {
    mocha.grep(args.grep);
  }

  // Enforce shared property-test defaults (min 100 iterations) before any spec.
  if (fs.existsSync(SETUP_FILE)) {
    require(SETUP_FILE);
  }

  const files = collectTestFiles(OUT_DIR, []);
  if (files.length === 0) {
    if (!args.silent) {
      console.log("No pure-module tests found (out/**/*.test.js).");
    }
    process.exit(0);
  }

  for (const file of files) {
    mocha.addFile(file);
  }

  mocha.run((failures) => {
    process.exitCode = failures ? 1 : 0;
  });
}

main();
