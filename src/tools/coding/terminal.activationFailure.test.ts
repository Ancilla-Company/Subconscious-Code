// Feature: agent-tools-and-settings, Property 36: Activation failure aborts and
// leaves the profile unchanged.
//
// Validates: Requirements 11.13
//
// For any command whose recorded environment activation cannot be applied, no
// command runs, the result is an `activation-failure` error, and the execution
// profile is left unchanged. An environment activation "cannot be applied" when the
// first detected technology whose environment requires activation (kind other than
// `none`) records no usable activation command (missing, empty, or whitespace-only).
//
// The property runs entirely against an INJECTED FAKE command-runner and a fake
// approval surface: no real shell/conda process is ever spawned. This is essential
// because fast-check enforces a floor of 100 iterations globally (see
// `src/test/setup.ts`), so spawning a real process per case would launch a storm of
// conda/cmd processes and crash the host. The runner records every call so the test
// can assert it was never invoked, and the profile is deep-compared against a
// snapshot taken before execution to prove it is left unchanged.

import * as assert from "assert";

import * as fc from "fast-check";

import type {
  DetectedTechnology,
  EnvironmentActivation,
  ExecutionProfile,
} from "../../env/types";
import type { ApprovalDecision, ApprovalPrompt } from "../approvalManager";
import { isToolExecutionError } from "../errors";
import type {
  ToolContext,
  ToolDefinition,
  WorkspacePathGuard,
} from "../types";
import {
  RunTerminalTool,
  RunTestsTool,
  type CommandInvocation,
  type CommandRunResult,
  type CommandRunner,
  type TerminalApprover,
} from "./terminal";

const ROOT = "/workspace/project";

// -----------------------------------------------------------------------------
// Test doubles
// -----------------------------------------------------------------------------

/** A path guard whose roots are fixed; `resolve` is unused by the terminal tools. */
function fakeGuard(roots: string[]): WorkspacePathGuard {
  return {
    roots: (): string[] => [...roots],
    resolve: () => ({ ok: false, error: "out-of-scope" }),
  };
}

/**
 * Records each invocation and returns a canned result; NEVER spawns a real process.
 * The recorded `calls` let the property assert the runner is never invoked on an
 * activation failure (Requirement 11.13).
 */
class RecordingRunner {
  public readonly calls: CommandInvocation[] = [];

  public readonly run: CommandRunner = async (
    invocation: CommandInvocation,
  ): Promise<CommandRunResult> => {
    this.calls.push(invocation);
    return { exitCode: 0, stdout: "ok", stderr: "" };
  };
}

/**
 * An approver that either auto-approves or prompts and confirms. Confirmation always
 * succeeds so the pipeline reaches the activation step (a declined confirmation would
 * abort earlier with a `rejected` error, not `activation-failure`). Counters let the
 * property assert the per-segment approval was obtained before the abort.
 */
class FakeApprover implements TerminalApprover {
  public resolveCalls = 0;
  public confirmCalls = 0;

  public constructor(private readonly outcome: "auto" | "prompt") {}

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

/** A non-empty, non-whitespace command string that passes input validation. */
const commandArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 24 })
  .map((s) => `cmd_${s.replace(/\s/g, "_")}`);

/** An activation command that CANNOT be applied: missing, empty, or whitespace-only. */
const unusableActivationArb: fc.Arbitrary<string | undefined> = fc.constantFrom(
  undefined,
  "",
  "   ",
  "\t",
  "\n",
  " \t \n ",
);

/**
 * A technology that `resolveActivation` skips: it has no environment, or an
 * environment whose kind is `none`. Any recorded activation command on a `none`
 * environment is ignored, so these never govern the resolution.
 */
const skippedTechArb: fc.Arbitrary<DetectedTechnology> = fc.oneof(
  fc.record({
    language: fc.constantFrom("text", "markdown", "json"),
    commands: fc.constant({}),
  }),
  fc.record({
    language: fc.constantFrom("go", "rust", "node"),
    environment: fc.constant<EnvironmentActivation>({ kind: "none" }),
    commands: fc.constant({}),
  }),
);

/**
 * The governing technology whose environment requires activation but records no
 * usable activation command — the source of the activation failure.
 */
