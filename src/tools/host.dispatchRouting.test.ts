// Feature: agent-tools-and-settings, Property 5: Dispatch routes to the target
// tool with its inputs.
//
// For any enabled tool and any schema-valid input, a `tool.call` for that tool
// dispatches to that exact tool with the supplied input unchanged — the targeted
// tool (and only it) is invoked, it receives the exact input, and its output is
// returned in the `tool.result` frame.
//
// The property drives `ToolHost.handleCall` over a catalogue of spy tools that
// record which tool received which input. A fake `ToolFrameTransport` captures the
// outgoing frames and a fake `createContext` supplies the ambient context, so the
// test is fully decoupled from `vscode` and the concrete `EngineClient`.
//
// Validates: Requirements 3.1
import * as assert from "assert";

import * as fc from "fast-check";

import { ConfigStore, type MementoLike } from "./configStore";
import { ToolHost, type ToolFrameTransport } from "./host";
import { ToolRegistry } from "./registry";
import type {
  CodingTool,
  JSONSchema,
  ToolContext,
  ToolDefinition,
  ToolOutput,
  ToolRegisterFrame,
  ToolResultFrame,
  WorkspacePathGuard,
} from "./types";

// -----------------------------------------------------------------------------
// Test doubles
// -----------------------------------------------------------------------------

/** In-memory MementoLike mirroring VS Code's Memento via JSON round-tripping. */
class InMemoryMemento implements MementoLike {
  private readonly store = new Map<string, string>();

  public get<T>(key: string): T | undefined {
    const raw = this.store.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }

  public update(key: string, value: unknown): PromiseLike<void> {
    if (value === undefined) {
      this.store.delete(key);
    } else {
      this.store.set(key, JSON.stringify(value));
    }
    return Promise.resolve();
  }
}

/** Captures every frame written to the transport; always reports the socket open. */
class RecordingTransport implements ToolFrameTransport {
  public readonly sent: Array<ToolRegisterFrame | ToolResultFrame> = [];

  public send(frame: ToolRegisterFrame | ToolResultFrame): void {
    this.sent.push(frame);
  }

  public isOpen(): boolean {
    return true;
  }
}

/**
 * A spy Coding_Tool that records each `(input)` it receives and returns a canned
 * output tagged with its own id, so the caller can assert both routing and the
 * returned output. It never touches the workspace.
 */
class SpyTool implements CodingTool {
  public readonly calls: unknown[] = [];

  public constructor(public readonly id: string) {}

  public async execute(input: unknown, _ctx: ToolContext): Promise<ToolOutput> {
    this.calls.push(input);
    return { content: `handled by ${this.id}`, data: { tool: this.id } };
  }
}

/** A path guard stub; file resolution is never exercised by these spy tools. */
const fakeGuard: WorkspacePathGuard = {
  roots: (): string[] => ["/workspace"],
  resolve: () => ({ ok: false, error: "out-of-scope" }),
};

/** Build a ToolContext carrying a non-aborted signal (fake createContext). */
function makeContext(signal: AbortSignal): ToolContext {
  return { guard: fakeGuard, profile: undefined, signal };
}

// -----------------------------------------------------------------------------
// Tool catalogue under test: distinct schemas with matching input generators
// -----------------------------------------------------------------------------

/** A definition paired with a generator that produces schema-valid inputs. */
interface RoutingCase {
  readonly definition: ToolDefinition;
  readonly input: () => fc.Arbitrary<unknown>;
}

/** Assemble a tool definition with the common catalogue fields. */
function defineTool(id: string, schema: JSONSchema): ToolDefinition {
  return {
    id,
    displayName: id,
    description: `Spy tool ${id}`,
    inputSchema: schema,
    category: "file",
    classification: "read-only",
    defaultEnabled: true,
  };
}

/**
 * Four tools with distinct input schemas. Each generator yields only schema-valid
 * inputs, so every generated call reaches dispatch (validation always passes).
 */
