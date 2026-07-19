// Feature: agent-tools-and-settings — Task 14.2 integration tests.
//
// Validates: Requirements 11.6, 11.9
//
// Two extension-wiring behaviours are covered here, both in the pure-module
// Node/Mocha tier (no `@vscode/test-electron` host required):
//
//   * New-thread profile injection (Requirement 11.6): the current per-root
//     execution profile is made available to a new thread's context — i.e. the
//     `ToolContext` supplied to each tool invocation carries the profile that
//     `ConfigStore.loadProfile(root)` returns. `extension.ts` builds this context
//     through its `createContext(signal)` closure
//     (`{ guard, profile: configStore.loadProfile(root), signal }`). That closure
//     is not exported, so we exercise the REAL `ToolHost` → `ToolContext` path with
//     the SAME wiring (a real `ConfigStore` holding a saved profile feeding a
//     `createContext` that reads `loadProfile(root)`) and assert the injected
//     context carries exactly that profile — including that a later profile edit is
//     reflected by the next thread's context.
//
//   * File-watch re-detection (Requirement 11.9): manifest changes trigger a
//     debounced re-detection. `DefaultEnvironmentDetector.watch(root)` collapses a
//     burst of rapid change notifications into a single re-detection once the
//     changes settle, and fires `onDidUpdate` with the freshly detected profile.
//     We drive re-detection with a FAKE, test-controlled `ManifestWatchSource` and
//     detect against a REAL temp directory, using the detector's injectable
//     `settleDelayMs` so the test never waits real seconds.
//
// This file imports no `vscode` module and spawns no processes; it is safe for the
// Node/Mocha runner. Run filtered, e.g.:
//   npm test -- --silent --grep "Task 14.2"

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { ConfigStore, type MementoLike } from "../tools/configStore";
import { ToolHost, type ToolFrameTransport } from "../tools/host";
import { ToolRegistry } from "../tools/registry";
import {
  DefaultEnvironmentDetector,
  type Disposable,
  type ManifestWatchSource,
  type WatchSourceFactory,
} from "../env/environmentDetector";
import type { ExecutionProfile } from "../env/types";
import type {
  CodingTool,
  JSONSchema,
  ToolContext,
  ToolDefinition,
  ToolOutput,
  ToolRegisterFrame,
  ToolResultFrame,
  WorkspacePathGuard,
} from "../tools/types";

// -----------------------------------------------------------------------------
// Shared test doubles
// -----------------------------------------------------------------------------

/** In-memory MementoLike mirroring VS Code's Memento via JSON round-tripping. */
class InMemoryMemento implements MementoLike {
  private readonly store = new Map<string, string>();

  public get<T>(key: string): T | undefined {
    const raw = this.store.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }

  public update(key: string, value: unknown): PromiseLike<void> {
    if (value === undefined) {
      this.store.delete(key);
    } else {
      this.store.set(key, JSON.stringify(value));
    }
    return Promise.resolve();
  }
}

/** Captures every frame written to the transport; always reports the socket open. */
class RecordingTransport implements ToolFrameTransport {
  public readonly sent: Array<ToolRegisterFrame | ToolResultFrame> = [];

  public send(frame: ToolRegisterFrame | ToolResultFrame): void {
    this.sent.push(frame);
  }

  public isOpen(): boolean {
    return true;
  }
}

/** A path guard stub; file resolution is never exercised by this spy tool. */
const fakeGuard: WorkspacePathGuard = {
  roots: (): string[] => ["/workspace"],
  resolve: () => ({ ok: false, error: "out-of-scope" }),
};

/**
 * A spy Coding_Tool that captures the {@link ToolContext} it was invoked with, so a
 * test can assert exactly what ambient context (and therefore which execution
 * profile) was injected into the invocation.
 */
class ContextCapturingTool implements CodingTool {
  public readonly contexts: ToolContext[] = [];
  public readonly id = "capture_ctx";

  public async execute(_input: unknown, ctx: ToolContext): Promise<ToolOutput> {
    this.contexts.push(ctx);
    return { content: "ok" };
  }
}

const CAPTURE_SCHEMA: JSONSchema = {
  type: "object",
  properties: {},
  additionalProperties: true,
};

const CAPTURE_DEFINITION: ToolDefinition = {
  id: "capture_ctx",
  displayName: "Capture Context",
  description: "Records the ambient ToolContext for assertions.",
  inputSchema: CAPTURE_SCHEMA,
  category: "file",
  classification: "read-only",
  defaultEnabled: true,
};

/** A sample execution profile as would be persisted for a workspace root. */
function sampleProfile(root: string, testCommand: string): ExecutionProfile {
  return {
    root,
    detectedAt: new Date("2024-01-01T00:00:00.000Z").toISOString(),
    technologies: [
      {
        language: "python",
        runtime: "python",
        environment: { kind: "conda", activationCommand: "conda activate demo" },
        commands: {
          run: { command: null, determined: false },
          test: { command: testCommand, determined: true },
          debug: { command: null, determined: false },
          build: { command: null, determined: false },
        },
      },
    ],
  };
}

