// Feature: agent-tools-and-settings, Property 9: Execution errors are typed and
// keep the connection open.
//
// For any tool whose execution raises, `ToolHost` returns a `tool.result` with a
// typed error and keeps the WebSocket connection open (Requirement 3.6). Two throw
// channels are exercised:
//
//   - A thrown `ToolExecutionError` carries a typed `ToolError` (any `kind` in the
//     taxonomy); the host echoes that `ToolError` unchanged into the `tool.result`.
//   - Any other throw — a plain `Error`, a subclass, or a non-`Error` value — is
//     wrapped into a generic `execution` error whose `message` is the `Error.message`
//     for `Error` instances and `String(value)` otherwise.
//
// In every case exactly one `tool.result` frame is emitted, its `ok` flag is `false`,
// and the transport is never torn down (it remains open). This is a pure-module
// property test: it drives `ToolHost` through a fake `ToolFrameTransport` and a fake
// `createContext`, and never imports `vscode`.
//
// Validates: Requirements 3.6
import * as assert from "assert";

import * as fc from "fast-check";

import { ToolExecutionError } from "./errors";
import { ToolHost, type ToolFrameTransport } from "./host";
import type { ToolRegistry } from "./registry";
import type {
  CodingTool,
  JSONSchema,
  ToolCallFrame,
  ToolContext,
  ToolDefinition,
  ToolError,
  ToolOutput,
  ToolRegisterFrame,
  ToolResultFrame,
  WorkspacePathGuard,
} from "./types";

// -----------------------------------------------------------------------------
// Test doubles
// -----------------------------------------------------------------------------

/** Wire-envelope version stamped on the frames the host emits. */
const FRAME_VERSION = 1;

/** Id of the single throwing tool under test. */
const THROWER_ID = "thrower";

/**
 * A recording transport that captures every frame the host sends and models the
 * WebSocket open/closed state. The host has no way to close the socket, so `isOpen`
 * stays `true`; the property asserts this to confirm no tear-down occurs (R3.6).
 */
class RecordingTransport implements ToolFrameTransport {
  public readonly sent: (ToolRegisterFrame | ToolResultFrame)[] = [];
  private open = true;

  public send(frame: ToolRegisterFrame | ToolResultFrame): void {
    this.sent.push(frame);
  }

  public isOpen(): boolean {
    return this.open;
  }

  /** The `tool.result` frames captured so far, in send order. */
  public results(): ToolResultFrame[] {
    return this.sent.filter(
      (frame): frame is ToolResultFrame => frame.type === "tool.result",
    );
  }
}

/** Input schema for the throwing tool: an object with a required string marker. */
const THROWER_SCHEMA: JSONSchema = {
  type: "object",
  properties: { marker: { type: "string" } },
  required: ["marker"],
  additionalProperties: false,
};

/** The throwing tool's definition, advertised as enabled by the fake registry. */
const THROWER_DEFINITION: ToolDefinition = {
  id: THROWER_ID,
  displayName: "Thrower",
  description: "Always throws to exercise typed error mapping.",
  inputSchema: THROWER_SCHEMA,
  category: "file",
  classification: "read-only",
  defaultEnabled: true,
};

/**
 * A minimal stand-in exposing only the `ToolRegistry` surface `ToolHost` consumes:
 * `get`, `isEnabled`, and `enabledDefinitions`. Cast to `ToolRegistry` for injection
 * so the test stays decoupled from `vscode` (the real registry imports it).
 */
function makeFakeRegistry(): ToolRegistry {
  const fake = {
    get(id: string): ToolDefinition | undefined {
      return id === THROWER_ID ? THROWER_DEFINITION : undefined;
    },
    isEnabled(id: string): boolean {
      return id === THROWER_ID;
    },
    enabledDefinitions(): ToolDefinition[] {
      return [THROWER_DEFINITION];
    },
  };
  return fake as unknown as ToolRegistry;
}

/** A fake path guard; the throwing tool never touches the workspace. */
const fakeGuard: WorkspacePathGuard = {
  roots(): string[] {
    return [];
  },
  resolve(): never {
    throw new Error("path guard is not used in this test");
  },
};

/** Build the per-call {@link ToolContext} without touching `vscode`. */
function createContext(signal: AbortSignal): ToolContext {
  return { guard: fakeGuard, profile: undefined, signal };
}

/** A tool whose `execute` always throws the value produced by `makeThrow`. */
function makeThrowingTool(makeThrow: () => unknown): CodingTool {
  return {
    id: THROWER_ID,
    async execute(_input: unknown, _ctx: ToolContext): Promise<ToolOutput> {
      throw makeThrow();
    },
  };
}

// -----------------------------------------------------------------------------
// Throw-scenario generators
// -----------------------------------------------------------------------------

/**
 * A planned throw: the value the tool throws (`makeThrow`) paired with the typed
 * error the host is expected to surface in the resulting `tool.result` (`expected`).
 */
interface ThrowScenario {
  readonly makeThrow: () => unknown;
  readonly expected: ToolError;
}

