// Feature: agent-tools-and-settings, Property 16: Session grants suppress subsequent
// confirmations for the same tool.
//
// Validates: Requirements 5.10
//
// For any tool, after an "allow for this session" grant, every subsequent invocation
// of that same tool resolves without confirmation for the remainder of the session.
//
// The grant can arise two ways, both exercised here:
//
//   1. explicitly, via `grantForSession(toolId)`; and
//   2. through the confirmation flow, when the user chooses "allow for this session"
//      (`requestConfirmation` sees an `approve-for-session` outcome and records the
//      grant).
//
// In both cases, once granted, `resolve` returns `auto-session` for that tool on
// every subsequent call — regardless of the tool's classification, its approval
// policy (even `always-ask`), or the autonomy mode — while OTHER tools are
// unaffected and still resolve per the decision table.
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

function policyViewWith(policy: ApprovalPolicy): ApprovalPolicyView {
  return {
    stateOf(_id: string): ToolState {
      return { enabled: true, approvalPolicy: policy };
    },
  };
}

/** A confirmation UI returning a fixed outcome. */
class FixedConfirmationUi implements ConfirmationUI {
  public calls = 0;

  public constructor(private readonly outcome: ConfirmationOutcome) {}

  public confirm(_prompt: ApprovalPrompt): Promise<ConfirmationOutcome> {
    this.calls += 1;
    return Promise.resolve(this.outcome);
  }
}

function toolDef(id: string, classification: ToolClassification): ToolDefinition {
  return {
    id,
    displayName: `Tool ${id}`,
    description: "A tool used to exercise session grants.",
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

// -----------------------------------------------------------------------------
// Property 16
// -----------------------------------------------------------------------------

describe("ApprovalManager — Property 16: session grants suppress subsequent confirmations", () => {
  it("after grantForSession, every subsequent resolve of that tool is auto-session", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_CLASSIFICATIONS),
        fc.constantFrom(...ALL_POLICIES),
        fc.constantFrom(...ALL_MODES),
        fc.integer({ min: 1, max: 5 }),
        (classification, policy, mode, repeats) => {
          const manager = new ApprovalManager({
            policyView: policyViewWith(policy),
            confirmationUi: new FixedConfirmationUi("decline"),
            decomposer,
            initialMode: mode,
          });
          const def = toolDef("edit_file", classification);

          manager.grantForSession(def.id);

          for (let i = 0; i < repeats; i += 1) {
            const decision = manager.resolve(def, { path: "src/a.ts" });
            assert.strictEqual(
              decision.outcome,
              "auto-session",
              `grant must suppress confirmation on invocation #${i + 1}`,
            );
          }
        },
      ),
    );
  });

  it("choosing 'allow for this session' in the UI records a grant for that tool", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...ALL_CLASSIFICATIONS),
        fc.constantFrom(...ALL_MODES),
        async (classification, mode) => {
          const ui = new FixedConfirmationUi("approve-for-session");
          const manager = new ApprovalManager({
            // always-ask guarantees the first invocation prompts.
            policyView: policyViewWith("always-ask"),
            confirmationUi: ui,
            decomposer,
            initialMode: mode,
          });
          const def = toolDef("edit_file", classification);

          // First invocation prompts; the user allows for the session.
          const first = manager.resolve(def, { path: "src/a.ts" });
          assert.strictEqual(first.outcome, "prompt");
          if (first.outcome !== "prompt") {
            return;
          }
          const approved = await manager.requestConfirmation(first.prompt);
          assert.strictEqual(approved, true);
          assert.strictEqual(manager.hasSessionGrant(def.id), true);

          // Subsequent invocations resolve without any further confirmation.
          const callsAfterGrant = ui.calls;
          const second = manager.resolve(def, { path: "src/b.ts" });
          assert.strictEqual(second.outcome, "auto-session");
          assert.strictEqual(
            ui.calls,
            callsAfterGrant,
            "resolve must not consult the UI once a grant exists",
          );
        },
      ),
    );
  });

  it("a grant for one tool does not suppress confirmations for a different tool", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_MODES), (mode) => {
        const manager = new ApprovalManager({
          policyView: policyViewWith("always-ask"),
          confirmationUi: new FixedConfirmationUi("decline"),
          decomposer,
          initialMode: mode,
        });
        const granted = toolDef("edit_file", "mutating");
        const other = toolDef("create_file", "mutating");

        manager.grantForSession(granted.id);

        assert.strictEqual(
          manager.resolve(granted, { path: "src/a.ts" }).outcome,
          "auto-session",
        );
        // The other tool is still gated (always-ask ⇒ prompt).
        assert.strictEqual(
          manager.resolve(other, { path: "src/b.ts" }).outcome,
          "prompt",
        );
      }),
    );
  });
});
