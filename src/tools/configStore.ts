// Feature: agent-tools-and-settings — configuration persistence (ConfigStore).
//
// ConfigStore is the single persistence choke point for agent configuration. It
// wraps VS Code's `globalState` for the `PersistedAgentConfig` (autonomy mode,
// per-tool states, custom instructions, default model) and `workspaceState` for
// the per-root `ExecutionProfile`.
//
// On load it applies defaults when nothing is persisted (R9.2), ignores entries
// for tool identifiers that are absent from the registry (R9.3), and degrades a
// corrupt/unreadable blob to defaults without throwing while reporting a
// "could not load" indication to the caller (R9.5). Edits persist through the
// underlying Memento, which resolves once the value is durably stored (R9.4).
//
// The store depends only on a minimal `MementoLike` surface rather than the full
// `vscode` module so it can be unit/property tested outside the VS Code host.
// `context.globalState` and `context.workspaceState` both satisfy `MementoLike`.
//
// _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5_

import type { ApprovalPolicy, AutonomyMode, ToolDefinition, ToolState } from "./types";
import type { ExecutionProfile } from "../env/types";

// -----------------------------------------------------------------------------
// Persisted data model
// -----------------------------------------------------------------------------

/**
 * The agent configuration persisted in `globalState` (survives extension reloads
 * and VS Code restarts, R9.1). `toolStates` is keyed by tool id.
 */
export interface PersistedAgentConfig {
  readonly version: 1;
  /** Agent-wide approval posture; defaults to `supervised` (R9.2). */
  readonly autonomyMode: AutonomyMode;
  /** Per-tool enabled state and approval policy, keyed by tool id. */
  readonly toolStates: Record<string, ToolState>;
  /** User-authored custom instructions (0–10,000 chars enforced by the view). */
  readonly customInstructions: string;
  /** Selected default model identifier, or `null` when none is chosen. */
  readonly defaultModelId: string | null;
}

/**
 * The result of loading the persisted configuration. `corrupt` is `true` when a
 * stored blob existed but was unreadable/malformed and was discarded in favour of
 * defaults, so the caller can surface a "could not load" indication (R9.5).
 */
export interface ConfigLoadResult {
  readonly config: PersistedAgentConfig;
  readonly corrupt: boolean;
}

/**
 * The minimal storage surface ConfigStore requires. VS Code's `Memento`
 * (`context.globalState` / `context.workspaceState`) is structurally compatible.
 */
export interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Current persisted-config schema version. */
export const CONFIG_VERSION = 1 as const;

/** Default autonomy posture when no configuration is persisted (R9.2). */
export const DEFAULT_AUTONOMY_MODE: AutonomyMode = "supervised";

/** Default per-tool approval policy (follows the autonomy mode). */
export const DEFAULT_APPROVAL_POLICY: ApprovalPolicy = "inherit";

/** `globalState` key under which the agent configuration is stored. */
export const AGENT_CONFIG_KEY = "subconscious.agentConfig";

/**
 * `globalState` key under which the handshake-assigned Client_ID is persisted, so a
 * restarted or reconnected extension can re-present the same id on `client.hello`
 * (Requirement 1.5, 9.3).
 */
export const CLIENT_ID_KEY = "subconscious.clientId";

/** `workspaceState` key prefix for per-root execution profiles. */
export const EXECUTION_PROFILE_KEY_PREFIX = "subconscious.executionProfile:";

const AUTONOMY_MODES: readonly AutonomyMode[] = ["auto", "supervised"];
const APPROVAL_POLICIES: readonly ApprovalPolicy[] = [
  "inherit",
  "always-ask",
  "auto-approve",
];

// -----------------------------------------------------------------------------
// ConfigStore
// -----------------------------------------------------------------------------

export class ConfigStore {
  private readonly knownToolIds: ReadonlySet<string>;

  /**
   * @param globalStore   Backing store for the agent configuration (globalState).
   * @param workspaceStore Backing store for execution profiles (workspaceState).
   * @param toolDefinitions The registry's tool definitions, used to build defaults
   *   and to identify unknown tool ids on load.
   */
  constructor(
    private readonly globalStore: MementoLike,
    private readonly workspaceStore: MementoLike,
    private readonly toolDefinitions: readonly ToolDefinition[]
  ) {
    this.knownToolIds = new Set(toolDefinitions.map((def) => def.id));
  }

