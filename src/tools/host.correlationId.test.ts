// Feature: agent-tools-and-settings, Property 6: Every result preserves its
// originating correlation id.
//
// For any set of `tool.call` frames with distinct correlation ids — whether they
// succeed, fail (execution error), reference an unknown tool, reference a disabled
// tool, or carry input that fails schema validation — and completing in ANY order,
// each resulting `tool.result` frame carries the correlation id of its originating
// `tool.call`, and the outcome delivered under that id is the outcome produced for
// THAT call (so concurrent, interleaved calls never cross wires).
//
// This is a pure-module property test that runs outside the VS Code extension host.
// It drives `ToolHost` through a fake `ToolFrameTransport` that records the frames it
// sends and a fake `createContext`; it does not import `vscode`.
//
// Validates: Requirements 3.2, 3.8, 3.9
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

/** The five outcome categories a well-formed call can resolve to. */
type Scenario = "success" | "execution" | "unknown" | "disabled" | "validation";

/** A recording transport that captures every frame the host sends. */
class RecordingTransport implements ToolFrameTransport {
  public readonly sent: (ToolRegisterFrame | ToolResultFrame)[] = [];

  public send(frame: ToolRegisterFrame | ToolResultFrame): void {
    this.sent.push(frame);
  }

  public isOpen(): boolean {
    return true;
  }

  /** The `tool.result` frames captured so far, in send order. */
  public results(): ToolResultFrame[] {
    return this.sent.filter(
      (frame): frame is ToolResultFrame => frame.type === "tool.result",
    );
  }
}

/** The input schema shared by the echo/boom tools used in this test. */
const ECHO_SCHEMA: JSONSchema = {
  type: "object",
  properties: {
    marker: { type: "string" },
    delayMs: { type: "integer" },
  },
  required: ["marker"],
  additionalProperties: false,
};

/** Sleep for `ms` milliseconds, yielding the event loop so calls interleave. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Read the `marker`/`delayMs` fields from a validated echo/boom input. */
function readEchoInput(input: unknown): { marker: string; delayMs: number } {
  const record = input as { marker: string; delayMs?: number };
  return { marker: record.marker, delayMs: record.delayMs ?? 0 };
}

/**
 * A tool that echoes its `marker` back as the output content after an optional
 * delay. The delay lets concurrent calls resolve out of submission order so the
 * property genuinely exercises interleaving.
 */
const echoTool: CodingTool = {
  id: "echo",
  async execute(input: unknown): Promise<ToolOutput> {
    const { marker, delayMs } = readEchoInput(input);
    await delay(delayMs);
    return { content: marker };
  },
};

/**
 * A tool that always throws a typed execution error carrying its `marker`, after an
 * optional delay. The host maps this to an `execution` `tool.result`.
 */
const boomTool: CodingTool = {
  id: "boom",
  async execute(input: unknown): Promise<ToolOutput> {
    const { marker, delayMs } = readEchoInput(input);
    await delay(delayMs);
    throw new ToolExecutionError({ kind: "execution", message: marker });
  },
};

/** Definitions the fake registry advertises: echo + boom enabled, disabled_echo off. */
const DEFINITIONS: Readonly<Record<string, ToolDefinition>> = {
  echo: {
    id: "echo",
    displayName: "Echo",
    description: "Echoes its marker.",
    inputSchema: ECHO_SCHEMA,
    category: "file",
    classification: "read-only",
    defaultEnabled: true,
  },
  boom: {
    id: "boom",
    displayName: "Boom",
    description: "Always throws.",
    inputSchema: ECHO_SCHEMA,
    category: "file",
    classification: "read-only",
    defaultEnabled: true,
  },
  disabled_echo: {
    id: "disabled_echo",
    displayName: "Disabled Echo",
    description: "Present but disabled.",
    inputSchema: ECHO_SCHEMA,
    category: "file",
    classification: "read-only",
    defaultEnabled: false,
  },
};

/** Which tool ids report as enabled. */
const ENABLED_IDS: ReadonlySet<string> = new Set(["echo", "boom"]);

/**
 * A minimal stand-in exposing only the `ToolRegistry` surface `ToolHost` consumes:
 * `get`, `isEnabled`, and `enabledDefinitions`. Cast to `ToolRegistry` for injection so
 * the test stays decoupled from `vscode` (the real registry imports it).
 */
function makeFakeRegistry(): ToolRegistry {
  const fake = {
    get(id: string): ToolDefinition | undefined {
      return DEFINITIONS[id];
    },
    isEnabled(id: string): boolean {
      return ENABLED_IDS.has(id);
    },
    enabledDefinitions(): ToolDefinition[] {
      return [...ENABLED_IDS].map((id) => DEFINITIONS[id]);
    },
  };
  return fake as unknown as ToolRegistry;
}

