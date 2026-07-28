// Feature: agent-tools-and-settings — integration tests for the engine RPC lifecycle.
//
// Exercises EngineClient's tool-registration / profile-broadcast wiring across
// connect, disconnect, and reconnect transitions WITHOUT opening real network
// sockets. The `ws` module is replaced by a controllable FakeWebSocket (see
// ../test/wsStub) whose open/close/message transitions the tests drive
// explicitly; the ToolCallRouter and the model/profile providers are fakes.
//
// Behaviours asserted:
//   - registration is sent on connect (R2.1) and re-sent on reconnect (R2.4);
//   - while the socket is closed, sendRegistration transmits nothing (a no-op)
//     yet the enabled set is retained, and it is re-sent on the next connect (R2.6);
//   - edits to the enabled set (registry change) trigger a registration send (R7.8),
//     which is likewise a no-op while closed and re-sent on reconnect;
//   - the execution profile is sent on connect (R11.5) and on profile edit (R11.8);
//   - inbound `tool.call` frames are routed to the attached router (R3.1).
//
// This runs in the pure-module Node/Mocha suite (NOT the @vscode/test-electron
// host suite): no real sockets are opened and no engine discovery is performed
// (the private `openSocket` is driven directly with preset RuntimeInfo).
//
// _Requirements: 2.1, 2.4, 2.6, 7.8, 11.5, 11.8_

// The ws stub MUST be imported first so its `Module._load` hook is installed
// before `client.ts` (and thus `require("ws")`) is first loaded.
import { FakeWebSocket } from "../test/wsStub";

import * as assert from "assert";

import {
  EngineClient,
  type ChangeSubscribe,
  type ToolCallRouter,
} from "./client";
import type { RuntimeInfo } from "./types";
import type { ExecutionProfile } from "../env/types";
import type { ToolCallFrame } from "../tools/types";

// -----------------------------------------------------------------------------
// Test doubles
// -----------------------------------------------------------------------------

/** Wire-envelope version stamped by EngineClient on the frames it originates. */
const FRAME_VERSION = 1;

/**
 * Fake ToolCallRouter that records calls to `sendRegistration` and `handleCall`.
 *
 * `sendRegistration` mirrors the real ToolHost contract: it transmits a
 * `tool.register` frame through the transport ONLY when the socket is open, so a
 * send attempted while closed is a genuine no-op (Requirement 2.6). This lets the
 * tests observe both the call count and the frames that actually reached the wire.
 */
class FakeToolCallRouter implements ToolCallRouter {
  public sendRegistrationCalls = 0;
  public readonly handledCalls: ToolCallFrame[] = [];

  public constructor(private readonly client: EngineClient) {}

  public handleCall(frame: ToolCallFrame): void {
    this.handledCalls.push(frame);
  }

  public sendRegistration(): void {
    this.sendRegistrationCalls += 1;
    // Faithful to ToolHost.sendRegistration: skip the send when the socket is not
    // open and rely on a resend on the next connection (Requirement 2.6).
    if (this.client.isOpen()) {
      this.client.send({
        v: FRAME_VERSION,
        type: "tool.register",
        data: { tools: [] },
      });
    }
  }
}

/**
 * A manual stand-in for `ToolRegistry.onDidChange`: records listeners and lets a
 * test fire a synthetic "enabled set changed" event.
 */
class FakeRegistryChange {
  private readonly listeners: Array<() => void> = [];

  public readonly subscribe: ChangeSubscribe = (listener: () => void) => {
    this.listeners.push(listener);
    return {
      dispose: (): void => {
        const index = this.listeners.indexOf(listener);
        if (index >= 0) {
          this.listeners.splice(index, 1);
        }
      },
    };
  };

