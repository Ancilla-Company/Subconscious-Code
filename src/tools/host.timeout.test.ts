// Feature: agent-tools-and-settings, Property 10: Calls exceeding the timeout
// return a timeout error.
//
// For any configured tool timeout within the range 5–600 seconds and any tool
// that never resolves, `ToolHost` returns a `tool.result` frame carrying a
// `timeout` error once the deadline elapses, aborts the tool's execution via its
// AbortSignal, and leaves the WebSocket connection open (Requirement 3.7).
//
// The real timeout is clamped to the 5–600s range by `clampTimeoutMs`, so waiting
// on wall-clock time would make the property prohibitively slow. Instead the test
// installs a deterministic fake clock that swaps `global.setTimeout` /
// `global.clearTimeout` for the duration of each iteration: the host schedules its
// timeout timer synchronously while dispatching, the test flushes the fake clock to
// fire that timer immediately, and the timeout branch wins the race against a tool
// whose `execute` never resolves. This exercises the genuine timeout path with no
// real waiting and no coupling to `vscode`.
//
// Validates: Requirements 3.7
import * as assert from "assert";

import * as fc from "fast-check";

import { ConfigStore, type MementoLike } from "./configStore";
import {
  MAX_TOOL_TIMEOUT_MS,
  MIN_TOOL_TIMEOUT_MS,
  ToolHost,
  type ToolFrameTransport,
} from "./host";
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
// Deterministic fake clock
// -----------------------------------------------------------------------------

/** A scheduled timer's fake handle; carries the id used to clear it. */
interface FakeTimerHandle {
  readonly id: number;
  unref(): FakeTimerHandle;
  ref(): FakeTimerHandle;
}

/**
 * A minimal fake clock that intercepts `global.setTimeout` / `global.clearTimeout`
 * so scheduled callbacks fire only when {@link FakeClock.flush} is called, never on
 * wall-clock time. Only the surface the ToolHost uses is emulated (`setTimeout`
 * returning a handle with `unref`, and `clearTimeout` accepting that handle).
 */
class FakeClock {
  private readonly pending = new Map<number, () => void>();
  private nextId = 1;
  private readonly realSetTimeout = global.setTimeout;
  private readonly realClearTimeout = global.clearTimeout;

  /** Swap the global timer functions for the fake implementations. */
  public install(): void {
    const fakeSetTimeout = (handler: (...args: unknown[]) => void): FakeTimerHandle => {
      const id = this.nextId;
      this.nextId += 1;
      this.pending.set(id, () => handler());
      const handle: FakeTimerHandle = {
        id,
        unref: () => handle,
        ref: () => handle,
      };
      return handle;
    };

    const fakeClearTimeout = (handle: unknown): void => {
      const id = (handle as FakeTimerHandle | undefined)?.id;
      if (typeof id === "number") {
        this.pending.delete(id);
      }
    };

    (global as unknown as { setTimeout: unknown }).setTimeout = fakeSetTimeout;
    (global as unknown as { clearTimeout: unknown }).clearTimeout = fakeClearTimeout;
  }

  /** Fire every currently scheduled callback, in scheduling order. */
  public flush(): void {
    const callbacks = [...this.pending.values()];
    this.pending.clear();
    for (const callback of callbacks) {
      callback();
    }
  }

  /** Restore the real global timer functions. */
  public uninstall(): void {
    (global as unknown as { setTimeout: unknown }).setTimeout = this.realSetTimeout;
    (global as unknown as { clearTimeout: unknown }).clearTimeout =
      this.realClearTimeout;
  }
}

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
 * A tool whose `execute` never resolves, so the only way its dispatch completes is
 * via the host's timeout. It records the AbortSignal it was handed so the test can
 * assert the signal is aborted when the deadline fires.
 */
class HangingTool implements CodingTool {
  public receivedSignal: AbortSignal | undefined;

  public constructor(public readonly id: string) {}

  public execute(_input: unknown, ctx: ToolContext): Promise<ToolOutput> {
    this.receivedSignal = ctx.signal;
    return new Promise<ToolOutput>(() => {
      /* never resolves: the host must time this out */
    });
  }
}

/** A path guard stub; file resolution is never exercised by the hanging tool. */
const fakeGuard: WorkspacePathGuard = {
  roots: (): string[] => ["/workspace"],
  resolve: () => ({ ok: false, error: "out-of-scope" }),
};

