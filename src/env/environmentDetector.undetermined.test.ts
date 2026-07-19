// Feature: agent-tools-and-settings, Property 33: Undetermined commands are
// marked as such.
//
// Validates: Requirements 11.10
//
// IF the Environment_Detector cannot determine an execution command for a detected
// technology, THEN the Execution_Profile marks that command as undetermined. This
// property asserts the marking contract holds across arbitrary project shapes:
//
//   * every CommandSpec produced by `detect` is internally consistent — an
//     undetermined command has `command === null` AND `determined === false`, and a
//     determined command has a non-empty `command` string AND `determined === true`
//     (the two states are mutually exclusive and exhaustive); and
//   * each command matches the determination fixed by construction — commands that
//     cannot be inferred from the written manifests (e.g. a Node `debug`, a Node
//     `run` with no start/dev/serve script, a Python `run`/`build`/`debug`, a Rust
//     or Go `debug`) are marked undetermined, while commands the detector can infer
//     (a Node `test` with a `test` script, a Rust `cargo test`, ...) are determined.
//
// The property runs against REAL temporary directories (created with
// `fs.mkdtempSync` under `os.tmpdir()`): each generated case writes the chosen
// manifests into a fresh subdirectory and detects against it through the default
// node-`fs` reader, so file behaviour is exercised for real and then cleaned up.
// Expected determinations are fixed by construction (never re-derived from the
// detector's own logic), so a marking bug is genuinely caught.

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import * as fc from "fast-check";

import { DefaultEnvironmentDetector } from "./environmentDetector";
import type { CommandSpec, ExecutionProfile } from "./types";

// -----------------------------------------------------------------------------
// Scenario model — the knobs that fix each command's determination by construction
// -----------------------------------------------------------------------------

interface NodeConfig {
  readonly present: boolean;
  readonly hasStart: boolean;
  readonly hasDev: boolean;
  readonly hasServe: boolean;
  readonly hasTest: boolean;
  readonly hasBuild: boolean;
}

interface PythonConfig {
  readonly present: boolean;
  readonly pytest: boolean;
}

interface Scenario {
  readonly node: NodeConfig;
  readonly python: PythonConfig;
  readonly rust: boolean;
  readonly go: boolean;
}

/** Determination expected for each of run/test/debug/build. */
interface ExpectedCommands {
  readonly run: boolean;
  readonly test: boolean;
  readonly debug: boolean;
  readonly build: boolean;
}

/** Node commands the detector can infer from the written `package.json` scripts. */
function expectedNode(cfg: NodeConfig): ExpectedCommands {
  return {
    run: cfg.hasStart || cfg.hasDev || cfg.hasServe,
    test: cfg.hasTest,
    build: cfg.hasBuild,
    // Debugging a Node project needs a launch configuration the detector cannot infer.
    debug: false,
  };
}

/** Python commands: only `test` is inferable, and only via a pytest signal. */
function expectedPython(cfg: PythonConfig): ExpectedCommands {
  return { run: false, test: cfg.pytest, debug: false, build: false };
}

/** Rust/Go: run/test/build inferred from the toolchain; debug is not. */
const EXPECTED_TOOLCHAIN: ExpectedCommands = {
  run: true,
  test: true,
  build: true,
  debug: false,
};

/**
 * Write the manifests implied by `scenario` into `dir`. Presence of each manifest is
 * what drives detection; the exact contents only matter where the detector inspects
 * them (Node `scripts`, the pytest signal).
 */
function writeScenario(dir: string, scenario: Scenario): void {
  if (scenario.node.present) {
    const scripts: Record<string, string> = {};
    if (scenario.node.hasStart) {
      scripts.start = "node index.js";
    }
    if (scenario.node.hasDev) {
      scripts.dev = "node dev.js";
    }
    if (scenario.node.hasServe) {
      scripts.serve = "node serve.js";
    }
    if (scenario.node.hasTest) {
      scripts.test = "mocha";
    }
    if (scenario.node.hasBuild) {
      scripts.build = "tsc";
    }
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name: "fixture", scripts }),
      "utf8"
    );
  }

  if (scenario.python.present) {
    // `requirements.txt` marks a Python project without contributing a pytest signal.
    fs.writeFileSync(path.join(dir, "requirements.txt"), "requests\n", "utf8");
    if (scenario.python.pytest) {
      // A `pytest.ini` is a determinate pytest signal for the `test` command.
      fs.writeFileSync(path.join(dir, "pytest.ini"), "[pytest]\n", "utf8");
    }
  }

  if (scenario.rust) {
    fs.writeFileSync(
      path.join(dir, "Cargo.toml"),
      '[package]\nname = "fixture"\n',
      "utf8"
    );
  }

  if (scenario.go) {
    fs.writeFileSync(path.join(dir, "go.mod"), "module fixture\n", "utf8");
  }
}