// -----------------------------------------------------------------------------
// Part A — New-thread profile injection (Requirement 11.6)
// -----------------------------------------------------------------------------

describe("Task 14.2: new-thread profile injection (Requirement 11.6)", () => {
  const ROOT = path.join(os.tmpdir(), "profile-injection-root");

  /**
   * Build the same createContext wiring extension.ts uses: the current per-root
   * profile is read from ConfigStore.loadProfile(root) at invocation time and placed
   * on the ToolContext supplied to the tool call.
   */
  function makeCreateContext(
    configStore: ConfigStore,
    root: string,
  ): (signal: AbortSignal) => ToolContext {
    return (signal: AbortSignal): ToolContext => ({
      guard: fakeGuard,
      profile: configStore.loadProfile(root),
      signal,
    });
  }

  function makeHost(configStore: ConfigStore, root: string): {
    host: ToolHost;
    tool: ContextCapturingTool;
  } {
    const registry = new ToolRegistry(configStore, [CAPTURE_DEFINITION]);
    const tool = new ContextCapturingTool();
    const host = new ToolHost({
      registry,
      tools: [tool],
      transport: new RecordingTransport(),
      createContext: makeCreateContext(configStore, root),
    });
    return { host, tool };
  }

  it("injects the saved execution profile into a new thread's tool context", async () => {
    const configStore = new ConfigStore(
      new InMemoryMemento(),
      new InMemoryMemento(),
      [CAPTURE_DEFINITION],
    );
    const saved = sampleProfile(ROOT, "pytest -q");
    await configStore.saveProfile(saved);

    const { host, tool } = makeHost(configStore, ROOT);

    await host.handleCall({
      v: 1,
      type: "tool.call",
      id: "corr-1",
      data: { tool: "capture_ctx", input: {} },
    });

    assert.strictEqual(tool.contexts.length, 1, "tool must be invoked once");
    const injected = tool.contexts[0].profile;
    assert.ok(injected !== undefined, "a profile must be injected into the context");
    assert.deepStrictEqual(
      injected,
      saved,
      "the injected profile must equal the profile persisted for the root",
    );
  });

  it("reflects a later profile edit in the next thread's context", async () => {
    const configStore = new ConfigStore(
      new InMemoryMemento(),
      new InMemoryMemento(),
      [CAPTURE_DEFINITION],
    );
    await configStore.saveProfile(sampleProfile(ROOT, "pytest -q"));

    const { host, tool } = makeHost(configStore, ROOT);

    // First thread sees the original profile.
    await host.handleCall({
      v: 1,
      type: "tool.call",
      id: "corr-a",
      data: { tool: "capture_ctx", input: {} },
    });

    // The user edits the execution profile (persisted through ConfigStore).
    const edited = sampleProfile(ROOT, "pytest -x --maxfail=1");
    await configStore.saveProfile(edited);

    // A subsequent thread's context must carry the edited profile.
    await host.handleCall({
      v: 1,
      type: "tool.call",
      id: "corr-b",
      data: { tool: "capture_ctx", input: {} },
    });

    assert.strictEqual(tool.contexts.length, 2, "tool must be invoked twice");
    assert.strictEqual(
      tool.contexts[0].profile?.technologies[0].commands.test?.command,
      "pytest -q",
      "first thread sees the original test command",
    );
    assert.deepStrictEqual(
      tool.contexts[1].profile,
      edited,
      "the next thread's context reflects the edited profile",
    );
  });

  it("injects undefined when no profile is persisted for the root", async () => {
    const configStore = new ConfigStore(
      new InMemoryMemento(),
      new InMemoryMemento(),
      [CAPTURE_DEFINITION],
    );
    const { host, tool } = makeHost(configStore, ROOT);

    await host.handleCall({
      v: 1,
      type: "tool.call",
      id: "corr-none",
      data: { tool: "capture_ctx", input: {} },
    });

    assert.strictEqual(tool.contexts.length, 1, "tool must be invoked once");
    assert.strictEqual(
      tool.contexts[0].profile,
      undefined,
      "no persisted profile ⇒ undefined profile on the context",
    );
  });
});

// -----------------------------------------------------------------------------
// Part B — File-watch debounced re-detection (Requirement 11.9)
// -----------------------------------------------------------------------------

/** A fully test-controlled {@link ManifestWatchSource} whose changes we fire. */
class FakeWatchSource implements ManifestWatchSource {
  private readonly listeners = new Set<() => void>();

  public onChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return {
      dispose: (): void => {
        this.listeners.delete(listener);
      },
    };
  }

  /** Simulate a manifest create/change/delete notification. */
  public fire(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  public get listenerCount(): number {
    return this.listeners.size;
  }
}

