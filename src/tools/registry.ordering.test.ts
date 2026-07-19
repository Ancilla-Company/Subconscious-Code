// Feature: agent-tools-and-settings, Property 20: The tools list is ordered by
// category then display name.
//
// For any registry contents, `ToolRegistry.all()` (the model the Tools_View renders)
// is a stable sort by category — in the fixed order file → search → terminal →
// diagnostics → test → web — and then by display name, and it includes every tool
// with its display name, description, category, and enabled state.
//
// This is a pure-module property test that runs outside the VS Code host against an
// in-memory fake `MementoLike`, following the ConfigStore round-trip test pattern.
//
// Validates: Requirements 7.2
import * as assert from "assert";
import * as fc from "fast-check";

import { ConfigStore, type MementoLike } from "./configStore";
import { ToolRegistry } from "./registry";
import type { ToolCategory, ToolClassification, ToolDefinition } from "./types";

// -----------------------------------------------------------------------------
// Test doubles
// -----------------------------------------------------------------------------

/**
 * In-memory MementoLike that JSON round-trips stored values, mirroring the fake used
 * by the ConfigStore round-trip test so the registry loads through the same
 * serialize/deserialize path real VS Code storage would.
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

// -----------------------------------------------------------------------------
// Ordering reference (kept independent of the implementation under test)
// -----------------------------------------------------------------------------

/** The fixed category ordering the registry must honour (Requirement 7.2). */
const CATEGORY_ORDER: readonly ToolCategory[] = [
  "file",
  "search",
  "terminal",
  "diagnostics",
  "test",
  "web",
];

const CLASSIFICATIONS: readonly ToolClassification[] = ["read-only", "mutating"];

// -----------------------------------------------------------------------------
// Generators
// -----------------------------------------------------------------------------

/**
 * Display-name generator drawn from a small pool so ties (equal display names within
 * a category) occur frequently, exercising the stable-sort tie-break. A few unicode
 * names are included so display-name comparison is not accidentally ASCII-only.
 */
const displayNameArb: fc.Arbitrary<string> = fc.constantFrom(
  "Alpha",
  "alpha",
  "Beta",
  "beta",
  "Gamma",
  "Zed",
  "ábaco",
  "Éclair",
  "10 things",
  "2 things",
  ""
);

/**
 * Arbitrary tool definitions with unique ids but freely repeating categories and
 * display names, so the generated catalogue spans every category and produces
 * category ties and display-name ties within a category.
 */
const definitionsArb: fc.Arbitrary<ToolDefinition[]> = fc.uniqueArray(
  fc.record({
    id: fc.string({ minLength: 1, maxLength: 16 }),
    displayName: displayNameArb,
    description: fc.string(),
    inputSchema: fc.constant({ type: "object" as const }),
    category: fc.constantFrom(...CATEGORY_ORDER),
    classification: fc.constantFrom(...CLASSIFICATIONS),
    defaultEnabled: fc.boolean(),
  }),
  { selector: (def) => def.id, minLength: 0, maxLength: 30 }
);

/**
 * Independent reference: a stable sort of `defs` by category (in `CATEGORY_ORDER`)
 * then display name. `Array.prototype.sort` is stable per the ECMAScript spec, so ties
 * preserve input order — which is exactly the stability the property asserts.
 */
function expectedOrder(defs: readonly ToolDefinition[]): ToolDefinition[] {
  return [...defs].sort((a, b) => {
    const delta =
      CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
    if (delta !== 0) {
      return delta;
    }
    return a.displayName.localeCompare(b.displayName);
  });
}

// -----------------------------------------------------------------------------
// Property 20
// -----------------------------------------------------------------------------

describe("Property 20: the tools list is ordered by category then display name", () => {
  it("all() is a stable category-then-displayName sort including every tool", () => {
    fc.assert(
      fc.property(definitionsArb, (defs) => {
        const registry = new ToolRegistry(
          new ConfigStore(new InMemoryMemento(), new InMemoryMemento(), defs),
          defs
        );

        const ordered = registry.all();

        // Includes exactly every tool — no additions, no omissions.
        assert.strictEqual(
          ordered.length,
          defs.length,
          "all() must include every tool definition"
        );
        assert.deepStrictEqual(
          [...ordered.map((d) => d.id)].sort(),
          [...defs.map((d) => d.id)].sort(),
          "all() must contain exactly the registered tool ids"
        );

        // Order matches the independent stable reference sort exactly.
        assert.deepStrictEqual(
          ordered.map((d) => d.id),
          expectedOrder(defs).map((d) => d.id),
          "all() must be a stable sort by category then display name"
        );

        // Each returned entry carries its display name, description, category, and
        // has an accessible enabled state (the fields the Tools_View renders).
        for (const def of ordered) {
          assert.strictEqual(typeof def.displayName, "string");
          assert.strictEqual(typeof def.description, "string");
          assert.ok(
            CATEGORY_ORDER.includes(def.category),
            `category ${def.category} must be a defined category`
          );
          assert.strictEqual(
            typeof registry.stateOf(def.id).enabled,
            "boolean",
            "each tool must expose a boolean enabled state"
          );
        }

        // Pairwise invariant: never a category out of order, and within a category
        // display names are non-decreasing.
        for (let i = 1; i < ordered.length; i++) {
          const prev = ordered[i - 1];
          const curr = ordered[i];
          const prevCat = CATEGORY_ORDER.indexOf(prev.category);
          const currCat = CATEGORY_ORDER.indexOf(curr.category);
          assert.ok(prevCat <= currCat, "categories must be non-decreasing");
          if (prevCat === currCat) {
            assert.ok(
              prev.displayName.localeCompare(curr.displayName) <= 0,
              "display names within a category must be non-decreasing"
            );
          }
        }
      })
    );
  });
});
