// Feature: agent-tools-and-settings — the agent Settings_View (SettingsView).
//
// SettingsView contributes the `subconscious.settings` webview view to the
// Subconscious activity-bar container. It is the single surface for configuring:
//
//   - the Autonomy_Mode, applied to the ApprovalManager before the next approval
//     decision (Requirement 8.2);
//   - the default-enabled tools, toggled through the ToolRegistry (Requirement 8.1);
//   - the Custom_Instructions, bounded to 0–10,000 characters — an overflow is
//     rejected, the previous value retained, and a max-length notice shown
//     (Requirement 8.3, 8.4);
//   - the default model, fetched from the engine's `GET /api/v1/models` within 5
//     seconds, degrading to an empty list plus an unavailable notice on failure
//     (Requirement 8.5, 8.6), and applied to un-overridden `chat.send` frames via
//     the EngineClient default-model provider (Requirement 8.7);
//   - the per-root Execution_Profile, displayed and edited (including undetermined
//     and manually added entries), persisted within 2 seconds and supplied to the
//     engine on edit (Requirement 11.7, 11.8, 11.10, 11.12, 11.14).
//
// All persistence flows through `ConfigStore`; every setting therefore survives an
// extension reload (Requirement 8.9). The view renders exclusively with VS Code
// theme tokens and the existing `media/main.css` component vocabulary
// (Requirement 8.8, 11.14).
//
// Collaborators are imported type-only so the module's pure helpers
// (`validateCustomInstructions`, `fetchModelsWithTimeout`) can be exercised outside
// the VS Code host.
//
// _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9, 11.7, 11.8, 11.14_

import * as vscode from "vscode";

import type { EngineClient } from "../engine/client";
import type { HiveSnapshot, ModelConfig } from "../engine/types";
import type { ConfigStore } from "../tools/configStore";
import type { ToolRegistry } from "../tools/registry";
import type { ApprovalManager } from "../tools/approvalManager";
import type { AutonomyMode } from "../tools/types";
import type {
  CommandSpec,
  DetectedTechnology,
  EnvironmentActivation,
  ExecutionProfile,
  ProjectCommands,
} from "../env/types";

// -----------------------------------------------------------------------------
// Pure, host-independent helpers (exported for unit/integration tests)
// -----------------------------------------------------------------------------

/** Maximum accepted length of the Custom_Instructions (Requirement 8.3, 8.4). */
export const MAX_CUSTOM_INSTRUCTIONS_LENGTH = 10_000;

/** Timeout for the engine model-list fetch (Requirement 8.5, 8.6). */
export const MODEL_FETCH_TIMEOUT_MS = 5_000;

/** The result of validating a Custom_Instructions edit against the length bound. */
export type CustomInstructionsResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: "too-long" };

/**
 * Validate a Custom_Instructions value against the 0–10,000 character bound. A value
 * within the bound is accepted; a longer value is rejected so the caller can retain
 * the previous value and surface a max-length notice (Requirement 8.3, 8.4).
 */
export function validateCustomInstructions(value: string): CustomInstructionsResult {
  if (value.length > MAX_CUSTOM_INSTRUCTIONS_LENGTH) {
    return { ok: false, reason: "too-long" };
  }
  return { ok: true, value };
}

/** The outcome of a (possibly timed-out) engine model-list fetch. */
export interface ModelListResult {
  /** The retrieved models; empty when the fetch failed or timed out. */
  readonly models: ModelConfig[];
  /** `false` when the list could not be retrieved within the timeout (Requirement 8.6). */
  readonly available: boolean;
}

/** The minimal engine surface the model fetch needs; `EngineClient` satisfies it. */
export interface ModelLister {
  listModels(): Promise<ModelConfig[]>;
}

/**
 * Fetch the engine model list, resolving to an empty, unavailable result if the
 * fetch rejects or does not complete within `timeoutMs` (Requirement 8.5, 8.6). Never
 * rejects: callers always receive a {@link ModelListResult}.
 */
export async function fetchModelsWithTimeout(
  lister: ModelLister,
  timeoutMs: number = MODEL_FETCH_TIMEOUT_MS
): Promise<ModelListResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ModelListResult>((resolve) => {
    timer = setTimeout(() => resolve({ models: [], available: false }), timeoutMs);
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  });
  const fetched = lister.listModels().then(
    (models): ModelListResult => ({ models, available: true }),
    (): ModelListResult => ({ models: [], available: false })
  );
  const result = await Promise.race([fetched, timeout]);
  if (timer !== undefined) {
    clearTimeout(timer);
  }
  return result;
}

