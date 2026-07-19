// Project execution-environment detection — derives the per-workspace
// `ExecutionProfile` from the dependency manifests, lockfiles, and language/runtime
// configuration files found in a Workspace_Root.
//
// `DefaultEnvironmentDetector.detect(root)` inspects the root for recognized manifest
// files (`package.json`, `pyproject.toml`, `requirements.txt`, `environment.yml`,
// `Cargo.toml`, `go.mod`, ...), maps each present manifest to its implied technology,
// records the run/test/debug/build commands (marking any it cannot determine as
// `undetermined`), and records the activation command for Python virtual/conda
// environments. When nothing is recognized it records an empty technology set
// (Requirement 11.1, 11.2, 11.3, 11.10, 11.12).
//
// `watch(root)` re-detects when a manifest changes and the changes settle, firing
// `onDidUpdate` with the fresh profile (Requirement 11.9).
//
// The module is intentionally free of any `vscode` dependency: filesystem reads go
// through an injected `FileSystemReader` and file-change notifications through an
// injected `ManifestWatchSource`, so the pure detection logic can be exercised against
// a plain directory or temp dir outside the VS Code host. Production wiring passes a
// node-fs reader (the default) and a `vscode.FileSystemWatcher`-backed source.
//
// _Requirements: 11.1, 11.2, 11.3, 11.9, 11.10, 11.12_

import * as fs from "fs";
import * as path from "path";

import type {
  CommandSpec,
  DetectedTechnology,
  EnvironmentActivation,
  ExecutionProfile,
  ProjectCommands,
} from "./types";

/** Minimal disposable, structurally compatible with `vscode.Disposable`. */
export interface Disposable {
  dispose(): void;
}

/** Event registration function, structurally compatible with `vscode.Event<T>`. */
export type Event<T> = (listener: (value: T) => void) => Disposable;

/**
 * Filesystem read abstraction. Detection only needs to test for a file's presence
 * and read manifest text, so this deliberately exposes nothing else. The default
 * implementation ({@link nodeFileSystemReader}) is backed by node `fs`; tests inject
 * an in-memory or temp-dir-backed reader.
 */
export interface FileSystemReader {
  /** Whether a file or directory exists at the absolute `target` path. */
  exists(target: string): boolean;
  /** Read the UTF-8 text at `target`, or `null` when it cannot be read. */
  readText(target: string): string | null;
}

/**
 * A source that notifies when a watched manifest/lockfile/config file changes.
 * Structurally compatible with a thin wrapper over `vscode.FileSystemWatcher`.
 */
export interface ManifestWatchSource {
  /** Register `listener` to run on any create/change/delete of a watched file. */
  onChange(listener: () => void): Disposable;
}

/** Builds a {@link ManifestWatchSource} for a root and the manifest names to watch. */
export type WatchSourceFactory = (
  root: string,
  manifestNames: readonly string[],
) => ManifestWatchSource;

/** Construction options; every dependency is injectable for host-free testing. */
export interface EnvironmentDetectorOptions {
  /** Filesystem reader; defaults to a node-`fs`-backed reader. */
  readonly fileSystem?: FileSystemReader;
  /** Watch-source factory; defaults to a never-firing no-op source. */
  readonly watchSourceFactory?: WatchSourceFactory;
  /** Debounce window (ms) applied before re-detecting after a change (Requirement 11.9). */
  readonly settleDelayMs?: number;
}

/** The detector contract (mirrors the design's `EnvironmentDetector`). */
export interface EnvironmentDetector {
  detect(root: string): Promise<ExecutionProfile>;
  watch(root: string): Disposable;
  readonly onDidUpdate: Event<ExecutionProfile>;
}

/**
 * The manifest, lockfile, and runtime-config file names that trigger (re-)detection.
 * Watching this set covers dependency manifests and lockfiles for the recognized
 * technologies (Requirement 11.9).
 */
export const WATCHED_MANIFESTS: readonly string[] = [
  // Node
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  // Python
  "pyproject.toml",
  "requirements.txt",
  "environment.yml",
  "environment.yaml",
  "setup.py",
  "setup.cfg",
  "Pipfile",
  "Pipfile.lock",
  "poetry.lock",
  "pytest.ini",
  "tox.ini",
  // Rust
  "Cargo.toml",
  "Cargo.lock",
  // Go
  "go.mod",
  "go.sum",
];

const DEFAULT_SETTLE_DELAY_MS = 300;

/** A {@link CommandSpec} for a determined command. */
function determined(command: string): CommandSpec {
  return { command, determined: true };
}

/** A {@link CommandSpec} for a command that could not be determined (Requirement 11.10). */
function undetermined(): CommandSpec {
  return { command: null, determined: false };
}