  // ---------------------------------------------------------------------------
  // Agent configuration
  // ---------------------------------------------------------------------------

  /**
   * Build the default configuration from the registry's `defaultEnabled` flags and
   * a `supervised` autonomy mode (R9.2).
   */
  defaults(): PersistedAgentConfig {
    return {
      version: CONFIG_VERSION,
      autonomyMode: DEFAULT_AUTONOMY_MODE,
      toolStates: this.defaultToolStates(),
      customInstructions: "",
      defaultModelId: null,
    };
  }

  /**
   * Load the persisted agent configuration (R9.1). Returns defaults when nothing is
   * stored (R9.2); ignores entries for unknown tool ids (R9.3); and degrades a
   * corrupt/unreadable blob to defaults with `corrupt: true` rather than throwing
   * (R9.5).
   */
  load(): ConfigLoadResult {
    let raw: unknown;
    try {
      raw = this.globalStore.get<unknown>(AGENT_CONFIG_KEY);
    } catch {
      // Reading itself failed (unreadable storage): degrade to defaults.
      return { config: this.defaults(), corrupt: true };
    }

    if (raw === undefined || raw === null) {
      return { config: this.defaults(), corrupt: false };
    }

    const parsed = this.parseConfig(raw);
    if (parsed === undefined) {
      return { config: this.defaults(), corrupt: true };
    }
    return { config: parsed, corrupt: false };
  }

  /**
   * Persist the full agent configuration (R9.4). Resolves once the value is durably
   * stored by the underlying Memento.
   */
  async save(config: PersistedAgentConfig): Promise<void> {
    await this.globalStore.update(AGENT_CONFIG_KEY, this.normalize(config));
  }

  /** Persist a new autonomy mode, preserving all other configuration (R9.4). */
  async setAutonomyMode(mode: AutonomyMode): Promise<void> {
    const current = this.load().config;
    await this.save({ ...current, autonomyMode: mode });
  }

  /** Persist the state for a single tool, preserving all other configuration (R9.4). */
  async setToolState(toolId: string, state: ToolState): Promise<void> {
    const current = this.load().config;
    const toolStates: Record<string, ToolState> = {
      ...current.toolStates,
      [toolId]: { enabled: state.enabled, approvalPolicy: state.approvalPolicy },
    };
    await this.save({ ...current, toolStates });
  }

  /** Persist new custom instructions, preserving all other configuration (R9.4). */
  async setCustomInstructions(instructions: string): Promise<void> {
    const current = this.load().config;
    await this.save({ ...current, customInstructions: instructions });
  }

  /** Persist a new default model id, preserving all other configuration (R9.4). */
  async setDefaultModelId(modelId: string | null): Promise<void> {
    const current = this.load().config;
    await this.save({ ...current, defaultModelId: modelId });
  }

  // ---------------------------------------------------------------------------
  // Handshake Client_ID
  // ---------------------------------------------------------------------------

  /**
   * Load the Client_ID persisted from a prior handshake, if any. Returns `undefined`
   * when none is stored or the stored value is not a non-empty string (R1.5, R9.3).
   */
  loadClientId(): string | undefined {
    let raw: unknown;
    try {
      raw = this.globalStore.get<unknown>(CLIENT_ID_KEY);
    } catch {
      return undefined;
    }
    return typeof raw === "string" && raw.length > 0 ? raw : undefined;
  }

  /** Persist the Client_ID assigned/validated by the engine's `client.hello.ack` (R1.5). */
  async saveClientId(clientId: string): Promise<void> {
    await this.globalStore.update(CLIENT_ID_KEY, clientId);
  }

  // ---------------------------------------------------------------------------
  // Execution profiles (per workspace root)
  // ---------------------------------------------------------------------------

  /**
   * Load the execution profile for a workspace root from `workspaceState`. Returns
   * `undefined` when none is stored or the stored value is malformed.
   */
  loadProfile(root: string): ExecutionProfile | undefined {
    let raw: unknown;
    try {
      raw = this.workspaceStore.get<unknown>(profileKey(root));
    } catch {
      return undefined;
    }
    if (raw === undefined || raw === null) {
      return undefined;
    }
    return parseProfile(raw);
  }

