// Feature: agent-tools-and-settings — minimal `ws` module stub for Node-level
// (non-host) integration tests of the engine RPC lifecycle.
//
// `EngineClient` opens a real `ws` WebSocket via `import WebSocket from "ws"`.
// To exercise its connect/disconnect/reconnect behaviour in the pure-module
// Node/Mocha suite WITHOUT opening real network sockets, importing this module
// for its side effect installs a `Module._load` hook that returns a controllable
// {@link FakeWebSocket} whenever `require("ws")` is requested. The hook is
// installed exactly once and delegates every non-`ws` request to the previously
// installed loader (so the shared `vscode` stub from `setup.ts` still applies).
//
// Usage: place `import { FakeWebSocket } from "../test/wsStub";` (or the correct
// relative path) as the FIRST import in a test file, before importing
// `EngineClient`. TypeScript preserves import order in the emitted CommonJS, so
// the hook is installed before `client.ts` (and thus `ws`) is first required.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require("module") as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};

/** A recorded outbound frame together with the raw string that was written. */
export interface RecordedSend {
  readonly raw: string;
  readonly frame: Record<string, unknown>;
}

/**
 * Controllable stand-in for a `ws` WebSocket exposing exactly the surface
 * {@link EngineClient} uses: an event registration `on`, `send`, `close`,
 * `readyState`, and the static `OPEN` constant. Tests drive the connection
 * lifecycle explicitly with {@link fireOpen}, {@link markClosed},
 * {@link fireClose}, and {@link fireMessage}.
 */
export class FakeWebSocket {
  /** Mirrors `ws`'s `WebSocket.OPEN` ready-state constant. */
  public static readonly OPEN = 1;
  /** CONNECTING ready state (initial). */
  public static readonly CONNECTING = 0;
  /** CLOSED ready state. */
  public static readonly CLOSED = 3;

  /** Every instance constructed since the last {@link reset}. */
  public static instances: FakeWebSocket[] = [];

  public readonly url: string;
  public readyState: number = FakeWebSocket.CONNECTING;
  /** Raw strings written through {@link send}. */
  public readonly sent: string[] = [];

  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  public constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  /** Register an event handler (`open` | `message` | `error` | `close`). */
  public on(event: string, listener: (...args: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(listener);
    this.handlers.set(event, list);
    return this;
  }

  /** Record an outbound frame (the real socket would transmit it). */
  public send(data: string): void {
    this.sent.push(data);
  }

  /** Close the socket: mark CLOSED and emit `close`. */
  public close(): void {
    this.markClosed();
    this.emit("close");
  }

  // ── Test drivers ───────────────────────────────────────────────────────────

  /** Transition to OPEN and emit `open` (resolves `EngineClient.openSocket`). */
  public fireOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  /**
   * Mark the socket closed WITHOUT emitting `close`, so `isOpen()` reports false
   * (Requirement 2.6 "WebSocket is not open") without triggering EngineClient's
   * auto-reconnect timer. Used to simulate a closed socket deterministically.
   */
  public markClosed(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  /** Emit `close` (EngineClient schedules a reconnect unless it is disposing). */
  public fireClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close");
  }

  /** Deliver an inbound frame to the `message` handlers. */
  public fireMessage(raw: string): void {
    this.emit("message", Buffer.from(raw));
  }

  /** Parsed view of every frame written through {@link send}. */
  public sentFrames(): Record<string, unknown>[] {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.handlers.get(event) ?? [])]) {
      listener(...args);
    }
  }

  // ── Static helpers ───────────────────────────────────────────────────────────

  /** The most recently constructed instance (the current socket). */
  public static latest(): FakeWebSocket {
    const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (socket === undefined) {
      throw new Error("No FakeWebSocket has been constructed yet.");
    }
    return socket;
  }

  /** Every frame written across every instance, parsed. */
  public static allSentFrames(): Record<string, unknown>[] {
    return FakeWebSocket.instances.flatMap((s) => s.sentFrames());
  }

  /** Clear all recorded instances (call in `beforeEach`). */
  public static reset(): void {
    FakeWebSocket.instances = [];
  }
}

interface StubbedModuleLoader {
  __subconsciousWsStubInstalled?: boolean;
}

const loader = NodeModule as unknown as StubbedModuleLoader;

if (loader.__subconsciousWsStubInstalled !== true) {
  const previousLoad = NodeModule._load;
  NodeModule._load = function patchedLoad(
    request: string,
    parent: unknown,
    isMain: boolean
  ): unknown {
    if (request === "ws") {
      // Returned as the module value; TS's esModuleInterop `__importDefault`
      // wraps this class as `{ default: FakeWebSocket }`, so `new WebSocket(url)`
      // and `WebSocket.OPEN` resolve to the fake in `client.ts`.
      return FakeWebSocket;
    }
    return previousLoad.call(this, request, parent, isMain);
  };
  loader.__subconsciousWsStubInstalled = true;
}
