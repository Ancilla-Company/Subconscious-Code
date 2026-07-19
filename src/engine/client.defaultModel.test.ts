// Feature: agent-tools-and-settings, Property 23: The default model is applied
// to un-overridden sends.
//
// For any selected default model and any `chat.send` that does not override the
// model, the outgoing frame's `data.model_id` equals the selected model's
// identifier; an explicit `modelId` passed to `sendChat` always overrides the
// default; and when neither an explicit id nor a configured default is present,
// no `model_id` is set on the frame.
//
// The property drives the real `EngineClient.sendChat` over an injected
// `DefaultModelProvider`. To observe the outgoing frame without opening a real
// socket, a tiny subclass overrides the single outbound write path (`send`) to
// capture frames instead of writing to a WebSocket — no network is touched.
//
// Validates: Requirements 8.7

// The `ws` stub MUST be imported first so its `Module._load` hook is installed
// before `client.ts` (and thus `require("ws")`) is first loaded. Although this
// test never opens a socket (it overrides the outbound `send` path), the Node
// runner loads every test file in one process; whichever engine test file is
// required first binds `client.ts`'s `import WebSocket from "ws"`. Installing the
// stub here as well guarantees the fake `ws` is in place regardless of file
// load order, so the sibling `client.rpcLifecycle.test.ts` sees the controllable
// FakeWebSocket rather than a real socket. (Both files are pure-module Node
// tests, never `*.vscode.test.ts`, so the host runner's real `ws` is untouched.)
import "../test/wsStub";

import * as assert from "assert";

import * as fc from "fast-check";

import { EngineClient } from "./client";
import type { WSFrame } from "./types";

// -----------------------------------------------------------------------------
// Test double
// -----------------------------------------------------------------------------

/**
 * An {@link EngineClient} whose outbound write path is intercepted: `send` records
 * every frame instead of writing to a WebSocket. This exercises the real
 * `sendChat` model-resolution logic while remaining fully offline (no socket is
 * ever created, since `connect` is never called).
 */
class CapturingEngineClient extends EngineClient {
  public readonly sent: WSFrame[] = [];

  public override send(frame: WSFrame): void {
    this.sent.push(frame);
  }
}

/** Read `data.model_id` off a captured frame (undefined when absent). */
function modelIdOf(frame: WSFrame): unknown {
  return (frame.data as Record<string, unknown> | undefined)?.model_id;
}

// -----------------------------------------------------------------------------
// Generators
// -----------------------------------------------------------------------------

// Model identifiers are non-empty, stable strings; constrain generators to the
// realistic input space so falsy-empty ids do not confound the property.
const modelId = (): fc.Arbitrary<string> => fc.string({ minLength: 1 });
const threadUuid = (): fc.Arbitrary<string> => fc.string({ minLength: 1 });

// -----------------------------------------------------------------------------
// Property 23
// -----------------------------------------------------------------------------

describe("Property 23: the default model is applied to un-overridden sends", () => {
  it("applies the configured default, lets an explicit modelId override, and sets no model_id when neither is present (Requirement 8.7)", () => {
    fc.assert(
      fc.property(
        fc.record({
          thread: threadUuid(),
          content: fc.string(),
          // null ⇒ no default configured.
          defaultModel: fc.option(modelId(), { nil: null }),
          // null ⇒ caller does not override the model on this send.
          explicitModel: fc.option(modelId(), { nil: null }),
        }),
        ({ thread, content, defaultModel, explicitModel }) => {
          const client = new CapturingEngineClient();
          client.setDefaultModelProvider(() => defaultModel);

          const returnedId = client.sendChat(
            thread,
            content,
            explicitModel ?? undefined,
          );

          // Exactly one chat.send frame is emitted, carrying the send's identity.
          assert.strictEqual(client.sent.length, 1, "one frame must be sent");
          const frame = client.sent[0];
          assert.strictEqual(frame.type, "chat.send");
          assert.strictEqual(frame.id, returnedId);
          assert.strictEqual(
            (frame.data as Record<string, unknown>).thread_uuid,
            thread,
          );
          assert.strictEqual(
            (frame.data as Record<string, unknown>).content,
            content,
          );

          // Expected model resolution: explicit overrides default; default applies
          // when un-overridden; otherwise no model_id is set at all.
          const expected =
            explicitModel !== null
              ? explicitModel
              : defaultModel !== null
                ? defaultModel
                : undefined;

          if (expected === undefined) {
            assert.strictEqual(
              modelIdOf(frame),
              undefined,
              "no model_id when neither explicit nor default is present",
            );
            assert.ok(
              !Object.prototype.hasOwnProperty.call(frame.data, "model_id"),
              "model_id key must be absent when unset",
            );
          } else {
            assert.strictEqual(
              modelIdOf(frame),
              expected,
              "model_id must equal the overriding/default identifier",
            );
          }
        },
      ),
    );
  });

  it("uses the default when no modelId is passed (Requirement 8.7)", () => {
    const client = new CapturingEngineClient();
    client.setDefaultModelProvider(() => "default-model");

    client.sendChat("thread-1", "hello");

    assert.strictEqual(modelIdOf(client.sent[0]), "default-model");
  });

  it("lets an explicit modelId override the configured default (Requirement 8.7)", () => {
    const client = new CapturingEngineClient();
    client.setDefaultModelProvider(() => "default-model");

    client.sendChat("thread-1", "hello", "explicit-model");

    assert.strictEqual(modelIdOf(client.sent[0]), "explicit-model");
  });

  it("sets no model_id when neither an explicit id nor a default is configured (Requirement 8.7)", () => {
    const client = new CapturingEngineClient();

    client.sendChat("thread-1", "hello");

    const frame = client.sent[0];
    assert.strictEqual(modelIdOf(frame), undefined);
    assert.ok(!Object.prototype.hasOwnProperty.call(frame.data, "model_id"));
  });
});
