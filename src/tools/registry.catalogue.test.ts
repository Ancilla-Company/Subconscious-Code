// Feature: agent-tools-and-settings — unit tests for catalogue membership and
// classification (Task 3.5).
//
// Validates: Requirements 1.1, 1.3, 1.4
//
// These are example-based unit tests (not property tests). They pin the exact set
// of thirteen built-in Coding_Tools (Requirement 1.1, plus the Copilot-parity tools)
// and the mutating/read-only classification of each tool against the design table
// (Requirements 1.3, 1.4). They run outside the VS Code host against the pure
// `BUILTIN_TOOL_DEFINITIONS` catalogue and the `ToolRegistry.all()` ordering.
import * as assert from "assert";

import { ConfigStore, type MementoLike } from "./configStore";
import { BUILTIN_TOOL_DEFINITIONS, ToolRegistry } from "./registry";
import type { ToolClassification } from "./types";

// -----------------------------------------------------------------------------
// Expected catalogue (per design.md tool table, Requirements 1.1, 1.3, 1.4)
// -----------------------------------------------------------------------------

/**
 * The exact set of built-in tool ids (ten core + three Copilot-parity tools).
 *
 * `grep_search` is intentionally absent: a hand-rolled recursive file-content walk
 * is not cross-platform reliable, so it was removed in favor of `run_terminal`
 * (OS-appropriate `grep`/`findstr`) or `search_files`.
 */
const EXPECTED_TOOL_IDS: readonly string[] = [
  "read_file",
  "list_directory",
  "search_files",
  "create_file",
  "edit_file",
  "run_terminal",
  "get_diagnostics",
  "run_tests",
  "fetch_web",
  "list_code_usages",
  "get_changes",
  "run_task",
  "get_workspace_context",
  "start_debug",
];

/**
 * The classification each tool must carry per the design table:
 * create_file / edit_file / run_terminal / run_tests / run_task are mutating
 * (Requirement 1.3); the remaining read/search/diagnostics/web tools are read-only
 * (Requirement 1.4).
 */
const EXPECTED_CLASSIFICATION: Readonly<Record<string, ToolClassification>> = {
  read_file: "read-only",
  list_directory: "read-only",
  search_files: "read-only",
  create_file: "mutating",
  edit_file: "mutating",
  run_terminal: "mutating",
  get_diagnostics: "read-only",
  run_tests: "mutating",
  fetch_web: "read-only",
  list_code_usages: "read-only",
  get_changes: "read-only",
  run_task: "mutating",
  get_workspace_context: "read-only",
  start_debug: "mutating",
};

// -----------------------------------------------------------------------------
// In-memory ConfigStore backing (no persisted state ⇒ registry defaults)
// -----------------------------------------------------------------------------

/** A MementoLike with no stored value, so the registry uses its defaults. */
function emptyStore(): MementoLike {
  return {
    get<T>(_key: string): T | undefined {
      return undefined;
    },
    update(_key: string, _value: unknown): PromiseLike<void> {
      return Promise.resolve();
    },
  };
}

function newRegistry(): ToolRegistry {
  const store = new ConfigStore(
    emptyStore(),
    emptyStore(),
    BUILTIN_TOOL_DEFINITIONS
  );
  return new ToolRegistry(store);
}

// -----------------------------------------------------------------------------
// Catalogue membership (Requirement 1.1)
// -----------------------------------------------------------------------------

describe("ToolRegistry catalogue — membership (Requirement 1.1)", () => {
  it("BUILTIN_TOOL_DEFINITIONS contains exactly the required tool ids", () => {
    const actualIds = BUILTIN_TOOL_DEFINITIONS.map((def) => def.id);

    assert.strictEqual(
      actualIds.length,
      EXPECTED_TOOL_IDS.length,
      "catalogue must define exactly the expected number of tools"
    );
    assert.deepStrictEqual(
      [...actualIds].sort(),
      [...EXPECTED_TOOL_IDS].sort(),
      "catalogue ids must equal the required set"
    );
  });

  it("has no duplicate tool ids", () => {
    const ids = BUILTIN_TOOL_DEFINITIONS.map((def) => def.id);
    assert.strictEqual(
      new Set(ids).size,
      ids.length,
      "every tool id must be unique"
    );
  });

  it("ToolRegistry.all() exposes exactly the required tools", () => {
    const registry = newRegistry();
    const ids = registry.all().map((def) => def.id);

    assert.strictEqual(ids.length, EXPECTED_TOOL_IDS.length);
    assert.deepStrictEqual([...ids].sort(), [...EXPECTED_TOOL_IDS].sort());
  });

  it("resolves each required tool id through ToolRegistry.get()", () => {
    const registry = newRegistry();
    for (const id of EXPECTED_TOOL_IDS) {
      assert.ok(registry.get(id), `registry must know tool "${id}"`);
    }
  });
});

// -----------------------------------------------------------------------------
// Classification (Requirements 1.3, 1.4)
// -----------------------------------------------------------------------------

describe("ToolRegistry catalogue — classification (Requirements 1.3, 1.4)", () => {
  it("classifies every tool exactly as the design table specifies", () => {
    for (const def of BUILTIN_TOOL_DEFINITIONS) {
      assert.strictEqual(
        def.classification,
        EXPECTED_CLASSIFICATION[def.id],
        `tool "${def.id}" must be ${EXPECTED_CLASSIFICATION[def.id]}`
      );
    }
  });

  it("marks create_file, edit_file, run_terminal, run_tests, run_task and start_debug as mutating (Requirement 1.3)", () => {
    const mutating = BUILTIN_TOOL_DEFINITIONS.filter(
      (def) => def.classification === "mutating"
    ).map((def) => def.id);

    assert.deepStrictEqual(
      [...mutating].sort(),
      ["create_file", "edit_file", "run_terminal", "run_tests", "run_task", "start_debug"].sort(),
      "exactly the six mutating tools must be classified mutating"
    );
  });

  it("marks the read/search/diagnostics/web tools as read-only (Requirement 1.4)", () => {
    const readOnly = BUILTIN_TOOL_DEFINITIONS.filter(
      (def) => def.classification === "read-only"
    ).map((def) => def.id);

    assert.deepStrictEqual(
      [...readOnly].sort(),
      [
        "read_file",
        "list_directory",
        "search_files",
        "get_diagnostics",
        "fetch_web",
        "list_code_usages",
        "get_changes",
        "get_workspace_context",
      ].sort(),
      "exactly the eight read-only tools must be classified read-only"
    );
  });

  it("classifies every tool as exactly one of read-only or mutating", () => {
    for (const def of BUILTIN_TOOL_DEFINITIONS) {
      assert.ok(
        def.classification === "read-only" || def.classification === "mutating",
        `tool "${def.id}" has an invalid classification: ${def.classification}`
      );
    }
  });
});
