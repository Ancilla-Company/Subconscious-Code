// Feature: agent-tools-and-settings — unit tests for the start_debug tool.
//
// Pure-module Node/Mocha tests: the `vscode.debug` interaction is injected via a fake
// DebugController, so the tool's logic (config discovery, unknown-config handling,
// start + wait) is verified without the extension host. `vscodeStub` is imported first
// so the module-level `import * as vscode` in `debug.ts` resolves.
import "../../test/vscodeStub";

import * as assert from "assert";

import {
  StartDebugTool,
  type DebugController,
  type DebugRunResult,
  type DebugStartRequest,
} from "./debug";
import { isToolExecutionError } from "../errors";
import type { ToolContext, WorkspacePathGuard } from "../types";

function guard(roots: string[]): WorkspacePathGuard {
  return { roots: () => roots, resolve: () => ({ ok: false, error: "no-workspace" }) };
}

function ctx(roots: string[]): ToolContext {
  return { guard: guard(roots), profile: undefined, signal: new AbortController().signal };
}

class FakeController implements DebugController {
  public lastRequest?: DebugStartRequest;
  public constructor(
    private readonly configs: string[],
    private readonly result: DebugRunResult = { started: true, sessionName: "Run" },
  ) {}
  public listConfigurations(): string[] {
    return this.configs;
  }
  public async start(request: DebugStartRequest): Promise<DebugRunResult> {
    this.lastRequest = request;
    return this.result;
  }
}

describe("StartDebugTool", () => {
  it("lists available configurations when none is specified", async () => {
    const tool = new StartDebugTool(new FakeController(["Run API", "Pytest"]));
    const out = await tool.execute({}, ctx(["/repo"]));
    assert.match(out.content, /Run API, Pytest/);
    assert.strictEqual((out.data as { started: boolean }).started, false);
  });

  it("reports the valid names when an unknown configuration is requested", async () => {
    const tool = new StartDebugTool(new FakeController(["Run API"]));
    const out = await tool.execute({ configuration: "Nope" }, ctx(["/repo"]));
    assert.match(out.content, /No launch configuration named "Nope"/);
    assert.match(out.content, /Run API/);
  });

  it("starts a known configuration and reports the session", async () => {
    const controller = new FakeController(["Run API"], { started: true, sessionName: "Run API" });
    const tool = new StartDebugTool(controller);
    const out = await tool.execute({ configuration: "Run API" }, ctx(["/repo"]));
    assert.match(out.content, /Debug session 'Run API' started/);
    assert.strictEqual(controller.lastRequest?.configuration, "Run API");
    assert.strictEqual(controller.lastRequest?.waitForExit, false);
  });

  it("waits for termination and includes output/exit code when requested", async () => {
    const controller = new FakeController(["Run API"], {
      started: true,
      sessionName: "Run API",
      terminated: true,
      exitCode: 0,
      output: "hello world\n",
    });
    const tool = new StartDebugTool(controller);
    const out = await tool.execute({ configuration: "Run API", waitForExit: true }, ctx(["/repo"]));
    assert.match(out.content, /exit code 0/);
    assert.match(out.content, /hello world/);
    assert.strictEqual(controller.lastRequest?.waitForExit, true);
  });

  it("reports no-workspace when no folder is open", async () => {
    const tool = new StartDebugTool(new FakeController([]));
    await assert.rejects(
      () => tool.execute({ configuration: "x" }, ctx([])),
      (e) => isToolExecutionError(e) && e.toolError.kind === "no-workspace",
    );
  });
});
