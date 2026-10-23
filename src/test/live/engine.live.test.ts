// Live (end-to-end) tests: the REAL extension modules (EngineClient, discovery, ConfigStore,
// ToolRegistry, ToolHost) against a REAL engine process started by the sibling repo's
// `scripts/live_stack.py`. Nothing here re-implements the protocol: every frame is sent by the
// extension's own client, and every assertion reads the engine's own REST API.
//
// Gating: always discovered, skipped (with SKIP_MESSAGE) when no live stack is reachable.
// Run: task "Test: Live (Code)" or `npm run test:live`. Never part of `npm run test:unit`.

import { setDiscoveryDataDir, resolveLiveStack, SKIP_MESSAGE, waitFor, sleep, nextEvent, engineRest, localClientLabels, makeWorkspace } from "./liveStack";
import type { LiveStack } from "./liveStack";
import * as assert from "assert";
import { randomBytes } from "crypto";
import { EngineClient } from "../../engine/client";
import type { ClientIdStore } from "../../engine/client";
import type { WSFrame } from "../../engine/types";
import { ConfigStore } from "../../tools/configStore";
import type { MementoLike } from "../../tools/configStore";
import { BUILTIN_TOOL_DEFINITIONS, ToolRegistry } from "../../tools/registry";
import { ToolHost } from "../../tools/host";

const EXTENSION_VERSION = "9.9.9-live";