/** Build a ToolContext carrying the call's abort signal (fake createContext). */
function makeContext(signal: AbortSignal): ToolContext {
  return { guard: fakeGuard, profile: undefined, signal };
}

// -----------------------------------------------------------------------------
// Tool catalogue under test
// -----------------------------------------------------------------------------

const HANGING_TOOL_ID = "hanging_tool";

const HANGING_TOOL_SCHEMA: JSONSchema = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};

const DEFINITIONS: readonly ToolDefinition[] = [
  {
    id: HANGING_TOOL_ID,
    displayName: HANGING_TOOL_ID,
    description: "A tool that never resolves, used to exercise the timeout path.",
    inputSchema: HANGING_TOOL_SCHEMA,
    category: "file",
    classification: "read-only",
    defaultEnabled: true,
  },
];

/** Fresh registry (tool enabled by default) backed by in-memory storage. */
function makeRegistry(): ToolRegistry {
  const store = new ConfigStore(
    new InMemoryMemento(),
    new InMemoryMemento(),
    DEFINITIONS,
  );
  return new ToolRegistry(store, DEFINITIONS);
}

// -----------------------------------------------------------------------------
// Property 10
// -----------------------------------------------------------------------------

describe("Property 10: calls exceeding the timeout return a timeout error", () => {
  it("returns a timeout error, aborts the tool signal, and keeps the connection open once the deadline elapses (Requirement 3.7)", async () => {
    // Requested timeouts span below the floor, inside the 5–600s range, and above
    // the ceiling: `clampTimeoutMs` bounds them all, and — because the tool never
    // resolves — every configured value must yield a timeout regardless of clamping.
    const requestedTimeoutArb = fc.oneof(
      fc.constant<number | undefined>(undefined),
      fc.integer({ min: 0, max: MIN_TOOL_TIMEOUT_MS - 1 }),
      fc.integer({ min: MIN_TOOL_TIMEOUT_MS, max: MAX_TOOL_TIMEOUT_MS }),
      fc.integer({ min: MAX_TOOL_TIMEOUT_MS + 1, max: MAX_TOOL_TIMEOUT_MS * 4 }),
    );

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.string(),
        requestedTimeoutArb,
        async (correlationId, text, requestedTimeoutMs) => {
          const clock = new FakeClock();
          clock.install();
          try {
            const registry = makeRegistry();
            const tool = new HangingTool(HANGING_TOOL_ID);
            const transport = new RecordingTransport();
            const host = new ToolHost({
              registry,
              tools: [tool],
              transport,
              createContext: makeContext,
              ...(requestedTimeoutMs !== undefined
                ? { timeoutMs: requestedTimeoutMs }
                : {}),
            });

            // Kick off dispatch. The host schedules its timeout timer synchronously
            // (in the timeout Promise executor) before suspending on the race, so the
            // timer is already registered with the fake clock by the time control
            // returns here.
            const pending = host.handleCall({
              v: 1,
              type: "tool.call",
              id: correlationId,
              data: { tool: HANGING_TOOL_ID, input: { text } },
            });

            // Fire the scheduled timeout so the timeout branch wins the race.
            clock.flush();
            await pending;

            // Exactly one tool.result frame is sent, echoing the correlation id.
            assert.strictEqual(
              transport.sent.length,
              1,
              "exactly one frame must be sent",
            );
            const frame = transport.sent[0] as ToolResultFrame;
            assert.strictEqual(frame.type, "tool.result");
            assert.strictEqual(frame.id, correlationId);

            // The result is a typed timeout error.
            assert.strictEqual(
              frame.data.ok,
              false,
              "a hung tool must yield a failure result",
            );
            if (!frame.data.ok) {
              assert.strictEqual(
                frame.data.error.kind,
                "timeout",
                "the failure must be a timeout error",
              );
            }

            // The tool's abort signal is aborted when the deadline fires.
            assert.ok(
              tool.receivedSignal !== undefined,
              "the tool must have received an abort signal",
            );
            assert.strictEqual(
              tool.receivedSignal?.aborted,
              true,
              "the tool's abort signal must be aborted on timeout",
            );

            // The connection stays open and the in-flight entry is cleared.
            assert.strictEqual(
              transport.isOpen(),
              true,
              "the connection must remain open after a timeout",
            );
            assert.strictEqual(
              host.inflight.size,
              0,
              "the timed-out call must be removed from the in-flight map",
            );
          } finally {
            clock.uninstall();
          }
        },
      ),
    );
  });
});
