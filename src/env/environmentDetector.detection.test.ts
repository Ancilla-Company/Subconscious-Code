// Feature: agent-tools-and-settings, Property 31: Detection maps present
// manifests to the implied technologies.
//
// Validates: Requirements 11.1, 11.2
//
// WHEN a Workspace_Root becomes available, THE Environment_Detector detects the
// technologies in use by inspecting dependency manifests, lockfiles, and
// language/runtime configuration files, and records, for each detected
// technology, the language/runtime and the run/test/debug/build commands.
//
// This property asserts the mapping contract holds across arbitrary combinations
// of present manifest files:
//
//   * the set of detected technology languages equals EXACTLY the set of
//     languages implied by the manifests written into the root — a manifest
//     implies its language, several manifests of the same language collapse to a
//     single technology entry, and a root with no recognized manifest yields an
//     empty technology set (Requirement 11.1, and the 11.12 empty-set corner);
//   * every detected technology records a non-empty `language`, a `runtime`, an
//     `environment` descriptor, and a `commands` object carrying all four of
//     run/test/debug/build command specs (Requirement 11.2).
//
// The property runs against REAL temporary directories (created with
// `fs.mkdtempSync` under `os.tmpdir()`): each generated case writes the chosen
// manifests into a fresh subdirectory and detects against it through the default
// node-`fs` reader, then cleans up. The expected technology set is fixed by
// construction from the manifests written (never re-derived from the detector's
// own logic), so a mapping bug is genuinely caught.

import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import * as fc from "fast-check";

import { DefaultEnvironmentDetector } from "./environmentDetector";
import type { ExecutionProfile } from "./types";

// -----------------------------------------------------------------------------
// Manifest → language mapping (fixed by construction, mirrors the detector's rules)
// -----------------------------------------------------------------------------

/** Every recognized manifest file name paired with the language it implies. */
const MANIFEST_LANGUAGE: ReadonlyArray<readonly [manifest: string, language: string]> = [
  ["package.json", "node"],
  ["pyproject.toml", "python"],
  ["requirements.txt", "python"],
  ["environment.yml", "python"],
  ["environment.yaml", "python"],
  ["setup.py", "python"],
  ["setup.cfg", "python"],
  ["Pipfile", "python"],
  ["Cargo.toml", "rust"],
  ["go.mod", "go"],
];

const ALL_MANIFESTS: readonly string[] = MANIFEST_LANGUAGE.map(([manifest]) => manifest);

/** The language a given manifest implies. */
function languageOf(manifest: string): string {
  const entry = MANIFEST_LANGUAGE.find(([name]) => name === manifest);
  assert.ok(entry !== undefined, `unmapped manifest ${manifest}`);
  return entry[1];
}

/** Minimal, plausible content for each manifest (presence is what drives detection). */
function contentFor(manifest: string): string {
  switch (manifest) {
    case "package.json":
      return JSON.stringify({ name: "fixture", scripts: {} });
    case "environment.yml":
    case "environment.yaml":
      return "name: fixture_env\ndependencies:\n  - python=3.12\n";
    case "Cargo.toml":
      return '[package]\nname = "fixture"\n';
    case "go.mod":
      return "module fixture\n";
    case "pyproject.toml":
      return "[project]\nname = \"fixture\"\n";
    case "Pipfile":
      return "[packages]\n";
    default:
      return "\n";
  }
}

/** Write the chosen manifests into `dir`. */
function writeManifests(dir: string, manifests: readonly string[]): void {
  for (const manifest of manifests) {
    fs.writeFileSync(path.join(dir, manifest), contentFor(manifest), "utf8");
  }
}

/** The set of languages implied by a set of present manifests. */
function impliedLanguages(manifests: readonly string[]): Set<string> {
  return new Set(manifests.map(languageOf));
}

// -----------------------------------------------------------------------------
// Generator — an arbitrary subset (possibly empty) of the recognized manifests
// -----------------------------------------------------------------------------

const manifestsArb: fc.Arbitrary<string[]> = fc
  .subarray([...ALL_MANIFESTS])
  .map((arr) => [...arr]);

// -----------------------------------------------------------------------------
// Property 31
// -----------------------------------------------------------------------------

describe("Property 31: detection maps present manifests to the implied technologies", () => {
  let baseDir: string;
  let counter = 0;
  const detector = new DefaultEnvironmentDetector();

  before(() => {
    baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "env-detection-"));
  });

  after(() => {
    if (baseDir) {
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("detects exactly the technologies implied by the present manifests, each fully recorded", async () => {
    await fc.assert(
      fc.asyncProperty(manifestsArb, async (manifests) => {
        // Fresh subdirectory per case so leftover manifests never leak between runs.
        const dir = path.join(baseDir, `case-${counter++}`);
        fs.mkdirSync(dir, { recursive: true });
        writeManifests(dir, manifests);

        const profile: ExecutionProfile = await detector.detect(dir);
        const expected = impliedLanguages(manifests);

        // The detected technology languages equal EXACTLY the implied set —
        // present manifests map to their languages, duplicates collapse, and
        // an empty manifest set yields an empty technology set (Req 11.1, 11.12).
        const detectedLanguages = profile.technologies.map((tech) => tech.language);
        assert.deepStrictEqual(
          [...detectedLanguages].sort(),
          [...expected].sort(),
          "detected technology languages must match the implied set exactly",
        );

        // No duplicate technology entries for a single language.
        assert.strictEqual(
          new Set(detectedLanguages).size,
          detectedLanguages.length,
          "each detected language must contribute exactly one technology entry",
        );

        // Each detected technology is fully recorded (Req 11.2).
        for (const tech of profile.technologies) {
          assert.ok(
            typeof tech.language === "string" && tech.language.length > 0,
            "technology must record a non-empty language",
          );
          assert.ok(
            typeof tech.runtime === "string" && tech.runtime.length > 0,
            `technology ${tech.language} must record a runtime`,
          );
          assert.ok(
            tech.environment !== undefined,
            `technology ${tech.language} must record an environment descriptor`,
          );
          assert.ok(
            tech.commands !== undefined,
            `technology ${tech.language} must record a commands object`,
          );
          // All four command slots are present (each either determined or undetermined).
          for (const key of ["run", "test", "debug", "build"] as const) {
            const spec = tech.commands[key];
            assert.ok(
              spec !== undefined,
              `technology ${tech.language} must record a ${key} command spec`,
            );
            assert.strictEqual(
              typeof spec.determined,
              "boolean",
              `technology ${tech.language} ${key} must carry a boolean determined flag`,
            );
          }
        }

        // The profile echoes the inspected root.
        assert.strictEqual(profile.root, dir, "profile must record the inspected root");
      }),
      { numRuns: 200 },
    );
  });

  it("records an empty technology set when no recognized manifest is present", async () => {
    const dir = path.join(baseDir, "empty-root");
    fs.mkdirSync(dir, { recursive: true });
    // A stray, unrecognized file must not trigger any technology.
    fs.writeFileSync(path.join(dir, "README.md"), "# fixture\n", "utf8");

    const profile = await detector.detect(dir);
    assert.deepStrictEqual(profile.technologies, [], "no manifest ⇒ empty technology set");
  });

  it("collapses multiple manifests of the same language into one technology entry", async () => {
    const dir = path.join(baseDir, "many-python");
    fs.mkdirSync(dir, { recursive: true });
    writeManifests(dir, ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"]);

    const profile = await detector.detect(dir);
    const pythonEntries = profile.technologies.filter((t) => t.language === "python");
    assert.strictEqual(
      pythonEntries.length,
      1,
      "several python manifests must collapse to a single python technology",
    );
  });
});
