// Feature: agent-tools-and-settings — integration test for the Settings_View
// model-list fetch and its 5-second timeout fallback.
//
// `fetchModelsWithTimeout` reads the engine model list and degrades gracefully:
//   (a) resolves with the fetched models and `available: true` when the lister
//       resolves within the timeout (Requirement 8.5);
//   (b) resolves with an empty list and `available: false` when the lister
//       rejects (Requirement 8.6);
//   (c) resolves with an empty list and `available: false` when the lister
//       exceeds the timeout (Requirement 8.6).
//
// The test uses a fake `ModelLister` and a small injected `timeoutMs` so the
// timeout path resolves in milliseconds — it never actually waits 5 seconds.
//
// _Requirements: 8.5, 8.6_

// `settingsView` imports the `vscode` module at load time; install the Node-level
// stub before that import is resolved so these pure helpers can be exercised
// outside the VS Code extension host.
import "../test/vscodeStub";

import * as assert from "assert";

import {
  fetchModelsWithTimeout,
  MODEL_FETCH_TIMEOUT_MS,
  type ModelLister,
} from "./settingsView";
import type { ModelConfig } from "../engine/types";

// -----------------------------------------------------------------------------
// Fixtures / fakes
// -----------------------------------------------------------------------------

const MODELS: ModelConfig[] = [
  { id: "gpt-x", provider: "openai", model: "gpt-x", is_default: true },
  { id: "claude-y", provider: "anthropic", model: "claude-y", is_default: false },
];

/** A lister that resolves with the given models after an optional delay. */
function resolvingLister(models: ModelConfig[], delayMs = 0): ModelLister {
  return {
    listModels: (): Promise<ModelConfig[]> =>
      new Promise((resolve) => setTimeout(() => resolve(models), delayMs)),
  };
}

/** A lister that rejects (engine unreachable / error). */
function rejectingLister(): ModelLister {
  return {
    listModels: (): Promise<ModelConfig[]> =>
      Promise.reject(new Error("engine unreachable")),
  };
}

/** A lister whose promise never settles — exercises the timeout path. */
function neverResolvingLister(): ModelLister {
  return {
    listModels: (): Promise<ModelConfig[]> => new Promise<ModelConfig[]>(() => {}),
  };
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe("SettingsView model-list fetch and timeout (Requirements 8.5, 8.6)", () => {
  it("(a) returns the fetched models with available:true when the lister resolves in time", async () => {
    const result = await fetchModelsWithTimeout(resolvingLister(MODELS), 1_000);
    assert.strictEqual(result.available, true);
    assert.deepStrictEqual(result.models, MODELS);
  });

  it("(a') returns an empty available list when the engine reports no models", async () => {
    const result = await fetchModelsWithTimeout(resolvingLister([]), 1_000);
    assert.strictEqual(result.available, true);
    assert.deepStrictEqual(result.models, []);
  });

  it("(b) returns an empty list with available:false when the lister rejects", async () => {
    const result = await fetchModelsWithTimeout(rejectingLister(), 1_000);
    assert.strictEqual(result.available, false);
    assert.deepStrictEqual(result.models, []);
  });

  it("(c) returns an empty list with available:false when the lister exceeds the timeout", async () => {
    const start = Date.now();
    // A never-resolving lister with a tiny injected timeout: the fallback must fire
    // in ~10ms rather than waiting the real 5-second default.
    const result = await fetchModelsWithTimeout(neverResolvingLister(), 10);
    const elapsed = Date.now() - start;

    assert.strictEqual(result.available, false);
    assert.deepStrictEqual(result.models, []);
    assert.ok(
      elapsed < 1_000,
      `timeout fallback must fire promptly (elapsed ${elapsed}ms)`
    );
  });

  it("resolves with the models when they arrive just before the deadline", async () => {
    const result = await fetchModelsWithTimeout(resolvingLister(MODELS, 5), 200);
    assert.strictEqual(result.available, true);
    assert.deepStrictEqual(result.models, MODELS);
  });

  it("exposes a 5-second default timeout constant", () => {
    assert.strictEqual(MODEL_FETCH_TIMEOUT_MS, 5_000);
  });
});
