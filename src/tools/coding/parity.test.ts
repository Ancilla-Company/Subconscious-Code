// Feature: agent-tools-and-settings — unit tests for the Copilot-parity tools.
//
// Pure-module Node/Mocha tests: each tool's VS Code / git interaction is injected, so
// the mapping into `ToolOutput` (and the typed error paths) is verified without the
// extension host, git, or real tasks. The `vscodeStub` import MUST come first so the
// module-level `import * as vscode` in `parity.ts` resolves to the Node stub.
import "../../test/vscodeStub";

import * as assert from "assert";

import {
  GetChangesTool,
  ListCodeUsagesTool,
  RunTaskTool,
  type CodeUsage,
} from "./parity";
import { isToolExecutionError } from "../errors";
import type { ToolContext, WorkspacePathGuard } from "../types";

/** A guard exposing the given roots; `resolve` is unused by the parity tools. */
function guardWithRoots(roots: string[]): WorkspacePathGuard {
  return {
    roots: () => roots,
    resolve: () => ({ ok: false, error: "no-workspace" }),
  };
}

function ctxWith(roots: string[]): ToolContext {
  return {
    guard: guardWithRoots(roots),
    profile: undefined,
    signal: new AbortController().signal,
  };
}

describe("ListCodeUsagesTool", () => {
  it("formats resolved usages and reports the count", async () => {
    const usages: CodeUsage[] = [
      { uri: "/repo/a.ts", line: 10, character: 3 },
      { uri: "/repo/b.ts", line: 2, character: 1 },
    ];
    const tool = new ListCodeUsagesTool({ find: async () => usages });

    const output = await tool.execute({ symbol: "doThing" }, ctxWith(["/repo"]));

    assert.match(output.content, /\/repo\/a\.ts:10:3/);
    assert.match(output.content, /\/repo\/b\.ts:2:1/);
    assert.strictEqual((output.data as { count: number }).count, 2);
  });

  it("reports when no usages are found", async () => {
    const tool = new ListCodeUsagesTool({ find: async () => [] });
    const output = await tool.execute({ symbol: "missing" }, ctxWith(["/repo"]));
    assert.match(output.content, /No usages found/);
  });

  it("rejects a missing symbol as a validation error", async () => {
    const tool = new ListCodeUsagesTool({ find: async () => [] });
    await assert.rejects(
      () => tool.execute({}, ctxWith(["/repo"])),
      (error) => isToolExecutionError(error) && error.toolError.kind === "validation",
    );
  });

  it("reports no-workspace when no root is open", async () => {
    const tool = new ListCodeUsagesTool({ find: async () => [] });
    await assert.rejects(
      () => tool.execute({ symbol: "x" }, ctxWith([])),
      (error) => isToolExecutionError(error) && error.toolError.kind === "no-workspace",
    );
  });
});

describe("GetChangesTool", () => {
  it("returns the diff and passes the staged flag through", async () => {
    let sawStaged: boolean | undefined;
    const tool = new GetChangesTool(async (request) => {
      sawStaged = request.staged;
      return "diff --git a b\n+added";
    });

    const output = await tool.execute({ staged: true }, ctxWith(["/repo"]));

    assert.strictEqual(sawStaged, true);
    assert.match(output.content, /\+added/);
    assert.strictEqual((output.data as { empty: boolean }).empty, false);
  });

  it("reports no changes for an empty diff", async () => {
    const tool = new GetChangesTool(async () => "   ");
    const output = await tool.execute({}, ctxWith(["/repo"]));
    assert.strictEqual(output.content, "No changes.");
    assert.strictEqual((output.data as { empty: boolean }).empty, true);
  });
});

describe("RunTaskTool", () => {
  it("reports a completed task with its exit code", async () => {
    const tool = new RunTaskTool({ run: async () => ({ found: true, exitCode: 0 }) });
    const output = await tool.execute({ task: "build" }, ctxWith(["/repo"]));
    assert.match(output.content, /exit code 0/);
    assert.strictEqual((output.data as { exitCode: number }).exitCode, 0);
  });

  it("raises an execution error when the task is not configured", async () => {
    const tool = new RunTaskTool({ run: async () => ({ found: false }) });
    await assert.rejects(
      () => tool.execute({ task: "nope" }, ctxWith(["/repo"])),
      (error) => isToolExecutionError(error) && error.toolError.kind === "execution",
    );
  });
});
