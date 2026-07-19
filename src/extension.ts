// Feature: agent-tools-and-settings — extension entry point wiring.
//
// This module composes the agent-tooling object graph at activation and attaches it
// to the existing chat client:
//
//   ConfigStore ─┬─▶ ToolRegistry ─┬─▶ ToolHost ─▶ EngineClient (transport + router)
//                │                 │
//                │                 └─▶ ApprovalManager ─▶ terminal tools
//                └─▶ EnvironmentDetector (per-root ExecutionProfile)
//
// The chat and Settings_View (`subconscious.settings`) webviews are registered in the
// activity-bar container; the Coding_Tools management surface is an editor-area
// "Configure Tools" page (`ToolsPanel`) opened via the `subconscious.configureTools`
// command and the gear button in the chat view title. MCP servers declared in
// `.vscode/mcp.json` are hosted by the extension (`McpManager`) and their discovered
// tools are pushed into the registry/host alongside the built-ins. The current per-root
// execution profile is supplied to the engine (on connect / edit via the
// SettingsView-registered provider) and to every tool invocation through the ToolHost
// `ToolContext`, so a new thread's context does not re-derive it (Requirement 11.6).
//
// _Requirements: 2.1, 7.1, 8.1, 11.5, 11.6_

import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";

import { EngineClient } from "./engine/client";
import { ChatPanel } from "./panel/chatPanel";
import { ToolsPanel } from "./panel/toolsPanel";
import { SettingsView } from "./panel/settingsView";

import { ConfigStore } from "./tools/configStore";
import { ToolRegistry, BUILTIN_TOOL_DEFINITIONS } from "./tools/registry";
import { DefaultWorkspacePathGuard } from "./tools/pathGuard";
import { ShellCommandDecomposer } from "./tools/commandDecomposer";
import { ApprovalManager } from "./tools/approvalManager";
import { VsCodeConfirmationUI } from "./tools/vscodeConfirmationUi";
import { ToolHost } from "./tools/host";
import type { AutonomyMode, CodingTool, ToolContext } from "./tools/types";

import { McpManager, type McpConfigSource } from "./mcp/manager";
import type { McpInputDef } from "./mcp/types";

import { ReadFileTool } from "./tools/coding/readFile";
import {
  CreateFileTool,
  EditFileTool,
  type DiffPresenter,
  type DiffReviewRequest,
} from "./tools/coding/writeFile";
import {
  ListDirectoryTool,
  SearchFilesTool,
  GrepSearchTool,
  GetDiagnosticsTool,
  FetchWebTool,
} from "./tools/coding/readOnly";
import { RunTerminalTool, RunTestsTool } from "./tools/coding/terminal";
import {
  ListCodeUsagesTool,
  GetChangesTool,
  RunTaskTool,
} from "./tools/coding/parity";
import { GetWorkspaceContextTool } from "./tools/coding/workspaceContext";
import { StartDebugTool } from "./tools/coding/debug";
import { createVsCodeTerminalRunner } from "./tools/coding/terminalRunner";

import {
  DefaultEnvironmentDetector,
  WATCHED_MANIFESTS,
  type Disposable as EnvDisposable,
  type ManifestWatchSource,
  type WatchSourceFactory,
} from "./env/environmentDetector";

let client: EngineClient | undefined;

/** globalState key holding the fallback working directory when no folder is open. */
const SCOPE_ROOT_KEY = "subconscious.scopeRoot";

/**
 * Supplies the fallback scope root chosen by the user when the window has no workspace
 * folder open. Set during activation to read from globalState; returns `undefined`
 * until a directory is chosen.
 */
let scopeRootFallback: () => string | undefined = () => undefined;

/**
 * The directories the agent's tools are scoped to. Prefers the open workspace
 * folder(s); when the window was opened without a folder, falls back to the
 * user-chosen working directory (see `subconscious.setWorkingDirectory`).
 */
