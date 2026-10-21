// Feature: agent-tools-and-settings — the tool catalogue (ToolRegistry).
//
// The ToolRegistry is the single source of truth for the extension's Coding_Tools:
// the built-in tool definitions (id, display name, description, input schema,
// category, classification, default-enabled flag, per Requirement 1.1–1.4) and their
// live enabled/approval-policy state.
//
// State is backed by `ConfigStore` (globalState persistence). On construction the
// registry loads the persisted per-tool states, applying registry defaults when none
// is stored (Requirement 9.2). `setEnabled` and `setApprovalPolicy` persist the change
// through `ConfigStore` and then fire `onDidChange` so the `ToolHost` can re-register
// the enabled set with the engine and the Tools_View can refresh (Requirement 7.3, 7.4).
//
// `all()` and `enabledDefinitions()` return definitions ordered by category then
// display name (Requirement 7.2). `setApprovalPolicy` accepts only the defined
// `ApprovalPolicy` values (Requirement 7.4).
//
// **Note:** grep_search has been removed as it is not cross-platform compatible.
// The terminal tool (`run_terminal`) properly detects and uses the correct shell
// for each platform (PowerShell on Windows, POSIX shell on Unix/Linux/macOS).
//
// _Requirements: 1.1, 1.2, 1.3, 1.4, 7.3, 7.4, 9.2_

import * as vscode from "vscode";

import type { ConfigStore } from "./configStore";
import { DEFAULT_APPROVAL_POLICY } from "./configStore";
import type {
  ApprovalPolicy,
  ToolCategory,
  ToolDefinition,
  ToolState,
} from "./types";

// -----------------------------------------------------------------------------
// Built-in tool definitions
// -----------------------------------------------------------------------------

/**
 * The built-in Coding_Tools (Requirement 1.1) with their category,
 * classification (Requirement 1.3, 1.4), default-enabled flag, and input schema.
 * Declared in a fixed source order; consumers that need catalogue ordering use
 * `all()` / `enabledDefinitions()`, which sort by category then display name.
 * 
 * grep_search was removed as it's not cross-platform compatible. Use the terminal
 * tool with OS-specific search commands (grep/findstr) or VS Code's built-in search.
 */