/** Filesystem reader backed by node `fs` (the production/default reader). */
export const nodeFileSystemReader: FileSystemReader = {
  exists(target: string): boolean {
    return fs.existsSync(target);
  },
  readText(target: string): string | null {
    try {
      return fs.readFileSync(target, "utf8");
    } catch {
      return null;
    }
  },
};

/** A watch source that never fires; the default when no factory is injected. */
const noopWatchSourceFactory: WatchSourceFactory = () => ({
  onChange(): Disposable {
    return { dispose: (): void => {} };
  },
});

/** Minimal multi-listener event emitter, structurally producing a {@link Event}. */
class Emitter<T> {
  private readonly listeners = new Set<(value: T) => void>();

  public readonly event: Event<T> = (listener) => {
    this.listeners.add(listener);
    return {
      dispose: (): void => {
        this.listeners.delete(listener);
      },
    };
  };

  public fire(value: T): void {
    for (const listener of [...this.listeners]) {
      listener(value);
    }
  }

  public dispose(): void {
    this.listeners.clear();
  }
}

/** A single technology's contribution to detection. */
interface TechnologyRule {
  readonly language: string;
  /** Manifest file names whose presence implies this technology. */
  readonly manifests: readonly string[];
  /** Build the detected-technology entry once at least one manifest is present. */
  build(root: string, fsReader: FileSystemReader): DetectedTechnology;
}

