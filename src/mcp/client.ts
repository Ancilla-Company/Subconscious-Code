// Feature: MCP support — a minimal Model Context Protocol client.
//
// `McpClient` drives the MCP handshake and the tool subset of the protocol over any
// {@link McpTransport}: it performs `initialize` + `notifications/initialized`, lists
// the server's tools (`tools/list`), and invokes them (`tools/call`). Requests are
// correlated to responses by JSON-RPC id, and each request is bounded by a timeout so a
// silent server cannot hang the extension. The client is transport-agnostic, so it can
// be unit tested against an in-memory fake transport with no process or network.

import type { McpToolDescriptor, McpCallResult } from "./types";
import type { JsonRpcMessage, McpTransport } from "./transport";

/** The MCP protocol revision this client advertises. */
export const MCP_PROTOCOL_VERSION = "2024-11-05";

/** Default per-request timeout in milliseconds. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** Identifies this client to MCP servers during `initialize`. */
export interface ClientInfo {
  readonly name: string;
  readonly version: string;
}

/** A pending request awaiting its correlated response. */
interface PendingRequest {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/**
 * A minimal MCP client covering the handshake and tool operations. One client instance
 * manages one server connection through its injected transport.
 */
export class McpClient {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private closed = false;
  private closeError?: Error;

  public constructor(
    private readonly transport: McpTransport,
    private readonly clientInfo: ClientInfo,
    private readonly requestTimeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
  ) {
    this.transport.onMessage((message) => this.onMessage(message));
    this.transport.onClose((error) => this.onClose(error));
  }

  /**
   * Start the transport and perform the MCP `initialize` handshake, returning the
   * server's advertised capabilities. Must be awaited before {@link listTools} /
   * {@link callTool}.
   */
  public async initialize(): Promise<void> {
    await this.transport.start();
    await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: this.clientInfo,
    });
    // The server expects an `initialized` notification once the handshake completes.
    this.notify("notifications/initialized", {});
  }

  /** List the tools advertised by the server (`tools/list`). */
  public async listTools(): Promise<McpToolDescriptor[]> {
    const result = await this.request("tools/list", {});
    const tools = (result as { tools?: unknown }).tools;
    if (!Array.isArray(tools)) {
      return [];
    }
    return tools
      .filter((tool): tool is Record<string, unknown> => isRecord(tool))
      .map((tool) => ({
        name: String(tool.name ?? ""),
        description: typeof tool.description === "string" ? tool.description : undefined,
        inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : undefined,
      }))
      .filter((tool) => tool.name.length > 0);
  }

  /** Invoke a tool by name with the supplied arguments (`tools/call`). */
  public async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpCallResult> {
    const result = await this.request("tools/call", { name, arguments: args });
    if (!isRecord(result)) {
      return { content: [] };
    }
    return {
      content: Array.isArray(result.content)
        ? (result.content as McpCallResult["content"])
        : [],
      isError: result.isError === true,
      structuredContent: result.structuredContent,
    };
  }

  /** Close the connection, rejecting any in-flight requests. */
  public dispose(): void {
    this.onClose(this.closeError);
    this.transport.stop();
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  /** Send a JSON-RPC request and resolve with its result (or reject on error/timeout). */
  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(this.closeError ?? new Error("MCP client is closed."));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request '${method}' timed out after ${this.requestTimeoutMs} ms.`));
      }, this.requestTimeoutMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Send a JSON-RPC notification (no response expected). */
  private notify(method: string, params: unknown): void {
    this.transport.send({ jsonrpc: "2.0", method, params });
  }

  /** Correlate an inbound response to its pending request. */
  private onMessage(message: JsonRpcMessage): void {
    if (message.id === undefined || typeof message.id !== "number") {
      return; // server request/notification — unsupported subset, ignore
    }
    const pending = this.pending.get(message.id);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error !== undefined) {
      pending.reject(new Error(message.error.message || "MCP server error"));
      return;
    }
    pending.resolve(message.result);
  }

  /** Fail every pending request when the transport closes. */
  private onClose(error?: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeError = error;
    const reason = error ?? new Error("MCP connection closed.");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
  }
}

/** Reduce an MCP tool-call result's content blocks to a single text string. */
export function callResultToText(result: McpCallResult): string {
  const blocks = result.content ?? [];
  const text = blocks
    .map((block) => {
      if (typeof block.text === "string") {
        return block.text;
      }
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      return JSON.stringify(block);
    })
    .join("\n");
  if (text.length > 0) {
    return text;
  }
  if (result.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent);
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
