// Feature: MCP support — server lifecycle + tool integration (McpManager).
//
// `McpManager` is the bridge between the `.vscode/mcp.json` configuration and the
// extension's existing tool pipeline. On {@link reload} it:
//
//   1. reads and parses the config (top-level `servers` + `inputs`),
//   2. resolves each `${input:id}` (prompting the user once, caching the answer) and
//      substitutes `${workspaceFolder}` / `${env:NAME}` in every server field,
//   3. starts each server through an injected transport factory, performs the MCP
//      handshake, and lists its tools,
//   4. maps every discovered tool to a built-in-style {@link ToolDefinition}
//      (namespaced `mcp.<server>.<tool>`, category `mcp`, classification `mutating`)
//      and a {@link CodingTool} whose `execute` proxies to `tools/call`,
//   5. fires {@link onDidChangeTools} so the wiring layer can push the definitions into
//      the `ToolRegistry` and the executable tools into the `ToolHost`.
//
// A failing server never breaks the others (or activation): its error is reported and
// it simply contributes no tools. The manager owns the client connections and shuts
// them down on {@link reload}/{@link dispose}.

import { ToolExecutionError } from "../tools/errors";
import type { CodingTool, JSONSchema, ToolDefinition, ToolOutput } from "../tools/types";

import { callResultToText, McpClient, type ClientInfo } from "./client";
import {
  collectInputRefs,
  parseMcpConfig,
  substitute,
  type SubstitutionContext,
} from "./config";
import {
  HttpTransport,
  StdioTransport,
  type McpTransport,
} from "./transport";
import { isStdioServer, type McpInputDef, type McpServerConfig } from "./types";

/** The prompt callback used to obtain an `${input:id}` value from the user. */
export type InputPrompter = (input: McpInputDef) => Promise<string | undefined>;

/** Reads the raw `.vscode/mcp.json` contents and the workspace folder for substitution. */
export interface McpConfigSource {
  /** Raw file contents, or `undefined` when the file is absent/unreadable. */
  read(): Promise<string | undefined>;
  /** Absolute path substituted for `${workspaceFolder}`; `undefined` when no root. */
  workspaceFolder(): string | undefined;
}

/** Builds a transport for a fully-resolved server config (injectable for tests). */
export type TransportFactory = (config: McpServerConfig) => McpTransport;

/** Construction dependencies for {@link McpManager}. */
export interface McpManagerDeps {
  readonly configSource: McpConfigSource;
  readonly prompt: InputPrompter;
  /** Defaults to real stdio/http transports; tests supply a fake. */
  readonly transportFactory?: TransportFactory;
  /** Identifies the extension to MCP servers. */
  readonly clientInfo?: ClientInfo;
  /** Reports a per-server startup/discovery failure (non-fatal). */
  readonly onError?: (serverId: string, error: Error) => void;
  /** Notified after every reload with the current tool set. */
  readonly onDidChangeTools?: (defs: ToolDefinition[], tools: CodingTool[]) => void;
}

/** A live server connection and the tools it contributed. */
interface ActiveServer {
  readonly id: string;
  readonly client: McpClient;
}

/** Default transport factory: stdio via child process, http via fetch. */
export const defaultTransportFactory: TransportFactory = (config) => {
  if (isStdioServer(config)) {
    return new StdioTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
    });
  }
  return new HttpTransport({ url: config.url, headers: config.headers });
};

/**
 * Manages MCP server connections declared in `.vscode/mcp.json` and exposes their tools
 * to the extension's tool pipeline.
 */
export class McpManager {
  private readonly configSource: McpConfigSource;
  private readonly prompt: InputPrompter;
  private readonly transportFactory: TransportFactory;
  private readonly clientInfo: ClientInfo;
  private readonly onError?: (serverId: string, error: Error) => void;
  private readonly onDidChangeTools?: (defs: ToolDefinition[], tools: CodingTool[]) => void;

  /** Resolved `${input:id}` values, cached across reloads so the user is asked once. */
  private readonly resolvedInputs = new Map<string, string>();

  private active: ActiveServer[] = [];
  private currentDefs: ToolDefinition[] = [];
  private currentTools: CodingTool[] = [];

  public constructor(deps: McpManagerDeps) {
    this.configSource = deps.configSource;
    this.prompt = deps.prompt;
    this.transportFactory = deps.transportFactory ?? defaultTransportFactory;
    this.clientInfo = deps.clientInfo ?? { name: "subconscious-code", version: "0.0.1" };
    this.onError = deps.onError;
    this.onDidChangeTools = deps.onDidChangeTools;
  }

  /** The MCP tool definitions from the most recent reload. */
  public toolDefinitions(): ToolDefinition[] {
    return [...this.currentDefs];
  }

  /** The executable MCP tools from the most recent reload. */
  public codingTools(): CodingTool[] {
    return [...this.currentTools];
  }