/** A fake path guard; the echo/boom tools never touch it. */
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

// -----------------------------------------------------------------------------
// Generators
// -----------------------------------------------------------------------------

/** A single planned call: a distinct correlation id, an outcome, and a delay. */
interface PlannedCall {
  readonly id: string;
  readonly scenario: Scenario;
  readonly delayMs: number;
}

/**
 * A batch of calls with pairwise-distinct, non-empty correlation ids. Distinctness is
 * essential: the property's cross-wiring check keys results by correlation id.
 */
const callsArb: fc.Arbitrary<PlannedCall[]> = fc.uniqueArray(
  fc.record({
    id: fc.string({ minLength: 1, maxLength: 12 }),
    scenario: fc.constantFrom<Scenario>(
      "success",
      "execution",
      "unknown",
      "disabled",
      "validation",
    ),
    delayMs: fc.integer({ min: 0, max: 4 }),
  }),
  { selector: (call) => call.id, minLength: 1, maxLength: 8 },
);

/** Map a planned call to the `tool.call` frame the host will receive. */
function toFrame(call: PlannedCall): ToolCallFrame {
  const toolByScenario: Record<Scenario, string> = {
    success: "echo",
    execution: "boom",
    unknown: "ghost", // absent from the registry
    disabled: "disabled_echo",
    validation: "echo",
  };
  const input =
    call.scenario === "validation"
      ? { marker: 42 } // wrong type for `marker` → schema validation failure
      : { marker: call.id, delayMs: call.delayMs };
  return {
    v: FRAME_VERSION,
    type: "tool.call",
    id: call.id,
    data: { tool: toolByScenario[call.scenario], input },
  };
}

/** Assert a result frame carries the outcome expected for its originating scenario. */
function assertOutcome(frame: ToolResultFrame, call: PlannedCall): void {
  const result = frame.data;
  switch (call.scenario) {
    case "success":
      assert.ok(result.ok, `call ${call.id} should have succeeded`);
      // The output is the marker for THIS call — proof the dispatch did not cross wires.
      assert.strictEqual(result.output.content, call.id);
      break;
    case "execution":
      assert.ok(!result.ok, `call ${call.id} should have failed`);
      assert.strictEqual(result.error.kind, "execution");
      // The error message carries this call's marker — again proving no cross-wiring.
      assert.strictEqual(result.error.message, call.id);
      break;
    case "unknown":
      assert.ok(!result.ok, `call ${call.id} should have failed`);
      assert.strictEqual(result.error.kind, "unknown-tool");
      break;
    case "disabled":
      assert.ok(!result.ok, `call ${call.id} should have failed`);
      assert.strictEqual(result.error.kind, "tool-disabled");
      break;
    case "validation":
      assert.ok(!result.ok, `call ${call.id} should have failed`);
      assert.strictEqual(result.error.kind, "validation");
      break;
    default: {
      const exhaustive: never = call.scenario;
      throw new Error(`unhandled scenario: ${String(exhaustive)}`);
    }
  }
}

// -----------------------------------------------------------------------------
// Property 6
// -----------------------------------------------------------------------------

describe("Property 6: every result preserves its originating correlation id", () => {
  it("echoes each call's correlation id on its result under concurrent dispatch", async () => {
    await fc.assert(
      fc.asyncProperty(callsArb, async (calls) => {
        const transport = new RecordingTransport();
        const host = new ToolHost({
          registry: makeFakeRegistry(),
          tools: [echoTool, boomTool],
          transport,
          createContext,
        });

        // Dispatch every call concurrently; delays make them resolve out of order.
        await Promise.all(calls.map((call) => host.handleCall(toFrame(call))));

        const results = transport.results();

        // Exactly one result per call — no drops, no duplicates.
        assert.strictEqual(
          results.length,
          calls.length,
          "each call must produce exactly one tool.result",
        );

        const byId = new Map(results.map((frame) => [frame.id, frame]));
        assert.strictEqual(
          byId.size,
          results.length,
          "result correlation ids must be pairwise distinct",
        );

        for (const call of calls) {
          const frame = byId.get(call.id);
          assert.ok(frame, `missing result for correlation id '${call.id}'`);
          // R3.2 / R3.9: the result echoes the originating correlation id.
          assert.strictEqual(frame.id, call.id);
          assert.strictEqual(frame.type, "tool.result");
          // R3.8: the outcome under this id is THIS call's outcome (no crossed wires).
          assertOutcome(frame, call);
        }

        // Every in-flight controller is cleared once all calls settle.
        assert.strictEqual(host.inflight.size, 0, "no calls should remain in flight");
      }),
    );
  });
});
