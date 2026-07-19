// Feature: agent-tools-and-settings, Property 32: Python virtual/conda
// environments record an activation command.
//
// Validates: Requirements 11.3
//
// For any detected Python project containing a virtual-environment or conda
// marker, the technology's environment records the activation command required
// before running Python commands.
//
// The property runs against REAL temporary directories (created with
// `fs.mkdtempSync` under `os.tmpdir()`). Each generated case materializes a
// Python project fixture in a fresh directory:
//   - a "conda" marker writes an `environment.yml`/`environment.yaml` with a
//     `name:` field (the file is itself a recognized Python manifest);
//   - a "venv" marker creates a `.venv`/`venv` directory (optionally with a
//     `pyvenv.cfg`) alongside another Python manifest (`pyproject.toml`,
//     `requirements.txt`, ...) so the project is still detected as Python.
// The case then runs the real `DefaultEnvironmentDetector.detect` (node-fs
// backed) and asserts the detected Python technology's `environment` records a
// non-empty activation command of the expected kind. Expected outcomes are
// fixed by construction from the fixture, never re-derived from the detector.

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import * as fc from "fast-check";

import { DefaultEnvironmentDetector } from "./environmentDetector";
import type { DetectedTechnology } from "./types";

/** Python manifests (other than environment.yml) that make a project detectable. */
const OTHER_PYTHON_MANIFESTS: readonly string[] = [
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "setup.cfg",
  "Pipfile",
];

interface CondaScenario {
  readonly marker: "conda";
  readonly file: "environment.yml" | "environment.yaml";
  readonly envName: string;
}

interface VenvScenario {
  readonly marker: "venv";
  readonly dir: ".venv" | "venv";
  readonly withPyvenvCfg: boolean;
  /** At least one non-environment.yml Python manifest so the project is detected. */
  readonly manifests: readonly string[];
}

type Scenario = CondaScenario | VenvScenario;

const condaScenario: fc.Arbitrary<CondaScenario> = fc.record({
  marker: fc.constant<"conda">("conda"),
  file: fc.constantFrom<"environment.yml" | "environment.yaml">(
    "environment.yml",
    "environment.yaml",
  ),
  // A conda env name: non-empty, no whitespace (matches the detector's `\S+` capture).
  envName: fc
    .string({ minLength: 1, maxLength: 24 })
    .map((s) => s.replace(/\s+/g, "_"))
    .filter((s) => s.length > 0),
});

const venvScenario: fc.Arbitrary<VenvScenario> = fc.record({
  marker: fc.constant<"venv">("venv"),
  dir: fc.constantFrom<".venv" | "venv">(".venv", "venv"),
  withPyvenvCfg: fc.boolean(),
  manifests: fc
    .subarray([...OTHER_PYTHON_MANIFESTS], { minLength: 1 })
    .map((arr) => [...arr]),
});

const scenario: fc.Arbitrary<Scenario> = fc.oneof(condaScenario, venvScenario);

/** Locate the detected Python technology in a profile, or undefined. */
function findPython(
  technologies: readonly DetectedTechnology[],
): DetectedTechnology | undefined {
  return technologies.find((tech) => tech.language === "python");
}

describe("Property 32: python virtual/conda environments record an activation command", () => {
  let baseDir: string;
  const detector = new DefaultEnvironmentDetector();

  before(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-activation-"));
  });

  after(() => {
    if (baseDir) {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  /** Materialize the scenario fixture in a fresh workspace root and return its path. */
  function materialize(sc: Scenario): string {
    const root = fs.mkdtempSync(path.join(baseDir, "root-"));

    if (sc.marker === "conda") {
      fs.writeFileSync(
        path.join(root, sc.file),
        `name: ${sc.envName}\ndependencies:\n  - python=3.12\n`,
        "utf8",
      );
    } else {
      // A non-environment.yml Python manifest so the project is detected as Python...
      for (const manifest of sc.manifests) {
        fs.writeFileSync(path.join(root, manifest), "\n", "utf8");
      }
      // ...plus the virtual-environment marker directory.
      const venvDir = path.join(root, sc.dir);
      fs.mkdirSync(venvDir, { recursive: true });
      if (sc.withPyvenvCfg) {
        fs.writeFileSync(
          path.join(venvDir, "pyvenv.cfg"),
          "home = /usr/bin\nversion = 3.12.0\n",
          "utf8",
        );
      }
    }

    return root;
  }

  it("records a non-empty activation command of the expected kind for Python venv/conda markers", async () => {
    await fc.assert(
      fc.asyncProperty(scenario, async (sc) => {
        const root = materialize(sc);

        const profile = await detector.detect(root);
        const python = findPython(profile.technologies);

        // The project must be detected as Python.
        assert.ok(python !== undefined, "expected a detected python technology");

        const env = python.environment;
        assert.ok(env !== undefined, "python technology must record an environment");

        // The environment kind reflects the marker present.
        assert.strictEqual(
          env.kind,
          sc.marker,
          `expected environment kind "${sc.marker}", got "${env.kind}"`,
        );

        // An activation command is recorded and non-empty (Requirement 11.3).
        assert.strictEqual(
          typeof env.activationCommand,
          "string",
          "activation command must be a string",
        );
        assert.ok(
          (env.activationCommand ?? "").length > 0,
          "activation command must be non-empty",
        );

        if (sc.marker === "conda") {
          assert.ok(
            env.activationCommand!.includes("conda activate"),
            `conda activation must invoke "conda activate" (got "${env.activationCommand}")`,
          );
          // The recorded name comes from the fixture, not re-derived by the test.
          assert.ok(
            env.activationCommand!.includes(sc.envName),
            `conda activation must reference env name "${sc.envName}"`,
          );
        } else {
          assert.ok(
            env.activationCommand!.includes("activate"),
            `venv activation must invoke an activate script (got "${env.activationCommand}")`,
          );
          assert.ok(
            env.activationCommand!.includes(sc.dir),
            `venv activation must reference the venv directory "${sc.dir}"`,
          );
        }
      }),
      { numRuns: 200 },
    );
  });

  it("prefers conda activation when both conda and venv markers are present", async () => {
    const root = fs.mkdtempSync(path.join(baseDir, "root-both-"));
    fs.writeFileSync(
      path.join(root, "environment.yml"),
      "name: combined_env\n",
      "utf8",
    );
    fs.mkdirSync(path.join(root, ".venv"), { recursive: true });
    fs.writeFileSync(path.join(root, ".venv", "pyvenv.cfg"), "home = /usr\n", "utf8");

    const profile = await detector.detect(root);
    const python = findPython(profile.technologies);

    assert.ok(python !== undefined, "expected a detected python technology");
    assert.strictEqual(python.environment?.kind, "conda");
    assert.ok(python.environment?.activationCommand?.includes("conda activate"));
  });
});
