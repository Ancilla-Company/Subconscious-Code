// Feature: agent-tools-and-settings — scaffolding smoke test.
//
// This is NOT one of the numbered correctness properties from design.md. It
// exists only to prove the property-based test scaffolding is wired correctly:
// Mocha discovers compiled specs, fast-check runs, and the shared 100-iteration
// floor is applied. Real feature properties are added by their own tasks.
import * as assert from "assert";
import * as fc from "fast-check";

import { MIN_PROPERTY_RUNS } from "./setup";

describe("PBT scaffolding", () => {
  it("applies the shared minimum iteration count globally", () => {
    const global = fc.readConfigureGlobal();
    assert.strictEqual(global.numRuns, MIN_PROPERTY_RUNS);
  });

  it("executes fast-check properties over generated inputs", () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => a + b === b + a)
    );
  });
});
