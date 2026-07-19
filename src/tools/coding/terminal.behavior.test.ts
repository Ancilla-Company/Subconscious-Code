// Feature: agent-tools-and-settings — example unit tests for the terminal tools (Task 9.7).
//
// These are example-based unit tests (not the fast-check property tests of Tasks
// 9.8–9.10). They exercise `RunTerminalTool` and `RunTestsTool` against an INJECTED
// FAKE command-runner and a fake approval surface, so no real shell/conda process is
// ever spawned. They cover the task's core behaviours: the working directory is a
// Workspace_Root (Requirement 6.6), recorded activation is applied (Requirement
// 11.11), an unappliable activation aborts with `activation-failure` and never runs
// (Requirement 11.13), a declined confirmation runs nothing (Requirement 10.4), and
// `run_tests` runs the profile's recorded test command.
import * as assert from "assert";

import type { ExecutionProfile } from "../../env/types";
import type { ApprovalDecision, ApprovalPrompt } from "../approvalManager";
import { ToolExecutionError, isToolExecutionError } from "../errors";
import type { ToolContext, ToolDefinition, WorkspacePathGuard } from "../types";
import {
  RunTerminalTool,
  RunTestsTool,
  type CommandInvocation,
  type CommandRunResult,
  type CommandRunner,
  type TerminalApprover,
} from "./terminal";

// -----------------------------------------------------------------------------
// Test doubles
// -----------------------------------------------------------------------------

/** A path guard whose roots are fixed and whose resolve is unused by these tools. */
function fakeGuard(roots: string[]): WorkspacePathGuard {
  return {
    roots: (): string[] => [...roots],
    resolve: () => ({ ok: false, error: "out-of-scope" }),
  };
}

/** Records each invocation and returns a canned result; never spawns a process. */
class RecordingRunner {
  public readonly calls: CommandInvocation[] = [];

  public readonly run: CommandRunner = async (
    invocation: CommandInvocation,
  ): Promise<CommandRunResult> => {
    this.calls.push(invocation);
    return { exitCode: 0, stdout: "ok", stderr: "" };
  };
}

/** An approver that either auto-approves or prompts and returns a fixed decision. */
class FakeApprover implements TerminalApprover {
  public resolveCalls = 0;
  public confirmCalls = 0;

  public constructor(
    private readonly outcome: "auto" | "prompt",
    private readonly confirmResult: boolean = true,
  ) {}

  public resolve(_def: ToolDefinition, input: unknown): ApprovalDecision {
    this.resolveCalls += 1;
    if (this.outcome === "auto") {
      return { outcome: "auto" };
    }
    const command = (input as { command?: string }).command ?? "";
    const prompt: ApprovalPrompt = {
      toolId: "run_terminal",
      toolName: "Run Terminal Command",
      target: command,
      affectedResources: [command],
      segments: [command],
      decomposed: true,
    };
    return { outcome: "prompt", prompt };
  }

  public async requestConfirmation(_prompt: ApprovalPrompt): Promise<boolean> {
    this.confirmCalls += 1;
    return this.confirmResult;
  }
}

/** Build a ToolContext with a non-aborted signal. */
function makeContext(
  guard: WorkspacePathGuard,
  profile: ExecutionProfile | undefined,
): ToolContext {
  return { guard, profile, signal: new AbortController().signal };
}

const ROOT = "/workspace/project";

/** A profile whose Python conda environment records an activation command. */
function condaProfile(activationCommand: string | undefined): ExecutionProfile {
  return {
    root: ROOT,
    detectedAt: new Date().toISOString(),
    technologies: [
      {
        language: "python",
        runtime: "python",
        environment: { kind: "conda", activationCommand },
        commands: { test: { command: "pytest", determined: true } },
      },
    ],
  };
}

// -----------------------------------------------------------------------------
// run_terminal
// -----------------------------------------------------------------------------