function workspaceRoots(): string[] {
  const folders = (vscode.workspace.workspaceFolders ?? []).map(
    (folder) => folder.uri.fsPath,
  );
  if (folders.length > 0) {
    return folders;
  }
  const fallback = scopeRootFallback();
  return fallback !== undefined && fallback.trim().length > 0 ? [fallback] : [];
}

/** The primary scope root, or `undefined` when neither a folder nor a fallback is set. */
function firstWorkspaceRoot(): string | undefined {
  return workspaceRoots()[0];
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  client = new EngineClient();
  const engine = client;

  // When the window has no folder open, tools fall back to a user-chosen working
  // directory persisted in globalState (see `subconscious.setWorkingDirectory`).
  scopeRootFallback = () => context.globalState.get<string>(SCOPE_ROOT_KEY);

  // ── Configuration + catalogue ───────────────────────────────────────────────
  const configStore = new ConfigStore(
    context.globalState,
    context.workspaceState,
    BUILTIN_TOOL_DEFINITIONS,
  );
  const registry = new ToolRegistry(configStore);
  context.subscriptions.push({ dispose: () => registry.dispose() });

  // ── Safety + approval components ─────────────────────────────────────────────
  const pathGuard = new DefaultWorkspacePathGuard(workspaceRoots);
  const decomposer = new ShellCommandDecomposer();
  const approvalManager = new ApprovalManager({
    policyView: registry,
    confirmationUi: new VsCodeConfirmationUI(),
    decomposer,
    initialMode: configStore.load().config.autonomyMode,
  });

  // ── Coding tools ─────────────────────────────────────────────────────────────
  const settings = vscode.workspace.getConfiguration("subconscious");
  const maxReadBytes = settings.get<number>("maxReadBytes", 10_485_760);
  const toolTimeoutSeconds = settings.get<number>("toolTimeoutSeconds", 120);

  const diffPresenter = createDiffPresenter(context);
  // Terminal tools run in the VISIBLE integrated terminal (inheriting the user's shell
  // profile and the Python extension's venv activation) rather than a hidden process.
  const terminalRunner = createVsCodeTerminalRunner();

  // The chat view is created early so the ToolHost can forward tool-activity events to
  // it (rendered as expandable cards in the message stream).
  const chat = new ChatPanel(context.extensionUri, engine, context.workspaceState);

  const tools: CodingTool[] = [
    new ReadFileTool({ maxReadBytes }),
    new CreateFileTool(),
    new EditFileTool(diffPresenter),
    new ListDirectoryTool(),
    new SearchFilesTool(),
    new GrepSearchTool(),
    new GetDiagnosticsTool(),
    new FetchWebTool(),
    new RunTerminalTool({ approval: approvalManager, runner: terminalRunner }),
    new RunTestsTool({ approval: approvalManager, runner: terminalRunner }),
    new ListCodeUsagesTool(),
    new GetChangesTool(),
    new RunTaskTool(),
    new GetWorkspaceContextTool(),
    new StartDebugTool(),
  ];

  // Each tool invocation receives the shared path guard, the current per-root
  // execution profile (Requirement 11.6), and its abort signal.
  const createContext = (signal: AbortSignal): ToolContext => {
    const root = firstWorkspaceRoot();
    return {
      guard: pathGuard,
      profile: root !== undefined ? configStore.loadProfile(root) : undefined,
      signal,
    };
  };

  // ── Tool-callback host ───────────────────────────────────────────────────────
  const host = new ToolHost({
    registry,
    tools,
    transport: engine,
    createContext,
    timeoutMs: toolTimeoutSeconds * 1000,
    onToolEvent: (event) => chat.showToolActivity(event),
  });
  // Route inbound tool.call frames and (re-)register on connect / registry change.
  engine.attachToolHost(host, registry.onDidChange);

  // ── Environment detection ────────────────────────────────────────────────────
  const detector = new DefaultEnvironmentDetector({
    watchSourceFactory: vsCodeWatchSourceFactory,
  });
  context.subscriptions.push(
    detector.onDidUpdate((profile) => {
      void configStore.saveProfile(profile).then(() => {
        engine.sendProfile(profile);
      });
    }),
  );

  // ── Views ──────────────────────────────────────────────────────────────────
  const settingsView = new SettingsView(context.extensionUri, {
    client: engine,
    configStore,
    registry,
    approvalManager,
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatPanel.viewType, chat, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(SettingsView.viewType, settingsView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("subconscious.reconnect", () => connect(engine)),
    vscode.commands.registerCommand("subconscious.newThread", () => chat.newThread()),
    vscode.commands.registerCommand("subconscious.configureTools", () =>
      ToolsPanel.show(context.extensionUri, registry, engine),
    ),
    vscode.commands.registerCommand("subconscious.setWorkingDirectory", () =>
      chooseWorkingDirectory(context, configStore, detector, engine),
    ),
    vscode.commands.registerCommand("subconscious.selectWorkspace", async () => {
      // The picker UI lives in the webview header; this command just focuses it.
      await vscode.commands.executeCommand("subconscious.chat.focus");
    }),
    { dispose: () => client?.dispose() },
  );

  // ── settings.json bridge ─────────────────────────────────────────────────────
  // VS Code settings are the declarative, user-editable overrides layered on top of
  // the persisted defaults (Decision 2A). When a setting is explicitly set it is
  // applied to the runtime immediately and mirrored into ConfigStore so the Settings
  // view reflects it; unset settings leave the stored value untouched.
  applySettings(configStore, approvalManager);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("subconscious")) {
        applySettings(configStore, approvalManager);
      }
    }),
  );

  // ── MCP servers (.vscode/mcp.json) ───────────────────────────────────────────
  // The extension hosts MCP clients itself (Decision 1A): it reads the VS Code–standard
  // `.vscode/mcp.json`, starts each server, discovers its tools, and registers them
  // alongside the built-in tools. Discovered tools flow into the ToolRegistry (so they
  // appear in Configure Tools and are advertised to the engine) and the ToolHost (so
  // they are executable via `tools/call`).
  const mcpManager = wireMcp(context, registry, host);
  context.subscriptions.push({ dispose: () => mcpManager?.dispose() });

  // Establish the initial per-root execution profile so it is available to threads
  // and advertised to the engine on connect (Requirement 11.5, 11.6). Non-blocking.
  void initializeProfile(configStore, detector, context);

  // With no folder open and no fallback chosen yet, the agent's tools have nothing to
  // scope to — invite the user to pick a working directory (non-blocking).
  if (workspaceRoots().length === 0) {
    void promptForWorkingDirectory(context, configStore, detector, engine);
  }

  await connect(engine);
}

