// Feature: agent-tools-and-settings, Property 25: Configuration load ignores
// unknown tool identifiers.
//
// For any persisted configuration containing tool identifiers absent from the
// registry mixed with valid entries, loading through ConfigStore drops the
// unknown entries and preserves all valid entries. This exercises the real
// persist -> load path: a config carrying both known and unknown tool ids is
// saved through the store and then reloaded; unknown ids must be gone and every
// known id must keep its persisted state.
//
// Validates: Requirements 9.3
import * as assert from "assert";
import * as fc from "fast-check";

import {
  ConfigStore,
  type MementoLike,
  type PersistedAgentConfig,
} from "./configStore";
import type { ApprovalPolicy, AutonomyMode, ToolDefinition, ToolState } from "./types";

// -----------------------------------------------------------------------------
// Test doubles
// -----------------------------------------------------------------------------

/**
 * In-memory MementoLike that mimics VS Code's Memento by JSON round-tripping
 * stored values, so the test exercises the same serialize/deserialize path real
 * storage would.
 */
class InMemoryMemento implements MementoLike {
  private readonly store = new Map<string, string>();

  get<T>(key: string): T | undefined {
    const raw = this.store.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }

  update(key: string, value: unknown): PromiseLike<void> {
    if (value === undefined) {
      this.store.delete(key);
    } else {
      this.store.set(key, JSON.stringify(value));
    }
    return Promise.resolve();
  }
}

/** Build a minimal, well-formed tool definition for a given id. */
function makeDef(id: string): ToolDefinition {
  return {
    id,
    displayName: id,
    description: `${id} tool`,
    inputSchema: { type: "object" },
    category: "file",
    classification: "read-only",
    defaultEnabled: false,
  };
}

// -----------------------------------------------------------------------------
// Generators
// -----------------------------------------------------------------------------

const autonomyModeArb: fc.Arbitrary<AutonomyMode> = fc.constantFrom(
  "auto",
  "supervised"
);

const approvalPolicyArb: fc.Arbitrary<ApprovalPolicy> = fc.constantFrom(
  "inherit",
  "always-ask",
  "auto-approve"
);

const toolStateArb: fc.Arbitrary<ToolState> = fc.record({
  enabled: fc.boolean(),
  approvalPolicy: approvalPolicyArb,
});

/**
 * Generate a disjoint partition of unique tool identifiers into a non-empty set
 * of "known" ids (registered with the store) and a non-empty set of "unknown"
 * ids (present in the persisted blob but absent from the registry). Guaranteeing
 * both sets are non-empty ensures every generated case is a genuine mix.
 */
const partitionedIdsArb: fc.Arbitrary<{ known: string[]; unknown: string[] }> = fc
  .uniqueArray(
    // Tool ids are real identifiers; exclude prototype-polluting keys that a plain
    // `Record<string, ToolState>` cannot hold as own data properties (no real tool
    // is named "__proto__" / "constructor" / "prototype").
    fc
      .string({ minLength: 1, maxLength: 24 })
      .filter(
        (s) =>
          s !== "__proto__" && s !== "constructor" && s !== "prototype",
      ),
    {
      minLength: 2,
      maxLength: 14,
    },
  )
  .chain((ids) =>
    fc.integer({ min: 1, max: ids.length - 1 }).map((knownCount) => ({
      known: ids.slice(0, knownCount),
      unknown: ids.slice(knownCount),
    }))
  );

// -----------------------------------------------------------------------------
// Property 25
// -----------------------------------------------------------------------------

describe("Property 25: configuration load ignores unknown tool identifiers", () => {
  it("drops unknown tool ids on load while preserving every known entry", async () => {
    await fc.assert(
      fc.asyncProperty(
        partitionedIdsArb,
        autonomyModeArb,
        fc.string({ maxLength: 200 }),
        fc.option(fc.string({ minLength: 1, maxLength: 40 }), { nil: null }),
        async ({ known, unknown }, autonomyMode, customInstructions, defaultModelId) => {
          const store = new ConfigStore(
            new InMemoryMemento(),
            new InMemoryMemento(),
            known.map(makeDef)
          );

          // Persist explicit states for every known id plus rogue states for
          // every unknown id, then reload through the store.
          const knownStates: Record<string, ToolState> = {};
          const toolStates: Record<string, ToolState> = {};
          for (let i = 0; i < known.length; i++) {
            const id = known[i];
            const state: ToolState = {
              enabled: i % 2 === 0,
              approvalPolicy: "always-ask",
            };
            knownStates[id] = state;
            toolStates[id] = state;
          }
          for (const id of unknown) {
            toolStates[id] = { enabled: true, approvalPolicy: "auto-approve" };
          }

          const config: PersistedAgentConfig = {
            version: 1,
            autonomyMode,
            toolStates,
            customInstructions,
            defaultModelId,
          };

          await store.save(config);
          const { config: loaded, corrupt } = store.load();

          // A well-formed blob is not treated as corrupt.
          assert.strictEqual(corrupt, false);

          // R9.3: every unknown id is dropped.
          for (const id of unknown) {
            assert.ok(
              !Object.prototype.hasOwnProperty.call(loaded.toolStates, id),
              `unknown tool id "${id}" should be dropped on load`
            );
          }

          // Every known id is preserved with its persisted state.
          for (const id of known) {
            assert.deepStrictEqual(
              loaded.toolStates[id],
              knownStates[id],
              `known tool id "${id}" should retain its persisted state`
            );
          }

          // Non-tool configuration survives untouched.
          assert.strictEqual(loaded.autonomyMode, autonomyMode);
          assert.strictEqual(loaded.customInstructions, customInstructions);
          assert.strictEqual(loaded.defaultModelId, defaultModelId);
        }
      )
    );
  });
});
