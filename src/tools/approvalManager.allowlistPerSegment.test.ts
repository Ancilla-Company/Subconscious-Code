// Feature: agent-tools-and-settings, Property 29: Allowlist coverage is evaluated
// per segment.
//
// Validates: Requirements 10.5, 10.6
//
// For any command string and any auto-approve allowlist, the command executes
// without confirmation iff every Command_Segment is covered by the allowlist, and
// confirmation is requested iff at least one segment is not covered.
//
// The allowlist gate only applies when the base decision would otherwise run the
// command without confirmation, so these cases use a base-auto policy
// (`auto-approve`). With an allowlist in play, `resolve` on `run_terminal`:
//
//   - returns `auto`   iff every decomposed segment is covered; and
//   - returns `prompt` iff any segment is uncovered — and that prompt lists every
//     segment so the user can approve the whole command.
//
// Command strings are built from simple, operator-free tokens joined by " && " so
// decomposition is deterministic and each segment matches an allowlist entry by
// exact string. The allowlist covers a randomly chosen subset of the tokens.
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
  type TerminalAllowlist,
} from "./approvalManager";
import { ShellCommandDecomposer } from "./commandDecomposer";
import type { AutonomyMode, ToolDefinition, ToolState } from "./types";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const decomposer = new ShellCommandDecomposer();

/** A base-auto policy so the per-segment allowlist gate is what decides the outcome. */
const AUTO_APPROVE_VIEW: ApprovalPolicyView = {
  stateOf(_id: string): ToolState {
    return { enabled: true, approvalPolicy: "auto-approve" };
  },
};

class ForbiddenConfirmationUi implements ConfirmationUI {
  public confirm(): Promise<ConfirmationOutcome> {
    throw new Error("confirmation UI must not be invoked by resolve()");
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

/** An allowlist covering exactly the given set of segment strings. */
function allowlistCovering(covered: ReadonlySet<string>): TerminalAllowlist {
  return { covers: (segment: string): boolean => covered.has(segment) };
}

// Distinct, operator-free tokens so decomposition yields exactly these segments.
const tokenArb = fc
  .array(fc.constantFrom(..."abcdefghij".split("")), { minLength: 1, maxLength: 6 })
  .map((chars) => chars.join(""));

// -----------------------------------------------------------------------------
// Property 29
// -----------------------------------------------------------------------------

describe("ApprovalManager — Property 29: allowlist coverage is evaluated per segment", () => {
  it("auto iff every segment is covered; prompt iff any segment is uncovered", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(tokenArb, { minLength: 1, maxLength: 5 }),
        // A subset (by index) of tokens that the allowlist will cover.
        fc.array(fc.boolean(), { minLength: 1, maxLength: 5 }),
        fc.constantFrom(...ALL_MODES),
        (tokens, coverFlags, mode) => {
          const command = tokens.join(" && ");
          const covered = new Set<string>();
          tokens.forEach((token, index) => {
            if (coverFlags[index] === true) {
              covered.add(token);
            }
          });

          const manager = new ApprovalManager({
            policyView: AUTO_APPROVE_VIEW,
            confirmationUi: new ForbiddenConfirmationUi(),
            decomposer,
            shell: "posix",
            initialMode: mode,
            terminalAllowlist: allowlistCovering(covered),
          });

          const decision = manager.resolve(RUN_TERMINAL_DEF, { command });

          const allCovered = tokens.every((token) => covered.has(token));
          if (allCovered) {
            assert.strictEqual(
              decision.outcome,
              "auto",
              `every segment covered ⇒ auto (command=${JSON.stringify(command)})`,
            );
          } else {
            assert.strictEqual(
              decision.outcome,
              "prompt",
              `an uncovered segment ⇒ prompt (command=${JSON.stringify(command)})`,
            );
            if (decision.outcome === "prompt") {
              // The prompt lists every segment so approval can cover them all.
              assert.deepStrictEqual(decision.prompt.segments, tokens);
            }
          }
        },
      ),
    );
  });

  it("a fully-covering allowlist runs the whole command without confirmation", () => {
    fc.assert(
      fc.property(fc.uniqueArray(tokenArb, { minLength: 2, maxLength: 5 }), (tokens) => {
        const command = tokens.join(" && ");
        const manager = new ApprovalManager({
          policyView: AUTO_APPROVE_VIEW,
          confirmationUi: new ForbiddenConfirmationUi(),
          decomposer,
          shell: "posix",
          terminalAllowlist: allowlistCovering(new Set(tokens)),
        });

        assert.strictEqual(
          manager.resolve(RUN_TERMINAL_DEF, { command }).outcome,
          "auto",
        );
      }),
    );
  });
});
