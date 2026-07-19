// Feature: agent-tools-and-settings, Property 21: A failed persistence reverts
// the edited value.
//
// Validates: Requirements 7.7
//
// For any Configure Tools edit whose persistence fails, the affected value reverts to
// its pre-edit value and an error indication is surfaced. `ToolsController.applyEdit`
// implements this: when a registry edit rejects (persistence failure), it reads back
// `registry.stateOf(id)` — which still holds the prior value because the registry
// updates its in-memory cache only AFTER persistence resolves — and posts a `revert`
// message carrying that retained enabled/approvalPolicy value plus an error message.
//
// This is a pure-module property test that runs outside the VS Code host. The
// `../test/vscodeStub` import (which MUST come first) installs a minimal `vscode`
// stand-in so the `vscode.EventEmitter` dependency of `ToolRegistry` resolves under
// the Node-level Mocha runner. The registry is backed by a `ConfigStore` whose global
// store FAILS to persist (its `update` rejects), and the controller is driven with a
// capturing `post` callback and a minimal `EngineClient` stub exposing `on`/`off`/`isOpen`.
import "../test/vscodeStub";

import * as assert from "assert";
import * as fc from "fast-check";

import { ConfigStore, type MementoLike } from "../tools/configStore";
import { BUILTIN_TOOL_DEFINITIONS, ToolRegistry } from "../tools/registry";
import type { ApprovalPolicy } from "../tools/types";
import { ToolsController } from "./toolsController";
import type { EngineClient } from "../engine/client";

// -----------------------------------------------------------------------------
// In-memory / failing fakes
// -----------------------------------------------------------------------------

/** A stateful in-memory `MementoLike` (used for the workspace store). */
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

/**
 * A `MementoLike` whose reads succeed (so the registry can load defaults) but whose
 * writes always REJECT — simulating a persistence failure (Requirement 7.7).
 */
class FailingMemento implements MementoLike {
  public constructor(private readonly reason: string) {}

  public get<T>(_key: string): T | undefined {
    return undefined;
  }

  public update(_key: string, _value: unknown): PromiseLike<void> {
    return Promise.reject(new Error(this.reason));
  }
}

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

/** The shape of the `revert` message `ToolsController.applyEdit` posts on failure. */
interface RevertMessage {
  readonly type: "revert";
  readonly id: string;
  readonly enabled: boolean;
  readonly approvalPolicy: ApprovalPolicy;
  readonly message: string;
}

type PostedMessage = RevertMessage | { readonly type: string; [key: string]: unknown };

/** A stubbed `EngineClient` exposing just the surface `ToolsController` touches. */
function makeClientStub(): EngineClient {
  return {
    on: (): unknown => undefined,
    off: (): unknown => undefined,
    isOpen: (): boolean => false,
  } as unknown as EngineClient;
}

function makeFailingController(): {
  controller: ToolsController;
  captured: PostedMessage[];
  registry: ToolRegistry;
} {
  const store = new ConfigStore(
    new FailingMemento("disk full"),
    new InMemoryMemento(),
    BUILTIN_TOOL_DEFINITIONS,
  );
  const registry = new ToolRegistry(store, BUILTIN_TOOL_DEFINITIONS);
  const captured: PostedMessage[] = [];
  const controller = new ToolsController(registry, makeClientStub(), (msg) => {
    captured.push(msg as PostedMessage);
  });
  return { controller, captured, registry };
}

// -----------------------------------------------------------------------------
// Generators
// -----------------------------------------------------------------------------

const TOOL_IDS: readonly string[] = BUILTIN_TOOL_DEFINITIONS.map((def) => def.id);
const VALID_POLICIES: readonly ApprovalPolicy[] = [
  "inherit",
  "always-ask",
  "auto-approve",
];

const toolIdArb: fc.Arbitrary<string> = fc.constantFrom(...TOOL_IDS);
const policyArb: fc.Arbitrary<ApprovalPolicy> = fc.constantFrom(...VALID_POLICIES);

// -----------------------------------------------------------------------------
// Property 21
// -----------------------------------------------------------------------------

describe("ToolsController.applyEdit — Property 21: a failed persistence reverts the edited value", () => {
  it("reverts an enabled-toggle edit to the prior persisted value and surfaces an error", async () => {
    await fc.assert(
      fc.asyncProperty(toolIdArb, fc.boolean(), async (id, desiredEnabled) => {
        const { controller, captured, registry } = makeFailingController();

        const prior = registry.stateOf(id);
        const enabled = desiredEnabled === prior.enabled ? !prior.enabled : desiredEnabled;

        await controller.handleMessage({ type: "setEnabled", id, enabled });

        const revert = captured.find(
          (m): m is RevertMessage => m.type === "revert" && (m as RevertMessage).id === id,
        );
        assert.ok(revert, "a revert message must be posted when persistence fails");
        assert.strictEqual(revert.enabled, prior.enabled);
        assert.strictEqual(revert.approvalPolicy, prior.approvalPolicy);

        const after = registry.stateOf(id);
        assert.strictEqual(after.enabled, prior.enabled);
        assert.strictEqual(after.approvalPolicy, prior.approvalPolicy);

        assert.strictEqual(typeof revert.message, "string");
        assert.ok(revert.message.length > 0);
      }),
    );
  });

  it("reverts an approval-policy edit to the prior persisted value and surfaces an error", async () => {
    await fc.assert(
      fc.asyncProperty(toolIdArb, policyArb, async (id, desiredPolicy) => {
        const { controller, captured, registry } = makeFailingController();

        const prior = registry.stateOf(id);
        const policy =
          desiredPolicy === prior.approvalPolicy
            ? VALID_POLICIES.find((p) => p !== prior.approvalPolicy)!
            : desiredPolicy;

        await controller.handleMessage({ type: "setPolicy", id, policy });

        const revert = captured.find(
          (m): m is RevertMessage => m.type === "revert" && (m as RevertMessage).id === id,
        );
        assert.ok(revert, "a revert message must be posted when persistence fails");
        assert.strictEqual(revert.approvalPolicy, prior.approvalPolicy);
        assert.strictEqual(revert.enabled, prior.enabled);

        const after = registry.stateOf(id);
        assert.strictEqual(after.approvalPolicy, prior.approvalPolicy);
        assert.strictEqual(after.enabled, prior.enabled);

        assert.strictEqual(typeof revert.message, "string");
        assert.ok(revert.message.length > 0);
      }),
    );
  });
});