/** A stand-in for VS Code's `globalState`/`workspaceState` (shared between "windows" on purpose). */
class MemoryMemento implements MementoLike {
  private readonly values = new Map<string, unknown>();
  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

interface Window {
  readonly client: EngineClient;
  readonly configStore: ConfigStore;
  /** Every Client_ID the engine assigned/confirmed to this window, in order. */
  readonly assignedIds: string[];
  readonly frames: WSFrame[];
  readonly statuses: string[];
}

describe("live: Subconscious Code against a real engine", function () {
  this.timeout(60_000);

  let stack: LiveStack;
  const windows: Window[] = [];

  before(async function () {
    const found = await resolveLiveStack();
    if (found === undefined) {
      console.log(`      ${SKIP_MESSAGE}`);
      this.skip();
    }
    stack = found as LiveStack;
    setDiscoveryDataDir(stack.engine.dataDir);
  });

  beforeEach(async () => {
    await waitFor(async () => !(await localClientLabels(stack)).includes("VS Code"), "engine starts the test with no VS Code client (stale sockets from a previous run?)", 15_000);
  });

  afterEach(async () => {
    for (const w of windows.splice(0)) {
      w.client.dispose();
    }
    // Let the engine release the sessions so the next test starts from a clean client list.
    await waitFor(async () => !(await localClientLabels(stack)).includes("VS Code"), "engine lists no VS Code clients", 15_000).catch(() => undefined);
  });

  /**
   * One extension "window". `sharedGlobalState` models VS Code's per-extension `globalState`,
   * which is the SAME store in every window of one installation.
   */
  function openWindow(sharedGlobalState: MemoryMemento = new MemoryMemento()): Window {
    const configStore = new ConfigStore(sharedGlobalState, new MemoryMemento(), BUILTIN_TOOL_DEFINITIONS);
    const assignedIds: string[] = [];
    const idStore: ClientIdStore = {
      loadClientId: () => configStore.loadClientId(),
      saveClientId: async (id) => {
        assignedIds.push(id);
        await configStore.saveClientId(id);
      },
    };
    const client = new EngineClient();
    client.setClientVersion(EXTENSION_VERSION);
    client.setClientIdStore(idStore);
    const frames: WSFrame[] = [];
    const statuses: string[] = [];
    client.on("event", (frame: WSFrame) => frames.push(frame));
    client.on("status", (status: string) => statuses.push(status));
    const w: Window = { client, configStore, assignedIds, frames, statuses };
    windows.push(w);
    return w;
  }

  /** Send a chat turn through the extension client and return the echoed assistant text. */
  async function chat(w: Window, workspace: string, text: string): Promise<string> {
    const thread = await w.client.createThread(workspace, `live ${text}`);
    const done = nextEvent<WSFrame>(w.client, "event", (f) => f.type === "chat.done" || f.type === "chat.error", 30_000);
    const turn = w.client.sendChat(thread.uuid, text, "echo");
    const end = await done;
    assert.strictEqual(end.type, "chat.done", `chat failed: ${JSON.stringify(end)}`);
    return w.frames
      .filter((f) => f.type === "chat.delta" && f.id === turn)
      .map((f) => String((f.data as { delta?: string }).delta ?? ""))
      .join("");
  }

  // ---------------------------------------------------------------------------------------------

  it("(a) connects with the master token, completes client.hello and is listed as a local VS Code client", async () => {
    // Bug class: the extension connects but sends no client_type/name, so the engine tray and
    // device list show it as 'Unknown' (or not as a local client at all).
    const w = openWindow();
    await w.client.connect();
    assert.deepStrictEqual(w.statuses, ["connected"]);
    assert.strictEqual(w.assignedIds.length, 1, "client.hello.ack must hand back a Client_ID");
    assert.ok(w.client.isOpen());
    // the identity the client puts on the wire (query client_type/client_name/client_version)
    assert.deepStrictEqual((w.client as unknown as { identity: unknown }).identity, {
      type: "vscode",
      name: "VS Code",
      version: EXTENSION_VERSION,
    });
    // the same token works for REST and the discovered engine is the stack's engine
    assert.ok((await w.client.listWorkspaces()).length >= 0);
    const labels = await waitFor(async () => {
      const l = await localClientLabels(stack);
      return l.includes("VS Code") ? l : undefined;
    }, "engine lists a local 'VS Code' client");
    assert.ok(!labels.includes("Unknown"), `engine labelled a client Unknown: ${labels.join(", ")}`);
    const node = (await engineRest<{ nodes: { id: string; local?: boolean }[] }>(stack, "/hive/nodes")).nodes.find((n) => n.id === stack.engine.nodeId);
    assert.strictEqual(node?.local, true);
  });

  it("(b) two windows get distinct client ids, are both acknowledged and chat concurrently", async () => {
    // Bug class: two VS Code windows share one globalState Client_ID, so the second window's
    // client.hello is rejected as 'Client_ID already in use' (and the windows steal the id from
    // each other on every reconnect).
    const shared = new MemoryMemento(); // VS Code: one globalState for every window of the extension
    const first = openWindow(shared);
    const second = openWindow(shared);
    await first.client.connect();
    await second.client.connect(); // must not be rejected
    const workspace = await makeWorkspace(stack, "live-two-windows");
    const [one, two] = await Promise.all([
      chat(first, workspace, `from window one ${randomBytes(3).toString("hex")}`),
      chat(second, workspace, `from window two ${randomBytes(3).toString("hex")}`),
    ]);
    assert.match(one, /from window one/);
    assert.doesNotMatch(one, /from window two/);
    assert.match(two, /from window two/);
    assert.doesNotMatch(two, /from window one/);
    assert.notStrictEqual(first.assignedIds.at(-1), second.assignedIds.at(-1), "windows must hold distinct Client_IDs");
    await waitFor(async () => (await localClientLabels(stack)).filter((l) => l === "VS Code").length >= 2, "engine lists both windows");
  });

  it("(c) ten rapid close/re-open cycles of one client all succeed", async () => {
    // Bug class: a reconnect loop ('Client_ID already in use' forever) when the extension
    // reconnects faster than the engine releases the previous session, or an old socket's close
    // handler spawning a second, parallel connection.
    const w = openWindow();
    await w.client.connect();
    for (let i = 0; i < 10; i += 1) {
      w.client.dispose(); // close ...
      await w.client.connect(); // ... and re-open at once; rejects if the engine refuses the hello
      assert.ok(w.client.isOpen(), `cycle ${i + 1}: socket not open`);
    }
    assert.strictEqual(w.assignedIds.length, 11);
    assert.strictEqual(new Set(w.assignedIds).size, 1, "the same Client_ID is re-presented and accepted every time");
    // The old sockets' close handlers must not have spawned extra connections: wait past the
    // 2 s auto-reconnect delay and check the engine still sees exactly one VS Code client.
    await sleep(3500);
    const count = (await localClientLabels(stack)).filter((l) => l === "VS Code").length;
    assert.strictEqual(count, 1, `expected one VS Code client after ten reconnects, engine lists ${count}`);
  });

  it("(d) client.hello sent twice on one socket is acknowledged both times", async () => {
    // Bug class: a client that greets again on the same socket is rejected by its own session.
    const w = openWindow();
    await w.client.connect();
    const firstId = w.assignedIds[0];
    const ack = nextEvent<WSFrame>(w.client, "event", (f) => f.type === "client.hello.ack" || f.type === "client.hello.reject");
    (w.client as unknown as { sendHello(): void }).sendHello();
    const reply = await ack;
    assert.strictEqual(reply.type, "client.hello.ack", JSON.stringify(reply));
    assert.strictEqual((reply.data as { clientId: string }).clientId, firstId);
    assert.ok(w.client.isOpen());
  });

  describe("client tools", () => {
    const groupName = `vscode_live_${randomBytes(3).toString("hex")}`;

    it("(e) a tool.register group sent by the extension client is listed in the engine tool catalog", async () => {
      // Bug class: a client registers tools over its link but the engine never lists them, so the
      // settings UI cannot toggle them and the model never sees them. This is the contract the
      // ENGINE implements (engine/README.md, 'Client-defined tools'): group/title/tools[].input_schema.
      const w = openWindow();
      await w.client.connect();
      const errors: WSFrame[] = [];
      w.client.on("event", (f: WSFrame) => f.type === "error" && errors.push(f));
      w.client.send({
        v: 1,
        type: "tool.register",
        id: "live-register",
        data: {
          group: groupName,
          title: "VS Code (live test)",
          tools: [
            {
              id: "open_file",
              description: "Open a file in the editor.",
              input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
              operation: "read",
              read_only: true,
            },
          ],
        },
      } as WSFrame);
      const catalog = await waitFor(async () => {
        const c = await engineRest<{ builtin: Record<string, { name: string }[]> }>(stack, "/tools/catalog");
        return c.builtin[groupName] ? c.builtin : undefined;
      }, `tools catalog lists group ${groupName}`);
      assert.deepStrictEqual(catalog[groupName].map((t) => t.name), ["open_file"]);
      assert.deepStrictEqual(errors, []);
      // an invalid registration is refused with an error frame on this socket only
      const refused = nextEvent<WSFrame>(w.client, "event", (f) => f.type === "error");
      w.client.send({ v: 1, type: "tool.register", id: "live-bad", data: { group: "Bad Group!", title: "x", tools: [{ id: "x", description: "x", input_schema: { type: "object" } }] } } as WSFrame);
      const reply = await refused;
      assert.match(String((reply.data as { error?: string }).error ?? ""), /tool\.register rejected/);
    });

    it("FINDING: the extension's own tool.register frame uses the legacy contract the engine does not list", async () => {
      // Bug class: contract drift. The extension's ToolHost registers `{tools:[{id,description,inputSchema}]}`
      // (no `group`, camelCase `inputSchema`, answered via `tool.call`/`tool.result`). The engine only treats
      // `{group,title,tools[].input_schema}` as client-defined tools (answered via `client.tool.request` /
      // `client.tool.result`); a payload without group/input_schema is the legacy DESKTOP-UI registration and
      // everything except its built-in UI tool names is silently dropped. This test pins the CURRENT behaviour
      // using the real registry/host/client; when the extension is migrated, flip the final assertion.
      const w = openWindow();
      const registry = new ToolRegistry(w.configStore);
      const host = new ToolHost({
        registry,
        tools: [],
        transport: { send: (f) => w.client.send(f as WSFrame), isOpen: () => w.client.isOpen() },
        createContext: () => {
          throw new Error("not used");
        },
      });
      try {
        const before = await engineRest<{ builtin: Record<string, unknown[]> }>(stack, "/tools/catalog");
        const frame = host.buildRegistrationFrame();
        const data = frame.data as unknown as Record<string, unknown>;
        assert.strictEqual(data.group, undefined, "the extension frame has no `group`");
        assert.ok((data.tools as Record<string, unknown>[]).length > 0, "the extension advertises its coding tools");
        assert.ok(!("input_schema" in (data.tools as Record<string, unknown>[])[0]), "the extension frame uses camelCase inputSchema");

        w.client.attachToolHost(host, registry.onDidChange); // the production wiring: registers on every connect
        const errors: WSFrame[] = [];
        w.client.on("event", (f: WSFrame) => f.type === "error" && errors.push(f));
        await w.client.connect();
        await sleep(1500);
        const after = await engineRest<{ builtin: Record<string, unknown[]> }>(stack, "/tools/catalog");
        const ids = new Set((data.tools as { id: string }[]).map((t) => t.id));
        const listed = Object.values(after.builtin).flat().filter((t) => ids.has((t as { name?: string }).name ?? ""));
        assert.deepStrictEqual(errors, [], "the engine does not even report an error for the legacy frame");
        assert.deepStrictEqual(Object.keys(after.builtin).sort(), Object.keys(before.builtin).sort(), "no group appeared");
        assert.strictEqual(listed.length, 0, "FINDING: none of the extension's coding tools is visible to the engine/model");
      } finally {
        registry.dispose();
      }
    });

    it.skip("(f) a client.tool.request from the engine is answered with client.tool.result by the extension", () => {
      // Not runnable end to end, for two reasons (see the final report):
      //  1. Only the model can make the engine send `client.tool.request`, and the dev Echo model cannot
      //     call tools (the Python tier invokes the session's request hook directly, which is not possible
      //     from outside the engine process).
      //  2. EngineClient only routes the legacy `tool.call` frame to ToolHost.handleCall; it has no handler
      //     for `client.tool.request`, so such a request would be ignored (emitted as an "event" only).
      // Enable once the extension speaks the group/`client.tool.request` contract and a tool-calling test
      // model (or an engine test hook) exists.
    });
  });

  it("(g) a dropped socket is re-established by the extension without a rejection loop", async () => {
    // Bug class: after the connection is cut (engine restart, network change) the client re-presents
    // its stored Client_ID while the engine still holds the dying session, is rejected, and loops.
    const w = openWindow();
    await w.client.connect();
    const idBefore = w.assignedIds[0];
    const started = Date.now();
    const down = nextEvent<string>(w.client, "status", (s) => s === "disconnected");
    const back = nextEvent<string>(w.client, "status", (s) => s === "connected", 20_000);
    // kill the connection from the test side: the underlying socket, not a polite close
    (w.client as unknown as { ws: { terminate(): void } }).ws.terminate();
    await down;
    await back;
    const elapsed = Date.now() - started;
    assert.ok(w.client.isOpen());
    // one 2 s reconnect delay is expected; a rejected hello would add another full retry cycle
    assert.ok(elapsed < 4500, `reconnect took ${elapsed} ms: looks like a rejected hello followed by a retry`);
    assert.strictEqual(w.assignedIds.at(-1), idBefore, "the Client_ID survives the reconnect");
    await sleep(2500);
    const count = (await localClientLabels(stack)).filter((l) => l === "VS Code").length;
    assert.strictEqual(count, 1, `engine lists ${count} VS Code clients after the reconnect (expected one)`);
    // the connection is usable again
    const workspace = await makeWorkspace(stack, "live-reconnect");
    assert.match(await chat(w, workspace, "after reconnect"), /after reconnect/);
  });
});