  /** Fire the change event to every current subscriber. */
  public fire(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

/** Internals of EngineClient the tests drive directly (no real discovery/socket). */
interface ClientInternals {
  info?: RuntimeInfo;
  openSocket(): Promise<void>;
}

const RUNTIME_INFO: RuntimeInfo = {
  host: "127.0.0.1",
  port: 51234,
  token: "test-token",
  pid: 4242,
  version: "0.0.0-test",
};

function makeProfile(root: string): ExecutionProfile {
  return {
    root,
    detectedAt: "2024-01-01T00:00:00.000Z",
    technologies: [],
  };
}

/**
 * Drive EngineClient through a `connected` transition using a FakeWebSocket:
 * preset the RuntimeInfo, invoke the private `openSocket`, fire `open` on the
 * freshly-constructed fake socket (which sends `client.hello`), then reply with a
 * `client.hello.ack` to complete the handshake (R1.5, R9.3). Returns that socket for
 * further driving.
 */
async function connect(client: EngineClient): Promise<FakeWebSocket> {
  const internals = client as unknown as ClientInternals;
  internals.info = RUNTIME_INFO;
  const opening = internals.openSocket();
  const socket = FakeWebSocket.latest();
  socket.fireOpen();
  socket.fireMessage(
    JSON.stringify({
      v: FRAME_VERSION,
      type: "client.hello.ack",
      data: { clientId: "test-client-id" },
    }),
  );
  await opening;
  return socket;
}

/** Count the `tool.register` frames written across every fake socket. */
function registrationFrameCount(): number {
  return FakeWebSocket.allSentFrames().filter((f) => f.type === "tool.register").length;
}

/** Every `profile.set` frame written across every fake socket. */
function profileFrames(): Record<string, unknown>[] {
  return FakeWebSocket.allSentFrames().filter((f) => f.type === "profile.set");
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("EngineClient RPC lifecycle (integration)", () => {
  let client: EngineClient;
  let router: FakeToolCallRouter;
  let registryChange: FakeRegistryChange;

  beforeEach(() => {
    FakeWebSocket.reset();
    client = new EngineClient();
    router = new FakeToolCallRouter(client);
    registryChange = new FakeRegistryChange();
    client.attachToolHost(router, registryChange.subscribe);
  });

  afterEach(() => {
    client.dispose();
  });

  it("sends registration on connect (R2.1)", async () => {
    await connect(client);

    assert.strictEqual(
      router.sendRegistrationCalls,
      1,
      "onConnected must call sendRegistration exactly once"
    );
    assert.strictEqual(
      registrationFrameCount(),
      1,
      "a tool.register frame must be transmitted on connect"
    );
  });

  it("re-sends registration on reconnect after a disconnect (R2.4)", async () => {
    const first = await connect(client);
    assert.strictEqual(registrationFrameCount(), 1, "registered once on first connect");

    // Simulate the socket dropping (not open), then a fresh connection.
    first.markClosed();
    const second = await connect(client);

    assert.strictEqual(
      router.sendRegistrationCalls,
      2,
      "sendRegistration runs again on the reconnect transition"
    );
    assert.strictEqual(
      registrationFrameCount(),
      2,
      "a second tool.register frame must be transmitted on reconnect"
    );
    // The re-registration rides the new socket, not the stale one.
    assert.strictEqual(
      second.sentFrames().filter((f) => f.type === "tool.register").length,
      1,
      "the reconnect registration is sent on the new socket"
    );
  });

  it("treats registration as a no-op while the socket is closed and re-sends on next connect (R2.6, R7.8)", async () => {
    const first = await connect(client);
    assert.strictEqual(registrationFrameCount(), 1);

    // Socket closed: an enabled-set edit fires a registry change. sendRegistration
    // is invoked but transmits nothing because the transport is not open.
    first.markClosed();
    registryChange.fire();

    assert.strictEqual(
      router.sendRegistrationCalls,
      2,
      "the registry-change edit still invokes sendRegistration while closed"
    );
    assert.strictEqual(
      registrationFrameCount(),
      1,
      "no additional registration frame is transmitted while the socket is closed"
    );

    // Next successful connection re-sends the retained enabled set.
    await connect(client);

    assert.strictEqual(
      registrationFrameCount(),
      2,
      "the retained registration is re-sent on the next connect"
    );
  });

  it("sends registration when the enabled set changes while connected (R7.8)", async () => {
    await connect(client);
    assert.strictEqual(registrationFrameCount(), 1);

    registryChange.fire();

    assert.strictEqual(
      router.sendRegistrationCalls,
      2,
      "a registry change while connected triggers another registration"
    );
    assert.strictEqual(
      registrationFrameCount(),
      2,
      "the registration frame is transmitted on the open socket"
    );
  });

  it("sends the execution profile on connect (R11.5)", async () => {
    const profile = makeProfile("/workspace/root-a");
    client.setExecutionProfileProvider(() => profile);

    await connect(client);

    const frames = profileFrames();
    assert.strictEqual(frames.length, 1, "exactly one profile.set frame on connect");
    assert.deepStrictEqual(
      (frames[0].data as { profile: ExecutionProfile }).profile,
      profile,
      "the advertised profile matches the provider's profile"
    );
  });

  it("does not send a profile on connect when no profile is available", async () => {
    client.setExecutionProfileProvider(() => undefined);

    await connect(client);

    assert.strictEqual(profileFrames().length, 0, "no profile.set frame when none is provided");
  });

  it("re-advertises the profile on reconnect (R11.5)", async () => {
    const profile = makeProfile("/workspace/root-b");
    client.setExecutionProfileProvider(() => profile);

    const first = await connect(client);
    assert.strictEqual(profileFrames().length, 1, "profile advertised on first connect");

    first.markClosed();
    await connect(client);

    assert.strictEqual(
      profileFrames().length,
      2,
      "profile is re-advertised on the reconnect transition"
    );
  });

  it("sends profile.set on a profile edit (R11.8)", async () => {
    const initial = makeProfile("/workspace/root-c");
    client.setExecutionProfileProvider(() => initial);
    await connect(client);
    assert.strictEqual(profileFrames().length, 1, "initial profile advertised on connect");

    // A profile edit re-broadcasts the updated profile over the open socket.
    const edited = makeProfile("/workspace/root-c-edited");
    client.sendProfile(edited);

    const frames = profileFrames();
    assert.strictEqual(frames.length, 2, "the edit produces a second profile.set frame");
    assert.deepStrictEqual(
      (frames[1].data as { profile: ExecutionProfile }).profile,
      edited,
      "the second profile.set carries the edited profile"
    );
  });

  it("drops a profile edit while the socket is closed (transport no-op)", async () => {
    const profile = makeProfile("/workspace/root-d");
    client.setExecutionProfileProvider(() => profile);
    const socket = await connect(client);
    assert.strictEqual(profileFrames().length, 1);

    socket.markClosed();
    client.sendProfile(makeProfile("/workspace/root-d-edited"));

    assert.strictEqual(
      profileFrames().length,
      1,
      "a profile edit while closed transmits nothing"
    );
  });

  it("routes inbound tool.call frames to the attached router (R3.1)", async () => {
    const socket = await connect(client);

    const call: ToolCallFrame = {
      v: FRAME_VERSION,
      type: "tool.call",
      id: "corr-1",
      data: { tool: "read_file", input: { path: "a.txt" } },
    };
    socket.fireMessage(JSON.stringify(call));

    assert.strictEqual(router.handledCalls.length, 1, "the tool.call is routed to the router");
    assert.deepStrictEqual(router.handledCalls[0], call, "the routed frame is delivered unchanged");
  });
});