  /** Persist the execution profile for its workspace root (R11.4). */
  async saveProfile(profile: ExecutionProfile): Promise<void> {
    await this.workspaceStore.update(profileKey(profile.root), profile);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /** Default per-tool states derived from each definition's `defaultEnabled`. */
  private defaultToolStates(): Record<string, ToolState> {
    const states: Record<string, ToolState> = {};
    for (const def of this.toolDefinitions) {
      states[def.id] = {
        enabled: def.defaultEnabled,
        approvalPolicy: DEFAULT_APPROVAL_POLICY,
      };
    }
    return states;
  }

  /**
   * Validate and normalize a raw stored value into a `PersistedAgentConfig`.
   * Returns `undefined` when the top-level shape is malformed (caller treats this
   * as corrupt). Known tools missing from the blob receive their default state;
   * entries for unknown tool ids are dropped (R9.3); individually malformed tool
   * entries fall back to that tool's default state.
   */
  private parseConfig(raw: unknown): PersistedAgentConfig | undefined {
    if (!isPlainObject(raw)) {
      return undefined;
    }
    if (raw.version !== CONFIG_VERSION) {
      return undefined;
    }
    if (!isAutonomyMode(raw.autonomyMode)) {
      return undefined;
    }
    if (typeof raw.customInstructions !== "string") {
      return undefined;
    }
    if (!(raw.defaultModelId === null || typeof raw.defaultModelId === "string")) {
      return undefined;
    }
    if (!isPlainObject(raw.toolStates)) {
      return undefined;
    }

    // Start from defaults so newly added tools always have a state, then apply the
    // stored states for known tools only.
    const toolStates = this.defaultToolStates();
    for (const [id, state] of Object.entries(raw.toolStates)) {
      if (!this.knownToolIds.has(id)) {
        continue; // R9.3: ignore unknown tool ids.
      }
      if (isToolState(state)) {
        toolStates[id] = {
          enabled: state.enabled,
          approvalPolicy: state.approvalPolicy,
        };
      }
      // Otherwise retain the default state already present for this known tool.
    }

    return {
      version: CONFIG_VERSION,
      autonomyMode: raw.autonomyMode,
      toolStates,
      customInstructions: raw.customInstructions,
      defaultModelId: raw.defaultModelId,
    };
  }

  /** Produce a clean, serializable copy of a config for persistence. */
  private normalize(config: PersistedAgentConfig): PersistedAgentConfig {
    const toolStates: Record<string, ToolState> = {};
    for (const [id, state] of Object.entries(config.toolStates)) {
      toolStates[id] = {
        enabled: state.enabled,
        approvalPolicy: state.approvalPolicy,
      };
    }
    return {
      version: CONFIG_VERSION,
      autonomyMode: config.autonomyMode,
      toolStates,
      customInstructions: config.customInstructions,
      defaultModelId: config.defaultModelId,
    };
  }
}

// -----------------------------------------------------------------------------
// Validation helpers
// -----------------------------------------------------------------------------

function profileKey(root: string): string {
  return `${EXECUTION_PROFILE_KEY_PREFIX}${root}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAutonomyMode(value: unknown): value is AutonomyMode {
  return typeof value === "string" && (AUTONOMY_MODES as readonly string[]).includes(value);
}

function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
  return typeof value === "string" && (APPROVAL_POLICIES as readonly string[]).includes(value);
}

function isToolState(value: unknown): value is ToolState {
  return (
    isPlainObject(value) &&
    typeof value.enabled === "boolean" &&
    isApprovalPolicy(value.approvalPolicy)
  );
}

/**
 * Validate a raw stored value into an `ExecutionProfile`, returning `undefined`
 * when the shape is malformed. Only the top-level structural invariants are
 * enforced here; richer technology validation belongs to the detector.
 */
function parseProfile(raw: unknown): ExecutionProfile | undefined {
  if (!isPlainObject(raw)) {
    return undefined;
  }
  if (typeof raw.root !== "string") {
    return undefined;
  }
  if (typeof raw.detectedAt !== "string") {
    return undefined;
  }
  if (!Array.isArray(raw.technologies)) {
    return undefined;
  }
  return raw as unknown as ExecutionProfile;
}