describe("RunTerminalTool (Task 9.7)", () => {
  it("runs an auto-approved command in a workspace root (Requirement 6.6)", async () => {
    const runner = new RecordingRunner();
    const approver = new FakeApprover("auto");
    const tool = new RunTerminalTool({ approval: approver, runner: runner.run, shell: "posix" });

    const output = await tool.execute({ command: "echo hi" }, makeContext(fakeGuard([ROOT]), undefined));

    assert.strictEqual(runner.calls.length, 1);
    assert.strictEqual(runner.calls[0].cwd, ROOT, "cwd must be a workspace root");
    assert.strictEqual(runner.calls[0].command, "echo hi");
    assert.strictEqual(output.data?.exitCode, 0);
  });

  it("applies a recorded environment activation before the command (Requirement 11.11)", async () => {
    const runner = new RecordingRunner();
    const approver = new FakeApprover("auto");
    const tool = new RunTerminalTool({ approval: approver, runner: runner.run, shell: "posix" });

    await tool.execute(
      { command: "pytest" },
      makeContext(fakeGuard([ROOT]), condaProfile("conda activate subconscious")),
    );

    assert.strictEqual(runner.calls.length, 1);
    assert.ok(
      runner.calls[0].command.startsWith("conda activate subconscious &&"),
      `activation must be applied before the command, got: ${runner.calls[0].command}`,
    );
  });

  it("aborts with activation-failure and never runs when activation cannot be applied (Requirement 11.13)", async () => {
    const runner = new RecordingRunner();
    const approver = new FakeApprover("prompt", true);
    const tool = new RunTerminalTool({ approval: approver, runner: runner.run, shell: "posix" });

    await assert.rejects(
      tool.execute({ command: "pytest" }, makeContext(fakeGuard([ROOT]), condaProfile(undefined))),
      (error: unknown) =>
        isToolExecutionError(error) && error.toolError.kind === "activation-failure",
    );
    assert.strictEqual(runner.calls.length, 0, "no command may run on activation failure");
    assert.strictEqual(approver.confirmCalls, 1, "approval is still obtained before activation");
  });

  it("runs nothing and reports rejected when confirmation is declined (Requirement 10.4)", async () => {
    const runner = new RecordingRunner();
    const approver = new FakeApprover("prompt", false);
    const tool = new RunTerminalTool({ approval: approver, runner: runner.run, shell: "posix" });

    await assert.rejects(
      tool.execute({ command: "rm -rf build" }, makeContext(fakeGuard([ROOT]), undefined)),
      (error: unknown) => isToolExecutionError(error) && error.toolError.kind === "rejected",
    );
    assert.strictEqual(runner.calls.length, 0, "a declined command must not run");
  });

  it("returns no-workspace when no root is open", async () => {
    const runner = new RecordingRunner();
    const approver = new FakeApprover("auto");
    const tool = new RunTerminalTool({ approval: approver, runner: runner.run, shell: "posix" });

    await assert.rejects(
      tool.execute({ command: "echo hi" }, makeContext(fakeGuard([]), undefined)),
      (error: unknown) => isToolExecutionError(error) && error.toolError.kind === "no-workspace",
    );
    assert.strictEqual(runner.calls.length, 0);
  });

  it("rejects a missing command as a validation error", async () => {
    const runner = new RecordingRunner();
    const approver = new FakeApprover("auto");
    const tool = new RunTerminalTool({ approval: approver, runner: runner.run, shell: "posix" });

    await assert.rejects(
      tool.execute({}, makeContext(fakeGuard([ROOT]), undefined)),
      (error: unknown) =>
        error instanceof ToolExecutionError && error.toolError.kind === "validation",
    );
  });
});

// -----------------------------------------------------------------------------
// run_tests
// -----------------------------------------------------------------------------

describe("RunTestsTool (Task 9.7)", () => {
  it("runs the profile's recorded test command", async () => {
    const runner = new RecordingRunner();
    const approver = new FakeApprover("auto");
    const tool = new RunTestsTool({ approval: approver, runner: runner.run, shell: "posix" });

    await tool.execute({}, makeContext(fakeGuard([ROOT]), condaProfile("conda activate subconscious")));

    assert.strictEqual(runner.calls.length, 1);
    assert.strictEqual(
      runner.calls[0].command,
      "conda activate subconscious && pytest",
      "run_tests applies activation and runs the recorded test command",
    );
  });

  it("appends an optional test filter to the recorded command", async () => {
    const runner = new RecordingRunner();
    const approver = new FakeApprover("auto");
    const tool = new RunTestsTool({ approval: approver, runner: runner.run, shell: "posix" });

    const profile: ExecutionProfile = {
      root: ROOT,
      detectedAt: new Date().toISOString(),
      technologies: [
        { language: "python", commands: { test: { command: "pytest", determined: true } } },
      ],
    };

    await tool.execute({ testFilter: "-k smoke" }, makeContext(fakeGuard([ROOT]), profile));

    assert.strictEqual(runner.calls[0].command, "pytest -k smoke");
  });

  it("reports an execution error when no test command is recorded", async () => {
    const runner = new RecordingRunner();
    const approver = new FakeApprover("auto");
    const tool = new RunTestsTool({ approval: approver, runner: runner.run, shell: "posix" });

    const profile: ExecutionProfile = {
      root: ROOT,
      detectedAt: new Date().toISOString(),
      technologies: [
        { language: "python", commands: { test: { command: null, determined: false } } },
      ],
    };

    await assert.rejects(
      tool.execute({}, makeContext(fakeGuard([ROOT]), profile)),
      (error: unknown) => isToolExecutionError(error) && error.toolError.kind === "execution",
    );
    assert.strictEqual(runner.calls.length, 0);
  });
});