/** Read and JSON-parse a manifest, returning `null` on absence or parse failure. */
function readJson(
  fsReader: FileSystemReader,
  filePath: string,
): Record<string, unknown> | null {
  const text = fsReader.readText(filePath);
  if (text === null) {
    return null;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Derive Node run/test/build commands from a `package.json` `scripts` map. */
function nodeCommands(root: string, fsReader: FileSystemReader): ProjectCommands {
  const pkg = readJson(fsReader, path.join(root, "package.json"));
  const scripts =
    pkg && typeof pkg.scripts === "object" && pkg.scripts !== null
      ? (pkg.scripts as Record<string, unknown>)
      : {};
  const has = (name: string): boolean => typeof scripts[name] === "string";

  let run: CommandSpec;
  if (has("start")) {
    run = determined("npm start");
  } else if (has("dev")) {
    run = determined("npm run dev");
  } else if (has("serve")) {
    run = determined("npm run serve");
  } else {
    run = undetermined();
  }

  return {
    run,
    test: has("test") ? determined("npm test") : undetermined(),
    build: has("build") ? determined("npm run build") : undetermined(),
    // Debugging a Node project needs a launch configuration the detector cannot infer.
    debug: undetermined(),
  };
}

/**
 * Resolve the Python environment activation. A `environment.yml`/`environment.yaml`
 * marks a conda environment; a `.venv`/`venv` directory (or `pyvenv.cfg`) marks a
 * virtual environment. Both record an activation command (Requirement 11.3); otherwise
 * no activation is required.
 */
function pythonEnvironment(
  root: string,
  fsReader: FileSystemReader,
): EnvironmentActivation {
  const condaFile = ["environment.yml", "environment.yaml"].find((name) =>
    fsReader.exists(path.join(root, name)),
  );
  if (condaFile !== undefined) {
    const name = readCondaEnvName(fsReader, path.join(root, condaFile));
    return {
      kind: "conda",
      activationCommand: `conda activate ${name ?? "<env>"}`,
    };
  }

  const venvDir = [".venv", "venv"].find(
    (dir) =>
      fsReader.exists(path.join(root, dir, "pyvenv.cfg")) ||
      fsReader.exists(path.join(root, dir)),
  );
  if (venvDir !== undefined) {
    return {
      kind: "venv",
      activationCommand: `source ${path.posix.join(venvDir, "bin", "activate")}`,
      interpreterPath: path.join(root, venvDir, "bin", "python"),
    };
  }

  return { kind: "none" };
}

/** Extract the `name:` field from an `environment.yml`, when present. */
function readCondaEnvName(
  fsReader: FileSystemReader,
  filePath: string,
): string | null {
  const text = fsReader.readText(filePath);
  if (text === null) {
    return null;
  }
  const match = /^\s*name\s*:\s*(\S+)/m.exec(text);
  return match ? match[1] : null;
}

/** Whether the Python project declares pytest via config or `pyproject.toml`. */
function pythonUsesPytest(root: string, fsReader: FileSystemReader): boolean {
  if (
    fsReader.exists(path.join(root, "pytest.ini")) ||
    fsReader.exists(path.join(root, "tox.ini"))
  ) {
    return true;
  }
  const pyproject = fsReader.readText(path.join(root, "pyproject.toml"));
  return pyproject !== null && /pytest/.test(pyproject);
}

/** Derive Python commands. Run/build/debug are left undetermined absent a reliable signal. */
function pythonCommands(root: string, fsReader: FileSystemReader): ProjectCommands {
  return {
    // A Python entry point cannot be reliably inferred from manifests.
    run: undetermined(),
    test: pythonUsesPytest(root, fsReader) ? determined("pytest") : undetermined(),
    debug: undetermined(),
    build: undetermined(),
  };
}

/** The recognized technologies and how each maps its manifests to a profile entry. */
const TECHNOLOGY_RULES: readonly TechnologyRule[] = [
  {
    language: "node",
    manifests: ["package.json"],
    build: (root, fsReader): DetectedTechnology => ({
      language: "node",
      runtime: "node",
      environment: { kind: "none" },
      commands: nodeCommands(root, fsReader),
    }),
  },
  {
    language: "python",
    manifests: [
      "pyproject.toml",
      "requirements.txt",
      "environment.yml",
      "environment.yaml",
      "setup.py",
      "setup.cfg",
      "Pipfile",
    ],
    build: (root, fsReader): DetectedTechnology => ({
      language: "python",
      runtime: "python",
      environment: pythonEnvironment(root, fsReader),
      commands: pythonCommands(root, fsReader),
    }),
  },
  {
    language: "rust",
    manifests: ["Cargo.toml"],
    build: (): DetectedTechnology => ({
      language: "rust",
      runtime: "cargo",
      environment: { kind: "none" },
      commands: {
        run: determined("cargo run"),
        test: determined("cargo test"),
        build: determined("cargo build"),
        // Debugging Rust needs an external debugger configuration.
        debug: undetermined(),
      },
    }),
  },
  {
    language: "go",
    manifests: ["go.mod"],
    build: (): DetectedTechnology => ({
      language: "go",
      runtime: "go",
      environment: { kind: "none" },
      commands: {
        run: determined("go run ."),
        test: determined("go test ./..."),
        build: determined("go build ./..."),
        // Debugging Go needs an external debugger configuration.
        debug: undetermined(),
      },
    }),
  },
];

/**
 * Concrete {@link EnvironmentDetector}. All filesystem access is routed through the
 * injected {@link FileSystemReader}, and file-change notifications through the injected
 * {@link WatchSourceFactory}, so `detect` runs unchanged against a temp directory in
 * tests and against a real workspace in the VS Code host.
 */
export class DefaultEnvironmentDetector implements EnvironmentDetector {
  private readonly fileSystem: FileSystemReader;
  private readonly watchSourceFactory: WatchSourceFactory;
  private readonly settleDelayMs: number;
  private readonly updateEmitter = new Emitter<ExecutionProfile>();

  public constructor(options: EnvironmentDetectorOptions = {}) {
    this.fileSystem = options.fileSystem ?? nodeFileSystemReader;
    this.watchSourceFactory = options.watchSourceFactory ?? noopWatchSourceFactory;
    this.settleDelayMs = options.settleDelayMs ?? DEFAULT_SETTLE_DELAY_MS;
  }

  /** Fires with the refreshed profile after a watched change settles (Requirement 11.9). */
  public get onDidUpdate(): Event<ExecutionProfile> {
    return this.updateEmitter.event;
  }

  /**
   * Inspect `root` and return its {@link ExecutionProfile}. Each recognized manifest
   * contributes exactly one technology entry (deduplicated by language), with a
   * language/runtime, an environment descriptor, and a full run/test/debug/build
   * command set. When no manifest is recognized the technology set is empty
   * (Requirement 11.1, 11.2, 11.12).
   */
  public async detect(root: string): Promise<ExecutionProfile> {
    const technologies: DetectedTechnology[] = [];

    for (const rule of TECHNOLOGY_RULES) {
      const present = rule.manifests.some((manifest) =>
        this.fileSystem.exists(path.join(root, manifest)),
      );
      if (present) {
        technologies.push(rule.build(root, this.fileSystem));
      }
    }

    return {
      root,
      detectedAt: new Date().toISOString(),
      technologies,
    };
  }

  /**
   * Watch `root`'s manifests and re-detect once changes settle, firing
   * {@link onDidUpdate} with the fresh profile. Change bursts are debounced by
   * `settleDelayMs` so a rapid series of edits triggers a single re-detection
   * (Requirement 11.9).
   */
  public watch(root: string): Disposable {
    const source = this.watchSourceFactory(root, WATCHED_MANIFESTS);
    let timer: ReturnType<typeof setTimeout> | undefined;

    const subscription = source.onChange(() => {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        timer = undefined;
        void this.detect(root).then((profile) => {
          this.updateEmitter.fire(profile);
        });
      }, this.settleDelayMs);
    });

    return {
      dispose: (): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        subscription.dispose();
      },
    };
  }
}
