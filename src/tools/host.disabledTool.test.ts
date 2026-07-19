// Feature: agent-tools-and-settings, Property 8: Disabled tools are rejected and
// keep the connection open.
//
// For any tool that is PRESENT in the ToolRegistry but currently DISABLED, a
// `tool.call` for it returns a `tool-disabled` error, executes nothing (no
// Coding_Tool's `execute` runs, leaving the workspace unchanged), and leaves the
// WebSocket connection open. The correlation id from the originating `tool.call`
// is echoed on the returned `tool.result`.
//
// The property is checked over randomly generated correlation ids, a target tool
// drawn from the built-in catalogue that the test disables in the registry, an
// additional randomly-disabled subset (so the disabled set varies), and arbitrary
// untrusted input payloads. The disabled check precedes schema validation in the
// host, so the input shape is irrelevant to the outcome.
//
// This is a pure-module test: it drives `ToolHost` with a fake `ToolFrameTransport`
// and a fake `createContext`, backed by an in-memory `ConfigStore` Memento double, so
// nothing here couples to the VS Code host. Run via the Node/Mocha suite:
// `npm test -- --grep "Property 8"`.
//
// Validates: Requirements 3.5
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
 * `isOpen` returning `true` throughout lets the test assert the connection is never
 * torn down on a tool-disabled rejection (Requirement 3.5).
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
 * A Coding_Tool whose `execute` records that it was invoked and throws. Any invocation
 * while dispatching a disabled-tool call would be a forbidden workspace side effect,
 * which Property 8 rules out.
 */
class RecordingTool implements CodingTool {
  public executed = false;

  public constructor(public readonly id: string) {}

  public async execute(): Promise<never> {
    this.executed = true;
    throw new Error(
      `RecordingTool '${this.id}' must not be executed for a disabled-tool call.`,
    );
  }
}

/** Build a fresh ToolRegistry over the ten built-in definitions with empty storage. */
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
// Property 8
// -----------------------------------------------------------------------------

describe("Property 8: disabled tools are rejected and keep the connection open", () => {
  const allIds = BUILTIN_TOOL_DEFINITIONS.map((def) => def.id);

  it("returns a tool-disabled error, runs no tool, and keeps the connection open", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 40 }), // correlation id (non-empty ⇒ not malformed)
        fc.constantFrom(...allIds), // the target tool to disable and call
        fc.subarray(allIds), // an additional subset to disable, for variety
        fc.anything(), // arbitrary untrusted input payload (irrelevant: disabled precedes validation)
        async (correlationId, targetId, extraDisabled, input) => {
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

          // Disable the target and any additionally-selected tools.
          for (const id of new Set([targetId, ...extraDisabled])) {
            await registry.setEnabled(id, false);
          }

          // Precondition: the target is present in the registry but disabled.
          assert.notStrictEqual(
            registry.get(targetId),
            undefined,
            `target '${targetId}' must be present in the registry`,
          );
          assert.strictEqual(
            registry.isEnabled(targetId),
            false,
            `target '${targetId}' must be disabled`,
          );

          // A registration triggered by the setEnabled edits may have been sent;
          // isolate the result-frame assertions to the tool.result frames only.
          const priorResults = transport.sent.filter(
            (frame): frame is ToolResultFrame => frame.type === "tool.result",
          ).length;

          await host.handleCall({
            type: "tool.call",
            id: correlationId,
            data: { tool: targetId, input },
          });

          const results = transport.sent.filter(
            (frame): frame is ToolResultFrame => frame.type === "tool.result",
          );

          // Exactly one new tool.result frame was emitted for this call.
          assert.strictEqual(
            results.length,
            priorResults + 1,
            "exactly one tool.result frame should be sent for the call",
          );

          const frame = results[results.length - 1];

          // Correlation id echoed back (Requirement 3.5 keeps the RPC coherent).
          assert.strictEqual(
            frame.id,
            correlationId,
            "the tool.result must echo the originating correlation id",
          );

          // The result is a tool-disabled error (Requirement 3.5).
          assert.strictEqual(frame.data.ok, false);
          if (frame.data.ok === false) {
            assert.strictEqual(frame.data.error.kind, "tool-disabled");
          }

          // No Coding_Tool executed ⇒ no workspace action.
          assert.ok(
            tools.every((tool) => !tool.executed),
            "no tool's execute should have run for a disabled-tool call",
          );

          // No in-flight controller was left registered.
          assert.strictEqual(
            host.inflight.size,
            0,
            "no in-flight call should remain after a disabled-tool rejection",
          );

          // The socket is still open (Requirement 3.5: connection kept open).
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
