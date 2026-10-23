// Regression (found by the live tier, scenario (c)): dispose() followed immediately by connect()
// left the OLD socket's close event looking like an unexpected drop, so it scheduled an
// auto-reconnect and opened a second, parallel connection to the engine for every rapid
// reconnect. A socket closed on purpose, or already replaced, must never trigger a reconnect.

// The ws stub MUST be imported first (see client.rpcLifecycle.test.ts).
import { FakeWebSocket } from "../test/wsStub";

import * as assert from "assert";

import { EngineClient } from "./client";
import type { RuntimeInfo } from "./types";

interface ClientInternals {
  info?: RuntimeInfo;
  closing: boolean;
  reconnectTimer?: unknown;
  openSocket(): Promise<void>;
}

const RUNTIME_INFO: RuntimeInfo = { host: "127.0.0.1", port: 51234, token: "t", pid: 1, version: "0" };

async function connect(client: EngineClient): Promise<FakeWebSocket> {
  const internals = client as unknown as ClientInternals;
  internals.info = RUNTIME_INFO;
  const opening = internals.openSocket();
  const socket = FakeWebSocket.latest();
  socket.fireOpen();
  socket.fireMessage(JSON.stringify({ v: 1, type: "client.hello.ack", data: { clientId: "c1" } }));
  await opening;
  return socket;
}

describe("EngineClient close handling of disposed/replaced sockets", () => {
  beforeEach(() => FakeWebSocket.reset());

  it("does not schedule a reconnect when a disposed socket closes after connect() re-armed the client", async () => {
    const client = new EngineClient();
    const internals = client as unknown as ClientInternals;
    const first = await connect(client);
    client.dispose();
    // what connect() does before it has finished discovery
    internals.closing = false;
    first.fireClose();
    assert.strictEqual(internals.reconnectTimer, undefined, "a disposed socket must not arm an auto-reconnect");
  });

  it("does not schedule a reconnect when an older socket closes after a newer one took over", async () => {
    const client = new EngineClient();
    const internals = client as unknown as ClientInternals;
    const first = await connect(client);
    await connect(client); // newer socket is now current
    first.fireClose();
    assert.strictEqual(internals.reconnectTimer, undefined, "a replaced socket must not arm an auto-reconnect");
    client.dispose();
  });

  it("still reconnects after an unexpected drop of the current socket, and dispose() cancels it", async () => {
    const client = new EngineClient();
    const internals = client as unknown as ClientInternals;
    const current = await connect(client);
    current.fireClose();
    assert.notStrictEqual(internals.reconnectTimer, undefined, "an unexpected drop must schedule a reconnect");
    client.dispose();
    assert.strictEqual(internals.reconnectTimer, undefined, "dispose() must cancel the pending reconnect");
  });
});
