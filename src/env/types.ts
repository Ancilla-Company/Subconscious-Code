// Shared execution-environment profile types for the agent-tools-and-settings feature.
//
// These describe a Workspace_Root's detected technologies and the commands used to
// run, test, debug, and build the project. Profiles are persisted per workspace root
// (Requirement 11.4) and supplied to the engine so the agent does not re-derive the
// execution environment on every new thread (Requirement 11.5, 11.6).

/**
 * How a detected environment must be activated before commands run against it
 * (e.g. a Python conda or venv environment, per Requirement 11.3).
 */
export interface EnvironmentActivation {
  /** The kind of environment isolation in use. */
  readonly kind: "venv" | "conda" | "none";
  /** Command applied before running project commands, when activation is required. */
  readonly activationCommand?: string;
  /** Absolute path to the interpreter/runtime, when known. */
  readonly interpreterPath?: string;
}

/**
 * A single project command (run/test/debug/build). A `null` command with
 * `determined: false` marks the command as undetermined for the user to supply
 * (Requirement 11.10).
 */
export interface CommandSpec {
  /** The command line, or `null` when it could not be determined. */
  readonly command: string | null;
  /** Whether the detector was able to determine this command. */
  readonly determined: boolean;
}

/**
 * The set of project commands recorded for a detected technology (Requirement 11.2).
 * Each entry is optional so a technology may contribute only the commands that apply.
 */
export interface ProjectCommands {
  readonly run?: CommandSpec;
  readonly test?: CommandSpec;
  readonly debug?: CommandSpec;
  readonly build?: CommandSpec;
}

/**
 * A technology detected within a Workspace_Root together with its execution
 * environment and commands (Requirement 11.2).
 */
export interface DetectedTechnology {
  /** Language identifier, e.g. "python" or "node". */
  readonly language: string;
  /** Interpreter/runtime identifier, when applicable. */
  readonly runtime?: string;
  /** Activation details for the technology's environment, when applicable. */
  readonly environment?: EnvironmentActivation;
  /** Commands to run, test, debug, and build the project for this technology. */
  readonly commands: ProjectCommands;
}

/**
 * The persisted description of a Workspace_Root's execution environment. Recorded
 * per workspace root (Requirement 11.4); an empty `technologies` array indicates no
 * recognized manifest or configuration file was found (Requirement 11.12).
 */
export interface ExecutionProfile {
  /** Filesystem path of the Workspace_Root this profile describes. */
  readonly root: string;
  /** ISO-8601 timestamp of when detection last ran. */
  readonly detectedAt: string;
  /** Detected technologies; empty when nothing was recognized. */
  readonly technologies: DetectedTechnology[];
}