/**
 * Prompt (non-modally) to choose a working directory when the window has no folder
 * open, so the agent's file/terminal tools have a directory to operate in.
 */
async function promptForWorkingDirectory(
  context: vscode.ExtensionContext,
  configStore: ConfigStore,
  detector: DefaultEnvironmentDetector,
  engine: EngineClient,
): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    "Subconscious: no folder is open. Choose a working directory for the agent's tools to operate in.",
    "Choose Folder",
  );
  if (choice === "Choose Folder") {
    await chooseWorkingDirectory(context, configStore, detector, engine);
  }
}

/**
 * Let the user pick a fallback working directory (used only when no workspace folder
 * is open). Persists it, re-detects its execution profile, and advertises it so the
 * agent's tools are scoped to it.
 */
async function chooseWorkingDirectory(
  context: vscode.ExtensionContext,
  configStore: ConfigStore,
  detector: DefaultEnvironmentDetector,
  engine: EngineClient,
): Promise<void> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: "Set as agent working directory",
  });
  if (picked === undefined || picked.length === 0) {
    return;
  }
  const root = picked[0].fsPath;
  await context.globalState.update(SCOPE_ROOT_KEY, root);

  // Re-detect + persist + advertise the profile for the chosen directory so tools and
  // the engine agree on where work happens.
  try {
    const profile = await detector.detect(root);
    await configStore.saveProfile(profile);
    if (engine.isOpen()) {
      engine.sendProfile(profile);
    }
  } catch {
    // Profile detection is best-effort; scoping still applies via workspaceRoots().
  }
  vscode.window.showInformationMessage(
    `Subconscious: agent working directory set to ${root}`,
  );
}