/** Expected determination per detected language for this scenario. */
function expectedByLanguage(scenario: Scenario): Map<string, ExpectedCommands> {
  const expected = new Map<string, ExpectedCommands>();
  if (scenario.node.present) {
    expected.set("node", expectedNode(scenario.node));
  }
  if (scenario.python.present) {
    expected.set("python", expectedPython(scenario.python));
  }
  if (scenario.rust) {
    expected.set("rust", EXPECTED_TOOLCHAIN);
  }
  if (scenario.go) {
    expected.set("go", EXPECTED_TOOLCHAIN);
  }
  return expected;
}

/**
 * Assert a single {@link CommandSpec} is consistently marked: undetermined ⇔
 * `command === null` ⇔ `determined === false`; determined ⇔ non-empty command
 * string ⇔ `determined === true`.
 */
function assertMarking(
  label: string,
  spec: CommandSpec | undefined,
  shouldBeDetermined: boolean
): void {
  assert.ok(spec !== undefined, `${label}: command spec must be present`);
  if (shouldBeDetermined) {
    assert.strictEqual(
      spec.determined,
      true,
      `${label}: expected determined command`
    );
    assert.strictEqual(
      typeof spec.command,
      "string",
      `${label}: determined command must be a string`
    );
    assert.ok(
      (spec.command as string).length > 0,
      `${label}: determined command must be non-empty`
    );
  } else {
    // The core of Property 33: an undetermined command is marked as such.
    assert.strictEqual(
      spec.determined,
      false,
      `${label}: expected undetermined command`
    );
    assert.strictEqual(
      spec.command,
      null,
      `${label}: undetermined command must be null`
    );
  }
}

// -----------------------------------------------------------------------------
// Generators
// -----------------------------------------------------------------------------

const nodeArb: fc.Arbitrary<NodeConfig> = fc.record({
  present: fc.boolean(),
  hasStart: fc.boolean(),
  hasDev: fc.boolean(),
  hasServe: fc.boolean(),
  hasTest: fc.boolean(),
  hasBuild: fc.boolean(),
});

const pythonArb: fc.Arbitrary<PythonConfig> = fc.record({
  present: fc.boolean(),
  pytest: fc.boolean(),
});

// At least one technology must be present so every generated case exercises the
// marking contract on real detected commands.
const scenarioArb: fc.Arbitrary<Scenario> = fc
  .record({
    node: nodeArb,
    python: pythonArb,
    rust: fc.boolean(),
    go: fc.boolean(),
  })
  .filter(
    (s) => s.node.present || s.python.present || s.rust || s.go
  );

// -----------------------------------------------------------------------------
// Property 33
// -----------------------------------------------------------------------------

describe("Property 33: undetermined commands are marked as such", () => {
  let baseDir: string;
  let counter = 0;

  before(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-undetermined-"));
  });

  after(() => {
    if (baseDir) {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("marks every command the detector cannot infer as undetermined (command null, determined false)", async () => {
    const detector = new DefaultEnvironmentDetector();

    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        // Fresh subdirectory per case so leftover manifests never leak between runs.
        const dir = path.join(baseDir, `case-${counter++}`);
        fs.mkdirSync(dir, { recursive: true });
        writeScenario(dir, scenario);

        const profile: ExecutionProfile = await detector.detect(dir);
        const expected = expectedByLanguage(scenario);

        // The detected languages match the manifests written (sanity for the assertions below).
        const detectedLanguages = new Set(
          profile.technologies.map((tech) => tech.language)
        );
        assert.deepStrictEqual(
          [...detectedLanguages].sort(),
          [...expected.keys()].sort(),
          "detected technologies must match the written manifests"
        );

        for (const tech of profile.technologies) {
          const exp = expected.get(tech.language);
          assert.ok(exp !== undefined, `unexpected technology ${tech.language}`);

          assertMarking(`${tech.language}.run`, tech.commands.run, exp.run);
          assertMarking(`${tech.language}.test`, tech.commands.test, exp.test);
          assertMarking(`${tech.language}.debug`, tech.commands.debug, exp.debug);
          assertMarking(`${tech.language}.build`, tech.commands.build, exp.build);
        }
      }),
      { numRuns: 200 }
    );
  });

  it("marks a bare Python project's run/debug/build as undetermined and its test as undetermined without pytest", async () => {
    const detector = new DefaultEnvironmentDetector();
    const dir = path.join(baseDir, "bare-python");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "requirements.txt"), "requests\n", "utf8");

    const profile = await detector.detect(dir);
    const python = profile.technologies.find((t) => t.language === "python");
    assert.ok(python !== undefined, "python must be detected");

    for (const key of ["run", "test", "debug", "build"] as const) {
      assertMarking(`python.${key}`, python.commands[key], false);
    }
  });
});
