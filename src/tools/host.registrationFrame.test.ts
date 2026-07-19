// Feature: agent-tools-and-settings, Property 4: Registration frame reflects exactly
// the enabled set.
//
// For any registry state, the built `tool.register` frame lists exactly the currently
// enabled tools — no disabled tool appears, every enabled tool appears — and each
// listed tool has a non-empty id, a non-empty description, and a present input schema
// (the list is empty when no tool is enabled).
//
// The property randomizes which of the ten built-in tools are enabled/disabled on a
// fresh registry each run, then asserts the frame produced by ToolHost reflects exactly
// that enabled set (ids, descriptions, and input schemas), including the empty-list case
// when nothing is enabled. It also asserts `sendRegistration()` transmits that same frame
// through the transport when the socket is open.
//
// Validates: Requirements 2.1, 2.2, 2.3, 2.5
import * as assert from "assert";
import * as fc from "fast-check";

import { ConfigStore, type MementoLike } from "./configStore";
import { BUILTIN_TOOL_DEFINITIONS, ToolRegistry } from "./registry";
import {
  ToolHost,
  type ToolFrameTransport,
  type ToolHostOptions,
} from "./host";
import type {
  ToolContext,
  ToolRegisterFrame,
  ToolResultFrame,
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

/**
 * Fake ToolFrameTransport that records every frame it is asked to send and reports a
 * configurable open/closed state. Only registration frames are exercised here.
 */
class FakeTransport implements ToolFrameTransport {
  public readonly sent: Array<ToolRegisterFrame | ToolResultFrame> = [];
  public open: boolean;

  public constructor(open: boolean) {
    this.open = open;
  }

  public send(frame: ToolRegisterFrame | ToolResultFrame): void {
    this.sent.push(frame);
  }

  public isOpen(): boolean {
    return this.open;
  }
}

// The ids of the ten built-in tools, used to drive the enabled/disabled randomization.
const BUILTIN_IDS: readonly string[] = BUILTIN_TOOL_DEFINITIONS.map((d) => d.id);

/**
 * Build a fresh ToolRegistry backed by empty in-memory storage (uses the built-in
 * definitions), so each property run starts from the registry's default state.
 */
function makeRegistry(): ToolRegistry {
  return new ToolRegistry(
    new ConfigStore(new InMemoryMemento(), new InMemoryMemento(), BUILTIN_TOOL_DEFINITIONS)
  );
}

/** Build a ToolHost over a registry and transport; no tools/context needed for registration. */
function makeHost(registry: ToolRegistry, transport: ToolFrameTransport): ToolHost {
  const options: ToolHostOptions = {
    registry,
    tools: [],
    transport,
    // Registration never invokes a tool, so a minimal context factory suffices.
    createContext: (signal: AbortSignal): ToolContext =>
      ({ signal } as unknown as ToolContext),
  };
  return new ToolHost(options);
}

/** Apply a per-tool enabled map to a registry, persisting each state. */
async function applyEnabled(
  registry: ToolRegistry,
  enabledById: Readonly<Record<string, boolean>>
): Promise<void> {
  for (const id of BUILTIN_IDS) {
    await registry.setEnabled(id, enabledById[id]);
  }
}

// -----------------------------------------------------------------------------
// Generators
// -----------------------------------------------------------------------------

/** A random enabled/disabled decision for every built-in tool id. */
const enabledMapArb: fc.Arbitrary<Record<string, boolean>> = fc
  .tuple(...BUILTIN_IDS.map(() => fc.boolean()))
  .map((flags) => {
    const out: Record<string, boolean> = {};
    BUILTIN_IDS.forEach((id, i) => {
      out[id] = flags[i];
    });
    return out;
  });

// -----------------------------------------------------------------------------
// Property 4
// -----------------------------------------------------------------------------

describe("Property 4: registration frame reflects exactly the enabled set", () => {
  it("lists exactly the enabled tools with well-formed id/description/schema", async () => {
    await fc.assert(
      fc.asyncProperty(enabledMapArb, async (enabledById) => {
        const registry = makeRegistry();
        await applyEnabled(registry, enabledById);

        const transport = new FakeTransport(true);
        const host = makeHost(registry, transport);
        const frame = host.buildRegistrationFrame();

        // Frame envelope shape.
        assert.strictEqual(frame.type, "tool.register");
        assert.strictEqual(typeof frame.v, "number");

        const listedIds = frame.data.tools.map((t) => t.id);
        const expectedIds = BUILTIN_IDS.filter((id) => enabledById[id]);

        // Exactly the enabled set — same membership, no duplicates, and matching the
        // registry's own ordered enabled definitions (ids compared as a set + as a list).
        assert.deepStrictEqual(
          [...listedIds].sort(),
          [...expectedIds].sort(),
          "frame must list exactly the enabled tool ids"
        );
        assert.strictEqual(
          new Set(listedIds).size,
          listedIds.length,
          "frame must not list a tool more than once"
        );

        // No disabled tool appears; every enabled tool appears.
        for (const id of BUILTIN_IDS) {
          const present = listedIds.includes(id);
          assert.strictEqual(
            present,
            enabledById[id],
            `tool '${id}' presence must equal its enabled state`
          );
        }

        // Each listed descriptor is well-formed and matches its registry definition.
        for (const descriptor of frame.data.tools) {
          assert.ok(
            typeof descriptor.id === "string" && descriptor.id.length > 0,
            "listed tool id must be non-empty"
          );
          assert.ok(
            typeof descriptor.description === "string" &&
              descriptor.description.length > 0,
            `listed tool '${descriptor.id}' description must be non-empty`
          );
          assert.ok(
            descriptor.inputSchema !== null &&
              typeof descriptor.inputSchema === "object" &&
              !Array.isArray(descriptor.inputSchema),
            `listed tool '${descriptor.id}' must carry a present input schema`
          );

          const def = registry.get(descriptor.id);
          assert.ok(def !== undefined, `listed tool '${descriptor.id}' must exist in registry`);
          assert.strictEqual(descriptor.description, def.description);
          assert.deepStrictEqual(descriptor.inputSchema, def.inputSchema);
        }

        // sendRegistration transmits exactly this frame when the socket is open (R2.1/2.2).
        host.sendRegistration();
        assert.strictEqual(transport.sent.length, 1, "one registration frame must be sent");
        assert.deepStrictEqual(transport.sent[0], frame);
      })
    );
  });

  it("produces an empty tool list when no tool is enabled (R2.5)", async () => {
    const registry = makeRegistry();
    const allDisabled: Record<string, boolean> = {};
    for (const id of BUILTIN_IDS) {
      allDisabled[id] = false;
    }
    await applyEnabled(registry, allDisabled);

    const transport = new FakeTransport(true);
    const host = makeHost(registry, transport);
    const frame = host.buildRegistrationFrame();

    assert.strictEqual(frame.type, "tool.register");
    assert.deepStrictEqual(frame.data.tools, [], "no enabled tools ⇒ empty tool list");
  });
});
