// Feature: agent-tools-and-settings, Property 7: Malformed request frames are
// rejected and keep the connection open.
//
// For any `tool.call` frame missing a correlation identifier and/or a tool
// identifier (each either absent or an empty string), `ToolHost.handleCall`
// returns a single `tool.result` carrying a `malformed-request` error, invokes no
// Coding_Tool, leaves no in-flight call registered, and keeps the WebSocket
// connection open (Requirement 3.3).
//
// This is a pure-module test: it drives `ToolHost` through a fake
// `ToolFrameTransport` and a fake `createContext`, so nothing here couples to the
// VS Code host. Run via the Node/Mocha suite: `npm test -- --grep "Property 7"`.
//
// Validates: Requirements 3.3
import * as assert from "assert";
import * as fc from "fast-check";

import { ConfigStore, type MementoLike } from "./configStore";
import { ToolHost, type ToolFrameTransport } from "./host";
import { BUILTIN_TOOL_DEFINITIONS, ToolRegistry } from "./registry";
import type {
  CodingTool,
  ToolCallFrame,
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

/**
 * A fake transport that records every frame sent and reports the socket as open.
 * `isOpen` returning `true` throughout lets the test assert the connection is
 * never torn down on a malformed-request rejection (Requirement 3.3).
 */
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
 * A Coding_Tool whose `execute` records that it was invoked. Any invocation while
 * dispatching a malformed frame would be a workspace side effect, which Property 7
 * forbids — a malformed frame must be rejected before any tool runs.
 */
class RecordingTool implements CodingTool {
  public executed = false;

  public constructor(public readonly id: string) {}

  public async execute(): Promise<never> {
    this.executed = true;
    throw new Error(
      `RecordingTool '${this.id}' must not be executed for a malformed request.`,
    );
  }
}

/** Build a ToolRegistry over the ten built-in definitions with empty storage. */
function makeRegistry(): ToolRegistry {
  return new ToolRegistry(
    new ConfigStore(
      new InMemoryMemento(),
      new InMemoryMemento(),
      BUILTIN_TOOL_DEFINITIONS,
    ),
  );
}

/** Build a fake ToolContext; never actually used since no tool executes. */
function makeContext(signal: AbortSignal): ToolContext {
  return {
    guard: {
      roots: (): string[] => [],
      resolve: (): { ok: false; error: "no-workspace" } => ({
        ok: false,
        error: "no-workspace",
      }),
    },
    profile: undefined,
    signal,
  };
}

// -----------------------------------------------------------------------------
// Generators
// -----------------------------------------------------------------------------

/** How an identifier field appears on a generated frame. */
type FieldKind = "valid" | "empty" | "missing";

/** A generated identifier field with the kind that produced it. */
interface GeneratedField {
  readonly kind: FieldKind;
  readonly value: string | undefined;
}

/**
 * An identifier field that is either present and non-empty (`valid`), present but
 * empty (`empty`), or entirely absent (`missing`). Empty and missing are the two
 * shapes the host treats as malformed (Requirement 3.3).
 */
const identifierField: fc.Arbitrary<GeneratedField> = fc.oneof(
  fc
    .string({ minLength: 1, maxLength: 20 })
    .map((value) => ({ kind: "valid" as const, value })),
  fc.constant({ kind: "empty" as const, value: "" }),
  fc.constant({ kind: "missing" as const, value: undefined }),
);

/**
 * A malformed pair: a correlation-id field and a tool-id field where at least one
 * is empty or missing. Pairs where BOTH fields are valid are filtered out, since
 * those describe a well-formed frame handled by other properties.
 */
const malformedPair: fc.Arbitrary<{
  readonly idField: GeneratedField;
  readonly toolField: GeneratedField;
}> = fc
  .record({ idField: identifierField, toolField: identifierField })
  .filter(
    ({ idField, toolField }) =>
      idField.kind !== "valid" || toolField.kind !== "valid",
  );

/**
 * Construct a `tool.call` frame from the generated fields, omitting the correlation
 * id and/or the tool id when their kind is `missing`. The shape is cast to
 * {@link ToolCallFrame} because malformed frames deliberately violate the
 * well-formed frame contract the type describes.
 */
function buildFrame(
  idField: GeneratedField,
  toolField: GeneratedField,
  input: unknown,
): ToolCallFrame {
  const frame: Record<string, unknown> = { v: 1, type: "tool.call" };
  if (idField.kind !== "missing") {
    frame.id = idField.value;
  }
  const data: Record<string, unknown> = { input };
  if (toolField.kind !== "missing") {
    data.tool = toolField.value;
  }
  frame.data = data;
  return frame as unknown as ToolCallFrame;
}

// -----------------------------------------------------------------------------
// Property 7
// -----------------------------------------------------------------------------

describe("Property 7: malformed request frames are rejected and keep the connection open", () => {
  it("returns a malformed-request error, runs no tool, and keeps the connection open", async () => {
    await fc.assert(
      fc.asyncProperty(
        malformedPair,
        fc.anything(), // arbitrary untrusted input payload
        async ({ idField, toolField }, input) => {
          const registry = makeRegistry();
          const transport = new RecordingTransport();
          const tools = BUILTIN_TOOL_DEFINITIONS.map(
            (def) => new RecordingTool(def.id),
          );

          const host = new ToolHost({
            registry,
            tools,
            transport,
            createContext: makeContext,
          });

          await host.handleCall(buildFrame(idField, toolField, input));

          // Exactly one frame — the tool.result — was emitted.
          assert.strictEqual(
            transport.sent.length,
            1,
            "exactly one tool.result frame should be sent",
          );

          const frame = transport.sent[0] as ToolResultFrame;
          assert.strictEqual(frame.type, "tool.result");

          // The result is a malformed-request error (Requirement 3.3).
          assert.strictEqual(frame.data.ok, false);
          if (frame.data.ok === false) {
            assert.strictEqual(frame.data.error.kind, "malformed-request");
          }

          // No Coding_Tool executed ⇒ no workspace action was performed.
          assert.ok(
            tools.every((tool) => !tool.executed),
            "no tool's execute should have run for a malformed request",
          );

          // No in-flight controller was left registered.
          assert.strictEqual(
            host.inflight.size,
            0,
            "no in-flight call should remain after a malformed-request rejection",
          );

          // The socket is still open (Requirement 3.3: connection kept open).
          assert.strictEqual(
            transport.isOpen(),
            true,
            "the WebSocket connection must remain open",
          );
        },
      ),
    );
  });
});