  /**
   * Re-read the configuration, restart all servers, and rediscover their tools. Safe to
   * call repeatedly (e.g. when `.vscode/mcp.json` changes). Never throws: a bad config or
   * a failing server yields an empty/partial tool set and reports the error.
   */
  public async reload(): Promise<void> {
    this.shutdownServers();

    const raw = await this.configSource.read();
    const parsed = raw !== undefined ? parseMcpConfig(raw) : undefined;
    const servers = parsed?.servers ?? {};
    const inputDefs = parsed?.inputs ?? [];

    const defs: ToolDefinition[] = [];
    const tools: CodingTool[] = [];

    for (const [serverId, config] of Object.entries(servers)) {
      try {
        const resolved = await this.resolveConfig(config, inputDefs);
        const client = new McpClient(
          this.transportFactory(resolved),
          this.clientInfo,
        );
        await client.initialize();
        const discovered = await client.listTools();
        this.active.push({ id: serverId, client });

        for (const tool of discovered) {
          const id = `mcp.${serverId}.${tool.name}`;
          defs.push(this.toDefinition(id, serverId, tool.name, tool.description, tool.inputSchema));
          tools.push(this.toCodingTool(id, client, tool.name));
        }
      } catch (error) {
        this.onError?.(
          serverId,
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }

    this.currentDefs = defs;
    this.currentTools = tools;
    this.onDidChangeTools?.(this.toolDefinitions(), this.codingTools());
  }

  /** Shut down all servers and clear the tool set. */
  public dispose(): void {
    this.shutdownServers();
    this.currentDefs = [];
    this.currentTools = [];
    this.onDidChangeTools?.([], []);
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  /** Resolve `${input:id}` values (prompting once) and substitute all server fields. */
  private async resolveConfig(
    config: McpServerConfig,
    inputDefs: readonly McpInputDef[],
  ): Promise<McpServerConfig> {
    for (const id of collectInputRefs(config)) {
      if (this.resolvedInputs.has(id)) {
        continue;
      }
      const def =
        inputDefs.find((candidate) => candidate.id === id) ??
        ({ type: "promptString", id } as McpInputDef);
      const value = await this.prompt(def);
      this.resolvedInputs.set(id, value ?? "");
    }

    const ctx: SubstitutionContext = {
      workspaceFolder: this.configSource.workspaceFolder(),
      inputs: Object.fromEntries(this.resolvedInputs),
    };
    return substituteConfig(config, ctx);
  }

  /** Build a registry definition for an MCP tool. */
  private toDefinition(
    id: string,
    serverId: string,
    toolName: string,
    description: string | undefined,
    inputSchema: Record<string, unknown> | undefined,
  ): ToolDefinition {
    return {
      id,
      displayName: toolName,
      description: description ?? `MCP tool '${toolName}' provided by '${serverId}'.`,
      inputSchema: (inputSchema as JSONSchema | undefined) ?? { type: "object" },
      category: "mcp",
      classification: "mutating",
      defaultEnabled: true,
      source: "mcp",
      serverId,
      serverLabel: serverId,
    };
  }

  /** Build the executable tool that proxies `execute` to the MCP `tools/call`. */
  private toCodingTool(id: string, client: McpClient, toolName: string): CodingTool {
    return {
      id,
      async execute(input: unknown): Promise<ToolOutput> {
        const args =
          typeof input === "object" && input !== null && !Array.isArray(input)
            ? (input as Record<string, unknown>)
            : {};
        let result;
        try {
          result = await client.callTool(toolName, args);
        } catch (error) {
          throw new ToolExecutionError({
            kind: "execution",
            message: `MCP tool '${toolName}' failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        }
        if (result.isError === true) {
          throw new ToolExecutionError({
            kind: "execution",
            message: callResultToText(result) || `MCP tool '${toolName}' reported an error.`,
          });
        }
        return { content: callResultToText(result), data: { structured: result.structuredContent } };
      },
    };
  }

  /** Dispose every active client connection. */
  private shutdownServers(): void {
    for (const server of this.active) {
      try {
        server.client.dispose();
      } catch {
        // best-effort shutdown
      }
    }
    this.active = [];
  }
}

/** Apply `${...}` substitution to every string field of a server config. */
export function substituteConfig(
  config: McpServerConfig,
  ctx: SubstitutionContext,
): McpServerConfig {
  if (isStdioServer(config)) {
    return {
      type: "stdio",
      command: substitute(config.command, ctx),
      ...(config.args !== undefined
        ? { args: config.args.map((arg) => substitute(arg, ctx)) }
        : {}),
      ...(config.env !== undefined ? { env: substituteMap(config.env, ctx) } : {}),
      ...(config.cwd !== undefined ? { cwd: substitute(config.cwd, ctx) } : {}),
    };
  }
  return {
    type: config.type,
    url: substitute(config.url, ctx),
    ...(config.headers !== undefined ? { headers: substituteMap(config.headers, ctx) } : {}),
  };
}

/** Substitute every value of a string map. */
function substituteMap(
  map: Readonly<Record<string, string>>,
  ctx: SubstitutionContext,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    out[key] = substitute(value, ctx);
  }
  return out;
}