/** Resolve after `ms` milliseconds. */
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Task 14.2: file-watch debounced re-detection (Requirement 11.9)", () => {
  const SETTLE_MS = 40;
  let baseDir: string;
  let counter = 0;

  before(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-watch-"));
  });

  after(() => {
    if (baseDir) {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  function freshRoot(): string {
    const dir = path.join(baseDir, `case-${counter++}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("collapses a burst of rapid changes into a single re-detection after settling", async () => {
    const root = freshRoot();
    const source = new FakeWatchSource();
    const factory: WatchSourceFactory = () => source;
    const detector = new DefaultEnvironmentDetector({
      watchSourceFactory: factory,
      settleDelayMs: SETTLE_MS,
    });

    const updates: ExecutionProfile[] = [];
    detector.onDidUpdate((profile) => updates.push(profile));

    const disposable = detector.watch(root);

    // A manifest appears, then a rapid burst of change notifications arrives.
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "x" }));
    for (let i = 0; i < 6; i++) {
      source.fire();
    }

    // Before the settle window elapses, no re-detection has fired.
    await wait(SETTLE_MS / 2);
    assert.strictEqual(updates.length, 0, "no re-detection before changes settle");

    // After the settle window, exactly one re-detection fires for the whole burst.
    await wait(SETTLE_MS * 2);
    assert.strictEqual(
      updates.length,
      1,
      "a burst of rapid changes must collapse into a single re-detection",
    );
    assert.deepStrictEqual(
      updates[0].technologies.map((t) => t.language),
      ["node"],
      "the re-detected profile reflects the newly added manifest",
    );

    disposable.dispose();
  });

  it("keeps resetting the settle timer while changes keep arriving within the window", async () => {
    const root = freshRoot();
    const source = new FakeWatchSource();
    const detector = new DefaultEnvironmentDetector({
      watchSourceFactory: () => source,
      settleDelayMs: SETTLE_MS,
    });

    const updates: ExecutionProfile[] = [];
    detector.onDidUpdate((profile) => updates.push(profile));
    const disposable = detector.watch(root);

    fs.writeFileSync(path.join(root, "go.mod"), "module fixture\n");

    // Fire repeatedly with gaps SHORTER than the settle window; each fire should reset
    // the timer, so no re-detection happens while the burst continues.
    for (let i = 0; i < 4; i++) {
      source.fire();
      await wait(SETTLE_MS / 2);
    }
    assert.strictEqual(
      updates.length,
      0,
      "continuous changes within the window keep deferring re-detection",
    );

    // Once changes stop and the window elapses, a single re-detection fires.
    await wait(SETTLE_MS * 2);
    assert.strictEqual(updates.length, 1, "re-detection fires once changes settle");
    assert.deepStrictEqual(updates[0].technologies.map((t) => t.language), ["go"]);

    disposable.dispose();
  });

  it("emits an updated profile when a subsequent settled burst changes the manifests", async () => {
    const root = freshRoot();
    const source = new FakeWatchSource();
    const detector = new DefaultEnvironmentDetector({
      watchSourceFactory: () => source,
      settleDelayMs: SETTLE_MS,
    });

    const updates: ExecutionProfile[] = [];
    detector.onDidUpdate((profile) => updates.push(profile));
    const disposable = detector.watch(root);

    // First settled burst: a node manifest exists.
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "x" }));
    source.fire();
    await wait(SETTLE_MS * 2);

    // Second settled burst: a python manifest is added alongside it.
    fs.writeFileSync(path.join(root, "pyproject.toml"), "[project]\nname = \"x\"\n");
    source.fire();
    await wait(SETTLE_MS * 2);

    assert.strictEqual(updates.length, 2, "each settled burst yields one re-detection");
    assert.deepStrictEqual(
      updates[0].technologies.map((t) => t.language).sort(),
      ["node"],
      "first re-detection reflects only the node manifest",
    );
    assert.deepStrictEqual(
      updates[1].technologies.map((t) => t.language).sort(),
      ["node", "python"],
      "second re-detection reflects the added python manifest",
    );

    disposable.dispose();
  });

  it("stops re-detecting after the watch is disposed", async () => {
    const root = freshRoot();
    const source = new FakeWatchSource();
    const detector = new DefaultEnvironmentDetector({
      watchSourceFactory: () => source,
      settleDelayMs: SETTLE_MS,
    });

    const updates: ExecutionProfile[] = [];
    detector.onDidUpdate((profile) => updates.push(profile));
    const disposable = detector.watch(root);

    fs.writeFileSync(path.join(root, "Cargo.toml"), "[package]\nname = \"x\"\n");
    disposable.dispose();

    // Firing after dispose (the source no longer has a live listener) and even a
    // pending timer must not produce a re-detection.
    source.fire();
    await wait(SETTLE_MS * 2);

    assert.strictEqual(updates.length, 0, "no re-detection fires after dispose");
    assert.strictEqual(source.listenerCount, 0, "watch dispose unsubscribes the source");
  });
});
