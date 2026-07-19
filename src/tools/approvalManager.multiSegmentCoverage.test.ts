// Feature: agent-tools-and-settings, Property 28: Multi-segment commands require
// approval covering every segment.
//
// Validates: Requirements 10.2, 10.3, 10.4
//
// For any command string that decomposes into more than one segment, the
// confirmation prompt lists each segment as a separate item, and execution proceeds
// only after approval covering every segment; if the user declines, no segment
// executes, the workspace is unchanged, and the result names the rejected segment.
//
// At the ApprovalManager layer this means:
//
//   1. resolving a compound `run_terminal` command that must be confirmed yields a
//      single `prompt` whose `segments` list every decomposed Command_Segment
//      (Requirement 10.2) — approving that one prompt covers the whole command
//      (Requirement 10.3);
//   2. declining the confirmation returns `false`, the signal the ToolHost uses to
//      run NOTHING and return a `rejected` error naming the offending segment
//      (Requirement 10.4, verified at the host layer); and
//   3. approving returns `true`, permitting the whole command to run.
//
// Confirmation is forced with an `always-ask` policy. Commands are built from
// simple operator-free tokens joined by " && " so decomposition is deterministic
// and yields more than one segment.
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
import type { AutonomyMode, ToolDefinition, ToolState } from "./types";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const decomposer = new ShellCommandDecomposer();

/** A policy that always forces confirmation, so multi-segment prompts always appear. */
const ALWAYS_ASK_VIEW: ApprovalPolicyView = {
  stateOf(_id: string): ToolState {
    return { enabled: true, approvalPolicy: "always-ask" };
  },
};

/** A confirmation UI returning a fixed outcome and recording the prompts it sees. */
class RecordingConfirmationUi implements ConfirmationUI {
  public readonly prompts: ApprovalPrompt[] = [];

  public constructor(private readonly outcome: ConfirmationOutcome) {}

  public confirm(prompt: ApprovalPrompt): Promise<ConfirmationOutcome> {
    this.prompts.push(prompt);
    return Promise.resolve(this.outcome);
  }
}

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

const ALL_MODES: readonly AutonomyMode[] = ["auto", "supervised"];

const tokenArb = fc
  .array(fc.constantFrom(..."abcdefghij".split("")), { minLength: 1, maxLength: 6 })
  .map((chars) => chars.join(""));

// Two-or-more tokens ⇒ a genuinely compound (multi-segment) command.
const multiTokenArb = fc.array(tokenArb, { minLength: 2, maxLength: 6 });

// -----------------------------------------------------------------------------
// Property 28
// -----------------------------------------------------------------------------

describe("ApprovalManager — Property 28: multi-segment commands require covering approval", () => {
  it("the prompt lists every segment as a separate item (Requirement 10.2)", () => {
    fc.assert(
      fc.property(multiTokenArb, fc.constantFrom(...ALL_MODES), (tokens, mode) => {
        const command = tokens.join(" && ");
        const manager = new ApprovalManager({
          policyView: ALWAYS_ASK_VIEW,
          confirmationUi: new RecordingConfirmationUi("decline"),
          decomposer,
          shell: "posix",
          initialMode: mode,
        });

        const decision = manager.resolve(RUN_TERMINAL_DEF, { command });
        assert.strictEqual(decision.outcome, "prompt");
        if (decision.outcome !== "prompt") {
          return;
        }
        const { prompt } = decision;
        // Each Command_Segment is a separate, individually listed item.
        assert.deepStrictEqual(prompt.segments, tokens);
        assert.ok(
          (prompt.segments?.length ?? 0) > 1,
          "a compound command must produce more than one segment",
        );
        assert.strictEqual(prompt.decomposed, true);
        // The whole command is the target that approval covers.
        assert.strictEqual(prompt.target, command);
      }),
    );
  });

  it("declining the confirmation gates the whole command off (⇒ false)", async () => {
    await fc.assert(
      fc.asyncProperty(
        multiTokenArb,
        fc.constantFrom(...ALL_MODES),
        async (tokens, mode) => {
          const command = tokens.join(" && ");
          const ui = new RecordingConfirmationUi("decline");
          const manager = new ApprovalManager({
            policyView: ALWAYS_ASK_VIEW,
            confirmationUi: ui,
            decomposer,
            shell: "posix",
            initialMode: mode,
          });

          const decision = manager.resolve(RUN_TERMINAL_DEF, { command });
          assert.strictEqual(decision.outcome, "prompt");
          if (decision.outcome !== "prompt") {
            return;
          }

          const approved = await manager.requestConfirmation(decision.prompt);
          assert.strictEqual(approved, false, "declining must gate execution off");
          assert.strictEqual(ui.prompts.length, 1, "one covering prompt for all segments");
          assert.deepStrictEqual(ui.prompts[0]?.segments, tokens);
        },
      ),
    );
  });

  it("approving covers every segment (⇒ true) with a single covering prompt", async () => {
    await fc.assert(
      fc.asyncProperty(
        multiTokenArb,
        fc.constantFrom<ConfirmationOutcome>("approve", "approve-for-session"),
        async (tokens, outcome) => {
          const command = tokens.join(" && ");
          const ui = new RecordingConfirmationUi(outcome);
          const manager = new ApprovalManager({
            policyView: ALWAYS_ASK_VIEW,
            confirmationUi: ui,
            decomposer,
            shell: "posix",
          });

          const decision = manager.resolve(RUN_TERMINAL_DEF, { command });
          assert.strictEqual(decision.outcome, "prompt");
          if (decision.outcome !== "prompt") {
            return;
          }

          const approved = await manager.requestConfirmation(decision.prompt);
          assert.strictEqual(approved, true, "approval must permit the whole command");
          assert.strictEqual(ui.prompts.length, 1, "a single prompt covers every segment");
        },
      ),
    );
  });
});
