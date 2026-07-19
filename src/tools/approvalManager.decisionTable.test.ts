// Feature: agent-tools-and-settings, Property 13: Approval decisions follow the
// classification × policy × autonomy table.
//
// Validates: Requirements 5.2, 5.3, 5.4, 5.5, 5.6, 5.9, 6.1, 8.2
//
// For any combination of tool classification (`read-only` / `mutating`),
// Approval_Policy (`inherit` / `always-ask` / `auto-approve`), and Autonomy_Mode
// (`auto` / `supervised`), `ApprovalManager.resolve` returns the decision required
// by the design decision table:
//
//   | Classification | Policy          | Autonomy    | Result |
//   | -------------- | --------------- | ----------- | ------ |
//   | read-only      | always-ask      | any         | prompt |
//   | read-only      | inherit / auto  | any         | auto   |
//   | mutating       | auto-approve    | any         | auto   |
//   | mutating       | always-ask      | any         | prompt |
//   | mutating       | inherit         | supervised  | prompt |
//   | mutating       | inherit         | auto        | auto   |
//
// `run_terminal` is mutating and, for a single non-compound command with no
// auto-approve allowlist in play, follows the same table rows (Requirement 6.1):
// it prompts under `always-ask` and under `inherit`+`supervised`, and runs without
// confirmation under `auto-approve` (and under `inherit`+`auto`, per Requirement
// 5.3). The per-segment allowlist behaviour is covered separately by Property 29.
//
// `resolve` is a pure function of its inputs and the manager's current mode; it must
// never touch the confirmation UI (a `ForbiddenConfirmationUi` guarantees this). The
// autonomy mode used is the one set immediately before resolution (Requirement 8.2),
// which the test exercises by calling `setAutonomyMode` right before `resolve`.
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
import type {
  ApprovalPolicy,
  AutonomyMode,
  ToolClassification,
  ToolDefinition,
  ToolState,
} from "./types";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const decomposer = new ShellCommandDecomposer();

const ALL_POLICIES: readonly ApprovalPolicy[] = [
  "inherit",
  "always-ask",
  "auto-approve",
];
const ALL_MODES: readonly AutonomyMode[] = ["auto", "supervised"];
const ALL_CLASSIFICATIONS: readonly ToolClassification[] = [
  "read-only",
  "mutating",
];

/** A `policyView` reporting a fixed approval policy for any tool id. */
function policyViewWith(policy: ApprovalPolicy): ApprovalPolicyView {
  return {
    stateOf(_id: string): ToolState {
      return { enabled: true, approvalPolicy: policy };
    },
  };
}

/** A confirmation UI that MUST NOT be consulted by `resolve`; calling it fails. */
class ForbiddenConfirmationUi implements ConfirmationUI {
  public confirm(): Promise<ConfirmationOutcome> {
    throw new Error("confirmation UI must not be invoked by resolve()");
  }
}

/** A non-terminal tool definition with the given classification. */
function nonTerminalDef(classification: ToolClassification): ToolDefinition {
  return {
    id: classification === "mutating" ? "edit_file" : "read_file",
    displayName: classification === "mutating" ? "Edit File" : "Read File",
    description: "A non-terminal tool used to exercise the decision table.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    category: "file",
    classification,
    defaultEnabled: true,
  };
}

/** The `run_terminal` definition (mutating, terminal category). */
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

/**
 * The decision required by the design decision table, expressed as the base rule.
 * `run_terminal` (mutating) with a single covered/non-compound command and no
 * allowlist reduces to this same base decision.
 */
function expectedIsPrompt(
  classification: ToolClassification,
  policy: ApprovalPolicy,
  mode: AutonomyMode,
): boolean {
  if (policy === "always-ask") {
    return true;
  }
  if (policy === "auto-approve") {
    return false;
  }
  // policy === "inherit"
  if (classification === "read-only") {
    return false;
  }
  return mode === "supervised";
}

// -----------------------------------------------------------------------------
// Property 13
// -----------------------------------------------------------------------------

describe("ApprovalManager — Property 13: decisions follow the classification × policy × autonomy table", () => {
  it("non-terminal tools resolve per the decision table for every classification/policy/mode", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_CLASSIFICATIONS),
        fc.constantFrom(...ALL_POLICIES),
        fc.constantFrom(...ALL_MODES),
        (classification, policy, mode) => {
          const manager = new ApprovalManager({
            policyView: policyViewWith(policy),
            confirmationUi: new ForbiddenConfirmationUi(),
            decomposer,
            initialMode: mode,
          });

          const def = nonTerminalDef(classification);
          const decision = manager.resolve(def, { path: "src/file.ts" });

          const expected = expectedIsPrompt(classification, policy, mode)
            ? "prompt"
            : "auto";
          assert.strictEqual(
            decision.outcome,
            expected,
            `classification=${classification}, policy=${policy}, mode=${mode}`,
          );
        },
      ),
    );
  });

  it("run_terminal (single non-compound command, no allowlist) follows the mutating rows", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_POLICIES),
        fc.constantFrom(...ALL_MODES),
        // A single, non-compound command decomposes into exactly one segment.
        fc
          .array(fc.constantFrom(..."abcdef0123".split("")), {
            minLength: 1,
            maxLength: 8,
          })
          .map((chars) => chars.join("")),
        (policy, mode, command) => {
          const manager = new ApprovalManager({
            policyView: policyViewWith(policy),
            confirmationUi: new ForbiddenConfirmationUi(),
            decomposer,
            shell: "posix",
            initialMode: mode,
            // No allowlist in play, so terminal reduces to the base decision.
          });

          const decision = manager.resolve(RUN_TERMINAL_DEF, { command });

          const expected = expectedIsPrompt("mutating", policy, mode)
            ? "prompt"
            : "auto";
          assert.strictEqual(
            decision.outcome,
            expected,
            `run_terminal policy=${policy}, mode=${mode}, command=${JSON.stringify(command)}`,
          );
        },
      ),
    );
  });

  it("uses the autonomy mode set immediately before resolution (Requirement 8.2)", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_MODES),
        fc.constantFrom(...ALL_MODES),
        (initialMode, resolveMode) => {
          const manager = new ApprovalManager({
            policyView: policyViewWith("inherit"),
            confirmationUi: new ForbiddenConfirmationUi(),
            decomposer,
            initialMode,
          });

          // Change the mode right before resolving; the decision must reflect it.
          manager.setAutonomyMode(resolveMode);
          const decision = manager.resolve(nonTerminalDef("mutating"), {
            path: "src/file.ts",
          });

          const expected = resolveMode === "supervised" ? "prompt" : "auto";
          assert.strictEqual(decision.outcome, expected);
        },
      ),
    );
  });
});
