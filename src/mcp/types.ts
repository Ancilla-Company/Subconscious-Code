// Feature: MCP support — shared types for the Model Context Protocol subsystem.
//
// The extension hosts MCP clients itself (per the agreed architecture): it reads the
// VS Code–standard `.vscode/mcp.json`, starts each configured server, discovers its
// tools, and registers them with the engine alongside the built-in coding tools. These
// types describe the on-disk configuration shape (matching VS Code's `servers` key —
// NOT Claude's `mcpServers`) and the subset of the MCP wire protocol the client uses.

// -----------------------------------------------------------------------------
// .vscode/mcp.json configuration shape
// -----------------------------------------------------------------------------

/** A stdio MCP server: a local process the extension spawns and speaks JSON-RPC to. */
export interface StdioServerConfig {
  readonly type?: "stdio";
  /** Executable to launch (e.g. `npx`, `uvx`, an absolute path). */
  readonly command: string;
  /** Arguments passed to the executable. */
  readonly args?: readonly string[];
  /** Extra environment variables for the server process. */
  readonly env?: Readonly<Record<string, string>>;
  /** Working directory; defaults to the workspace folder. */
  readonly cwd?: string;
}

/** A remote MCP server reached over Streamable HTTP (or SSE). */
export interface HttpServerConfig {
  readonly type: "http" | "sse";
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}

/** A single server entry, keyed by its name in the `servers` map. */
export type McpServerConfig = StdioServerConfig | HttpServerConfig;

/** An `${input:id}` placeholder definition prompting the user for a value. */
export interface McpInputDef {
  readonly type: "promptString";
  readonly id: string;
  readonly description?: string;
  /** When true the entered value is masked and never echoed. */
  readonly password?: boolean;
}

/** The parsed `.vscode/mcp.json` document. */
export interface McpConfigFile {
  readonly servers: Readonly<Record<string, McpServerConfig>>;
  readonly inputs?: readonly McpInputDef[];
}

/** Narrow a server config to the stdio variant. */
export function isStdioServer(config: McpServerConfig): config is StdioServerConfig {
  return (
    (config as HttpServerConfig).type !== "http" &&
    (config as HttpServerConfig).type !== "sse"
  );
}

// -----------------------------------------------------------------------------
// MCP wire protocol (subset)
// -----------------------------------------------------------------------------

/** A tool as advertised by an MCP server's `tools/list` result. */
export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: Record<string, unknown>;
}

/** A single content block from a `tools/call` result. */
export interface McpContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly [key: string]: unknown;
}

/** The result payload of an MCP `tools/call`. */
export interface McpCallResult {
  readonly content?: readonly McpContentBlock[];
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
}
