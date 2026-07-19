// Feature: agent-tools-and-settings, Property 3: Unknown tool identifiers are
// rejected without side effects.
//
// For any identifier that is NOT present in the ToolRegistry, dispatching a
// `tool.call` for that identifier returns an `unknown-tool` error, performs no
// workspace action (no Coding_Tool's `execute` runs), and leaves the WebSocket
// connection open. The correlation id from the originating `tool.call` is echoed
// on the returned `tool.result`.
//
// The property is checked over randomly generated correlation ids, unknown tool
// ids (constrained to non-empty strings absent from the registry so the
// malformed-request path is not taken), and arbitrary untrusted input payloads.
//
// This is a pure-module test: it drives `ToolHost` with a fake
// `ToolFrameTransport` and a fake `createContext`, so nothing here couples to the
// VS Code host. Run via the Node/Mocha suite: `npm test -- --grep "Property 3"`.
//
// Validates: Requirements 1.6, 3.4
import * as assert from "assert";
import * as fc from "fast-check";

import { ConfigStore, type MementoLike } from "./configStore";
import { ToolHost, type ToolFrameTransport } from "./host";
import { BUILTIN_TOOL_DEFINITIONS, ToolRegistry } from "./registry";
import type {
  CodingTool,
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
 * never torn down on an unknown-tool rejection (Requirement 3.4).
 */
class RecordingTransport implements ToolFrameTransport {
  public readonly sent: Array<ToolRegisterFrame | ToolResultFrame> = [];
  private open = true;

  public send(frame: ToolRegisterFrame | ToolResultFrame): void {
    this.sent.push(frame);
  }

  public isOpen(): boolean {
    return this.open;
  }

  /** Test-only helper to simulate the socket being closed (unused in the happy path). */
  public close(): void {
    this.open = false;
  }
}

/**
 * A Coding_Tool whose `execute` records that it was invoked. Any invocation of one
 * of these while dispatching an unknown-tool call would be a workspace side effect,
 * which Property 3 forbids.
 */
class RecordingTool implements CodingTool {
  public executed = false;

  public constructor(public readonly id: string) {}

  public async execute(): Promise<never> {
    this.executed = true;
    throw new Error(`RecordingTool '${this.id}' must not be executed for an unknown-tool call.`);
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
// Property 3
// -----------------------------------------------------------------------------

describe("Property 3: unknown tool identifiers are rejected without side effects", () => {
  const knownIds = new Set(BUILTIN_TOOL_DEFINITIONS.map((def) => def.id));

  /** Non-empty identifiers that are absent from the registry. */
  const unknownToolId = fc
    .string({ minLength: 1, maxLength: 40 })
    .filter((id) => id.length > 0 && !knownIds.has(id));

  it("returns an unknown-tool error, runs no tool, and keeps the connection open", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 40 }), // correlation id (non-empty ⇒ not malformed)
        unknownToolId,
        fc.anything(), // arbitrary untrusted input payload
        async (correlationId, toolId, input) => {
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

          // Sanity: the generated id really is unknown to the registry.
          assert.strictEqual(
            registry.get(toolId),
            undefined,
            `generated id '${toolId}' must be absent from the registry`,
          );

          await host.handleCall({
            type: "tool.call",
            id: correlationId,
            data: { tool: toolId, input },
          });

          // Exactly one frame — the tool.result — was emitted.
          assert.strictEqual(
            transport.sent.length,
            1,
            "exactly one tool.result frame should be sent",
          );

          const frame = transport.sent[0] as ToolResultFrame;
          assert.strictEqual(frame.type, "tool.result");

          // Correlation id echoed back (Requirement 3.4 keeps the RPC coherent).
          assert.strictEqual(
            frame.id,
            correlationId,
            "the tool.result must echo the originating correlation id",
          );

          // The result is an unknown-tool error (Requirement 1.6, 3.4).
          assert.strictEqual(frame.data.ok, false);
          if (frame.data.ok === false) {
            assert.strictEqual(frame.data.error.kind, "unknown-tool");
          }

          // No Coding_Tool executed ⇒ no workspace action.
          assert.ok(
            tools.every((tool) => !tool.executed),
            "no tool's execute should have run for an unknown-tool call",
          );

          // No in-flight controller was left registered.
          assert.strictEqual(
            host.inflight.size,
            0,
            "no in-flight call should remain after an unknown-tool rejection",
          );

          // The socket is still open (Requirement 3.4: connection kept open).
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
