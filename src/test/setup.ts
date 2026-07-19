// Feature: agent-tools-and-settings — shared property-based test setup.
//
// Loaded by every test runner (Node-level Mocha via `.mocharc.json` and the
// VS Code host runner via `.vscode-test.mjs`) so the workspace standard of a
// minimum of 100 iterations per fast-check property is enforced in one place.
// Individual properties may raise `numRuns` locally, but never lower it below
// this floor by default.
import * as fc from "fast-check";
import Module = require("module");

export const MIN_PROPERTY_RUNS = 100;

fc.configureGlobal({ numRuns: MIN_PROPERTY_RUNS });

// -----------------------------------------------------------------------------
// Minimal `vscode` module stub for Node-level tests
// -----------------------------------------------------------------------------
//
// Some otherwise-pure modules (e.g. `ToolRegistry`) import `vscode` solely for
// lightweight utilities such as `EventEmitter`. When those modules are exercised
// outside the VS Code extension host, `require("vscode")` cannot be resolved, so
// this setup installs a require hook that returns a minimal, behaviour-compatible
// stub. The VS Code host runner never loads this file with the stub in effect for
// host tests (those import the real `vscode`), so the shim is confined to the
// Node-level runner.

/** Minimal `vscode.EventEmitter` replacement with the same observable behaviour. */
class StubEventEmitter<T> {
  private readonly listeners = new Set<(event: T) => unknown>();

  public readonly event = (
    listener: (event: T) => unknown
  ): { dispose(): void } => {
    this.listeners.add(listener);
    return {
      dispose: (): void => {
        this.listeners.delete(listener);
      },
    };
  };

  public fire(data: T): void {
    for (const listener of [...this.listeners]) {
      listener(data);
    }
  }

  public dispose(): void {
    this.listeners.clear();
  }
}

const vscodeStub = { EventEmitter: StubEventEmitter };

interface LoaderModule {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  __vscodeStubInstalled?: boolean;
}

const loader = Module as unknown as LoaderModule;
if (!loader.__vscodeStubInstalled) {
  const originalLoad = loader._load.bind(loader);
  loader._load = function patchedLoad(
    request: string,
    parent: unknown,
    isMain: boolean
  ): unknown {
    if (request === "vscode") {
      return vscodeStub;
    }
    return originalLoad(request, parent, isMain);
  };
  loader.__vscodeStubInstalled = true;
}
