// Feature: MCP support — JSON-RPC transports for MCP servers.
//
// The extension hosts MCP clients itself, so it needs to speak the two transports the
// VS Code `.vscode/mcp.json` format describes:
//
//   - stdio: a local child process; JSON-RPC messages are newline-delimited on the
//     process's stdin/stdout (the MCP stdio framing).
//   - http:  a remote server reached over HTTP; each JSON-RPC request is POSTed and the
//     response body (JSON, or the first JSON object of an SSE stream) is delivered back.
//
// Both are reduced to a single {@link McpTransport} surface (`start` / `send` /
// `onMessage` / `onClose` / `stop`) so {@link McpClient} is transport-agnostic and can
// be unit tested against an in-memory fake. No third-party dependency is introduced:
// stdio uses `child_process.spawn` and http uses the global `fetch` (Node 20+).

import { spawn, type ChildProcessWithoutNullStreams } from "child_process";

// -----------------------------------------------------------------------------
// JSON-RPC message shape
// -----------------------------------------------------------------------------

/** A JSON-RPC 2.0 message (request, response, or notification). */
export interface JsonRpcMessage {
  readonly jsonrpc: "2.0";
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string; readonly data?: unknown };
}

/** Handler invoked for every inbound JSON-RPC message. */
export type MessageHandler = (message: JsonRpcMessage) => void;

/** Handler invoked once when the transport closes (optionally with the cause). */
export type CloseHandler = (error?: Error) => void;

/**
 * The minimal transport surface {@link McpClient} writes through. Implemented by the
 * stdio and http transports and by test fakes.
 */
export interface McpTransport {
  /** Establish the connection (spawn the process / prepare the HTTP endpoint). */
  start(): Promise<void>;
  /** Send a JSON-RPC message to the server. */
  send(message: JsonRpcMessage): void;
  /** Register the inbound-message handler. */
  onMessage(handler: MessageHandler): void;
  /** Register the close handler. */
  onClose(handler: CloseHandler): void;
  /** Terminate the connection and release resources. */
  stop(): void;
}

// -----------------------------------------------------------------------------
// stdio transport
// -----------------------------------------------------------------------------

/** Options for a {@link StdioTransport}. */
export interface StdioTransportOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

/**
 * MCP stdio transport: spawns the configured command and exchanges newline-delimited
 * JSON-RPC messages over the child's stdin/stdout. The child's stderr is drained so it
 * cannot block, but is not treated as protocol data.
 */
export class StdioTransport implements McpTransport {
  private child?: ChildProcessWithoutNullStreams;
  private buffer = "";
  private messageHandler?: MessageHandler;
  private closeHandler?: CloseHandler;

  public constructor(private readonly options: StdioTransportOptions) {}

  public start(): Promise<void> {
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.options.command, [...(this.options.args ?? [])], {
          cwd: this.options.cwd,
          env: { ...process.env, ...(this.options.env ?? {}) },
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.child = child;

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.ingest(chunk));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", () => undefined); // drain; not protocol data
      child.on("error", (error) => {
        this.closeHandler?.(error);
        reject(error);
      });
      child.on("close", (code) => {
        this.closeHandler?.(
          code === 0 || code === null
            ? undefined
            : new Error(`MCP server exited with code ${code}`),
        );
      });

      // The process is considered started once spawned; the MCP `initialize`
      // handshake (driven by the client) confirms it actually speaks the protocol.
      resolve();
    });
  }

  public send(message: JsonRpcMessage): void {
    const child = this.child;
    if (child === undefined || child.stdin.destroyed) {
      return;
    }
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  public onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  public onClose(handler: CloseHandler): void {
    this.closeHandler = handler;
  }

  public stop(): void {
    const child = this.child;
    this.child = undefined;
    if (child !== undefined && !child.killed) {
      child.kill();
    }
  }

  /** Buffer stdout and dispatch each complete newline-delimited JSON message. */
  private ingest(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) {
        this.dispatch(line);
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  /** Parse a single line as JSON-RPC and forward it; malformed lines are ignored. */
  private dispatch(line: string): void {
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line) as JsonRpcMessage;
    } catch {
      return;
    }
    this.messageHandler?.(message);
  }
}

// -----------------------------------------------------------------------------
// http transport
// -----------------------------------------------------------------------------

/** Options for an {@link HttpTransport}. */
export interface HttpTransportOptions {
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/**
 * MCP Streamable-HTTP transport (request/response subset): each outbound request is
 * POSTed to the endpoint and the response — a JSON object, or the first `data:` event
 * of an SSE stream — is delivered back through the message handler. Server-initiated
 * SSE notifications are not consumed; the tool-listing/-calling flow only issues
 * client requests, so a plain request/response model is sufficient.
 */
export class HttpTransport implements McpTransport {
  private messageHandler?: MessageHandler;
  private closeHandler?: CloseHandler;
  private stopped = false;

  public constructor(private readonly options: HttpTransportOptions) {}

  public async start(): Promise<void> {
    // Nothing to establish up front; the first `send` performs the request.
    return;
  }

  public send(message: JsonRpcMessage): void {
    // Notifications (no id) expect no response; still POST them, ignore the body.
    void this.post(message);
  }

  public onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  public onClose(handler: CloseHandler): void {
    this.closeHandler = handler;
  }

  public stop(): void {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.closeHandler?.();
  }

  /** POST one message and route its response (if any) back to the message handler. */
  private async post(message: JsonRpcMessage): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      const response = await fetch(this.options.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(this.options.headers ?? {}),
        },
        body: JSON.stringify(message),
      });
      if (message.id === undefined) {
        return; // notification: no response expected
      }
      const text = await response.text();
      const parsed = parseHttpBody(text);
      if (parsed !== undefined) {
        this.messageHandler?.(parsed);
      }
    } catch (error) {
      this.closeHandler?.(error instanceof Error ? error : new Error(String(error)));
    }
  }
}

/**
 * Parse an HTTP response body that is either a single JSON-RPC object or an SSE stream
 * (`data: {json}` lines). Returns the first JSON-RPC message found, or `undefined`.
 */
export function parseHttpBody(text: string): JsonRpcMessage | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  // Plain JSON body.
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      return undefined;
    }
  }
  // SSE framing: take the first `data:` payload that parses as JSON.
  for (const line of trimmed.split(/\r?\n/)) {
    const match = /^data:\s*(.*)$/.exec(line);
    if (match !== null) {
      try {
        return JSON.parse(match[1]) as JsonRpcMessage;
      } catch {
        // keep scanning
      }
    }
  }
  return undefined;
}
