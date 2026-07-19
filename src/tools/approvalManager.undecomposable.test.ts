// Feature: agent-tools-and-settings, Property 30: Undecomposable commands force
// whole-string confirmation.
//
// Validates: Requirements 10.7
//
// Requirement 10.7: "IF a command string cannot be decomposed because it contains
// unbalanced quotes, an unterminated escape, or unmatched subshell or grouping
// delimiters, THEN THE Approval_Manager SHALL request confirmation for the entire
// command string, SHALL indicate that it could not be decomposed, and SHALL NOT
// execute the command until confirmation is granted."
//
// This is the Approval_Manager variant of Property 30 (the CommandDecomposer
// variant lives in `commandDecomposer.failure.test.ts`). It exercises
// `ApprovalManager.resolve` and `ApprovalManager.requestConfirmation` end-to-end
// with the real `ShellCommandDecomposer`, asserting that for any GUARANTEED
// undecomposable `run_terminal` command string — regardless of the tool's
// approval policy, the autonomy mode, or the auto-approve allowlist — the manager:
//
//   1. resolves to `{ outcome: "prompt" }` (never `auto`/`auto-session`), so
//      nothing runs without confirmation;
//   2. builds a prompt over the ENTIRE command string (`target` and the single
//      `segments`/`affectedResources` entry are the whole command), flagged
//      `decomposed: false`; and
//   3. leaves execution gated on the confirmation outcome — a declined/dismissed
//      confirmation yields `false`, an approval yields `true`.
//
// The undecomposable inputs are constructed by construction (unbalanced quote,
// trailing escape, unmatched grouping delimiter) so expected outcomes are fixed
// by the way each case is built, not by re-deriving the decomposer's own logic.
//
// The `ApprovalManager` and `ShellCommandDecomposer` are both free of any `vscode`
// dependency, so this pure-module property test runs directly under the Node-level
// Mocha runner without a `vscode` stub.

import * as assert from "assert";

import * as fc from "fast-check";

import {
  ApprovalManager,
  type ApprovalPolicyView,
  type ConfirmationOutcome,
  type ConfirmationUI,
  type ApprovalPrompt,
  type TerminalAllowlist,
} from "./approvalManager";
import { ShellCommandDecomposer } from "./commandDecomposer";
import type { ShellKind } from "./commandDecomposer";
import type {
  ApprovalPolicy,
  AutonomyMode,
  ToolDefinition,
  ToolState,
} from "./types";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const decomposer = new ShellCommandDecomposer();

