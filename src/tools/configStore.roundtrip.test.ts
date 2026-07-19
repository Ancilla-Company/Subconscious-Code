// Feature: agent-tools-and-settings, Property 24: Agent configuration survives a
// save/load round-trip.
//
// For any valid agent configuration (autonomy mode, per-tool enabled states,
// per-tool approval policies, custom instructions, default model), saving it via
// ConfigStore and then loading it back yields an equal configuration.
//
// Validates: Requirements 8.9, 9.1, 9.4
import * as assert from "assert";
import * as fc from "fast-check";

import {
  ConfigStore,
  type MementoLike,
  type PersistedAgentConfig,
  CONFIG_VERSION,
} from "./configStore";
import type { ApprovalPolicy, AutonomyMode, ToolDefinition } from "./types";

// -----------------------------------------------------------------------------
// Test doubles
// -----------------------------------------------------------------------------

/**
 * In-memory MementoLike that mimics VS Code's Memento by JSON round-tripping stored
 * values, so the test exercises the same serialize/deserialize path real storage
 * would (surfacing any non-serializable content).
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

// A representative slice of the registry's tool definitions. Only the ids and
// classifications matter for the round-trip; other fields are filler.
const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  makeDef("read_file", "file", "read-only", true),
  makeDef("edit_file", "file", "mutating", true),
  makeDef("run_terminal", "terminal", "mutating", false),
  makeDef("get_diagnostics", "diagnostics", "read-only", true),
  makeDef("fetch_web", "web", "read-only", true),
];

const KNOWN_TOOL_IDS: readonly string[] = TOOL_DEFINITIONS.map((d) => d.id);

function makeDef(
  id: string,
  category: ToolDefinition["category"],
  classification: ToolDefinition["classification"],
  defaultEnabled: boolean
): ToolDefinition {
  return {
    id,
    displayName: id,
    description: `${id} tool`,
    inputSchema: { type: "object" },
    category,
    classification,
    defaultEnabled,
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

/**
 * Generate a full set of tool states keyed by every known tool id. Covering every
 * known id (rather than a subset) is what makes the round-trip an exact equality:
 * load() fills defaults for any known tool absent from the blob, so an exact
 * round-trip requires the saved config to already carry all known ids.
 */
const toolStatesArb: fc.Arbitrary<PersistedAgentConfig["toolStates"]> = fc
  .tuple(
    ...KNOWN_TOOL_IDS.map(() =>
      fc.record({ enabled: fc.boolean(), approvalPolicy: approvalPolicyArb })
    )
  )
  .map((states) => {
    const out: PersistedAgentConfig["toolStates"] = {};
    KNOWN_TOOL_IDS.forEach((id, i) => {
      out[id] = states[i];
    });
    return out;
  });

const configArb: fc.Arbitrary<PersistedAgentConfig> = fc.record({
  version: fc.constant(CONFIG_VERSION),
  autonomyMode: autonomyModeArb,
  toolStates: toolStatesArb,
  customInstructions: fc.string({ maxLength: 10000 }),
  defaultModelId: fc.option(fc.string(), { nil: null }),
});

// -----------------------------------------------------------------------------
// Property 24
// -----------------------------------------------------------------------------

describe("Property 24: agent configuration survives a save/load round-trip", () => {
  it("load(save(config)) equals config for any valid configuration", async () => {
    await fc.assert(
      fc.asyncProperty(configArb, async (config) => {
        const store = new ConfigStore(
          new InMemoryMemento(),
          new InMemoryMemento(),
          TOOL_DEFINITIONS
        );

        await store.save(config);
        const { config: loaded, corrupt } = store.load();

        assert.strictEqual(corrupt, false, "round-tripped config must not be corrupt");
        // Compare configuration *data*: the round-trip must preserve values, not
        // object-prototype identity. Normalizing the expected config through the
        // same JSON boundary that real VS Code storage uses isolates the property
        // to what matters — that every field survives save then load.
        assert.deepStrictEqual(loaded, JSON.parse(JSON.stringify(config)));
      })
    );
  });
});
