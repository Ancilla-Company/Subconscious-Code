// Feature: agent-tools-and-settings, Property 15: Confirmation prompts describe the
// action.
//
// Validates: Requirements 5.8
//
// For any mutating invocation, the constructed confirmation prompt includes the tool
// name, the target path or command string, and the set of resources to be created,
// modified, or deleted.
//
// This exercises the prompt built by `ApprovalManager.resolve` for two representative
// mutating tools:
//
//   - a file tool (`create_file` / `edit_file`): the prompt's `toolName` is the
//     tool's display name, its `target` is the supplied path, and its
//     `affectedResources` contains that path (the resource created/modified); and
//   - `run_terminal`: the prompt's `toolName` is the display name, its `target` is
//     the command string, and its `affectedResources`/`segments` list the decomposed
//     Command_Segments (the resources the command touches).
//
// Confirmation is forced with an `always-ask` policy so a prompt is always produced.
//
// `ApprovalManager` and `ShellCommandDecomposer` are `vscode`-free, so this
// pure-module property test runs directly under the Node-level Mocha runner.

import * as assert from "assert";

import * as fc from "fast-check";

import {
  ApprovalManager,
  type ApprovalPolicyView,
  type ConfirmationOutcome,
  type ConfirmationUI,
} from "./approvalManager";
import { ShellCommandDecomposer } from "./commandDecomposer";
import type { ToolDefinition, ToolState } from "./types";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const decomposer = new ShellCommandDecomposer();

/** A `policyView` that forces confirmation (always-ask) for every tool. */
const ALWAYS_ASK_VIEW: ApprovalPolicyView = {
  stateOf(_id: string): ToolState {
    return { enabled: true, approvalPolicy: "always-ask" };
  },
};

/** A confirmation UI that must not be consulted by `resolve`. */
class ForbiddenConfirmationUi implements ConfirmationUI {
  public confirm(): Promise<ConfirmationOutcome> {
    throw new Error("confirmation UI must not be invoked by resolve()");
  }
}

const CREATE_FILE_DEF: ToolDefinition = {
  id: "create_file",
  displayName: "Create File",
  description: "Create a new file with the supplied contents.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
    additionalProperties: false,
  },
  category: "file",
  classification: "mutating",
  defaultEnabled: true,
};

const RUN_TERMINAL_DEF: ToolDefinition = {
  id: "run_terminal",
  displayName: "Run Terminal Command",
  description: "Run a shell command in a workspace terminal.",
  inputSchema: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
    additionalProperties: false,
  },
  category: "terminal",
  classification: "mutating",
  defaultEnabled: false,
};

function newManager(): ApprovalManager {
  return new ApprovalManager({
    policyView: ALWAYS_ASK_VIEW,
    confirmationUi: new ForbiddenConfirmationUi(),
    decomposer,
    shell: "posix",
  });
}

// Path-safe fragments so generated paths never contain shell operators/quotes.
const pathSegment = fc
  .array(fc.constantFrom(..."abcXYZ019_-.".split("")), { minLength: 1, maxLength: 8 })
  .map((chars) => chars.join(""));
const pathArb = fc
  .array(pathSegment, { minLength: 1, maxLength: 4 })
  .map((parts) => parts.join("/"));

// Simple command tokens joined by " && " so decomposition is deterministic.
const tokenArb = fc
  .array(fc.constantFrom(..."abcdef0123".split("")), { minLength: 1, maxLength: 6 })
  .map((chars) => chars.join(""));

// -----------------------------------------------------------------------------
// Property 15
// -----------------------------------------------------------------------------

describe("ApprovalManager — Property 15: confirmation prompts describe the action", () => {
  it("file-tool prompts carry the tool name, target path, and affected resource", () => {
    fc.assert(
      fc.property(pathArb, (path) => {
        const manager = newManager();
        const decision = manager.resolve(CREATE_FILE_DEF, { path, content: "data" });

        assert.strictEqual(decision.outcome, "prompt");
        if (decision.outcome !== "prompt") {
          return;
        }
        const { prompt } = decision;
        assert.strictEqual(prompt.toolName, CREATE_FILE_DEF.displayName);
        assert.strictEqual(prompt.target, path, "target must be the supplied path");
        assert.deepStrictEqual(
          prompt.affectedResources,
          [path],
          "the affected resource must be the created/modified path",
        );
      }),
    );
  });

  it("terminal prompts carry the tool name, command string, and per-segment resources", () => {
    fc.assert(
      fc.property(
        fc.array(tokenArb, { minLength: 1, maxLength: 5 }),
        (tokens) => {
          const command = tokens.join(" && ");
          const manager = newManager();
          const decision = manager.resolve(RUN_TERMINAL_DEF, { command });

          assert.strictEqual(decision.outcome, "prompt");
          if (decision.outcome !== "prompt") {
            return;
          }
          const { prompt } = decision;
          assert.strictEqual(prompt.toolName, RUN_TERMINAL_DEF.displayName);
          assert.strictEqual(prompt.target, command, "target must be the command string");
          // Every decomposed segment is surfaced as an affected resource.
          assert.deepStrictEqual(prompt.segments, tokens);
          assert.deepStrictEqual(prompt.affectedResources, tokens);
        },
      ),
    );
  });
});