export const BUILTIN_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
  {
    id: "read_file",
    displayName: "Read File",
    description:
      "Read the contents of a file in the workspace, returning its text (truncated to the configured maximum read size when the file is large).",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative or absolute path to the file to read.",
        },
        startLine: {
          type: "integer",
          description: "Optional 1-based line to start reading from.",
        },
        endLine: {
          type: "integer",
          description: "Optional 1-based line to stop reading at (inclusive).",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    category: "file",
    classification: "read-only",
    defaultEnabled: true,
  },
  {
    id: "list_directory",
    displayName: "List Directory",
    description:
      "List the files and subdirectories contained within a directory in the workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative or absolute path to the directory to list.",
        },
        depth: {
          type: "integer",
          description: "Optional recursion depth for the listing.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    category: "file",
    classification: "read-only",
    defaultEnabled: true,
  },
  {
    id: "search_files",
    displayName: "Search Files",
    description:
      "Find files in the workspace whose paths match a glob or fuzzy name query.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Glob or fuzzy filename query to match against workspace paths.",
        },
        maxResults: {
          type: "integer",
          description: "Optional maximum number of matching paths to return.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    category: "search",
    classification: "read-only",
    defaultEnabled: true,
  },
  {
    id: "create_file",

    displayName: "Create File",
    description:
      "Create a new file in the workspace with the supplied contents.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative or absolute path of the file to create.",
        },
        content: {
          type: "string",
          description: "Full textual contents to write into the new file.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    category: "file",
    classification: "mutating",
    defaultEnabled: true,
  },
  {
    id: "edit_file",
    displayName: "Edit File",
    description:
      "Apply an edit to an existing file, presented as a reviewable diff before the change is written.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Workspace-relative or absolute path of the file to edit.",
        },
        content: {
          type: "string",
          description: "The full replacement contents for the file.",
        },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    category: "file",
    classification: "mutating",
    defaultEnabled: true,
  },
  {
    id: "run_terminal",
    displayName: "Run Terminal Command",
    description:
      "Run a shell command in a workspace terminal. Compound command lines are decomposed and each command is approved individually. The terminal automatically uses the correct shell for your operating system (PowerShell on Windows, POSIX shell on Unix/Linux/macOS).",
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The command line to execute.",
        },
        cwd: {
          type: "string",
          description: "Optional working directory; must resolve within a workspace root.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    category: "terminal",
    classification: "mutating",
    defaultEnabled: false,
  },
  {
    id: "get_diagnostics",
    displayName: "Get Diagnostics",
    description:
      "Retrieve the compile, lint, and type diagnostics VS Code has reported for a file or the whole workspace.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Optional workspace-relative or absolute path; omit to retrieve workspace-wide diagnostics.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    category: "diagnostics",
    classification: "read-only",
    defaultEnabled: true,
  },
  {
    id: "run_tests",
    displayName: "Run Tests",
    description:
      "Run the project's test command as recorded in the execution profile, under the terminal safety rules.",
    inputSchema: {
      type: "object",
      properties: {
        testFilter: {
          type: "string",
          description: "Optional pattern restricting which tests are run.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    category: "test",
    classification: "mutating",
    defaultEnabled: true,
  },
  {
    id: "fetch_web",
    displayName: "Fetch Web Content",
    description:
      "Fetch and return the contents of a remote URL for the agent to read.",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The HTTPS URL to fetch content from.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    category: "web",
    classification: "read-only",
    defaultEnabled: true,
  },
  {
    id: "list_code_usages",
    displayName: "List Code Usages",
    description:
      "Find where a named symbol (function, class, variable) is defined and referenced across the workspace using the active language services.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: {
          type: "string",
          description: "The symbol name to locate definitions and references for.",
        },
      },
      required: ["symbol"],
      additionalProperties: false,
    },
    category: "search",
    classification: "read-only",
    defaultEnabled: true,
  },
  {
    id: "get_changes",
    displayName: "Get Changes",
    description:
      "Return the working-tree (or staged) git diff for the workspace so pending changes can be reviewed without re-reading every file.",
    inputSchema: {
      type: "object",
      properties: {
        staged: {
          type: "boolean",
          description: "When true, show staged changes (git diff --staged) instead of the working tree.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    category: "search",
    classification: "read-only",
    defaultEnabled: true,
  },
  {
    id: "run_task",
    displayName: "Run Task",
    description:
      "Run a configured VS Code task by name (for example a build or lint task) under the terminal safety rules.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "The name of the configured task to run.",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
    category: "terminal",
    classification: "mutating",
    defaultEnabled: false,
  },
  {
    id: "get_workspace_context",
    displayName: "Get Workspace Context",
    description:
      "Report the IDE/workspace context the agent is operating in: the open workspace folder name(s) and absolute path(s), whether it is a multi-root workspace, the active editor file, other open files, and the editor name/version and platform. Use this to know where you are building.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    category: "ide",
    classification: "read-only",
    defaultEnabled: true,
  },
  {
    id: "start_debug",
    displayName: "Start Debugging",
    description:
      "Run a program under the VS Code debugger using a named launch configuration from .vscode/launch.json. This resolves the interpreter/virtual environment through the language extension (e.g. the Python extension's selected venv), so it avoids having to discover and activate environments manually. Optionally waits for the session to finish and returns its output and exit code. Call with no configuration to list the available launch configurations.",
    inputSchema: {
      type: "object",
      properties: {
        configuration: {
          type: "string",
          description:
            "Name of a launch configuration from .vscode/launch.json to run. Omit to list the available configurations.",
        },
        waitForExit: {
          type: "boolean",
          description:
            "When true, wait for the debug session to terminate and return its captured output and exit code.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    category: "ide",
    classification: "mutating",
    defaultEnabled: true,
  },
];

// -----------------------------------------------------------------------------
// Ordering
// -----------------------------------------------------------------------------

/** Category ordering used by `all()` / `enabledDefinitions()` (Requirement 7.2). */
const CATEGORY_ORDER: readonly ToolCategory[] = [
  "file",
  "search",
  "terminal",
  "diagnostics",
  "test",
  "web",
  "ide",
  "mcp",
];

/** The defined approval-policy values that may be persisted (Requirement 7.4). */
const APPROVAL_POLICIES: readonly ApprovalPolicy[] = [
  "inherit",
  "always-ask",
  "auto-approve",
];

/**
 * Stable comparator ordering tool definitions by category (in the fixed
 * `CATEGORY_ORDER`) and then by display name (Requirement 7.2).
 */
function compareDefinitions(a: ToolDefinition, b: ToolDefinition): number {
  const categoryDelta =
    CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category);
  if (categoryDelta !== 0) {
    return categoryDelta;
  }
  return a.displayName.localeCompare(b.displayName);
}

// -----------------------------------------------------------------------------
// ToolRegistry
// -----------------------------------------------------------------------------

/**
 * The catalogue of Coding_Tools and their live enabled/approval-policy state, backed
 * by `ConfigStore` for persistence. Emits `onDidChange` whenever the enabled set or a
 * tool's approval policy changes so dependents (ToolHost, Tools_View) can react.
 */
export class ToolRegistry {
  /** The static built-in tool definitions (never change at runtime). */
  private readonly builtinDefinitions: readonly ToolDefinition[];
  /** Dynamic definitions contributed by MCP servers; replaced wholesale on refresh. */
  private dynamicDefinitions: readonly ToolDefinition[] = [];

  /** The combined (built-in + dynamic) definitions, recomputed on every refresh. */
  private definitions: readonly ToolDefinition[];
  private definitionsById: ReadonlyMap<string, ToolDefinition>;
  private orderedDefinitions: readonly ToolDefinition[];
  private readonly states: Map<string, ToolState>;

  private readonly changeEmitter = new vscode.EventEmitter<void>();

  /** Fires when a tool's enabled state or approval policy changes. */
  public readonly onDidChange: vscode.Event<void> = this.changeEmitter.event;

  /**
   * @param store       Persistence backing for per-tool state.
   * @param definitions Tool definitions; defaults to the built-in tools.
   */
  public constructor(
    private readonly store: ConfigStore,
    definitions: readonly ToolDefinition[] = BUILTIN_TOOL_DEFINITIONS
  ) {
    this.builtinDefinitions = definitions;
    this.definitions = definitions;
    this.definitionsById = new Map(definitions.map((def) => [def.id, def]));
    this.orderedDefinitions = [...definitions].sort(compareDefinitions);
    this.states = this.loadStates();
  }

  /**
   * Replace the set of dynamic (MCP-provided) tool definitions and re-register.
   * Existing per-tool state is preserved; newly appearing tools receive their
   * default state (MCP tools default to enabled). Fires `onDidChange` so the
   * `ToolHost` re-registers and the Configure Tools page refreshes.
   */
  public updateDynamicTools(defs: readonly ToolDefinition[]): void {
    this.dynamicDefinitions = defs.map((def) => ({ ...def, source: "mcp" as const }));
    this.rebuild();
    this.changeEmitter.fire();
  }

  /** Recompute the combined definition maps and seed default state for new tools. */
  private rebuild(): void {
    const combined = [...this.builtinDefinitions, ...this.dynamicDefinitions];
    this.definitions = combined;
    this.definitionsById = new Map(combined.map((def) => [def.id, def]));
    this.orderedDefinitions = [...combined].sort(compareDefinitions);
    for (const def of combined) {
      if (!this.states.has(def.id)) {
        this.states.set(def.id, {
          enabled: def.defaultEnabled,
          approvalPolicy: DEFAULT_APPROVAL_POLICY,
        });
      }
    }
  }

  /** All tool definitions, ordered by category then display name (Requirement 7.2). */
  public all(): ToolDefinition[] {
    return [...this.orderedDefinitions];
  }

  /** Look up a tool definition by id; `undefined` when absent (Requirement 1.6). */
  public get(id: string): ToolDefinition | undefined {
    return this.definitionsById.get(id);
  }

  /** Whether the identified tool is currently enabled. Unknown ids are not enabled. */
  public isEnabled(id: string): boolean {
    return this.stateOf(id).enabled;
  }

  /**
   * The live state (enabled flag + approval policy) of a tool. For a known tool with
   * no persisted state the registry default is returned; for an unknown id a disabled
   * `inherit` state is returned.
   */
  public stateOf(id: string): ToolState {
    const state = this.states.get(id);
    if (state !== undefined) {
      return { enabled: state.enabled, approvalPolicy: state.approvalPolicy };
    }
    const def = this.definitionsById.get(id);
    if (def !== undefined) {
      return { enabled: def.defaultEnabled, approvalPolicy: DEFAULT_APPROVAL_POLICY };
    }
    return { enabled: false, approvalPolicy: DEFAULT_APPROVAL_POLICY };
  }

  /**
   * The definitions of every currently enabled tool, ordered by category then display
   * name — used to build tool-registration frames (Requirement 2.1–2.3).
   */
  public enabledDefinitions(): ToolDefinition[] {
    return this.orderedDefinitions.filter((def) => this.isEnabled(def.id));
  }

  /**
   * Enable or disable a tool, persisting the change and firing `onDidChange`. Unknown
   * tool ids are ignored (no persistence, no event).
   */
  public async setEnabled(id: string, enabled: boolean): Promise<void> {
    const def = this.definitionsById.get(id);
    if (def === undefined) {
      return;
    }
    const current = this.stateOf(id);
    if (current.enabled === enabled) {
      return;
    }
    const next: ToolState = { enabled, approvalPolicy: current.approvalPolicy };
    await this.persist(id, next);
  }

  /**
   * Set a tool's approval policy, constrained to the defined `ApprovalPolicy` values
   * (Requirement 7.4). An unrecognized value is rejected without persistence. Unknown
   * tool ids are ignored.
   */
  public async setApprovalPolicy(id: string, policy: ApprovalPolicy): Promise<void> {
    if (!isApprovalPolicy(policy)) {
      throw new TypeError(`Invalid approval policy: ${String(policy)}`);
    }
    const def = this.definitionsById.get(id);
    if (def === undefined) {
      return;
    }
    const current = this.stateOf(id);
    if (current.approvalPolicy === policy) {
      return;
    }
    const next: ToolState = { enabled: current.enabled, approvalPolicy: policy };
    await this.persist(id, next);
  }

  /** Release the change emitter. */
  public dispose(): void {
    this.changeEmitter.dispose();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Persist a tool's state through `ConfigStore`, update the in-memory cache, and fire
   * `onDidChange`. The cache is updated only after persistence resolves so a failed
   * save leaves the observable state unchanged (callers handle the rejection).
   */
  private async persist(id: string, state: ToolState): Promise<void> {
    await this.store.setToolState(id, state);
    this.states.set(id, { enabled: state.enabled, approvalPolicy: state.approvalPolicy });
    this.changeEmitter.fire();
  }

  /**
   * Load the per-tool states from `ConfigStore`, seeding registry defaults for any
   * known tool absent from the persisted configuration (Requirement 9.2).
   */
  private loadStates(): Map<string, ToolState> {
    const persisted = this.store.load().config.toolStates;
    const states = new Map<string, ToolState>();
    for (const def of this.definitions) {
      const stored = persisted[def.id];
      if (stored !== undefined) {
        states.set(def.id, {
          enabled: stored.enabled,
          approvalPolicy: stored.approvalPolicy,
        });
      } else {
        states.set(def.id, {
          enabled: def.defaultEnabled,
          approvalPolicy: DEFAULT_APPROVAL_POLICY,
        });
      }
    }
    return states;
  }
}

/** Runtime guard: `value` is one of the defined `ApprovalPolicy` values. */
function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
  return (
    typeof value === "string" &&
    (APPROVAL_POLICIES as readonly string[]).includes(value)
  );
}