/**
 * Build a {@link CommandSpec} from a user-entered command string. A blank value marks
 * the command undetermined (`command: null`, `determined: false`, Requirement 11.10);
 * a non-blank value records the trimmed command as determined.
 */
export function toCommandSpec(raw: unknown): CommandSpec {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (text.length === 0) {
    return { command: null, determined: false };
  }
  return { command: text, determined: true };
}

/**
 * Rebuild a safe {@link ExecutionProfile} from untrusted webview edit input,
 * preserving the profile's root and detection timestamp. Manually added and
 * undetermined entries are retained (Requirement 11.7, 11.10, 11.12).
 */
export function normalizeProfileFromWebview(
  raw: unknown,
  root: string,
  detectedAt: string
): ExecutionProfile {
  const technologies: DetectedTechnology[] = [];
  const rawTechs =
    isRecord(raw) && Array.isArray(raw.technologies) ? raw.technologies : [];

  for (const rawTech of rawTechs) {
    if (!isRecord(rawTech)) {
      continue;
    }
    technologies.push(normalizeTechnology(rawTech));
  }

  return { root, detectedAt, technologies };
}

function normalizeTechnology(raw: Record<string, unknown>): DetectedTechnology {
  const language = typeof raw.language === "string" ? raw.language : "";
  const tech: {
    language: string;
    runtime?: string;
    environment?: EnvironmentActivation;
    commands: ProjectCommands;
  } = {
    language,
    commands: normalizeCommands(raw.commands),
  };

  if (typeof raw.runtime === "string" && raw.runtime.trim().length > 0) {
    tech.runtime = raw.runtime.trim();
  }

  const environment = normalizeEnvironment(raw.environment);
  if (environment !== undefined) {
    tech.environment = environment;
  }

  return tech;
}

function normalizeEnvironment(raw: unknown): EnvironmentActivation | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const kind: EnvironmentActivation["kind"] =
    raw.kind === "venv" || raw.kind === "conda" ? raw.kind : "none";
  const activationCommand =
    typeof raw.activationCommand === "string" && raw.activationCommand.trim().length > 0
      ? raw.activationCommand.trim()
      : undefined;
  const interpreterPath =
    typeof raw.interpreterPath === "string" && raw.interpreterPath.trim().length > 0
      ? raw.interpreterPath.trim()
      : undefined;

  // A "none" kind with no activation/interpreter detail carries no information.
  if (kind === "none" && activationCommand === undefined && interpreterPath === undefined) {
    return { kind: "none" };
  }

  const env: {
    kind: EnvironmentActivation["kind"];
    activationCommand?: string;
    interpreterPath?: string;
  } = { kind };
  if (activationCommand !== undefined) {
    env.activationCommand = activationCommand;
  }
  if (interpreterPath !== undefined) {
    env.interpreterPath = interpreterPath;
  }
  return env;
}

function normalizeCommands(raw: unknown): ProjectCommands {
  const source = isRecord(raw) ? raw : {};
  return {
    run: toCommandSpec(readCommandField(source.run)),
    test: toCommandSpec(readCommandField(source.test)),
    debug: toCommandSpec(readCommandField(source.debug)),
    build: toCommandSpec(readCommandField(source.build)),
  };
}

