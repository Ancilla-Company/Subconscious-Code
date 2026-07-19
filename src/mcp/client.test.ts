// Feature: MCP support — unit tests for the MCP client against a fake transport.
//
// Pure-module Node/Mocha tests: the client is transport-agnostic, so a scripted
// in-memory transport exercises the handshake, tool listing, tool calls, error
// mapping, and request timeout with no child process or network.

import * as assert from "assert";

import { McpClient, callResultToText } from "./client";
import type {
  CloseHandler,
  JsonRpcMessage,
  McpTransport,
  MessageHandler,
} from "./transport";

/** A scripted transport that replies to requests using a per-method responder. */
class ScriptedTransport implements McpTransport {
  public readonly sent: JsonRpcMessage[] = [];
  public started = false;
  public stopped = false;
  private messageHandler?: MessageHandler;
  private closeHandler?: CloseHandler;

  /** @param responders result (or throw) keyed by JSON-RPC method. */
  public constructor(
    private readonly responders: Record<string, (params: unknown) => unknown> = {},
  ) {}

  public async start(): Promise<void> {
    this.started = true;
  }

  public send(message: JsonRpcMessage): void {
    this.sent.push(message);
    if (message.id === undefined || message.method === undefined) {
      return; // notification
    }
    const responder = this.responders[message.method];
    if (responder === undefined) {
      return; // no reply → will time out if awaited
    }
    // Reply asynchronously, mirroring real transport delivery.
    queueMicrotask(() => {
      try {
        const result = responder(message.params);
        this.deliver({ jsonrpc: "2.0", id: message.id, result });
      } catch (error) {
        this.deliver({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: (error as Error).message },
        });
      }
    });
  }

  public onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  public onClose(handler: CloseHandler): void {
    this.closeHandler = handler;
  }

  public stop(): void {
    this.stopped = true;
  }

  public closeNow(error?: Error): void {
    this.closeHandler?.(error);
  }

  private deliver(message: JsonRpcMessage): void {
    this.messageHandler?.(message);
  }
}

const CLIENT_INFO = { name: "test", version: "1.0.0" };

describe("McpClient handshake and tools", () => {
  it("starts the transport and completes the initialize handshake", async () => {
    const transport = new ScriptedTransport({
      initialize: () => ({ capabilities: {}, serverInfo: { name: "srv", version: "1" } }),
    });
    const client = new McpClient(transport, CLIENT_INFO);

    await client.initialize();

    assert.strictEqual(transport.started, true);
    const init = transport.sent.find((m) => m.method === "initialize");
    assert.ok(init, "initialize request must be sent");
    const initialized = transport.sent.find((m) => m.method === "notifications/initialized");
    assert.ok(initialized, "initialized notification must be sent");
    assert.strictEqual(initialized.id, undefined, "notification carries no id");
  });

  it("lists tools, filtering malformed entries", async () => {
    const transport = new ScriptedTransport({
      initialize: () => ({}),
      "tools/list": () => ({
        tools: [
          { name: "read", description: "Read a thing", inputSchema: { type: "object" } },
          { description: "no name" },
          { name: "" },
        ],
      }),
    });
    const client = new McpClient(transport, CLIENT_INFO);
    await client.initialize();

    const tools = await client.listTools();
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].name, "read");
    assert.strictEqual(tools[0].description, "Read a thing");
  });

  it("calls a tool and returns its content", async () => {
    const transport = new ScriptedTransport({
      initialize: () => ({}),
      "tools/call": (params) => {
        assert.deepStrictEqual(params, { name: "echo", arguments: { text: "hi" } });
        return { content: [{ type: "text", text: "hi" }] };
      },
    });
    const client = new McpClient(transport, CLIENT_INFO);
    await client.initialize();

    const result = await client.callTool("echo", { text: "hi" });
    assert.strictEqual(callResultToText(result), "hi");
  });

  it("rejects when the server returns a JSON-RPC error", async () => {
    const transport = new ScriptedTransport({
      initialize: () => ({}),
      "tools/call": () => {
        throw new Error("boom");
      },
    });
    const client = new McpClient(transport, CLIENT_INFO);
    await client.initialize();

    await assert.rejects(() => client.callTool("x", {}), /boom/);
  });

  it("times out a request that never receives a response", async () => {
    const transport = new ScriptedTransport({}); // no responders
    const client = new McpClient(transport, CLIENT_INFO, 40);
    await assert.rejects(() => client.initialize(), /timed out/);
  });

  it("fails in-flight requests when the transport closes", async () => {
    const transport = new ScriptedTransport({}); // never replies
    const client = new McpClient(transport, CLIENT_INFO, 5_000);
    const pending = client.initialize();
    transport.closeNow(new Error("pipe closed"));
    await assert.rejects(() => pending, /pipe closed/);
  });
});

describe("callResultToText", () => {
  it("joins text blocks and falls back to structured content", () => {
    assert.strictEqual(
      callResultToText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }),
      "a\nb",
    );
    assert.strictEqual(
      callResultToText({ content: [], structuredContent: { ok: true } }),
      '{"ok":true}',
    );
  });
});
