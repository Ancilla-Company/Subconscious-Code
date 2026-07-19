// Feature: agent-tools-and-settings, Property 27: Command decomposition respects
// operators, grouping, quotes, and escapes.
//
// Validates: Requirements 10.1
//
// For any command string, `ShellCommandDecomposer.decompose` must:
//   * split on the target shell's control operators appearing OUTSIDE quotes and
//     escapes (`&&`, `||`, `|`, `;`, `&`, newline for POSIX/PowerShell; the
//     cmd subset for cmd),
//   * expand subshell `( )` and grouping `{ }` constructs into the segments they
//     contain, and
//   * treat operator characters that appear inside quotes or immediately after an
//     escape character as literal text rather than separators.
//
// Testing strategy: rather than re-deriving the tokenizer's own logic (which would
// let a shared bug hide), the generators COMPOSE inputs from atoms whose expected
// segmentation is fixed by construction. Each generated case carries both the raw
// command string and the exact list of segments it must decompose into, so any
// off-by-one split, swallowed quote, or mishandled escape is caught by a direct
// deep-equality assertion. Operator characters are only ever emitted inside quotes
// or right after an escape (where they must stay literal) or as deliberate,
// space-padded separators (where they must split) — so the expected boundaries are
// unambiguous.

import * as assert from "assert";

import * as fc from "fast-check";

import { ShellCommandDecomposer } from "./commandDecomposer";
import type { ShellKind } from "./commandDecomposer";

// -----------------------------------------------------------------------------
// Per-shell lexical configuration (mirrors the shells the decomposer supports).
// -----------------------------------------------------------------------------

interface ShellCfg {
  readonly shell: ShellKind;
  /** Control operators usable as separators, longest-first is irrelevant here. */
  readonly operators: readonly string[];
  /** The escape character honoured outside quotes. */
  readonly escapeChar: string;
  /** Quote characters that open a literal/quoted region for this shell. */
  readonly quoteChars: readonly string[];
}

const SHELL_CONFIGS: readonly ShellCfg[] = [
  {
    shell: "posix",
    operators: ["&&", "||", "|", ";", "&", "\n"],
    escapeChar: "\\",
    quoteChars: ["'", '"'],
  },
  {
    // cmd has no `;` operator and does not treat single quotes as quoting.
    shell: "cmd",
    operators: ["&&", "||", "|", "&", "\n"],
    escapeChar: "^",
    quoteChars: ['"'],
  },
  {
    shell: "powershell",
    operators: ["&&", "||", "|", ";", "&", "\n"],
    escapeChar: "`",
    quoteChars: ["'", '"'],
  },
];

// Characters that are safe inside an unquoted, unescaped word: they never act as
// operators, escapes, quotes, or grouping delimiters in any supported shell.
const SAFE_CHARS =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_./=:@+~".split(
    ""
  );

// Operator/grouping characters that MUST stay literal when quoted or escaped.
const DANGEROUS_CHARS = ["&", "|", ";", "(", ")", "{", "}"];

// Grouping delimiter pairs the decomposer expands into their contained segments.
const GROUP_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["(", ")"],
  ["{", "}"],
];

// -----------------------------------------------------------------------------
// Generated case shape: raw input plus the segmentation it must produce.
// -----------------------------------------------------------------------------

interface Unit {
  /** The exact substring contributed to the command line. */
  readonly raw: string;
  /** The segments this unit must decompose into, in order. */
  readonly segments: string[];
}

const safeWordArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...SAFE_CHARS), { minLength: 1, maxLength: 8 })
  .map((chars) => chars.join(""));

/**
 * A quoted chunk containing operator/grouping characters (and spaces) that must be
 * preserved verbatim and never treated as separators. Content excludes the quote
 * and escape characters so the quote stays balanced and no escaping occurs.
 */
function quotedChunkArb(cfg: ShellCfg): fc.Arbitrary<string> {
  const contentChars = [...SAFE_CHARS, ...DANGEROUS_CHARS, " "];
  return fc
    .tuple(
      fc.constantFrom(...cfg.quoteChars),
      fc.array(fc.constantFrom(...contentChars), { minLength: 1, maxLength: 6 })
    )
    .map(([quote, chars]) => `${quote}${chars.join("")}${quote}`);
}

/**
 * An escaped operator/grouping/quote character: the escape char followed by one
 * special character, which the decomposer must keep as literal text.
 */
function escapedCharArb(cfg: ShellCfg): fc.Arbitrary<string> {
  const escapable = [...DANGEROUS_CHARS, ...cfg.quoteChars, cfg.escapeChar];
  return fc
    .constantFrom(...escapable)
    .map((ch) => `${cfg.escapeChar}${ch}`);
}

/**
 * A single command segment: a concatenation of safe words, quoted chunks, and
 * escaped characters. By construction it contains no unquoted/unescaped operator
 * or grouping character, so it tokenizes to exactly one segment equal to itself.
 */
function simpleSegmentArb(cfg: ShellCfg): fc.Arbitrary<Unit> {
  const partArb = fc.oneof(
    safeWordArb,
    quotedChunkArb(cfg),
    escapedCharArb(cfg)
  );
  return fc
    .array(partArb, { minLength: 1, maxLength: 4 })
    .map((parts) => {
      const raw = parts.join("");
      return { raw, segments: [raw] };
    });
}