const failingTechArb: fc.Arbitrary<DetectedTechnology> = fc
  .record({
    language: fc.constantFrom("python"),
    kind: fc.constantFrom<"conda" | "venv">("conda", "venv"),
    activationCommand: unusableActivationArb,
  })
  .map(({ language, kind, activationCommand }) => ({
    language,
    runtime: "python",
    environment: { kind, activationCommand } as EnvironmentActivation,
    // A determined test command so `run_tests` can derive a base command and thus
    // still reach the activation step (rather than failing earlier).
    commands: { test: { command: "pytest", determined: true } },
  }));

/**
 * A profile whose first activation-requiring technology cannot be activated. Leading
 * `skipped` technologies (none/undefined environments) are ignored by
 * `resolveActivation`, so the failing technology governs and the resolution is a
 * failure regardless of what follows it.
 */
const failingProfileArb: fc.Arbitrary<ExecutionProfile> = fc
  .record({
    leading: fc.array(skippedTechArb, { maxLength: 3 }),
    failing: failingTechArb,
    detectedAt: fc
      .date({
        min: new Date(0),
        max: new Date(4102444800000),
        noInvalidDate: true,
      })
      .map((d) => d.toISOString()),
  })
  .map(({ leading, failing, detectedAt }) => ({
    root: ROOT,
    detectedAt,
    technologies: [...leading, failing],
  }));

// -----------------------------------------------------------------------------
// Property
// -----------------------------------------------------------------------------

describe("Property 36: activation failure aborts and leaves the profile unchanged", () => {
  it("aborts with activation-failure, never runs, and leaves the profile unchanged (run_terminal & run_tests)", async () => {
    const scenario = fc.record({
      profile: failingProfileArb,
      command: commandArb,
      approval: fc.constantFrom<"auto" | "prompt">("auto", "prompt"),
      shell: fc.constantFrom<"posix" | "powershell" | "cmd">(
        "posix",
        "powershell",
        "cmd",
      ),
      useRunTests: fc.boolean(),
      testFilter: fc.option(fc.constantFrom("-k smoke", "--fast"), {
        nil: undefined,
      }),
    });

    await fc.assert(
      fc.asyncProperty(scenario, async (s) => {
        const runner = new RecordingRunner();
        const approver = new FakeApprover(s.approval);
        const ctx = makeContext(fakeGuard([ROOT]), s.profile);

        // Snapshot the profile before execution to prove it is left unchanged.
        // Both sides of the comparison are normalized through the same `structuredClone`
        // so the assertion reflects the profile's *content* rather than incidental
        // representation differences: `structuredClone` preserves keys whose value is
        // `undefined` (e.g. an omitted `activationCommand`) — unlike a JSON round-trip —
        // and normalizes the prototype of the null-prototype objects fast-check emits.
        const before = structuredClone(s.profile);

        let threw: unknown;
        if (s.useRunTests) {
          const tool = new RunTestsTool({
            approval: approver,
            runner: runner.run,
            shell: s.shell,
          });
          try {
            await tool.execute({ testFilter: s.testFilter }, ctx);
          } catch (error) {
            threw = error;
          }
        } else {
          const tool = new RunTerminalTool({
            approval: approver,
            runner: runner.run,
            shell: s.shell,
          });
          try {
            await tool.execute({ command: s.command }, ctx);
          } catch (error) {
            threw = error;
          }
        }

        // 1. The result is an `activation-failure` error.
        assert.ok(
          isToolExecutionError(threw) &&
            threw.toolError.kind === "activation-failure",
          `expected an activation-failure ToolExecutionError, got: ${String(threw)}`,
        );

        // 2. No command runs on activation failure.
        assert.strictEqual(
          runner.calls.length,
          0,
          "no command may run when activation cannot be applied",
        );

        // Per-segment approval is still obtained before the abort: when the approver
        // prompts, confirmation is requested exactly once.
        if (s.approval === "prompt") {
          assert.strictEqual(
            approver.confirmCalls,
            1,
            "confirmation is obtained before the activation step",
          );
        }

        // 3. The execution profile is left unchanged.
        assert.deepStrictEqual(
          structuredClone(s.profile),
          before,
          "the execution profile must be left unchanged",
        );
      }),
    );
  });
});
