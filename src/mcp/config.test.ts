// Feature: MCP support — unit tests for `.vscode/mcp.json` parsing and substitution.
//
// These are pure-module Node/Mocha tests (no VS Code host): the parser and the
// `${...}` substitution are host-independent functions.

import * as assert from "assert";

import {
  collectInputRefs,
  parseMcpConfig,
  stripJsonComments,
  substitute,
} from "./config";
import { isStdioServer } from "./types";

describe("MCP config parsing", () => {
  it("parses a VS Code `servers` map with a stdio server", () => {
    const parsed = parseMcpConfig(
      JSON.stringify({
        servers: {
          fs: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem"] },
        },
      }),
    );
    assert.ok(parsed);
    const server = parsed.servers.fs;
    assert.ok(server);
    assert.ok(isStdioServer(server));
    if (isStdioServer(server)) {
      assert.strictEqual(server.command, "npx");
      assert.deepStrictEqual(server.args, ["-y", "@modelcontextprotocol/server-filesystem"]);
    }
  });

  it("accepts the Claude/Cursor `mcpServers` key as a fallback", () => {
    const parsed = parseMcpConfig(
      JSON.stringify({ mcpServers: { db: { command: "uvx", args: ["mcp-db"] } } }),
    );
    assert.ok(parsed);
    assert.ok(parsed.servers.db);
  });

  it("parses an http server with headers and inputs", () => {
    const parsed = parseMcpConfig(
      JSON.stringify({
        inputs: [{ type: "promptString", id: "key", description: "API key", password: true }],
        servers: {
          remote: {
            type: "http",
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer ${input:key}" },
          },
        },
      }),
    );
    assert.ok(parsed);
    const server = parsed.servers.remote;
    assert.ok(server);
    assert.strictEqual(isStdioServer(server), false);
    if (!isStdioServer(server)) {
      assert.strictEqual(server.type, "http");
      assert.strictEqual(server.url, "https://example.com/mcp");
    }
    assert.strictEqual(parsed.inputs?.[0].id, "key");
    assert.strictEqual(parsed.inputs?.[0].password, true);
  });

  it("tolerates JSONC comments and trailing commas", () => {
    const raw = `{
      // filesystem server
      "servers": {
        "fs": { "command": "npx", "args": ["-y", "server"], },
      },
    }`;
    const parsed = parseMcpConfig(raw);
    assert.ok(parsed);
    assert.ok(parsed.servers.fs);
  });

  it("drops malformed server entries but keeps the valid ones", () => {
    const parsed = parseMcpConfig(
      JSON.stringify({
        servers: {
          good: { command: "node" },
          bad: { nonsense: true },
          badHttp: { type: "http" },
        },
      }),
    );
    assert.ok(parsed);
    assert.ok(parsed.servers.good);
    assert.strictEqual(parsed.servers.bad, undefined);
    assert.strictEqual(parsed.servers.badHttp, undefined);
  });

  it("returns undefined for non-JSON input", () => {
    assert.strictEqual(parseMcpConfig("not json {{{"), undefined);
  });
});

describe("stripJsonComments", () => {
  it("keeps `//` inside string values intact", () => {
    const out = stripJsonComments('{"url":"https://example.com"}');
    assert.strictEqual(out, '{"url":"https://example.com"}');
  });
});

describe("MCP substitution", () => {
  it("substitutes workspaceFolder, env, and input placeholders", () => {
    const result = substitute("${workspaceFolder}/bin --key ${input:key} --home ${env:HOME}", {
      workspaceFolder: "/repo",
      inputs: { key: "secret" },
      env: { HOME: "/home/u" },
    });
    assert.strictEqual(result, "/repo/bin --key secret --home /home/u");
  });

  it("leaves unknown input placeholders intact for detection", () => {
    const result = substitute("${input:missing}", { inputs: {} });
    assert.strictEqual(result, "${input:missing}");
  });

  it("collects distinct input references across all fields", () => {
    const refs = collectInputRefs({
      type: "http",
      url: "https://x/${input:a}",
      headers: { Authorization: "Bearer ${input:b}", Extra: "${input:a}" },
    });
    assert.deepStrictEqual(refs.sort(), ["a", "b"]);
  });
});