/** The real `run_terminal` definition shape (matches the built-in registry entry). */
const RUN_TERMINAL_DEF: ToolDefinition = {
  id: "run_terminal",
  displayName: "Run Terminal Command",
  description:
    "Run a shell command in a workspace terminal. Compound command lines are " +
    "decomposed and each command is approved individually.",
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

/** A `policyView` that reports a fixed approval policy for the terminal tool. */
function policyViewWith(policy: ApprovalPolicy): ApprovalPolicyView {
  return {
    stateOf(_id: string): ToolState {
      return { enabled: true, approvalPolicy: policy };
    },
  };
}

/** A confirmation UI that records every prompt it is shown and returns a fixed choice. */
class RecordingConfirmationUi implements ConfirmationUI {
  public readonly prompts: ApprovalPrompt[] = [];

  public constructor(private readonly outcome: ConfirmationOutcome) {}

  public confirm(prompt: ApprovalPrompt): Promise<ConfirmationOutcome> {
    this.prompts.push(prompt);
    return Promise.resolve(this.outcome);
  }
}

/** A confirmation UI that MUST NOT be consulted; calling it fails the test. */
class ForbiddenConfirmationUi implements ConfirmationUI {
  public confirm(): Promise<ConfirmationOutcome> {
    throw new Error("confirmation UI must not be invoked by resolve()");
  }
}

/** An allowlist that claims to cover every segment (the most permissive case). */
const COVER_ALL_ALLOWLIST: TerminalAllowlist = { covers: (): boolean => true };

// -----------------------------------------------------------------------------
// Generators for guaranteed-undecomposable command strings
// -----------------------------------------------------------------------------

const SHELLS: readonly ShellKind[] = ["posix", "cmd", "powershell"];

/** The escape character honoured outside quotes for each shell. */
const ESCAPE_CHAR: Record<ShellKind, string> = {
  posix: "\\",
  cmd: "^",
  powershell: "`",
};

/** Whether the shell treats a single quote as a literal-string opener. */
const SUPPORTS_SINGLE_QUOTE: Record<ShellKind, boolean> = {
  posix: true,
  cmd: false,
  powershell: true,
};

/**
 * "Inert" filler: characters with no lexical meaning for any shell, so embedding
 * them cannot accidentally balance a quote, satisfy an escape, or open/close a
 * grouping delimiter. This keeps every constructed case undecomposable for the
 * reason we intend.
 */
const inertText = fc
  .array(fc.constantFrom(..."abcXYZ 019-_./=@".split("")), { maxLength: 12 })
  .map((chars) => chars.join(""))
  .filter((s: string) => !/[`^\\'"(){}]/.test(s));

const ALL_POLICIES: readonly ApprovalPolicy[] = [
  "inherit",
  "always-ask",
  "auto-approve",
];
const ALL_MODES: readonly AutonomyMode[] = ["auto", "supervised"];

/**
 * A tuple `[shell, command]` where `command` is GUARANTEED undecomposable for
 * `shell`: an unbalanced quote, a trailing (unterminated) escape, or an unmatched
 * opening grouping delimiter.
 */
const undecomposableArb: fc.Arbitrary<[ShellKind, string]> = fc
  .constantFrom(...SHELLS)
  .chain((shell) =>
    fc
      .oneof(
        // Unbalanced quote: one opener, no matching close.
        fc.record({ before: inertText, after: inertText }).map(({ before, after }) => {
          const quote = SUPPORTS_SINGLE_QUOTE[shell] ? "'" : '"';
          return `${before}${quote}${after}`;
        }),
        // Unterminated escape: escape char is the final character.
        inertText.map((before) => `${before}${ESCAPE_CHAR[shell]}`),
        // Unmatched delimiter: an opening group that is never closed.
        fc
          .record({
            open: fc.constantFrom("(", "{"),
            before: inertText,
            inner: inertText,
          })
          .map(({ open, before, inner }) => `${before}${open}${inner}`),
      )
      .map((command): [ShellKind, string] => [shell, command]),
  );

// -----------------------------------------------------------------------------
// Property 30 (Approval_Manager)
// -----------------------------------------------------------------------------

describe("ApprovalManager — Property 30: undecomposable commands force whole-string confirmation", () => {
  it("resolves to a whole-string prompt flagged not-decomposed, regardless of policy/mode/allowlist", () => {
    fc.assert(
      fc.property(
        undecomposableArb,
        fc.constantFrom(...ALL_POLICIES),
        fc.constantFrom(...ALL_MODES),
        fc.boolean(),
        ([shell, command], policy, mode, withAllowlist) => {
          const manager = new ApprovalManager({
            policyView: policyViewWith(policy),
            // resolve() must never touch the UI, so guarantee that here.
            confirmationUi: new ForbiddenConfirmationUi(),
            decomposer,
            shell,
            initialMode: mode,
            // Even a fully-covering allowlist must not bypass whole-string
            // confirmation for an undecomposable command (Requirement 10.7).
            terminalAllowlist: withAllowlist ? COVER_ALL_ALLOWLIST : undefined,
          });

          const decision = manager.resolve(RUN_TERMINAL_DEF, { command });

          // 1. It never runs without confirmation.
          assert.strictEqual(
            decision.outcome,
            "prompt",
            `expected prompt for undecomposable command ${JSON.stringify(command)} (shell=${shell}, policy=${policy}, mode=${mode})`,
          );
          if (decision.outcome !== "prompt") {
            return;
          }

          const { prompt } = decision;
          // 2. The prompt covers the ENTIRE command string and is flagged
          //    as not decomposed.
          assert.strictEqual(prompt.decomposed, false, "prompt must be flagged not-decomposed");
          assert.strictEqual(prompt.target, command, "prompt target must be the whole command string");
          assert.deepStrictEqual(
            prompt.segments,
            [command],
            "the single segment must be the whole command string",
          );
          assert.deepStrictEqual(
            prompt.affectedResources,
            [command],
            "affected resources must be the whole command string",
          );
          assert.strictEqual(prompt.toolId, RUN_TERMINAL_DEF.id);
          assert.strictEqual(prompt.toolName, RUN_TERMINAL_DEF.displayName);
        },
      ),
    );
  });

  it("keeps execution gated: a declined/dismissed confirmation yields false, an approval yields true", async () => {
    await fc.assert(
      fc.asyncProperty(
        undecomposableArb,
        fc.constantFrom(...ALL_POLICIES),
        fc.constantFrom(...ALL_MODES),
        fc.constantFrom<ConfirmationOutcome>("approve", "approve-for-session", "decline"),
        async ([shell, command], policy, mode, outcome) => {
          const ui = new RecordingConfirmationUi(outcome);
          const manager = new ApprovalManager({
            policyView: policyViewWith(policy),
            confirmationUi: ui,
            decomposer,
            shell,
            initialMode: mode,
          });

          const decision = manager.resolve(RUN_TERMINAL_DEF, { command });
          assert.strictEqual(decision.outcome, "prompt");
          if (decision.outcome !== "prompt") {
            return;
          }

          const approved = await manager.requestConfirmation(decision.prompt);

          // The UI was consulted with the whole-string, not-decomposed prompt.
          assert.strictEqual(ui.prompts.length, 1, "confirmation UI must be consulted exactly once");
          assert.strictEqual(ui.prompts[0]?.decomposed, false);
          assert.strictEqual(ui.prompts[0]?.target, command);

          // Execution is permitted iff the user approved.
          const expected = outcome !== "decline";
          assert.strictEqual(
            approved,
            expected,
            `approval result must reflect the confirmation outcome (${outcome})`,
          );
        },
      ),
    );
  });
});
