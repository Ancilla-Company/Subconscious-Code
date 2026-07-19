// Feature: agent-tools-and-settings — minimal `vscode` module stub for
// Node-level (non-host) property/unit tests.
//
// A handful of otherwise-pure modules (e.g. `ToolRegistry`) depend on
// `vscode.EventEmitter` for their change notifications. Those modules are still
// tested outside the VS Code extension host (see design.md — "pure modules are
// tested outside the VS Code host"), so `require("vscode")` must resolve to a
// lightweight stand-in when the Node-level Mocha runner loads them.
//
// Importing this module for its side effect installs a `Module._load` hook that
// returns a fake `vscode` namespace exposing just the surface those modules use:
// a structurally-compatible `EventEmitter`. The hook is installed exactly once
// and delegates every non-`vscode` request to the original loader.
//
// Usage: place `import "../test/vscodeStub";` (or the correct relative path)
// as the FIRST import in a test file, before importing any module that pulls in
// `vscode`. TypeScript preserves import order in the emitted CommonJS, so the
// hook is installed before the dependent module is required.

// eslint-disable-next-line @typescript-eslint/no-var-requires
const NodeModule = require("module") as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};

/**
 * Minimal, structurally-compatible replacement for `vscode.EventEmitter<T>`.
 * Supports `event(listener)` registration returning a disposable, `fire(data)`
 * to notify listeners, and `dispose()` to drop them.
 */
class FakeEventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];

  public readonly event = (listener: (e: T) => void): { dispose(): void } => {
    this.listeners.push(listener);
    return {
      dispose: (): void => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };

  public fire(data: T): void {
    for (const listener of [...this.listeners]) {
      listener(data);
    }
  }

  public dispose(): void {
    this.listeners = [];
  }
}

const fakeVscode = { EventEmitter: FakeEventEmitter };

interface StubbedModuleLoader {
  __subconsciousVscodeStubInstalled?: boolean;
}

const loader = NodeModule as unknown as StubbedModuleLoader;

if (loader.__subconsciousVscodeStubInstalled !== true) {
  const originalLoad = NodeModule._load;
  NodeModule._load = function patchedLoad(
    request: string,
    parent: unknown,
    isMain: boolean
  ): unknown {
    if (request === "vscode") {
      return fakeVscode;
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  loader.__subconsciousVscodeStubInstalled = true;
}

export {};
