// Feature: agent-tools-and-settings, Property 18: Terminal commands run in a
// workspace root.
//
// Validates: Requirements 6.6
//
// For any `run_terminal` invocation, the command's working directory is one of the
// configured Workspace_Roots. This property drives `RunTerminalTool` against an
// INJECTED FAKE command-runner and a fake approval surface — no real shell/conda
// process is ever spawned, so the fast-check floor of 100 iterations cannot launch a
// storm of real shell processes and crash the host. The runner records the exact
// `CommandInvocation.cwd` it receives, and the property asserts that this working
// directory is always one of the open roots, and that the selection rule holds: the
// active profile's root wins when it is one of the open roots, otherwise the first
// open root is used.
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

/** A path-segment token free of shell operators and whitespace. */
const pathToken = (): fc.Arbitrary<string> =>
  fc.stringMatching(/^[A-Za-z0-9_.-]+$/).filter((s) => s.trim().length > 0);

/** A workspace-root path under `/workspace/…`, distinct from any foreign root. */
const workspaceRoot = (): fc.Arbitrary<string> =>
  pathToken().map((name) => `/workspace/${name}`);

/** A foreign root under `/elsewhere/…` that can never collide with a workspace root. */
const foreignRoot = (): fc.Arbitrary<string> =>
  pathToken().map((name) => `/elsewhere/${name}`);

/** A non-empty command line built from whitespace-joined shell tokens. */
const commandLine = (): fc.Arbitrary<string> =>
  fc
    .array(
      fc.stringMatching(/^[A-Za-z0-9_./-]+$/).filter((s) => s.trim().length > 0 && !s.includes("&")),
      { minLength: 1, maxLength: 4 },
    )
    .map((parts) => parts.join(" "));

/**
 * A profile with the given root and no activation-requiring environment, so the
 * command always reaches the runner (activation is exercised by Property 35, not here).
 */
const profileWithRoot = (root: string): ExecutionProfile => ({
  root,
  detectedAt: new Date(0).toISOString(),
  technologies: [
    { language: "python", commands: { test: { command: "pytest", determined: true } } },
  ],
});

/**
 * A scenario: one or more open Workspace_Roots, a command, and an active-profile
 * choice — either none, a profile whose root is one of the open roots, or a profile
 * whose root is foreign (not among the open roots).
 */
const scenario = (): fc.Arbitrary<{
  readonly roots: readonly string[];
  readonly command: string;
  readonly profile: ExecutionProfile | undefined;
}> =>
  fc
    .uniqueArray(workspaceRoot(), { minLength: 1, maxLength: 4 })
    .chain((roots) =>
      fc.record({
        roots: fc.constant(roots),
        command: commandLine(),
        profile: fc.oneof(
          fc.constant(undefined),
          fc.constantFrom(...roots).map((root) => profileWithRoot(root)),
          foreignRoot().map((root) => profileWithRoot(root)),
        ),
      }),
    );

// -----------------------------------------------------------------------------
// Property 18
// -----------------------------------------------------------------------------

describe("Property 18: terminal commands run in a workspace root", () => {
  it("sets the run_terminal working directory to one of the open roots (Requirement 6.6)", async () => {
    await fc.assert(
      fc.asyncProperty(scenario(), async ({ roots, command, profile }) => {
        const runner = new RecordingRunner();
        const tool = new RunTerminalTool({
          approval: new AutoApprover(),
          runner: runner.run,
          shell: "posix",
        });

        await tool.execute(
          { command },
          makeContext(fakeGuard([...roots]), profile),
        );

        assert.strictEqual(runner.calls.length, 1, "exactly one command must run");
        const cwd = runner.calls[0].cwd;

        // Core property: the working directory is always one of the open roots.
        assert.ok(
          roots.includes(cwd),
          `cwd must be a configured workspace root, got: ${cwd}`,
        );

        // Selection rule: the profile's root wins when it is one of the open roots,
        // otherwise the first open root is used.
        const profileRootIsOpen =
          profile !== undefined && roots.includes(profile.root);
        const expected = profileRootIsOpen ? profile!.root : roots[0];
        assert.strictEqual(
          cwd,
          expected,
          `expected cwd ${expected}, got ${cwd}`,
        );
      }),
    );
  });
});
