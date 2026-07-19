// Feature: agent-tools-and-settings, Property 14: Declining a confirmation prevents
// execution and preserves the workspace.
//
// Validates: Requirements 5.7, 6.3, 6.4
//
// For any mutating tool whose confirmation is declined, the tool's action is never
// executed, the workspace is left unchanged, and the result is a `rejected`
// (cancelled/declined) error.
//
// The ApprovalManager is the choke point that gates execution: its observable
// contract is that `requestConfirmation` returns `false` for a declined or dismissed
// prompt (Requirement 5.7, 5.11). A `false` outcome is precisely the signal the
// ToolHost uses to abort without executing and to return a `rejected` error while
// leaving the workspace untouched (Requirement 6.3, 6.4) — verified end-to-end in the
// host-level tests. Here we prove the gate:
//
//   1. resolving a mutating invocation whose policy/mode require confirmation yields
//      a `prompt` (execution never proceeds without one);
//   2. `requestConfirmation` returns `false` when the user declines OR when the
//      prompt is dismissed/times out (modelled with a UI that declines / a very
//      short timeout); and
//   3. a declined confirmation records NO session grant, so the manager's approval
//      state is preserved exactly as it was before the (declined) request.
//
// `ApprovalManager` and `ShellCommandDecomposer` are `vscode`-free, so this
// pure-module property test runs directly under the Node-level Mocha runner.

import * as assert from "assert";

import * as fc from "fast-check";

import {
  ApprovalManager,
  type ApprovalPolicyView,
  type ApprovalPrompt,
  type ConfirmationOutcome,
  type ConfirmationUI,
} from "./approvalManager";
import { ShellCommandDecomposer } from "./commandDecomposer";
import type { ApprovalPolicy, AutonomyMode, ToolDefinition, ToolState } from "./types";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const decomposer = new ShellCommandDecomposer();

function policyViewWith(policy: ApprovalPolicy): ApprovalPolicyView {
  return {
    stateOf(_id: string): ToolState {
      return { enabled: true, approvalPolicy: policy };
    },
  };
}

/** A confirmation UI returning a fixed outcome and counting how often it is asked. */
class CountingConfirmationUi implements ConfirmationUI {
  public calls = 0;

  public constructor(private readonly outcome: ConfirmationOutcome) {}

  public confirm(_prompt: ApprovalPrompt): Promise<ConfirmationOutcome> {
    this.calls += 1;
    return Promise.resolve(this.outcome);
  }
}

/** A confirmation UI that never resolves — models a prompt left unanswered. */
class NeverResolvingConfirmationUi implements ConfirmationUI {
  public confirm(_prompt: ApprovalPrompt): Promise<ConfirmationOutcome> {
    return new Promise<ConfirmationOutcome>(() => {
      /* never settles: exercises the confirmation timeout ⇒ decline */
    });
  }
}

/** A mutating file tool with the given approval policy. */
function mutatingDef(): ToolDefinition {
  return {
    id: "edit_file",
    displayName: "Edit File",
    description: "Apply an edit to an existing file (presented as a diff).",
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
}

// Policy/mode combinations that force a confirmation prompt for a mutating tool.
const PROMPTING_COMBOS: ReadonlyArray<readonly [ApprovalPolicy, AutonomyMode]> = [
  ["always-ask", "auto"],
  ["always-ask", "supervised"],
  ["inherit", "supervised"],
];

// -----------------------------------------------------------------------------
// Property 14
// -----------------------------------------------------------------------------

describe("ApprovalManager — Property 14: declining a confirmation prevents execution", () => {
  it("a declined confirmation returns false and records no session grant", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...PROMPTING_COMBOS),
        fc.string(),
        async ([policy, mode], path) => {
          const ui = new CountingConfirmationUi("decline");
          const manager = new ApprovalManager({
            policyView: policyViewWith(policy),
            confirmationUi: ui,
            decomposer,
            initialMode: mode,
          });
          const def = mutatingDef();

          // 1. A prompt is required before any execution.
          const decision = manager.resolve(def, { path, content: "x" });
          assert.strictEqual(decision.outcome, "prompt");
          if (decision.outcome !== "prompt") {
            return;
          }

          // 2. Declining the confirmation gates execution off (⇒ false).
          const approved = await manager.requestConfirmation(decision.prompt);
          assert.strictEqual(ui.calls, 1, "the UI must be consulted exactly once");
          assert.strictEqual(approved, false, "a declined confirmation must return false");

          // 3. No session grant is recorded, so approval state is preserved.
          assert.strictEqual(
            manager.hasSessionGrant(def.id),
            false,
            "declining must not grant the tool for the session",
          );
        },
      ),
    );
  });

  it("a dismissed/unanswered prompt is treated as declined (Requirement 5.11)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...PROMPTING_COMBOS), async ([policy, mode]) => {
        const manager = new ApprovalManager({
          policyView: policyViewWith(policy),
          confirmationUi: new NeverResolvingConfirmationUi(),
          decomposer,
          initialMode: mode,
          // Tiny timeout so the unanswered prompt resolves to a decline quickly.
          confirmationTimeoutMs: 5,
        });
        const def = mutatingDef();

        const decision = manager.resolve(def, { path: "src/a.ts", content: "x" });
        assert.strictEqual(decision.outcome, "prompt");
        if (decision.outcome !== "prompt") {
          return;
        }

        const approved = await manager.requestConfirmation(decision.prompt);
        assert.strictEqual(approved, false, "an unanswered prompt must resolve to declined");
        assert.strictEqual(manager.hasSessionGrant(def.id), false);
      }),
      // A handful of runs is plenty for the timeout path; keep well above the floor
      // while avoiding 100 real timers.
      { numRuns: 100 },
    );
  });
});
