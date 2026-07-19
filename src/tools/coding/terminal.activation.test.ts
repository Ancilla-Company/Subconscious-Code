// Feature: agent-tools-and-settings, Property 35: Recorded activation is applied
// to terminal commands.
//
// Validates: Requirements 11.11
//
// For any `run_terminal` command executed under a profile that records an
// environment activation, the effective command applies that activation before the
// command runs. This property drives `RunTerminalTool` against an INJECTED FAKE
// command-runner and a fake approval surface — no real shell/conda process is ever
// spawned, so the fast-check floor of 100 iterations cannot cause a process storm.
// The runner records the exact `CommandInvocation` it receives, and the property
// asserts that the recorded environment activation is chained ahead of the command
// (`<activation> && <command>`) and that the activation prefix precedes the command
// text in the effective command line.
import * as assert from "assert";

import * as fc from "fast-check";

import type { ExecutionProfile } from "../../env/types";
import type { ApprovalDecision } from "../approvalManager";
import type { ToolContext, ToolDefinition, WorkspacePathGuard } from "../types";
import {
  RunTerminalTool,
  type CommandInvocation,
  type CommandRunResult,
  type CommandRunner,
  type TerminalApprover,
} from "./terminal";

// -----------------------------------------------------------------------------
// Test doubles (never spawn a real process)
// -----------------------------------------------------------------------------

const ROOT = "/workspace/project";

/** A path guard whose roots are fixed; `resolve` is unused by the terminal tools. */
function fakeGuard(roots: string[]): WorkspacePathGuard {
  return {
    roots: (): string[] => [...roots],
    resolve: () => ({ ok: false, error: "out-of-scope" }),
  };
}

/** Records each invocation and returns a canned success; never spawns a process. */
class RecordingRunner {
  public readonly calls: CommandInvocation[] = [];

  public readonly run: CommandRunner = async (
    invocation: CommandInvocation,
  ): Promise<CommandRunResult> => {
    this.calls.push(invocation);
    return { exitCode: 0, stdout: "ok", stderr: "" };
  };
}

/** An approver that auto-approves every command so the pipeline reaches the runner. */
class AutoApprover implements TerminalApprover {
  public resolve(_def: ToolDefinition, _input: unknown): ApprovalDecision {
    return { outcome: "auto" };
  }

  public async requestConfirmation(): Promise<boolean> {
    return true;
  }
}

/** Build a ToolContext with a non-aborted signal. */
function makeContext(
  guard: WorkspacePathGuard,
  profile: ExecutionProfile | undefined,
): ToolContext {
  return { guard, profile, signal: new AbortController().signal };
}

// -----------------------------------------------------------------------------
// Generators
// -----------------------------------------------------------------------------

/**
 * A shell token free of the sequencing operator and surrounding whitespace, so the
 * expected effective command (`<activation> && <command>`) is fixed by construction
 * and never re-derived from the tool's own chaining logic.
 */
const shellToken = (): fc.Arbitrary<string> =>
  fc
    .stringMatching(/^[A-Za-z0-9_./-]+$/)
    .filter((s) => s.trim().length > 0 && !s.includes("&"));

/** A non-empty command line built from whitespace-joined shell tokens. */
const commandLine = (): fc.Arbitrary<string> =>
  fc.array(shellToken(), { minLength: 1, maxLength: 4 }).map((parts) => parts.join(" "));

/** A non-empty activation command (e.g. `conda activate env`, `. .venv/bin/activate`). */
const activationCommand = (): fc.Arbitrary<string> =>
  fc.array(shellToken(), { minLength: 1, maxLength: 4 }).map((parts) => parts.join(" "));

/** A technology whose environment records no activation (skipped by the resolver). */
const inertTechnology = (): fc.Arbitrary<ExecutionProfile["technologies"][number]> =>
  fc.constant({
    language: "node",
    commands: { run: { command: "node index.js", determined: true } },
  });

/**
 * A profile that records an activation on its first activating technology, optionally
 * preceded by technologies whose environment requires no activation. The governing
 * activation is the first technology whose environment is not `none` — mirroring the
 * resolver — so the expected prefix is unambiguous.
 */
const scenario = (): fc.Arbitrary<{
  readonly command: string;
  readonly activation: string;
  readonly profile: ExecutionProfile;
}> =>
  fc.record({
    command: commandLine(),
    activation: activationCommand(),
    kind: fc.constantFrom("conda" as const, "venv" as const),
    leading: fc.array(inertTechnology(), { maxLength: 2 }),
  }).map(({ command, activation, kind, leading }) => ({
    command,
    activation,
    profile: {
      root: ROOT,
      detectedAt: new Date(0).toISOString(),
      technologies: [
        ...leading,
        {
          language: "python",
          runtime: "python",
          environment: { kind, activationCommand: activation },
          commands: { test: { command: "pytest", determined: true } },
        },
      ],
    },
  }));

// -----------------------------------------------------------------------------
// Property 35
// -----------------------------------------------------------------------------

describe("Property 35: recorded activation is applied to terminal commands", () => {
  it("chains the recorded activation ahead of the run_terminal command (Requirement 11.11)", async () => {
    await fc.assert(
      fc.asyncProperty(scenario(), async ({ command, activation, profile }) => {
        const runner = new RecordingRunner();
        const tool = new RunTerminalTool({
          approval: new AutoApprover(),
          runner: runner.run,
          shell: "posix",
        });

        await tool.execute({ command }, makeContext(fakeGuard([ROOT]), profile));

        assert.strictEqual(runner.calls.length, 1, "exactly one command must run");
        const effective = runner.calls[0].command;

        // The activation is applied before the command runs.
        assert.strictEqual(
          effective,
          `${activation} && ${command}`,
          `activation must be chained ahead of the command, got: ${effective}`,
        );

        // The activation prefix precedes the command text in the effective line.
        const activationIndex = effective.indexOf(activation);
        const commandIndex = effective.indexOf(command, activation.length);
        assert.ok(activationIndex === 0, "activation must be the prefix");
        assert.ok(
          commandIndex > activationIndex,
          "the command must appear after the activation",
        );

        // The working directory remains a Workspace_Root.
        assert.strictEqual(runner.calls[0].cwd, ROOT);
      }),
    );
  });
});
