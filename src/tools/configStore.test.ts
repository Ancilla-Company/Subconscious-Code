// Feature: agent-tools-and-settings, Property 26: Corrupt configuration loads
// as defaults without failing.
//
// Validates: Requirements 9.5
//
// For any malformed or unreadable stored configuration blob, `ConfigStore.load()`
// returns the defaults (registry default-enabled flags and `supervised` autonomy),
// does not throw, and sets `corrupt: true` so the caller can surface a "could not
// load" indication. This is a pure-module property test that runs outside the
// VS Code host against an in-memory fake `MementoLike`.
import * as assert from "assert";
import * as fc from "fast-check";

import {
  ConfigStore,
  DEFAULT_AUTONOMY_MODE,
  type MementoLike,
} from "./configStore";
import type { ToolCategory, ToolClassification, ToolDefinition } from "./types";

// -----------------------------------------------------------------------------
// In-memory fakes
// -----------------------------------------------------------------------------

/** A MementoLike whose `get` returns a fixed (possibly garbage) value. */
function returningStore(value: unknown): MementoLike {
  return {
    get<T>(_key: string): T | undefined {
      return value as T;
    },
    update(_key: string, _value: unknown): PromiseLike<void> {
      return Promise.resolve();
    },
  };
}

/** A MementoLike whose `get` throws, modelling unreadable storage. */
function throwingStore(): MementoLike {
  return {
    get<T>(_key: string): T | undefined {
      throw new Error("storage unreadable");
    },
    update(_key: string, _value: unknown): PromiseLike<void> {
      return Promise.resolve();
    },
  };
}

/** A benign workspace store; execution-profile loading is not exercised here. */
function emptyStore(): MementoLike {
  return {
    get<T>(_key: string): T | undefined {
      return undefined;
    },
    update(_key: string, _value: unknown): PromiseLike<void> {
      return Promise.resolve();
    },
  };
}

// -----------------------------------------------------------------------------
// Generators
// -----------------------------------------------------------------------------

const CATEGORIES: readonly ToolCategory[] = [
  "file",
  "search",
  "terminal",
  "diagnostics",
  "test",
  "web",
];
const CLASSIFICATIONS: readonly ToolClassification[] = ["read-only", "mutating"];

/** Arbitrary well-formed tool definitions used to derive the defaults. */
const toolDefinitionsArb: fc.Arbitrary<ToolDefinition[]> = fc.uniqueArray(
  fc.record({
    id: fc.string({ minLength: 1, maxLength: 24 }),
    displayName: fc.string(),
    description: fc.string(),
    inputSchema: fc.constant({ type: "object" as const }),
    category: fc.constantFrom(...CATEGORIES),
    classification: fc.constantFrom(...CLASSIFICATIONS),
    defaultEnabled: fc.boolean(),
  }),
  { selector: (def) => def.id, maxLength: 10 }
);

/** True when a value would be accepted by ConfigStore as a valid config shape. */
function looksLikeValidConfig(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const v = value as Record<string, unknown>;
  const toolStatesOk =
    typeof v.toolStates === "object" &&
    v.toolStates !== null &&
    !Array.isArray(v.toolStates);
  return (
    v.version === 1 &&
    (v.autonomyMode === "auto" || v.autonomyMode === "supervised") &&
    typeof v.customInstructions === "string" &&
    (v.defaultModelId === null || typeof v.defaultModelId === "string") &&
    toolStatesOk
  );
}

/**
 * Malformed / garbage stored blobs. Excludes `undefined`/`null` (which mean "no
 * config stored", not corrupt) and any value that would parse as a valid config.
 */
const corruptBlobArb: fc.Arbitrary<unknown> = fc
  .oneof(
    // Primitives and arrays are never valid config shapes.
    fc.string(),
    fc.integer(),
    fc.double(),
    fc.boolean(),
    fc.array(fc.anything()),
    // Plain objects that violate a specific structural invariant.
    fc.record({
      version: fc.constantFrom(0, 2, 99, "1", -1),
      autonomyMode: fc.anything(),
      toolStates: fc.anything(),
      customInstructions: fc.anything(),
      defaultModelId: fc.anything(),
    }),
    fc.record({
      version: fc.constant(1),
      autonomyMode: fc.constantFrom("nope", "", 123, null, "AUTO"),
      customInstructions: fc.string(),
      defaultModelId: fc.oneof(fc.string(), fc.constant(null)),
      toolStates: fc.dictionary(fc.string(), fc.anything()),
    }),
    fc.record({
      version: fc.constant(1),
      autonomyMode: fc.constantFrom("auto", "supervised"),
      customInstructions: fc.oneof(fc.integer(), fc.boolean(), fc.constant(null)),
      defaultModelId: fc.anything(),
      toolStates: fc.anything(),
    }),
    fc.record({
      version: fc.constant(1),
      autonomyMode: fc.constantFrom("auto", "supervised"),
      customInstructions: fc.string(),
      defaultModelId: fc.anything(),
      toolStates: fc.oneof(fc.string(), fc.integer(), fc.array(fc.anything())),
    }),
    // Fully arbitrary garbage, filtered to guaranteed-corrupt values.
    fc.anything()
  )
  .filter((v) => v !== undefined && v !== null && !looksLikeValidConfig(v));

// -----------------------------------------------------------------------------
// Property 26
// -----------------------------------------------------------------------------

describe("ConfigStore.load — Property 26: corrupt configuration loads as defaults", () => {
  it("returns defaults with corrupt:true for any malformed stored blob, without throwing", () => {
    fc.assert(
      fc.property(toolDefinitionsArb, corruptBlobArb, (toolDefs, blob) => {
        const store = new ConfigStore(returningStore(blob), emptyStore(), toolDefs);

        let result: ReturnType<ConfigStore["load"]> | undefined;
        assert.doesNotThrow(() => {
          result = store.load();
        });

        assert.ok(result, "load must return a result");
        assert.strictEqual(result.corrupt, true, "malformed blob must flag corrupt");
        assert.strictEqual(
          result.config.autonomyMode,
          DEFAULT_AUTONOMY_MODE,
          "corrupt config must fall back to supervised autonomy"
        );
        assert.deepStrictEqual(
          result.config,
          store.defaults(),
          "corrupt config must load exactly the registry defaults"
        );
      })
    );
  });

  it("returns defaults with corrupt:true when the store itself throws on read", () => {
    fc.assert(
      fc.property(toolDefinitionsArb, (toolDefs) => {
        const store = new ConfigStore(throwingStore(), emptyStore(), toolDefs);

        let result: ReturnType<ConfigStore["load"]> | undefined;
        assert.doesNotThrow(() => {
          result = store.load();
        });

        assert.ok(result, "load must return a result");
        assert.strictEqual(result.corrupt, true, "unreadable storage must flag corrupt");
        assert.strictEqual(result.config.autonomyMode, DEFAULT_AUTONOMY_MODE);
        assert.deepStrictEqual(result.config, store.defaults());
      })
    );
  });
});
