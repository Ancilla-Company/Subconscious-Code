// Feature: agent-tools-and-settings — Configure Tools controller (view-independent).
//
// `ToolsController` holds the tools-management logic that was previously embedded in
// the sidebar `ToolsView`: it builds the grouped tool model, forwards enable/policy
// edits to the `ToolRegistry` (persisting within 2 seconds), and reverts a control to
// its prior value when persistence fails (Requirement 7.2–7.4, 7.7). It is deliberately
// decoupled from any concrete webview host — outbound messages are delivered through an
// injected `post` callback — so it can back either a webview view or the editor-area
// Configure Tools panel, and be unit tested outside the VS Code host.
//
// Built-in tools are grouped under a single "Built-In" group (sub-grouped by category);
// each MCP server contributes its own group so the page mirrors the Copilot "Configure
// Tools" layout (Requirement 7.2, plus MCP integration).

import type { EngineClient } from "../engine/client";
import type { ToolRegistry } from "../tools/registry";
import type {
  ApprovalPolicy,
  ToolCategory,
  ToolClassification,
} from "../tools/types";

/** Human-facing labels for each tool category, shown as group sub-headers. */
export const CATEGORY_LABELS: Readonly<Record<ToolCategory, string>> = {
  file: "File",
  search: "Search",
  terminal: "Terminal",
  diagnostics: "Diagnostics",
  test: "Test",
  web: "Web",
  ide: "IDE",
  mcp: "MCP",
};

/** The serialisable model of a single tool sent to the webview. */
export interface ToolViewModel {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly category: ToolCategory;
  readonly categoryLabel: string;
  readonly classification: ToolClassification;
  readonly enabled: boolean;
  readonly approvalPolicy: ApprovalPolicy;
}

/** A top-level group in the Configure Tools page (Built-In, or one per MCP server). */
export interface ToolGroupModel {
  readonly id: string;
  readonly label: string;
  /** `true` for the built-in group, whose tools carry meaningful category sub-headers. */
  readonly builtin: boolean;
  readonly tools: ToolViewModel[];
}

/** Messages the webview may post back to the controller. */
export type InboundMessage =
  | { readonly type: "ready" }
  | { readonly type: "setEnabled"; readonly id: string; readonly enabled: boolean }
  | { readonly type: "setPolicy"; readonly id: string; readonly policy: ApprovalPolicy };

/** The sink the controller posts outbound messages through (a webview, or a test spy). */
export type PostMessage = (msg: unknown) => void;

/**
 * View-independent controller for the Configure Tools surface. The registry is the
 * single source of truth: edits flow to `registry.setEnabled` / `setApprovalPolicy`
 * and the view re-renders whenever `registry.onDidChange` fires so the displayed state
 * always reflects what was actually persisted.
 */
export class ToolsController {
  private disposed = false;
  private readonly subscriptions: Array<{ dispose(): void }> = [];

  public constructor(
    private readonly registry: ToolRegistry,
    private readonly client: EngineClient,
    private post: PostMessage,
  ) {
    const onStatus = (status: string): void =>
      this.post({ type: "status", connected: status === "connected" });
    this.client.on("status", onStatus);
    this.subscriptions.push({ dispose: () => this.client.off("status", onStatus) });
    this.subscriptions.push(this.registry.onDidChange(() => this.postTools()));
  }

  /** Redirect outbound messages to a new sink (used when a panel is re-created). */
  public setPost(post: PostMessage): void {
    this.post = post;
  }

  /** Handle an inbound webview message. */
  public async handleMessage(msg: InboundMessage): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.postTools();
        break;
      case "setEnabled":
        await this.applyEdit(msg.id, () => this.registry.setEnabled(msg.id, msg.enabled));
        break;
      case "setPolicy":
        await this.applyEdit(msg.id, () =>
          this.registry.setApprovalPolicy(msg.id, msg.policy),
        );
        break;
    }
  }

  /** Push the current grouped tool model plus connection state to the webview. */
  public postTools(): void {
    this.post({
      type: "tools",
      groups: this.buildGroups(),
      connected: this.client.isOpen(),
    });
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const sub of this.subscriptions.splice(0)) {
      sub.dispose();
    }
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  /**
   * Apply a registry edit. On success `registry.onDidChange` re-renders; on failure the
   * registry retains the prior value, so the affected control is reverted to it and an
   * inline error is surfaced (Requirement 7.7).
   */
  private async applyEdit(id: string, edit: () => Promise<void>): Promise<void> {
    try {
      await edit();
    } catch (err: unknown) {
      const state = this.registry.stateOf(id);
      this.post({
        type: "revert",
        id,
        enabled: state.enabled,
        approvalPolicy: state.approvalPolicy,
        message: `Couldn't save change: ${describeError(err)}`,
      });
    }
  }

  /** Build the grouped model: a Built-In group followed by one group per MCP server. */
  private buildGroups(): ToolGroupModel[] {
    const builtin: ToolViewModel[] = [];
    const byServer = new Map<string, { label: string; tools: ToolViewModel[] }>();

    for (const def of this.registry.all()) {
      const state = this.registry.stateOf(def.id);
      const model: ToolViewModel = {
        id: def.id,
        displayName: def.displayName,
        description: def.description,
        category: def.category,
        categoryLabel: CATEGORY_LABELS[def.category],
        classification: def.classification,
        enabled: state.enabled,
        approvalPolicy: state.approvalPolicy,
      };
      if (def.source === "mcp" && def.serverId !== undefined) {
        const entry = byServer.get(def.serverId) ?? {
          label: def.serverLabel ?? def.serverId,
          tools: [],
        };
        entry.tools.push(model);
        byServer.set(def.serverId, entry);
      } else {
        builtin.push(model);
      }
    }

    const groups: ToolGroupModel[] = [
      { id: "builtin", label: "Built-In", builtin: true, tools: builtin },
    ];
    for (const [serverId, entry] of byServer) {
      groups.push({
        id: `mcp:${serverId}`,
        label: entry.label,
        builtin: false,
        tools: entry.tools,
      });
    }
    return groups;
  }
}

/** Extract a human-readable message from an unknown thrown value. */
function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