const ROUTING_CASES: readonly RoutingCase[] = [
  {
    definition: defineTool("alpha_string", {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    }),
    input: () => fc.record({ text: fc.string() }),
  },
  {
    definition: defineTool("beta_number", {
      type: "object",
      properties: { n: { type: "integer" }, label: { type: "string" } },
      required: ["n"],
      additionalProperties: false,
    }),
    input: () =>
      fc.record(
        { n: fc.integer(), label: fc.string() },
        { requiredKeys: ["n"] },
      ),
  },
  {
    definition: defineTool("gamma_flag", {
      type: "object",
      properties: { on: { type: "boolean" } },
      required: ["on"],
      additionalProperties: false,
    }),
    input: () => fc.record({ on: fc.boolean() }),
  },
  {
    definition: defineTool("delta_list", {
      type: "object",
      properties: { items: { type: "array", items: { type: "string" } } },
      required: ["items"],
      additionalProperties: false,
    }),
    input: () => fc.record({ items: fc.array(fc.string()) }),
  },
];

const DEFINITIONS: readonly ToolDefinition[] = ROUTING_CASES.map(
  (c) => c.definition,
);

/** Fresh registry (all tools enabled by default) backed by in-memory storage. */
function makeRegistry(): ToolRegistry {
  const store = new ConfigStore(
    new InMemoryMemento(),
    new InMemoryMemento(),
    DEFINITIONS,
  );
  return new ToolRegistry(store, DEFINITIONS);
}

// -----------------------------------------------------------------------------
// Property 5
// -----------------------------------------------------------------------------

describe("Property 5: dispatch routes to the target tool with its inputs", () => {
  it("invokes exactly the targeted enabled tool with the exact input and returns its output (Requirement 3.1)", async () => {
    const targetIndex = fc.integer({ min: 0, max: ROUTING_CASES.length - 1 });

    await fc.assert(
      fc.asyncProperty(
        targetIndex.chain((index) =>
          fc.record({
            index: fc.constant(index),
            input: ROUTING_CASES[index].input(),
            correlationId: fc
              .string({ minLength: 1 })
              .filter((s) => s.length > 0),
          }),
        ),
        async ({ index, input, correlationId }) => {
          const registry = makeRegistry();
          const spies = DEFINITIONS.map((def) => new SpyTool(def.id));
          const transport = new RecordingTransport();
          const host = new ToolHost({
            registry,
            tools: spies,
            transport,
            createContext: makeContext,
          });

          const targetId = DEFINITIONS[index].id;

          await host.handleCall({
            v: 1,
            type: "tool.call",
            id: correlationId,
            data: { tool: targetId, input },
          });

          // The targeted tool is invoked exactly once with the exact input.
          const target = spies[index];
          assert.strictEqual(
            target.calls.length,
            1,
            `target tool ${targetId} must be invoked exactly once`,
          );
          assert.deepStrictEqual(
            target.calls[0],
            input,
            "target tool must receive the supplied input unchanged",
          );

          // No other tool is invoked.
          spies.forEach((spy, i) => {
            if (i !== index) {
              assert.strictEqual(
                spy.calls.length,
                0,
                `non-target tool ${spy.id} must not be invoked`,
              );
            }
          });

          // Exactly one tool.result frame is sent, echoing the correlation id and
          // carrying the targeted tool's output.
          assert.strictEqual(
            transport.sent.length,
            1,
            "exactly one frame must be sent",
          );
          const frame = transport.sent[0] as ToolResultFrame;
          assert.strictEqual(frame.type, "tool.result");
          assert.strictEqual(frame.id, correlationId);
          assert.strictEqual(frame.data.ok, true);
          if (frame.data.ok) {
            assert.deepStrictEqual(frame.data.output, {
              content: `handled by ${targetId}`,
              data: { tool: targetId },
            });
          }
        },
      ),
    );
  });
});
