// Feature: agent-tools-and-settings, Property 34: Execution profile survives a
// save/load round-trip.
//
// For any execution profile, saving it for a workspace root via ConfigStore and
// then loading it back for that same root yields an equal profile.
//
// Validates: Requirements 11.4
import * as assert from "assert";
import * as fc from "fast-check";

import { ConfigStore, type MementoLike } from "./configStore";
import type { ToolDefinition } from "./types";
import type {
  CommandSpec,
  DetectedTechnology,
  EnvironmentActivation,
  ExecutionProfile,
  ProjectCommands,
} from "../env/types";

// -----------------------------------------------------------------------------
// Test doubles
// -----------------------------------------------------------------------------

/**
 * In-memory MementoLike that mimics VS Code's Memento by JSON round-tripping stored
 * values, so the test exercises the same serialize/deserialize path real
 * `workspaceState` would (surfacing any non-serializable content and dropping
 * `undefined` optional fields exactly as real storage does).
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

// Execution profiles live in `workspaceState` and are keyed by root; the tool
// definitions are irrelevant to profile persistence, so an empty registry is fine.
const TOOL_DEFINITIONS: readonly ToolDefinition[] = [];

function newStore(): ConfigStore {
  return new ConfigStore(
    new InMemoryMemento(),
    new InMemoryMemento(),
    TOOL_DEFINITIONS
  );
}

// -----------------------------------------------------------------------------
// Generators
// -----------------------------------------------------------------------------

/**
 * A CommandSpec is either determined (a concrete command string) or undetermined
 * (a null command), matching the design invariant that a null command marks the
 * command as undetermined (R11.10).
 */
const commandSpecArb: fc.Arbitrary<CommandSpec> = fc.oneof(
  fc.record({ command: fc.string(), determined: fc.constant(true) }),
  fc.record({ command: fc.constant(null), determined: fc.constant(false) })
);

/** Each run/test/debug/build key is optional. */
const projectCommandsArb: fc.Arbitrary<ProjectCommands> = fc.record(
  {
    run: commandSpecArb,
    test: commandSpecArb,
    debug: commandSpecArb,
    build: commandSpecArb,
  },
  { requiredKeys: [] }
);

const environmentActivationArb: fc.Arbitrary<EnvironmentActivation> = fc.record(
  {
    kind: fc.constantFrom<EnvironmentActivation["kind"]>("venv", "conda", "none"),
    activationCommand: fc.string(),
    interpreterPath: fc.string(),
  },
  { requiredKeys: ["kind"] }
);

const detectedTechnologyArb: fc.Arbitrary<DetectedTechnology> = fc.record(
  {
    language: fc.string(),
    runtime: fc.string(),
    environment: environmentActivationArb,
    commands: projectCommandsArb,
  },
  { requiredKeys: ["language", "commands"] }
);

const executionProfileArb: fc.Arbitrary<ExecutionProfile> = fc.record({
  root: fc.string(),
  detectedAt: fc.date({ noInvalidDate: true }).map((d) => d.toISOString()),
  technologies: fc.array(detectedTechnologyArb, { maxLength: 6 }),
});

// -----------------------------------------------------------------------------
// Property 34
// -----------------------------------------------------------------------------

describe("Property 34: execution profile survives a save/load round-trip", () => {
  it("loadProfile(root) equals the profile saved for that root", async () => {
    await fc.assert(
      fc.asyncProperty(executionProfileArb, async (profile) => {
        const store = newStore();

        await store.saveProfile(profile);
        const loaded = store.loadProfile(profile.root);

        assert.notStrictEqual(loaded, undefined, "a saved profile must load back");
        // Compare profile *data*, not object-prototype identity. Normalizing the
        // expected profile through the same JSON boundary that real VS Code
        // storage uses isolates the property to what matters — that every field
        // survives save then load (and that dropped `undefined` optionals match).
        assert.deepStrictEqual(loaded, JSON.parse(JSON.stringify(profile)));
      })
    );
  });
});
