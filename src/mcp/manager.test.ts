// Feature: MCP support — unit tests for McpManager tool integration.
//
// Pure-module Node/Mocha tests: an injected transport factory and config source let
// the manager be driven without a child process, network, or VS Code host. They assert
// that discovered tools become namespaced definitions + executable CodingTools, that
// input placeholders are prompted and substituted, and that a failing server is
// isolated from the others.

import * as assert from "assert";

import { McpManager, type McpConfigSource } from "./manager";
import type { CodingTool, ToolDefinition } from "../tools/types";
import { isToolExecutionError } from "../tools/errors";
import type {
  CloseHandler,
  JsonRpcMessage,
  McpTransport,
  MessageHandler,
} from "./transport";
import type { McpServerConfig } from "./types";

/** A transport that serves a fixed tool list and echoes call arguments back as text. */
class FakeTransport implements McpTransport {
  public lastCallArgs?: Record<string, unknown>;
  private messageHandler?: MessageHandler;
  private closeHandler?: CloseHandler;

  public constructor(
    private readonly tools: Array<{ name: string; description?: string }>,
    private readonly failInitialize = false,
  ) {}

  public async start(): Promise<void> {
    return;
  }

  public send(message: JsonRpcMessage): void {
    if (message.id === undefined || message.method === undefined) {
      return;
    }
    queueMicrotask(() => this.respond(message));
  }

  public onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  public onClose(handler: CloseHandler): void {
    this.closeHandler = handler;
  }

  public stop(): void {
    this.closeHandler?.();
  }

  private respond(message: JsonRpcMessage): void {
    const reply = (result: unknown): void =>
      this.messageHandler?.({ jsonrpc: "2.0", id: message.id, result });
    switch (message.method) {
      case "initialize":
        if (this.failInitialize) {
          this.messageHandler?.({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -1, message: "init failed" },
          });
        } else {
          reply({ capabilities: {} });
        }
        break;
      case "tools/list":
        reply({ tools: this.tools.map((t) => ({ ...t, inputSchema: { type: "object" } })) });
        break;
      case "tools/call": {
        const params = message.params as { arguments?: Record<string, unknown> };
        this.lastCallArgs = params.arguments;
        reply({ content: [{ type: "text", text: JSON.stringify(params.arguments ?? {}) }] });
        break;
      }
      default:
        reply({});
    }
  }
}

/** A config source returning a fixed JSON document. */
function source(doc: unknown, workspaceFolder = "/repo"): McpConfigSource {
  return {
    read: async () => JSON.stringify(doc),
    workspaceFolder: () => workspaceFolder,
  };
}

describe("McpManager tool integration", () => {
  it("maps discovered tools to namespaced definitions and executable tools", async () => {
    let defs: ToolDefinition[] = [];
    let tools: CodingTool[] = [];
    const manager = new McpManager({
      configSource: source({ servers: { fsx: { command: "node" } } }),
      prompt: async () => undefined,
      transportFactory: () => new FakeTransport([{ name: "read", description: "Reads" }]),
      onDidChangeTools: (d, t) => {
        defs = d;
        tools = t;
      },
    });

    await manager.reload();

    assert.strictEqual(defs.length, 1);
    assert.strictEqual(defs[0].id, "mcp.fsx.read");
    assert.strictEqual(defs[0].category, "mcp");
    assert.strictEqual(defs[0].source, "mcp");
    assert.strictEqual(defs[0].serverId, "fsx");
    assert.strictEqual(defs[0].classification, "mutating");

    assert.strictEqual(tools.length, 1);
    const output = await tools[0].execute({ path: "a.txt" }, {} as never);
    assert.strictEqual(output.content, JSON.stringify({ path: "a.txt" }));
  });

  it("prompts for input placeholders and substitutes them into the config", async () => {
    const seen: Record<string, McpServerConfig> = {};
    const manager = new McpManager({
      configSource: source({
        inputs: [{ type: "promptString", id: "token", password: true }],
        servers: { api: { command: "run", args: ["--token", "${input:token}"] } },
      }),
      prompt: async (input) => (input.id === "token" ? "secret-value" : undefined),
      transportFactory: (config) => {
        seen.api = config;
        return new FakeTransport([{ name: "ping" }]);
      },
      onDidChangeTools: () => undefined,
    });

    await manager.reload();

    const cfg = seen.api;
    assert.ok(cfg && "args" in cfg);
    assert.deepStrictEqual((cfg as { args?: string[] }).args, ["--token", "secret-value"]);
  });

  it("isolates a failing server so the others still contribute tools", async () => {
    const errors: string[] = [];
    let defs: ToolDefinition[] = [];
    const manager = new McpManager({
      configSource: source({
        servers: { good: { command: "a" }, bad: { command: "b" } },
      }),
      prompt: async () => undefined,
      transportFactory: (config) => {
        const fail = "command" in config && config.command === "b";
        return new FakeTransport([{ name: "ok" }], fail);
      },
      onError: (id) => errors.push(id),
      onDidChangeTools: (d) => {
        defs = d;
      },
    });

    await manager.reload();

    assert.deepStrictEqual(errors, ["bad"]);
    assert.strictEqual(defs.length, 1);
    assert.strictEqual(defs[0].serverId, "good");
  });

  it("surfaces an MCP tool error as a typed execution error", async () => {
    let tools: CodingTool[] = [];
    const failingTransport: McpTransport = {
      start: async () => undefined,
      send: (m) => {
        if (m.id === undefined) {
          return;
        }
        queueMicrotask(() => {
          if (m.method === "tools/call") {
            handler?.({
              jsonrpc: "2.0",
              id: m.id,
              result: { content: [{ type: "text", text: "nope" }], isError: true },
            });
          } else if (m.method === "tools/list") {
            handler?.({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "boom", inputSchema: { type: "object" } }] } });
          } else {
            handler?.({ jsonrpc: "2.0", id: m.id, result: {} });
          }
        });
      },
      onMessage: (h) => {
        handler = h;
      },
      onClose: () => undefined,
      stop: () => undefined,
    };
    let handler: MessageHandler | undefined;

    const manager = new McpManager({
      configSource: source({ servers: { s: { command: "x" } } }),
      prompt: async () => undefined,
      transportFactory: () => failingTransport,
      onDidChangeTools: (_d, t) => {
        tools = t;
      },
    });

    await manager.reload();
    assert.strictEqual(tools.length, 1);
    try {
      await tools[0].execute({}, {} as never);
      assert.fail("expected the tool to throw");
    } catch (error) {
      assert.ok(isToolExecutionError(error));
      if (isToolExecutionError(error)) {
        assert.strictEqual(error.toolError.kind, "execution");
        assert.match(error.toolError.message, /nope/);
      }
    }
  });
});