/**
 * A grouping construct `( ... )` or `{ ... }` wrapping one or more simple segments
 * joined by an operator. The decomposer must expand it into the contained segments.
 */
function groupArb(cfg: ShellCfg): fc.Arbitrary<Unit> {
  return fc
    .tuple(
      fc.constantFrom(...GROUP_PAIRS),
      fc.array(simpleSegmentArb(cfg), { minLength: 1, maxLength: 3 }),
      fc.constantFrom(...cfg.operators)
    )
    .map(([[open, close], inner, op]) => {
      const innerStr = inner.map((u) => u.raw).join(` ${op} `);
      const raw = `${open} ${innerStr} ${close}`;
      const segments = inner.flatMap((u) => u.segments);
      return { raw, segments };
    });
}

/** A top-level unit is either a simple segment or a grouping construct. */
function unitArb(cfg: ShellCfg): fc.Arbitrary<Unit> {
  const simple = simpleSegmentArb(cfg);
  const group = groupArb(cfg);
  // Bias toward simple segments; groups appear roughly one time in four.
  return fc.oneof(simple, simple, simple, group);
}

interface Case {
  readonly shell: ShellKind;
  readonly input: string;
  readonly expected: string[];
}

/**
 * Compose several units joined by space-padded control operators, optionally
 * surrounded by leading/trailing whitespace (which must be trimmed away).
 */
function caseArb(cfg: ShellCfg): fc.Arbitrary<Case> {
  return fc
    .tuple(
      fc.array(unitArb(cfg), { minLength: 1, maxLength: 4 }),
      fc.array(fc.constantFrom(...cfg.operators), { minLength: 3, maxLength: 3 }),
      fc.constantFrom("", " ", "  "),
      fc.constantFrom("", " ", "  ")
    )
    .map(([units, ops, lead, trail]) => {
      let input = lead;
      units.forEach((unit, index) => {
        if (index > 0) {
          const op = ops[(index - 1) % ops.length];
          input += ` ${op} `;
        }
        input += unit.raw;
      });
      input += trail;
      const expected = units.flatMap((u) => u.segments);
      return { shell: cfg.shell, input, expected };
    });
}

const anyCaseArb: fc.Arbitrary<Case> = fc
  .constantFrom(...SHELL_CONFIGS)
  .chain((cfg) => caseArb(cfg));

// -----------------------------------------------------------------------------
// Property 27
// -----------------------------------------------------------------------------

describe("Property 27: command decomposition respects operators, grouping, quotes, and escapes", () => {
  const decomposer = new ShellCommandDecomposer();

  it("splits at intended boundaries and keeps quoted/escaped operators literal", () => {
    fc.assert(
      fc.property(anyCaseArb, ({ shell, input, expected }) => {
        const result = decomposer.decompose(input, shell);
        assert.strictEqual(
          result.ok,
          true,
          `expected decomposable input for ${shell}: ${JSON.stringify(input)} (reason: ${String(
            result.reason
          )})`
        );
        assert.deepStrictEqual(
          result.segments,
          expected,
          `segments mismatch for ${shell}: ${JSON.stringify(input)}`
        );
      }),
      { numRuns: 300 }
    );
  });

  it("never emits an empty segment", () => {
    fc.assert(
      fc.property(anyCaseArb, ({ shell, input }) => {
        const result = decomposer.decompose(input, shell);
        assert.strictEqual(result.ok, true);
        for (const segment of result.segments) {
          assert.ok(
            segment.length > 0 && segment.trim() === segment,
            `segment must be non-empty and trimmed: ${JSON.stringify(segment)}`
          );
        }
      }),
      { numRuns: 200 }
    );
  });

  // ---------------------------------------------------------------------------
  // Fixed examples: make the intended behaviour explicit and guard regressions.
  // ---------------------------------------------------------------------------

  it("splits POSIX control operators outside quotes", () => {
    assert.deepStrictEqual(
      decomposer.decompose("echo a && echo b", "posix").segments,
      ["echo a", "echo b"]
    );
    assert.deepStrictEqual(
      decomposer.decompose("a | b ; c & d", "posix").segments,
      ["a", "b", "c", "d"]
    );
  });

  it("keeps operators inside quotes literal", () => {
    assert.deepStrictEqual(
      decomposer.decompose('echo "a && b | c"', "posix").segments,
      ['echo "a && b | c"']
    );
    assert.deepStrictEqual(
      decomposer.decompose("echo 'x ; y'", "posix").segments,
      ["echo 'x ; y'"]
    );
  });

  it("keeps escaped operators literal", () => {
    assert.deepStrictEqual(
      decomposer.decompose("echo a\\&\\&b", "posix").segments,
      ["echo a\\&\\&b"]
    );
    assert.deepStrictEqual(
      decomposer.decompose("echo a^|b", "cmd").segments,
      ["echo a^|b"]
    );
  });

  it("expands grouping and subshell constructs into contained segments", () => {
    assert.deepStrictEqual(
      decomposer.decompose("(a && b)", "posix").segments,
      ["a", "b"]
    );
    assert.deepStrictEqual(
      decomposer.decompose("{ c ; d } && e", "posix").segments,
      ["c", "d", "e"]
    );
  });

  it("treats a single quote as an ordinary character in cmd", () => {
    // cmd does not honour single quotes, so the `|` splits normally.
    assert.deepStrictEqual(
      decomposer.decompose("echo 'a | b'", "cmd").segments,
      ["echo 'a", "b'"]
    );
  });
});
