// Feature: agent-tools-and-settings, Property 1: Tool definitions are well-formed.
//
// For any tool definition in the ToolRegistry, the definition has a non-empty id,
// a non-empty display name, a non-empty description, a present input schema, a valid
// category, a classification that is exactly one of `read-only` or `mutating`, and a
// boolean default-enabled flag. Ids are additionally unique across the registry.
//
// The property is checked by randomly selecting a definition from the live registry
// contents on each run (fast-check), so the invariants are asserted across the whole
// catalogue rather than a single fixed example.
//
// Validates: Requirements 1.2
import * as assert from "assert";
import * as fc from "fast-check";

import {
  ConfigStore,
  type MementoLike,
} from "./configStore";
import { BUILTIN_TOOL_DEFINITIONS, ToolRegistry } from "./registry";
import type {
  ToolCategory,
  ToolClassification,
  ToolDefinition,
} from "./types";

// -----------------------------------------------------------------------------
// Test doubles
// -----------------------------------------------------------------------------

/** In-memory MementoLike mirroring VS Code's Memento via JSON round-tripping. */
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

// -----------------------------------------------------------------------------
// Defined value sets (the closed vocabularies a well-formed definition must use)
// -----------------------------------------------------------------------------

const VALID_CATEGORIES: readonly ToolCategory[] = [
  "file",
  "search",
  "terminal",
  "diagnostics",
  "test",
  "web",
  "ide",
  "mcp",
];

const VALID_CLASSIFICATIONS: readonly ToolClassification[] = [
  "read-only",
  "mutating",
];

/** Build a ToolRegistry backed by empty in-memory storage (uses built-in defs). */
function makeRegistry(): ToolRegistry {
  return new ToolRegistry(
    new ConfigStore(new InMemoryMemento(), new InMemoryMemento(), BUILTIN_TOOL_DEFINITIONS)
  );
}

/** Assert every well-formedness invariant of Property 1 for a single definition. */
function assertWellFormed(def: ToolDefinition): void {
  // Non-empty id.
  assert.strictEqual(typeof def.id, "string");
  assert.ok(def.id.length > 0, `id must be non-empty (got "${def.id}")`);

  // Non-empty display name.
  assert.strictEqual(typeof def.displayName, "string");
  assert.ok(
    def.displayName.length > 0,
    `displayName must be non-empty for ${def.id}`
  );

  // Non-empty description.
  assert.strictEqual(typeof def.description, "string");
  assert.ok(
    def.description.length > 0,
    `description must be non-empty for ${def.id}`
  );

  // Present input schema: a non-null object.
  assert.ok(
    def.inputSchema !== null &&
      typeof def.inputSchema === "object" &&
      !Array.isArray(def.inputSchema),
    `inputSchema must be a present object for ${def.id}`
  );

  // Category is one of the defined ToolCategory values.
  assert.ok(
    VALID_CATEGORIES.includes(def.category),
    `category must be a defined ToolCategory for ${def.id} (got "${def.category}")`
  );

  // Classification is exactly one of read-only | mutating.
  assert.ok(
    VALID_CLASSIFICATIONS.includes(def.classification),
    `classification must be read-only or mutating for ${def.id} (got "${def.classification}")`
  );

  // defaultEnabled is a boolean.
  assert.strictEqual(
    typeof def.defaultEnabled,
    "boolean",
    `defaultEnabled must be a boolean for ${def.id}`
  );
}

// -----------------------------------------------------------------------------
// Property 1
// -----------------------------------------------------------------------------

describe("Property 1: tool definitions are well-formed", () => {
  it("every randomly selected registry definition satisfies all well-formedness invariants", () => {
    const registry = makeRegistry();
    const definitions = registry.all();
    assert.ok(definitions.length > 0, "registry must expose at least one tool");

    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: definitions.length - 1 }),
        (index) => {
          assertWellFormed(definitions[index]);
        }
      )
    );
  });

  it("all tool ids are unique across the registry", () => {
    const registry = makeRegistry();
    const ids = registry.all().map((def) => def.id);
    const unique = new Set(ids);
    assert.strictEqual(
      unique.size,
      ids.length,
      "every tool definition must have a unique id"
    );
  });
});
