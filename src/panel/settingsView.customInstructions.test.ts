// Feature: agent-tools-and-settings, Property 22: Custom-instructions length
// boundary is enforced.
//
// For any string whose length is within 0–10,000 characters, validating the
// custom instructions accepts it and returns the value unchanged; for any string
// longer than 10,000 characters, the change is rejected with reason "too-long"
// so the caller can retain the previous value and surface a max-length notice.
//
// The generators deliberately straddle the boundary (including exactly 10,000 and
// 10,001) so the accept/reject transition is exercised right at the limit.
//
// Validates: Requirements 8.3, 8.4

// `settingsView` imports the `vscode` module at load time; install the Node-level
// stub before that import is resolved so this pure helper can be exercised
// outside the VS Code extension host.
import "../test/vscodeStub";

import * as assert from "assert";
import * as fc from "fast-check";

import {
  validateCustomInstructions,
  MAX_CUSTOM_INSTRUCTIONS_LENGTH,
} from "./settingsView";

// -----------------------------------------------------------------------------
// Generators
// -----------------------------------------------------------------------------

// A single BMP character is exactly one UTF-16 code unit, so `char.repeat(n)`
// yields a string whose `.length` is exactly `n`. This lets the generators
// control string length precisely right at the 10,000-character boundary.
const singleUnitChar: fc.Arbitrary<string> = fc.constantFrom(
  "a",
  "Z",
  "0",
  " ",
  ".",
  "\n"
);

/**
 * Draw a length that straddles the 10,000-character boundary — a tight window
 * around the limit plus the exact boundary values — so the accept/reject
 * transition is tested precisely where it matters.
 */
const boundaryLength: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: 0, max: 20 }), // small, well within bound
  fc.integer({
    min: MAX_CUSTOM_INSTRUCTIONS_LENGTH - 5,
    max: MAX_CUSTOM_INSTRUCTIONS_LENGTH + 5,
  }), // straddles the limit, includes 10,000 and 10,001
  fc.integer({
    min: MAX_CUSTOM_INSTRUCTIONS_LENGTH + 1,
    max: MAX_CUSTOM_INSTRUCTIONS_LENGTH + 5_000,
  }) // clearly over the limit
);

/** Build a string of an exact character length from a single-code-unit char. */
const exactLengthString: fc.Arbitrary<string> = fc
  .tuple(boundaryLength, singleUnitChar)
  .map(([len, char]) => char.repeat(len));

// -----------------------------------------------------------------------------
// Property 22
// -----------------------------------------------------------------------------

describe("Property 22: custom-instructions length boundary is enforced", () => {
  it("accepts any value with length <= 10,000 unchanged and rejects any longer value as too-long (Requirements 8.3, 8.4)", () => {
    fc.assert(
      fc.property(exactLengthString, (value) => {
        const result = validateCustomInstructions(value);
        if (value.length <= MAX_CUSTOM_INSTRUCTIONS_LENGTH) {
          assert.strictEqual(result.ok, true, "in-bound value must be accepted");
          assert.ok(result.ok);
          assert.strictEqual(
            result.value,
            value,
            "accepted value must be returned unchanged"
          );
        } else {
          assert.strictEqual(result.ok, false, "over-bound value must be rejected");
          assert.ok(!result.ok);
          assert.strictEqual(result.reason, "too-long");
        }
      })
    );
  });

  it("accepts arbitrary content consistently with its actual length (Requirements 8.3, 8.4)", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: MAX_CUSTOM_INSTRUCTIONS_LENGTH + 200 }),
        (value) => {
          const result = validateCustomInstructions(value);
          if (value.length <= MAX_CUSTOM_INSTRUCTIONS_LENGTH) {
            assert.ok(result.ok);
            assert.strictEqual(result.value, value);
          } else {
            assert.ok(!result.ok);
            assert.strictEqual(result.reason, "too-long");
          }
        }
      )
    );
  });

  // Pin the exact boundary values so the limit itself never regresses.
  it("accepts a string of exactly 10,000 characters", () => {
    const value = "a".repeat(MAX_CUSTOM_INSTRUCTIONS_LENGTH);
    const result = validateCustomInstructions(value);
    assert.ok(result.ok);
    assert.strictEqual(result.value, value);
  });

  it("rejects a string of exactly 10,001 characters as too-long", () => {
    const value = "a".repeat(MAX_CUSTOM_INSTRUCTIONS_LENGTH + 1);
    const result = validateCustomInstructions(value);
    assert.ok(!result.ok);
    assert.strictEqual(result.reason, "too-long");
  });

  it("accepts the empty string", () => {
    const result = validateCustomInstructions("");
    assert.ok(result.ok);
    assert.strictEqual(result.value, "");
  });
});
