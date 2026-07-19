// Feature: agent-tools-and-settings, Property 19: Approval policy edits accept
// only defined values.
//
// Validates: Requirements 7.4
//
// For any input to set a tool's approval policy, only values in the
// `Approval_Policy` set (`inherit`, `always-ask`, `auto-approve`) are persisted,
// and the persisted value equals the selected value. Any other value is rejected
// (the call throws a `TypeError`) and the previously-persisted policy is left
// unchanged.
//
// This is a pure-module property test that runs outside the VS Code host. The
// `../test/vscodeStub` import (which MUST come first) installs a minimal `vscode`
// stand-in so `ToolRegistry`'s `vscode.EventEmitter` dependency resolves under
// the Node-level Mocha runner. The registry is built over a `ConfigStore` backed
// by in-memory `MementoLike` fakes.
import "../test/vscodeStub";

import * as assert from "assert";
import * as fc from "fast-check";

import { ConfigStore, type MementoLike } from "./configStore";
import { BUILTIN_TOOL_DEFINITIONS, ToolRegistry } from "./registry";
import type { ApprovalPolicy } from "./types";

// -----------------------------------------------------------------------------
// In-memory fakes
// -----------------------------------------------------------------------------

/** A stateful in-memory `MementoLike` so persisted edits round-trip on reload. */
class InMemoryMemento implements MementoLike {
  private readonly data = new Map<string, unknown>();

  public get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  public update(key: string, value: unknown): PromiseLike<void> {
    this.data.set(key, value);
    return Promise.resolve();
  }
}

/** Build a fresh registry + shared global store over in-memory mementos. */
function makeRegistry(): { registry: ToolRegistry; global: MementoLike } {
  const global = new InMemoryMemento();
  const workspace = new InMemoryMemento();
  const store = new ConfigStore(global, workspace, BUILTIN_TOOL_DEFINITIONS);
  return { registry: new ToolRegistry(store, BUILTIN_TOOL_DEFINITIONS), global };
}

// -----------------------------------------------------------------------------
// Generators
// -----------------------------------------------------------------------------

/** The defined `Approval_Policy` values (Requirement 7.4). */
const VALID_POLICIES: readonly ApprovalPolicy[] = [
  "inherit",
  "always-ask",
  "auto-approve",
];

/** Every built-in tool id — the domain of valid tool identifiers. */
const TOOL_IDS: readonly string[] = BUILTIN_TOOL_DEFINITIONS.map((def) => def.id);

const validPolicyArb: fc.Arbitrary<ApprovalPolicy> = fc.constantFrom(
  ...VALID_POLICIES
);

const toolIdArb: fc.Arbitrary<string> = fc.constantFrom(...TOOL_IDS);

/**
 * Arbitrary values that are NOT defined `Approval_Policy` values: near-miss
 * strings, other primitives, and structured values. Filtered to guarantee none
 * accidentally equals a valid policy.
 */
const invalidPolicyArb: fc.Arbitrary<unknown> = fc
  .oneof(
    fc.string(),
    fc.constantFrom(
      "",
      "INHERIT",
      "Always-Ask",
      "auto_approve",
      "autoapprove",
      "always ask",
      "ask",
      "auto",
      "deny",
      "supervised"
    ),
    fc.integer(),
    fc.double(),
    fc.boolean(),
    fc.constant(null),
    fc.constant(undefined),
    fc.array(fc.anything()),
    fc.object()
  )
  .filter((v) => !(VALID_POLICIES as readonly unknown[]).includes(v));

// -----------------------------------------------------------------------------
// Property 19
// -----------------------------------------------------------------------------

describe("ToolRegistry.setApprovalPolicy — Property 19: approval policy edits accept only defined values", () => {
  it("persists any defined ApprovalPolicy and reflects it in stateOf (and on reload)", async () => {
    await fc.assert(
      fc.asyncProperty(toolIdArb, validPolicyArb, async (id, policy) => {
        const { registry, global } = makeRegistry();

        await registry.setApprovalPolicy(id, policy);

        // The selected value is reflected in the live state.
        assert.strictEqual(
          registry.stateOf(id).approvalPolicy,
          policy,
          "stateOf must reflect the selected valid policy"
        );

        // ...and it persisted: a fresh registry over the same store agrees.
        const reloaded = new ToolRegistry(
          new ConfigStore(global, new InMemoryMemento(), BUILTIN_TOOL_DEFINITIONS),
          BUILTIN_TOOL_DEFINITIONS
        );
        assert.strictEqual(
          reloaded.stateOf(id).approvalPolicy,
          policy,
          "persisted policy must survive a reload"
        );
      })
    );
  });

  it("rejects any non-defined value with a TypeError and leaves the persisted policy unchanged", async () => {
    await fc.assert(
      fc.asyncProperty(toolIdArb, invalidPolicyArb, async (id, badPolicy) => {
        const { registry, global } = makeRegistry();

        const before = registry.stateOf(id).approvalPolicy;

        // The signature is typed to ApprovalPolicy; a real caller (e.g. an
        // untrusted webview message) can still deliver an out-of-domain value.
        await assert.rejects(
          registry.setApprovalPolicy(id, badPolicy as ApprovalPolicy),
          TypeError,
          "an undefined approval policy must be rejected with a TypeError"
        );

        // Live state is unchanged by the rejected edit.
        assert.strictEqual(
          registry.stateOf(id).approvalPolicy,
          before,
          "rejected edit must not change the live policy"
        );

        // Nothing was persisted: a fresh registry over the same store agrees.
        const reloaded = new ToolRegistry(
          new ConfigStore(global, new InMemoryMemento(), BUILTIN_TOOL_DEFINITIONS),
          BUILTIN_TOOL_DEFINITIONS
        );
        assert.strictEqual(
          reloaded.stateOf(id).approvalPolicy,
          before,
          "rejected edit must not persist any value"
        );
      })
    );
  });
});
