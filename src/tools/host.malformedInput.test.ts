// Feature: agent-tools-and-settings, Property 2: Malformed input is rejected before execution.
//
// For any tool and any input that violates that tool's input schema (a missing required
// field, a wrong-typed field, or an unexpected additional field), `ToolHost` returns a
// validation error whose `field` names an offending input, and the tool's `execute` is
// NEVER invoked.
//
// The property is exercised across every enabled built-in tool and every malformation
// strategy applicable to that tool. Each iteration builds a malformed input that is
// guaranteed to violate the tool's schema at a known, named field, dispatches it through
// the host with a spy tool wired in, and asserts (a) a `validation` error naming that
// field is returned on the `tool.result` frame, and (b) no spy `execute` ran.
//
// Validates: Requirements 1.5, 6.7, 6.8
import * as assert from "assert";
import * as fc from "fast-check";

import { ConfigStore, type MementoLike } from "./configStore";
import { ToolHost, type ToolFrameTransport } from "./host";
import { BUILTIN_TOOL_DEFINITIONS, ToolRegistry } from "./registry";
import type {
  CodingTool,
  JSONSchema,
  ToolCallFrame,
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

/** Records every frame the host sends and reports the socket as always open. */
class RecordingTransport implements ToolFrameTransport {
  public readonly sent: Array<ToolRegisterFrame | ToolResultFrame> = [];

  public send(frame: ToolRegisterFrame | ToolResultFrame): void {
    this.sent.push(frame);
  }

  public isOpen(): boolean {
    return true;
  }

  /** The most recently sent frame, or `undefined` when nothing has been sent. */
  public last(): ToolRegisterFrame | ToolResultFrame | undefined {
    return this.sent[this.sent.length - 1];
  }
}

/** A path guard fake; never exercised because execution is never reached. */
const NEVER_CALLED_GUARD: WorkspacePathGuard = {
  roots(): string[] {
    throw new Error("guard.roots must not be called on a validation failure");
  },
  resolve(): never {
    throw new Error("guard.resolve must not be called on a validation failure");
  },
};

/** A spy CodingTool that records how many times `execute` was invoked. */
interface SpyTool extends CodingTool {
  readonly calls: () => number;
}

/** Build a spy tool for a definition; `execute` is expected never to run here. */
function makeSpyTool(id: string): SpyTool {
  let count = 0;
  return {
    id,
    execute(): Promise<ToolOutput> {
      count += 1;
      return Promise.resolve({ content: "spy-should-not-run" });
    },
    calls: (): number => count,
  };
}

// -----------------------------------------------------------------------------
// Harness
// -----------------------------------------------------------------------------

interface Harness {
  readonly host: ToolHost;
  readonly transport: RecordingTransport;
  readonly spies: ReadonlyMap<string, SpyTool>;
  /** Total number of `execute` invocations across every spy tool. */
  readonly totalExecuteCalls: () => number;
}

/** The enabled built-in definitions (every default-enabled tool). */
function enabledDefinitions(): ToolDefinition[] {
  const registry = new ToolRegistry(
    new ConfigStore(new InMemoryMemento(), new InMemoryMemento(), BUILTIN_TOOL_DEFINITIONS),
  );
  return registry.enabledDefinitions();
}

/** Build a fresh host wired to spy tools for every enabled definition. */
function makeHarness(): Harness {
  const registry = new ToolRegistry(
    new ConfigStore(new InMemoryMemento(), new InMemoryMemento(), BUILTIN_TOOL_DEFINITIONS),
  );
  const transport = new RecordingTransport();
  const spies = new Map<string, SpyTool>();
  for (const def of registry.enabledDefinitions()) {
    spies.set(def.id, makeSpyTool(def.id));
  }
  const createContext = (signal: AbortSignal): ToolContext => ({
    guard: NEVER_CALLED_GUARD,
    profile: undefined,
    signal,
  });
  const host = new ToolHost({
    registry,
    tools: [...spies.values()],
    transport,
    createContext,
  });
  return {
    host,
    transport,
    spies,
    totalExecuteCalls: (): number => {
      let total = 0;
      for (const spy of spies.values()) {
        total += spy.calls();
      }
      return total;
    },
  };
}

// -----------------------------------------------------------------------------
// Schema helpers
// -----------------------------------------------------------------------------

/** The required-field names declared by a tool's object schema. */
function requiredFields(def: ToolDefinition): string[] {
  return [...(def.inputSchema.required ?? [])];
}

/** The described property entries of a tool's object schema. */
function propertyEntries(def: ToolDefinition): Array<[string, JSONSchema]> {
  return Object.entries(def.inputSchema.properties ?? {});
}

/** A schema-valid value for a leaf property type used by the built-in tools. */
function validValue(schema: JSONSchema): unknown {
  if (schema.enum !== undefined && schema.enum.length > 0) {
    return schema.enum[0];
  }
  switch (schema.type) {
    case "string":
      return "valid";
    case "integer":
      return 1;
    case "number":
      return 1.5;
    case "boolean":
      return true;
    case "array":
      return [];
    case "object":
      return {};
    case "null":
      return null;
    default:
      return "valid";
  }
}

/** A value guaranteed to be the WRONG type for a leaf property schema. */
function wrongValue(schema: JSONSchema): unknown {
  // Built-in tool inputs use only string / integer / boolean leaves.
  return schema.type === "string" ? 4242 : "wrong-type";
}

/** Build an object populated with valid values for every required field. */
function validBase(def: ToolDefinition): Record<string, unknown> {
  const base: Record<string, unknown> = {};
  const properties = def.inputSchema.properties ?? {};
  for (const name of requiredFields(def)) {
    base[name] = validValue(properties[name]);
  }
  return base;
}

// -----------------------------------------------------------------------------
// Malformation strategies
// -----------------------------------------------------------------------------

type Strategy = "missing-required" | "wrong-type" | "additional-property";

/** The malformation strategies applicable to a given tool definition. */
function applicableStrategies(def: ToolDefinition): Strategy[] {
  // `additional-property` applies to every object schema with additionalProperties:false.
  const strategies: Strategy[] = ["additional-property"];
  // `wrong-type` needs a described property to corrupt; skip it for empty schemas
  // (e.g. get_workspace_context, which takes no input).
  if (propertyEntries(def).length > 0) {
    strategies.push("wrong-type");
  }
  if (requiredFields(def).length > 0) {
    strategies.push("missing-required");
  }
  return strategies;
}

interface Malformed {
  readonly input: unknown;
  /** The field the validator is expected to name as offending. */
  readonly expectedField: string;
}

/**
 * Build a malformed input for `def` under `strategy` that is guaranteed to fail schema
 * validation at a single, known field. `propIndex` selects which property to corrupt
 * (for `wrong-type`) or omit (for `missing-required`); `extraSeed` names the unexpected
 * key (for `additional-property`).
 */
function buildMalformed(
  def: ToolDefinition,
  strategy: Strategy,
  propIndex: number,
  extraSeed: number,
): Malformed {
  const properties = def.inputSchema.properties ?? {};
  switch (strategy) {
    case "missing-required": {
      const required = requiredFields(def);
      const target = required[propIndex % required.length];
      const input = validBase(def);
      delete input[target];
      return { input, expectedField: target };
    }
    case "wrong-type": {
      const entries = propertyEntries(def);
      const [name, schema] = entries[propIndex % entries.length];
      const input = validBase(def);
      input[name] = wrongValue(schema);
      return { input, expectedField: name };
    }
    case "additional-property": {
      const extraKey = `__extra_${extraSeed}`;
      const input = validBase(def);
      input[extraKey] = "unexpected";
      return { input, expectedField: extraKey };
    }
    default: {
      const exhaustive: never = strategy;
      throw new Error(`Unhandled strategy: ${String(exhaustive)}`);
    }
  }
}

/** Extract the single `tool.result` frame the host sent for a call. */
function resultFrame(transport: RecordingTransport): ToolResultFrame {
  const frame = transport.last();
  assert.ok(frame !== undefined, "host must send a frame");
  assert.strictEqual(frame.type, "tool.result", "host must send a tool.result frame");
  return frame as ToolResultFrame;
}

// -----------------------------------------------------------------------------
// Property 2
// -----------------------------------------------------------------------------

describe("Property 2: malformed input is rejected before execution", () => {
  const enabled = enabledDefinitions();

  it("returns a validation error naming the offending field and never invokes execute", async () => {
    assert.ok(enabled.length > 0, "there must be at least one enabled tool");

    await fc.assert(
      fc.asyncProperty(
        fc
          .constantFrom(...enabled)
          .chain((def) =>
            fc.record({
              def: fc.constant(def),
              strategy: fc.constantFrom(...applicableStrategies(def)),
              propIndex: fc.nat({ max: 32 }),
              extraSeed: fc.nat({ max: 1_000_000 }),
              correlationId: fc.string({ minLength: 1, maxLength: 24 }),
            }),
          ),
        async ({ def, strategy, propIndex, extraSeed, correlationId }) => {
          const harness = makeHarness();
          const { input, expectedField } = buildMalformed(
            def,
            strategy,
            propIndex,
            extraSeed,
          );

          const frame: ToolCallFrame = {
            type: "tool.call",
            id: correlationId,
            data: { tool: def.id, input },
          };

          await harness.host.handleCall(frame);

          // A validation error naming the offending field is returned (R1.5, R6.8).
          const result = resultFrame(harness.transport);
          assert.strictEqual(
            result.id,
            correlationId,
            "the result must echo the originating correlation id",
          );
          assert.strictEqual(result.data.ok, false, "the result must be a failure");
          if (result.data.ok === false) {
            assert.strictEqual(
              result.data.error.kind,
              "validation",
              `expected a validation error for ${def.id}/${strategy}`,
            );
            assert.strictEqual(
              result.data.error.field,
              expectedField,
              `validation error must name the offending field for ${def.id}/${strategy}`,
            );
          }

          // The tool's execute was NEVER invoked (R6.7): validation precedes dispatch.
          assert.strictEqual(
            harness.totalExecuteCalls(),
            0,
            "no tool execute may run when input fails validation",
          );
        },
      ),
    );
  });

  it("rejects non-object top-level inputs without invoking execute", async () => {
    assert.ok(enabled.length > 0, "there must be at least one enabled tool");

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...enabled),
        fc.oneof(
          fc.string(),
          fc.integer(),
          fc.boolean(),
          fc.constant(null),
          fc.array(fc.integer(), { maxLength: 4 }),
        ),
        async (def, input) => {
          const harness = makeHarness();
          const frame: ToolCallFrame = {
            type: "tool.call",
            id: "corr-nonobject",
            data: { tool: def.id, input },
          };

          await harness.host.handleCall(frame);

          const result = resultFrame(harness.transport);
          assert.strictEqual(result.data.ok, false);
          if (result.data.ok === false) {
            assert.strictEqual(
              result.data.error.kind,
              "validation",
              `non-object input must fail validation for ${def.id}`,
            );
          }
          assert.strictEqual(
            harness.totalExecuteCalls(),
            0,
            "no tool execute may run for a non-object input",
          );
        },
      ),
    );
  });
});
