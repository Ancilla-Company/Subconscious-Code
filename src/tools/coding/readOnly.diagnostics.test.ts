// Feature: agent-tools-and-settings — unit tests for `get_diagnostics` mapping.
//
// Validates: Requirements 6.2 (diagnostics wrapping)
//
// These example-based unit tests assert that `get_diagnostics` maps the diagnostics
// reported by VS Code into the `ToolOutput` contract: the structured per-resource
// diagnostics are surfaced verbatim in `output.data`, the total count is reported,
// and `output.content` carries a human-readable summary that reflects each
// diagnostic's location, severity label, source, and message.
//
// The tool is exercised outside the VS Code host: its `DiagnosticsSource` collaborator
// (which in production wraps `vscode.languages.getDiagnostics`) is supplied as a fake
// so the mapping is verified deterministically. The `../test/vscodeStub` import MUST
// come first because `./readOnly` imports the `vscode` module at load time; the stub
// installs a minimal stand-in under the Node-level runner.
import "../../test/vscodeStub";

import * as assert from "assert";

import type { PathResolution, ToolContext, WorkspacePathGuard } from "../types";
import {
  GetDiagnosticsTool,
  type DiagnosticEntry,
  type DiagnosticsSource,
} from "./readOnly";

/** A `DiagnosticsSource` fake returning a fixed set and recording its argument. */
class FakeDiagnosticsSource implements DiagnosticsSource {
  public lastResolvedPath: string | undefined = "<<uncalled>>";

  public constructor(private readonly entries: readonly DiagnosticEntry[]) {}

  public collect(resolvedPath?: string): readonly DiagnosticEntry[] {
    this.lastResolvedPath = resolvedPath;
    return this.entries;
  }
}

/** A guard that accepts any path and treats it as its own canonical form. */
const passthroughGuard: WorkspacePathGuard = {
  roots(): string[] {
    return ["/workspace"];
  },
  resolve(inputPath: string): PathResolution {
    return { ok: true, canonicalPath: inputPath, root: "/workspace" };
  },
};

function makeContext(): ToolContext {
  return {
    guard: passthroughGuard,
    profile: undefined,
    signal: new AbortController().signal,
  };
}

describe("get_diagnostics wrapping (Requirement 6.2)", () => {
  const entries: DiagnosticEntry[] = [
    {
      uri: "/workspace/src/app.ts",
      diagnostics: [
        {
          message: "Cannot find name 'foo'.",
          severity: 0, // error
          source: "ts",
          code: 2304,
          range: {
            start: { line: 9, character: 4 },
            end: { line: 9, character: 7 },
          },
        },
        {
          message: "'bar' is declared but never used.",
          severity: 1, // warning
          source: "ts",
          code: 6133,
          range: {
            start: { line: 20, character: 0 },
            end: { line: 20, character: 3 },
          },
        },
      ],
    },
    {
      uri: "/workspace/src/util.ts",
      diagnostics: [
        {
          message: "Consider using const.",
          severity: 2, // information
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 5 },
          },
        },
      ],
    },
  ];

  it("maps the collected diagnostics verbatim into ToolOutput.data with a total count", async () => {
    const source = new FakeDiagnosticsSource(entries);
    const tool = new GetDiagnosticsTool(source);

    const output = await tool.execute({}, makeContext());

    // Structured diagnostics are surfaced verbatim, grouped by resource.
    assert.deepStrictEqual(output.data?.diagnostics, entries);
    // The reported count is the total across every resource.
    assert.strictEqual(output.data?.count, 3);
  });

  it("summarizes each diagnostic in content with location, severity, source, and message", async () => {
    const source = new FakeDiagnosticsSource(entries);
    const tool = new GetDiagnosticsTool(source);

    const output = await tool.execute({}, makeContext());
    const lines = output.content.split("\n");

    // One human-readable line per diagnostic.
    assert.strictEqual(lines.length, 3);
    // Line/character are surfaced 1-based; severity label and source are included.
    assert.strictEqual(
      lines[0],
      "/workspace/src/app.ts:10:5: error [ts]: Cannot find name 'foo'."
    );
    assert.strictEqual(
      lines[1],
      "/workspace/src/app.ts:21:1: warning [ts]: 'bar' is declared but never used."
    );
    // A diagnostic without a `source` omits the bracketed origin.
    assert.strictEqual(
      lines[2],
      "/workspace/src/util.ts:1:1: information: Consider using const."
    );
  });

  it("reports an empty diagnostic set as a zero count and a clear message", async () => {
    const source = new FakeDiagnosticsSource([]);
    const tool = new GetDiagnosticsTool(source);

    const output = await tool.execute({}, makeContext());

    assert.strictEqual(output.data?.count, 0);
    assert.deepStrictEqual(output.data?.diagnostics, []);
    assert.strictEqual(output.content, "No diagnostics reported.");
  });

  it("passes the resolved workspace path through to the diagnostics source when a path is supplied", async () => {
    const source = new FakeDiagnosticsSource(entries);
    const tool = new GetDiagnosticsTool(source);

    await tool.execute({ path: "/workspace/src/app.ts" }, makeContext());

    // The path was resolved through the guard and forwarded to the source.
    assert.strictEqual(source.lastResolvedPath, "/workspace/src/app.ts");
  });

  it("collects workspace-wide diagnostics (undefined path) when no path is supplied", async () => {
    const source = new FakeDiagnosticsSource(entries);
    const tool = new GetDiagnosticsTool(source);

    await tool.execute({}, makeContext());

    assert.strictEqual(source.lastResolvedPath, undefined);
  });
});
