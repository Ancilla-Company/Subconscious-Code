// Feature: MCP support — reading and validating `.vscode/mcp.json`.
//
// Parses the VS Code–standard MCP configuration file (top-level `servers` map plus an
// optional `inputs` array) into a validated {@link McpConfigFile}, and performs the
// `${...}` variable substitution VS Code supports: `${workspaceFolder}`, `${env:NAME}`,
// and `${input:id}` (the resolved input values are supplied by the caller, which
// prompts the user). The parser is pure and host-independent so it can be unit tested
// outside the VS Code host; JSONC (comments / trailing commas) is tolerated.

import {
  isStdioServer,
  type HttpServerConfig,
  type McpConfigFile,
  type McpInputDef,
  type McpServerConfig,
  type StdioServerConfig,
} from "./types";

/** Values used to resolve `${...}` placeholders during substitution. */
export interface SubstitutionContext {
  /** Absolute path substituted for `${workspaceFolder}`. */
  readonly workspaceFolder?: string;
  /** Values keyed by input id, substituted for `${input:id}`. */
  readonly inputs: Readonly<Record<string, string>>;
  /** Environment map substituted for `${env:NAME}`; defaults to `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** Strip `//` and `/* *\/` comments and trailing commas so JSONC parses as JSON. */
export function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  // Remove trailing commas before } or ].
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** Parse a raw `.vscode/mcp.json` string into a validated config, or `undefined`. */
export function parseMcpConfig(raw: string): McpConfigFile | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  // Accept both `servers` (VS Code) and `mcpServers` (Claude/Cursor) for convenience.
  const rawServers = isRecord(parsed.servers)
    ? parsed.servers
    : isRecord(parsed.mcpServers)
      ? parsed.mcpServers
      : undefined;
  if (rawServers === undefined) {
    return { servers: {}, inputs: parseInputs(parsed.inputs) };
  }

  const servers: Record<string, McpServerConfig> = {};
  for (const [name, value] of Object.entries(rawServers)) {
    const server = parseServer(value);
    if (server !== undefined) {
      servers[name] = server;
    }
  }
  return { servers, inputs: parseInputs(parsed.inputs) };
}

function parseServer(value: unknown): McpServerConfig | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const type = value.type;
  if (type === "http" || type === "sse") {
    if (typeof value.url !== "string" || value.url.length === 0) {
      return undefined;
    }
    const http: HttpServerConfig = {
      type,
      url: value.url,
      ...(isStringMap(value.headers) ? { headers: value.headers } : {}),
    };
    return http;
  }
  // stdio (explicit or implied by a `command`).
  if (typeof value.command !== "string" || value.command.length === 0) {
    return undefined;
  }
  const stdio: StdioServerConfig = {
    type: "stdio",
    command: value.command,
    ...(Array.isArray(value.args)
      ? { args: value.args.filter((a): a is string => typeof a === "string") }
      : {}),
    ...(isStringMap(value.env) ? { env: value.env } : {}),
    ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
  };
  return stdio;
}

function parseInputs(value: unknown): McpInputDef[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const inputs: McpInputDef[] = [];
  for (const entry of value) {
    if (isRecord(entry) && typeof entry.id === "string") {
      inputs.push({
        type: "promptString",
        id: entry.id,
        ...(typeof entry.description === "string"
          ? { description: entry.description }
          : {}),
        ...(entry.password === true ? { password: true } : {}),
      });
    }
  }
  return inputs;
}

/**
 * Substitute `${workspaceFolder}`, `${env:NAME}`, and `${input:id}` placeholders in a
 * string. Unknown placeholders are left intact so the caller can detect them.
 */
export function substitute(value: string, ctx: SubstitutionContext): string {
  const env = ctx.env ?? process.env;
  return value.replace(/\$\{(\w+)(?::([^}]*))?\}/g, (match, kind: string, arg?: string) => {
    if (kind === "workspaceFolder") {
      return ctx.workspaceFolder ?? match;
    }
    if (kind === "env" && arg !== undefined) {
      return env[arg] ?? "";
    }
    if (kind === "input" && arg !== undefined) {
      return ctx.inputs[arg] ?? match;
    }
    return match;
  });
}

/** Collect the distinct `${input:id}` ids referenced anywhere in a server config. */
export function collectInputRefs(config: McpServerConfig): string[] {
  const ids = new Set<string>();
  const scan = (text: unknown): void => {
    if (typeof text !== "string") {
      return;
    }
    const re = /\$\{input:([^}]+)\}/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      ids.add(m[1]);
    }
  };

  if (isStdioServer(config)) {
    scan(config.command);
    for (const arg of config.args ?? []) {
      scan(arg);
    }
    for (const v of Object.values(config.env ?? {})) {
      scan(v);
    }
  } else {
    scan(config.url);
    for (const v of Object.values(config.headers ?? {})) {
      scan(v);
    }
  }
  return [...ids];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringMap(value: unknown): value is Record<string, string> {
  return (
    isRecord(value) && Object.values(value).every((v) => typeof v === "string")
  );
}