/**
 * Detect and persist the per-root execution profile when none is stored yet, then
 * begin watching the root's manifests for re-detection (Requirement 11.5, 11.6, 11.9).
 */
async function initializeProfile(
  configStore: ConfigStore,
  detector: DefaultEnvironmentDetector,
  context: vscode.ExtensionContext,
): Promise<void> {
  const root = firstWorkspaceRoot();
  if (root === undefined) {
    return;
  }

  if (configStore.loadProfile(root) === undefined) {
    const profile = await detector.detect(root);
    await configStore.saveProfile(profile);
    if (client?.isOpen() === true) {
      client.sendProfile(profile);
    }
  }

  const watcher = detector.watch(root);
  context.subscriptions.push({ dispose: () => watcher.dispose() });
}

/**
 * Build the production {@link DiffPresenter} for `edit_file`: it shows a side-by-side
 * diff of the file's current contents against the proposed contents, then asks the
 * user to apply or discard the change (Requirement 6.2, 6.4).
 */
function createDiffPresenter(context: vscode.ExtensionContext): DiffPresenter {
  const scheme = "subconscious-edit";
  const proposedByPath = new Map<string, string>();
  const provider: vscode.TextDocumentContentProvider = {
    provideTextDocumentContent: (uri) => proposedByPath.get(uri.path) ?? "",
  };
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(scheme, provider),
  );

  let counter = 0;
  return async (request: DiffReviewRequest): Promise<boolean> => {
    counter += 1;
    const key = `/${counter}${request.path}`;
    proposedByPath.set(key, request.proposedContent);
    const proposedUri = vscode.Uri.parse(`${scheme}:${key}`);
    const originalUri = vscode.Uri.file(request.path);
    const title = `Proposed edit: ${vscode.workspace.asRelativePath(originalUri)}`;

    try {
      await vscode.commands.executeCommand(
        "vscode.diff",
        originalUri,
        proposedUri,
        title,
      );
      const choice = await vscode.window.showInformationMessage(
        `Apply the proposed edit to ${vscode.workspace.asRelativePath(originalUri)}?`,
        { modal: true },
        "Apply",
      );
      return choice === "Apply";
    } finally {
      proposedByPath.delete(key);
    }
  };
}

/**
 * A {@link WatchSourceFactory} backed by a `vscode.FileSystemWatcher` that fires on any
 * create/change/delete of a watched manifest in `root` (Requirement 11.9).
 */
const vsCodeWatchSourceFactory: WatchSourceFactory = (
  root: string,
  manifestNames: readonly string[],
): ManifestWatchSource => {
  const pattern = new vscode.RelativePattern(
    root,
    `{${[...manifestNames].join(",")}}`,
  );
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);
  return {
    onChange(listener: () => void): EnvDisposable {
      const subs = [
        watcher.onDidCreate(() => listener()),
        watcher.onDidChange(() => listener()),
        watcher.onDidDelete(() => listener()),
      ];
      return {
        dispose: (): void => {
          for (const sub of subs) {
            sub.dispose();
          }
          watcher.dispose();
        },
      };
    },
  };
};

/**
 * Apply the user-editable `settings.json` overrides to the runtime. Only settings the
 * user has explicitly set (workspace or global) are applied, so an untouched setting
 * leaves the persisted default in place (Decision 2A — augment, don't replace).
 */
