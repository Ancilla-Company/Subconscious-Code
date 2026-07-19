// Feature: agent-tools-and-settings, Property 30 (decomposition): Undecomposable
// commands report failure.
//
// Validates: Requirements 10.7
//
// This is the decomposition-failure variant of Property 30. Requirement 10.7:
// "IF a command string cannot be decomposed because it contains unbalanced
// quotes, an unterminated escape, or unmatched subshell or grouping delimiters,
// THEN THE Approval_Manager SHALL request confirmation for the entire command
// string, SHALL indicate that it could not be decomposed, and SHALL NOT execute
// the command until confirmation is granted."
//
// At the `CommandDecomposer` layer this manifests as `decompose` returning
// `{ ok: false, segments: [], reason }` where `reason` names the failure class.
// This file generates command strings that are GUARANTEED to be undecomposable
// by construction — an unbalanced quote, a trailing (unterminated) escape
// character, or an unmatched `(`/`)`/`{`/`}` grouping delimiter — and asserts
// that `decompose` reports failure with an empty segment list and the expected
// reason. Expected outcomes are fixed by the way each case is constructed, not
// by re-deriving the decomposer's own logic, so a real bug is genuinely caught.

import * as assert from "assert";

import * as fc from "fast-check";

import { ShellCommandDecomposer } from "./commandDecomposer";
import type { DecompositionFailure, ShellKind } from "./commandDecomposer";

const decomposer = new ShellCommandDecomposer();
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
 * "Inert" content: characters that carry no lexical meaning for any shell, so
 * embedding them cannot accidentally balance a quote, satisfy an escape, or
 * open/close a delimiter. Restricting the generated filler to these keeps every
 * constructed case undecomposable for the reason we intend.
 */
const inertText = fc
  .array(fc.constantFrom(..."abcXYZ 019-_./=@".split("")), { maxLength: 12 })
  .map((chars) => chars.join(""))
  .filter((s: string) => !/[`^\\'"(){}]/.test(s));

function assertFailure(
  result: ReturnType<ShellCommandDecomposer["decompose"]>,
  expected: DecompositionFailure,
  command: string,
  shell: ShellKind,
): void {
  const label = `shell=${shell} command=${JSON.stringify(command)}`;
  assert.strictEqual(result.ok, false, `expected ok:false for ${label}`);
  assert.deepStrictEqual(
    result.segments,
    [],
    `expected empty segments for ${label}`,
  );
  assert.strictEqual(
    result.reason,
    expected,
    `expected reason "${expected}" for ${label}`,
  );
}

// -----------------------------------------------------------------------------
// Property 30 (decomposition) — unbalanced quotes
// -----------------------------------------------------------------------------

describe("Property 30 (decomposition): undecomposable commands report failure", () => {
  it("reports unbalanced-quote for an unterminated quoted string", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SHELLS),
        fc.boolean(),
        inertText,
        inertText,
        (shell, useSingle, before, after) => {
          // A single opening quote with no matching close. `after` is inert and
          // never contains a quote, so the string stays open through EOL.
          const quote = useSingle && SUPPORTS_SINGLE_QUOTE[shell] ? "'" : '"';
          const command = `${before}${quote}${after}`;
          assertFailure(
            decomposer.decompose(command, shell),
            "unbalanced-quote",
            command,
            shell,
          );
        },
      ),
    );
  });

  it("reports unterminated-escape for a trailing escape character", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SHELLS),
        inertText,
        (shell, before) => {
          // The escape char as the final character has nothing to escape.
          const command = `${before}${ESCAPE_CHAR[shell]}`;
          assertFailure(
            decomposer.decompose(command, shell),
            "unterminated-escape",
            command,
            shell,
          );
        },
      ),
    );
  });

  it("reports unmatched-delimiter for an unclosed opening group", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SHELLS),
        fc.constantFrom("(", "{"),
        inertText,
        inertText,
        (shell, open, before, inner) => {
          // An opening delimiter that is never closed leaves the stack non-empty.
          const command = `${before}${open}${inner}`;
          assertFailure(
            decomposer.decompose(command, shell),
            "unmatched-delimiter",
            command,
            shell,
          );
        },
      ),
    );
  });

  it("reports unmatched-delimiter for a stray closing group", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SHELLS),
        fc.constantFrom(")", "}"),
        inertText,
        (shell, close, before) => {
          // A closing delimiter with no matching opener on the stack.
          const command = `${before}${close}`;
          assertFailure(
            decomposer.decompose(command, shell),
            "unmatched-delimiter",
            command,
            shell,
          );
        },
      ),
    );
  });

  it("reports unmatched-delimiter for mismatched delimiter pairs", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...SHELLS),
        fc.constantFrom<[string, string]>(["(", "}"], ["{", ")"]),
        inertText,
        (shell, pair, inner) => {
          // `(...}` or `{...)`: the closer does not match the top of the stack.
          const [open, close] = pair;
          const command = `${open}${inner}${close}`;
          assertFailure(
            decomposer.decompose(command, shell),
            "unmatched-delimiter",
            command,
            shell,
          );
        },
      ),
    );
  });
});