/** The complete `ToolError` `kind` taxonomy a `ToolExecutionError` may carry. */
const TOOL_ERROR_KINDS: readonly ToolError["kind"][] = [
  "validation",
  "unknown-tool",
  "tool-disabled",
  "malformed-request",
  "out-of-scope",
  "no-workspace",
  "rejected",
  "timeout",
  "execution",
  "activation-failure",
];

/**
 * Scenario 1 — a thrown `ToolExecutionError` carrying a generated `ToolError`. The
 * host must echo that exact `ToolError` (its `kind`, `message`, and any optional
 * `field`/`segment`) unchanged into the `tool.result`.
 */
const typedScenarioArb: fc.Arbitrary<ThrowScenario> = fc
  .record(
    {
      kind: fc.constantFrom(...TOOL_ERROR_KINDS),
      message: fc.string(),
      field: fc.option(fc.string(), { nil: undefined }),
      segment: fc.option(fc.string(), { nil: undefined }),
    },
    { requiredKeys: ["kind", "message"] },
  )
  .map((raw): ThrowScenario => {
    const expected: ToolError = {
      kind: raw.kind,
      message: raw.message,
      ...(raw.field !== undefined ? { field: raw.field } : {}),
      ...(raw.segment !== undefined ? { segment: raw.segment } : {}),
    };
    return {
      makeThrow: (): unknown => new ToolExecutionError(expected),
      expected,
    };
  });

/**
 * Scenario 2 — a thrown ordinary `Error` (or subclass). The host wraps it into a
 * generic `execution` error whose `message` is the `Error.message`.
 */
const plainErrorScenarioArb: fc.Arbitrary<ThrowScenario> = fc
  .record({
    message: fc.string(),
    subclass: fc.constantFrom("Error", "TypeError", "RangeError"),
  })
  .map(({ message, subclass }): ThrowScenario => {
    const build = (): Error => {
      switch (subclass) {
        case "TypeError":
          return new TypeError(message);
        case "RangeError":
          return new RangeError(message);
        default:
          return new Error(message);
      }
    };
    return {
      makeThrow: (): unknown => build(),
      expected: { kind: "execution", message },
    };
  });

/**
 * Scenario 3 — a thrown non-`Error` value (string, number, boolean, null, or plain
 * object). The host wraps it into a generic `execution` error whose `message` is
 * `String(value)`. `makeThrow` returns the value (the tool re-throws it at execution
 * time) rather than throwing during generation.
 */
const nonErrorScenarioArb: fc.Arbitrary<ThrowScenario> = fc
  .oneof(
    fc.string(),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    // A normal object literal (with `Object.prototype`) so `String(value)` yields
    // the stable "[object Object]" rather than throwing on a null-prototype value.
    fc.integer().map((code): unknown => ({ code })),
  )
  .map((value): ThrowScenario => ({
    makeThrow: (): unknown => value,
    expected: { kind: "execution", message: String(value) },
  }));

/** The union of all throw scenarios exercised by the property. */
const scenarioArb: fc.Arbitrary<ThrowScenario> = fc.oneof(
  typedScenarioArb,
  plainErrorScenarioArb,
  nonErrorScenarioArb,
);

/** Build the `tool.call` frame for the throwing tool with a valid marker input. */
function toFrame(correlationId: string, marker: string): ToolCallFrame {
  return {
    v: FRAME_VERSION,
    type: "tool.call",
    id: correlationId,
    data: { tool: THROWER_ID, input: { marker } },
  };
}

// -----------------------------------------------------------------------------
// Property 9
// -----------------------------------------------------------------------------

describe("Property 9: execution errors are typed and keep the connection open", () => {
  it("returns a typed error result and leaves the transport open whenever a tool raises (Requirement 3.6)", async () => {
    await fc.assert(
      fc.asyncProperty(
        scenarioArb,
        fc.string({ minLength: 1, maxLength: 12 }),
        fc.string(),
        async (scenario, correlationId, marker) => {
          const transport = new RecordingTransport();
          const host = new ToolHost({
            registry: makeFakeRegistry(),
            tools: [makeThrowingTool(scenario.makeThrow)],
            transport,
            createContext,
          });

          await host.handleCall(toFrame(correlationId, marker));

          // Exactly one tool.result frame is emitted, echoing the correlation id.
          const results = transport.results();
          assert.strictEqual(
            results.length,
            1,
            "a raising tool must produce exactly one tool.result",
          );
          const frame = results[0];
          assert.strictEqual(frame.type, "tool.result");
          assert.strictEqual(frame.id, correlationId);

          // The result is a typed failure matching the expected ToolError.
          assert.ok(!frame.data.ok, "a raising tool must yield a failure result");
          assert.deepStrictEqual(frame.data.error, scenario.expected);

          // The connection is kept open — the host never tears down the transport.
          assert.strictEqual(
            transport.isOpen(),
            true,
            "the WebSocket connection must remain open after a tool raises",
          );

          // No call remains in flight once the result has been delivered.
          assert.strictEqual(
            host.inflight.size,
            0,
            "no calls should remain in flight",
          );
        },
      ),
    );
  });
});