/** Read a command field that may arrive as a bare string or a `{ command }` record. */
function readCommandField(raw: unknown): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (isRecord(raw) && typeof raw.command === "string") {
    return raw.command;
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// -----------------------------------------------------------------------------
// SettingsView dependencies
// -----------------------------------------------------------------------------

/** Collaborators the {@link SettingsView} reads from and writes through. */
export interface SettingsViewDeps {
  /** Engine client: model list, default-model provider, profile provider + send. */
  readonly client: EngineClient;
  /** Persistence for autonomy, custom instructions, default model, and profiles. */
  readonly configStore: ConfigStore;
  /** Tool catalogue used to toggle default-enabled tools. */
  readonly registry: ToolRegistry;
  /** Approval manager the selected autonomy mode is applied to (Requirement 8.2). */
  readonly approvalManager: ApprovalManager;
}

// -----------------------------------------------------------------------------
// SettingsView
// -----------------------------------------------------------------------------

/** Message shape a webview posts back to the extension. */
interface WebviewMessage {
  readonly type: string;
  readonly [key: string]: unknown;
}

/**
 * The agent Settings_View webview provider (view id `subconscious.settings`).
 * Follows the `ChatPanel` webview conventions: strict CSP with a per-load nonce,
 * `postMessage` bridge, and the shared `media/main.css` theme-token vocabulary.
 */
export class SettingsView {
  /** Editor-area panel id (settings open as a page, not a sidebar section). */
  public static readonly viewType = "subconscious.settingsPanel";

  private panel?: vscode.WebviewPanel;
  private connected = false;

  private readonly client: EngineClient;
  private readonly configStore: ConfigStore;
  private readonly registry: ToolRegistry;
  private readonly approvalManager: ApprovalManager;

  private readonly disposables: vscode.Disposable[] = [];

  public constructor(
    private readonly extensionUri: vscode.Uri,
    deps: SettingsViewDeps
  ) {
    this.client = deps.client;
    this.configStore = deps.configStore;
    this.registry = deps.registry;
    this.approvalManager = deps.approvalManager;

    // Apply the persisted autonomy mode to the approval manager immediately so it is
    // in force before the first approval decision (Requirement 8.2).
    this.approvalManager.setAutonomyMode(this.configStore.load().config.autonomyMode);

    // Supply the selected default model to un-overridden `chat.send` frames (R8.7) and
    // the current (possibly edited) execution profile to the engine on connect (R11.5).
    this.client.setDefaultModelProvider(() => this.configStore.load().config.defaultModelId);
    this.client.setExecutionProfileProvider(() => this.currentProfile());

    // Refresh the tool list whenever the registry's enabled set changes.
    this.disposables.push(
      this.registry.onDidChange(() => this.postToolStates())
    );

    // Track connection status to refresh the model list on (re)connect.
    const onStatus = (status: string): void => {
      this.connected = status === "connected";
      this.post({ type: "status", connected: this.connected });
      if (this.connected) {
        void this.loadModels();
      }
      void this.postAccount();
    };
    this.client.on("status", onStatus);
    this.disposables.push({ dispose: () => this.client.off("status", onStatus) });
  }

  /** Open the settings page in the editor area, or reveal it if already open. */
  public show(): void {
    if (this.panel !== undefined) {
      this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.One);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      SettingsView.viewType,
      "Subconscious Settings",
      vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
      }
    );
    this.panel = panel;
    // Separate light/dark icons so the tab icon stays visible in every theme.
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.extensionUri, "media", "icon-settings-light.svg"),
      dark: vscode.Uri.joinPath(this.extensionUri, "media", "icon-settings-dark.svg"),
    };
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage(
      (msg: WebviewMessage) => this.onWebviewMessage(msg),
      undefined,
      this.disposables
    );
    // Closing the page only drops the panel; the collaborators wired in the
    // constructor (model provider, registry listener) live as long as the extension.
    panel.onDidDispose(() => {
      this.panel = undefined;
    });
  }

  public dispose(): void {
    this.panel?.dispose();
    this.panel = undefined;
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  // ── Webview → extension ────────────────────────────────────────────────────
  private async onWebviewMessage(msg: WebviewMessage): Promise<void> {
    try {
      switch (msg.type) {
        case "ready":
          this.postInit();
          this.postProfile();
          this.post({ type: "status", connected: this.connected });
          await this.loadModels();
          await this.postAccount();
          break;
        case "refreshAccount":
          await this.postAccount(msg.reconnect === true);
          break;
        case "login":
          await this.login(msg.email, msg.password);
          break;
        case "logout":
          await this.logout();
          break;
        case "setAutonomyMode":
          await this.setAutonomyMode(msg.mode);
          break;
        case "setToolEnabled":
          await this.setToolEnabled(msg.id, msg.enabled);
          break;
        case "setCustomInstructions":
          await this.setCustomInstructions(msg.value);
          break;
        case "setDefaultModel":
          await this.setDefaultModel(msg.modelId);
          break;
        case "refreshModels":
          await this.loadModels();
          break;
        case "saveProfile":
          await this.saveProfile(msg.profile);
          break;
      }
    } catch (err) {
      this.post({ type: "error", message: errorMessage(err) });
    }
  }

  // ── Account and server ──────────────────────────────────────────────────────
  // The engine owns the server session (sign-in, hive membership, presence); this
  // page only shows it and lets the user sign the engine in or out.

  /** Read the engine's account/hive state and push it; failures degrade to a note. */
  private async postAccount(reconnect = false): Promise<void> {
    if (!this.connected) {
      this.post({ type: "account", available: false, engineVersion: null });
      return;
    }
    try {
      const session = await this.client.getAccountSession();
      let hive: HiveSnapshot | undefined;
      try {
        hive = reconnect ? await this.client.refreshHive() : await this.client.getHiveSnapshot();
      } catch {
        hive = undefined; // older engines have no hive routes
      }
      this.post({
        type: "account",
        available: true,
        engineVersion: this.client.engineVersion ?? null,
        authenticated: session.authenticated,
        email: session.user?.email ?? null,
        displayName: session.user?.display_name ?? null,
        hive: hive ?? null,
      });
    } catch (err) {
      this.post({ type: "account", available: false, engineVersion: null, error: errorMessage(err) });
    }
  }

  private async login(rawEmail: unknown, rawPassword: unknown): Promise<void> {
    const email = typeof rawEmail === "string" ? rawEmail.trim() : "";
    const password = typeof rawPassword === "string" ? rawPassword : "";
    if (!email || !password) {
      this.post({ type: "accountError", message: "Enter your email and password." });
      return;
    }
    try {
      await this.client.login(email, password, "VS Code");
    } catch (err) {
      this.post({ type: "accountError", message: errorMessage(err) });
      return;
    }
    await this.postAccount(true);
  }

  private async logout(): Promise<void> {
    try {
      await this.client.logout();
    } catch (err) {
      this.post({ type: "accountError", message: errorMessage(err) });
      return;
    }
    await this.postAccount();
  }

  /** Persist the autonomy mode and apply it before the next approval decision (R8.2). */
  private async setAutonomyMode(rawMode: unknown): Promise<void> {
    if (rawMode !== "auto" && rawMode !== "supervised") {
      return;
    }
    const mode: AutonomyMode = rawMode;
    this.approvalManager.setAutonomyMode(mode); // apply first (R8.2)
    await this.configStore.setAutonomyMode(mode); // then persist within 2s (R8.9)
  }

  /** Toggle a default-enabled tool through the registry (R8.1); it persists + re-registers. */
  private async setToolEnabled(rawId: unknown, rawEnabled: unknown): Promise<void> {
    if (typeof rawId !== "string" || typeof rawEnabled !== "boolean") {
      return;
    }
    await this.registry.setEnabled(rawId, rawEnabled);
  }

  /**
   * Enforce the Custom_Instructions length bound (Requirement 8.4). An overflow is
   * rejected: the previous value is retained and a max-length notice posted; a valid
   * value is persisted and confirmed.
   */
  private async setCustomInstructions(rawValue: unknown): Promise<void> {
    const value = typeof rawValue === "string" ? rawValue : "";
    const result = validateCustomInstructions(value);
    if (!result.ok) {
      const previous = this.configStore.load().config.customInstructions;
      this.post({
        type: "customInstructionsRejected",
        reason: result.reason,
        value: previous,
        maxLength: MAX_CUSTOM_INSTRUCTIONS_LENGTH,
      });
      return;
    }
    await this.configStore.setCustomInstructions(result.value);
    this.post({ type: "customInstructionsSaved", value: result.value });
  }

  /** Persist the selected default model id; the provider applies it to sends (R8.7). */
  private async setDefaultModel(rawModelId: unknown): Promise<void> {
    const modelId = typeof rawModelId === "string" ? rawModelId : null;
    await this.configStore.setDefaultModelId(modelId);
  }

  /**
   * Persist an edited Execution_Profile within 2 seconds and supply it to the engine
   * (Requirement 11.8). No-op when no workspace root is open.
   */
  private async saveProfile(rawProfile: unknown): Promise<void> {
    const root = this.currentRoot();
    if (root === undefined) {
      return;
    }
    const existing = this.configStore.loadProfile(root);
    const detectedAt = existing?.detectedAt ?? new Date().toISOString();
    const profile = normalizeProfileFromWebview(rawProfile, root, detectedAt);
    await this.configStore.saveProfile(profile); // persist within 2s (R11.8)
    this.client.sendProfile(profile); // supply updated profile to engine (R11.8)
    this.postProfile();
  }

  // ── extension → webview ─────────────────────────────────────────────────────

  /** Push the initial configuration snapshot to the webview. */
  private postInit(): void {
    const { config, corrupt } = this.configStore.load();
    this.post({
      type: "init",
      autonomyMode: config.autonomyMode,
      customInstructions: config.customInstructions,
      defaultModelId: config.defaultModelId,
      maxInstructionsLength: MAX_CUSTOM_INSTRUCTIONS_LENGTH,
      tools: this.toolViewModel(),
      configError: corrupt,
    });
  }

  /** Push the current per-tool enabled state to the webview. */
  private postToolStates(): void {
    this.post({ type: "toolStates", tools: this.toolViewModel() });
  }

  /** Fetch the model list (5s timeout) and push it with availability (R8.5, R8.6). */
  private async loadModels(): Promise<void> {
    const defaultModelId = this.configStore.load().config.defaultModelId;
    const { models, available } = await fetchModelsWithTimeout(
      this.client,
      MODEL_FETCH_TIMEOUT_MS
    );
    this.post({ type: "models", models, available, defaultModelId });
  }

  /** Push the current workspace Execution_Profile (or an unavailable marker). */
  private postProfile(): void {
    const root = this.currentRoot();
    this.post({ type: "profile", root: root ?? null, profile: this.currentProfile() ?? null });
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  /** The tools list model: id, display name, category, and enabled state. */
  private toolViewModel(): Array<{
    id: string;
    displayName: string;
    category: string;
    enabled: boolean;
  }> {
    return this.registry.all().map((def) => ({
      id: def.id,
      displayName: def.displayName,
      category: def.category,
      enabled: this.registry.isEnabled(def.id),
    }));
  }

  /** The filesystem path of the primary workspace root, if any. */
  private currentRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
  }

  /** The persisted Execution_Profile for the current root, if any. */
  private currentProfile(): ExecutionProfile | undefined {
    const root = this.currentRoot();
    return root === undefined ? undefined : this.configStore.loadProfile(root);
  }

  private post(msg: Record<string, unknown>): void {
    void this.panel?.webview.postMessage(msg);
  }

  // ── HTML ──────────────────────────────────────────────────────────────────
  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "settings.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "media", "main.css")
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Subconscious Settings</title>
</head>
<body class="settings">
  <div id="conn" class="settings-banner" hidden>Disconnected — reconnecting…</div>
  <div id="config-error" class="settings-banner error" hidden>Saved configuration could not be loaded; defaults applied.</div>

  <section class="settings-section">
    <h2 class="settings-title">Account and server</h2>
    <div class="settings-hint">The engine keeps the server session; sign in here to link it to your account.</div>
    <div id="acct-status" class="settings-hint">Checking…</div>
    <div id="acct-error" class="settings-notice" hidden></div>
    <div id="acct-login" hidden>
      <input id="acct-email" class="settings-input" type="email" placeholder="Email" autocomplete="username" />
      <input id="acct-password" class="settings-input" type="password" placeholder="Password" autocomplete="current-password" />
      <div class="settings-row">
        <button id="acct-signin" class="settings-btn" type="button">Sign in</button>
      </div>
    </div>
    <div id="acct-devices" class="tool-list"></div>
    <div class="settings-row">
      <button id="acct-refresh" class="settings-btn secondary" type="button">Refresh and reconnect</button>
      <button id="acct-signout" class="settings-btn secondary" type="button" hidden>Sign out</button>
    </div>
  </section>

  <section class="settings-section">
    <h2 class="settings-title">Autonomy</h2>
    <div class="settings-hint">How the agent handles approvals for mutating actions.</div>
    <div id="autonomy" class="segmented" role="radiogroup" aria-label="Autonomy mode">
      <button class="segment" data-mode="supervised" role="radio" aria-checked="false">Supervised</button>
      <button class="segment" data-mode="auto" role="radio" aria-checked="false">Auto</button>
    </div>
  </section>

  <section class="settings-section">
    <h2 class="settings-title">Default-enabled tools</h2>
    <div class="settings-hint">Tools available to the agent by default.</div>
    <div id="tools" class="tool-list"></div>
  </section>

  <section class="settings-section">
    <h2 class="settings-title">Custom instructions</h2>
    <div class="settings-hint">Guidance supplied to the agent (max <span id="ci-max">10000</span> characters).</div>
    <textarea id="custom-instructions" class="settings-textarea" rows="5" placeholder="Add custom instructions…"></textarea>
    <div class="settings-row">
      <span id="ci-count" class="settings-hint">0 / 10000</span>
      <span id="ci-notice" class="settings-notice" hidden>Maximum length exceeded — change not saved.</span>
    </div>
  </section>

  <section class="settings-section">
    <h2 class="settings-title">Default model</h2>
    <div class="settings-hint">Model used when a message does not select one.</div>
    <select id="model" class="settings-select"></select>
    <div id="model-notice" class="settings-notice" hidden>Models unavailable — engine not reachable.</div>
  </section>

  <section class="settings-section">
    <h2 class="settings-title">Execution profile</h2>
    <div class="settings-hint">How to run, test, debug, and build this workspace.</div>
    <div id="profile" class="profile"></div>
    <div class="settings-row">
      <button id="add-tech" class="settings-btn secondary" type="button">Add technology</button>
      <button id="save-profile" class="settings-btn" type="button">Save profile</button>
    </div>
  </section>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

/** Extract a human-readable message from an unknown thrown value. */
function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/** Generate a 32-character nonce for the webview CSP (mirrors ChatPanel). */
function getNonce(): string {
  let text = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