function applySettings(
  configStore: ConfigStore,
  approvalManager: ApprovalManager,
): void {
  const config = vscode.workspace.getConfiguration("subconscious");

  // Autonomy mode — the standardized approval posture (cf. Copilot/Kiro auto-approve).
  const autonomy = config.inspect<AutonomyMode>("agent.autonomyMode");
  const autonomyValue = autonomy?.workspaceValue ?? autonomy?.globalValue;
  const autoApprove = config.inspect<boolean>("tools.autoApprove");
  const autoApproveValue = autoApprove?.workspaceValue ?? autoApprove?.globalValue;

  let effectiveMode: AutonomyMode | undefined;
  if (autoApproveValue === true) {
    effectiveMode = "auto";
  } else if (autonomyValue === "auto" || autonomyValue === "supervised") {
    effectiveMode = autonomyValue;
  }

  if (effectiveMode !== undefined) {
    approvalManager.setAutonomyMode(effectiveMode);
    void configStore.setAutonomyMode(effectiveMode);
  }
}

/**
 * Wire the MCP subsystem: read `.vscode/mcp.json`, start the servers, and push their
 * discovered tools into the registry and host. Watches the config file for changes and
 * reloads. Returns the manager (for disposal), or `undefined` when MCP is disabled or
 * no workspace root is open. Never throws — MCP failures must not break activation.
 */
function wireMcp(
  context: vscode.ExtensionContext,
  registry: ToolRegistry,
  host: ToolHost,
): McpManager | undefined {
  const root = firstWorkspaceRoot();
  if (root === undefined) {
    return undefined;
  }
  const enabled = vscode.workspace
    .getConfiguration("subconscious")
    .get<boolean>("mcp.enabled", true);
  if (!enabled) {
    return undefined;
  }

  const relativeConfig = vscode.workspace
    .getConfiguration("subconscious")
    .get<string>("mcp.configFile", ".vscode/mcp.json");
  const configFsPath = path.isAbsolute(relativeConfig)
    ? relativeConfig
    : path.join(root, relativeConfig);

  const configSource: McpConfigSource = {
    async read(): Promise<string | undefined> {
      try {
        return await fs.promises.readFile(configFsPath, "utf8");
      } catch {
        return undefined; // absent/unreadable → no servers
      }
    },
    workspaceFolder(): string | undefined {
      return root;
    },
  };

  const manager = new McpManager({
    configSource,
    prompt: (input: McpInputDef) => promptForInput(input),
    onError: (serverId, error) => {
      vscode.window.showWarningMessage(
        `Subconscious MCP: server '${serverId}' failed — ${error.message}`,
      );
    },
    onDidChangeTools: (defs, tools) => {
      // Set the executable tools first so a call arriving right after registration can
      // be dispatched, then advertise the definitions (which fires re-registration).
      host.setDynamicTools(tools);
      registry.updateDynamicTools(defs);
    },
  });

  // Initial load and file-watch driven reloads (both non-blocking).
  void manager.reload();
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(root, relativeConfig),
  );
  const reload = (): void => {
    void manager.reload();
  };
  watcher.onDidCreate(reload);
  watcher.onDidChange(reload);
  watcher.onDidDelete(reload);
  context.subscriptions.push(watcher);

  return manager;
}

/** Prompt the user for an `${input:id}` value declared in `.vscode/mcp.json`. */
async function promptForInput(input: McpInputDef): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt: input.description ?? `Value for '${input.id}' (MCP configuration)`,
    password: input.password === true,
    ignoreFocusOut: true,
  });
}

async function connect(c: EngineClient): Promise<void> {
  try {
    await vscode.window.withProgress(
      { location: { viewId: ChatPanel.viewType }, title: "Connecting to Subconscious engine…" },
      () => c.connect(),
    );
  } catch (err: any) {
    vscode.window.showErrorMessage(`Subconscious: ${err?.message ?? err}`);
  }
}

export function deactivate(): void {
  client?.dispose();
}
