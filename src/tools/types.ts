// Shared tool types for the agent-tools-and-settings feature.
//
// This module defines the Tool_Registry vocabulary (categories, classifications,
// approval policies), the Tool_Result payload shapes (including the full ToolError
// `kind` taxonomy), the Coding_Tool execution contract, and the new WebSocket frame
// shapes (`tool.register`, `tool.call`, `tool.result`, `profile.set`) layered on the
// existing `WSFrame` envelope carried by `EngineClient`.
//
// _Requirements: 1.2, 3.2, 3.9_

import type { WSFrame } from "../engine/types";
import type { ExecutionProfile } from "../env/types";

// -----------------------------------------------------------------------------
// Tool catalogue vocabulary
// -----------------------------------------------------------------------------

/** The functional category a Coding_Tool belongs to. */
export type ToolCategory =
  | "file"
  | "search"
  | "terminal"
  | "diagnostics"
  | "test"
  | "web"
  | "ide"
  | "mcp";

/** Where a Coding_Tool originates: a built-in tool or one provided by an MCP server. */
export type ToolSource = "builtin" | "mcp";

/** Whether a Coding_Tool only reads state or may mutate the workspace/system. */
export type ToolClassification = "read-only" | "mutating";

/** Per-tool confirmation behaviour (Requirement 5, 7.4). */
export type ApprovalPolicy = "inherit" | "always-ask" | "auto-approve";

/** The agent-wide approval posture (Requirement 5.1). */
export type AutonomyMode = "auto" | "supervised";

/**
 * Minimal JSON Schema shape used to describe a tool's input contract. Tool inputs
 * received from the engine are untrusted and validated against this schema before
 * execution (Requirement 6.7, 6.8).
 */
export interface JSONSchema {
  readonly type?:
    | "object"
    | "array"
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "null";
  readonly properties?: Readonly<Record<string, JSONSchema>>;
  readonly required?: readonly string[];
  readonly items?: JSONSchema;
  readonly enum?: readonly unknown[];
  readonly description?: string;
  readonly default?: unknown;
  readonly additionalProperties?: boolean | JSONSchema;
  readonly [keyword: string]: unknown;
}

/**
 * A static definition of a Coding_Tool held in the Tool_Registry (Requirement 1.2).
 */
export interface ToolDefinition {
  /** Unique, stable identifier. */
  readonly id: string;
  /** Human-facing name shown in the Tools_View. */
  readonly displayName: string;
  /** Human-readable description of what the tool does. */
  readonly description: string;
  /** Schema describing the tool's expected input. */
  readonly inputSchema: JSONSchema;
  /** Functional category. */
  readonly category: ToolCategory;
  /** Read-only vs mutating classification. */
  readonly classification: ToolClassification;
  /** Whether the tool is enabled by default when no configuration is persisted. */
  readonly defaultEnabled: boolean;
  /** Where the tool comes from; absent is treated as `"builtin"`. */
  readonly source?: ToolSource;
  /** For MCP tools: the stable id of the providing server (grouping key). */
  readonly serverId?: string;
  /** For MCP tools: the human-facing label of the providing server. */
  readonly serverLabel?: string;
}

/** The live, user-configurable state of a Coding_Tool (Requirement 7.3, 7.4). */
export interface ToolState {
  enabled: boolean;
  approvalPolicy: ApprovalPolicy;
}

// -----------------------------------------------------------------------------
// Tool results
// -----------------------------------------------------------------------------

/**
 * The successful output of a Coding_Tool invocation. `content` carries the primary
 * textual result; `truncated` is set by `read_file` when output was clipped to the
 * configured maximum read size (Requirement 4.5); `data` carries any structured
 * supplementary payload (e.g. diagnostics).
 */
export interface ToolOutput {
  readonly content: string;
  readonly truncated?: boolean;
  readonly data?: Readonly<Record<string, unknown>>;
}

/**
 * The full taxonomy of typed tool failures returned to the engine. Every failure
 * keeps the WebSocket connection open (Requirement 3.3–3.7).
 *
 * - `validation`        input failed schema validation (Requirement 1.5, 6.8)
 * - `unknown-tool`      identifier absent from the registry (Requirement 1.6, 3.4)
 * - `tool-disabled`     tool present but disabled (Requirement 3.5)
 * - `malformed-request` frame missing tool id and/or correlation id (Requirement 3.3)
 * - `out-of-scope`      resolved path escapes every workspace root (Requirement 4.2, 4.3)
 * - `no-workspace`      no workspace root open (Requirement 4.4)
 * - `rejected`          user declined confirmation (Requirement 5.7, 6.3, 6.4, 10.4)
 * - `timeout`           tool exceeded the configured timeout (Requirement 3.7)
 * - `execution`         tool raised during execution (Requirement 3.6)
 * - `activation-failure` environment activation could not be applied (Requirement 11.13)
 * - `no-provider`       no registered provider currently offers the requested tool id (Requirement 9.3)
 */
export interface ToolError {
  readonly kind:
    | "validation"
    | "unknown-tool"
    | "tool-disabled"
    | "malformed-request"
    | "out-of-scope"
    | "no-workspace"
    | "rejected"
    | "timeout"
    | "execution"
    | "activation-failure"
    | "no-provider";
  readonly message: string;
  /** For validation errors: the offending input field name. */
  readonly field?: string;
  /** For terminal rejection: the rejected Command_Segment. */
  readonly segment?: string;
}

/** The result of a tool invocation: either a success output or a typed error. */
export type ToolResult =
  | { readonly ok: true; readonly output: ToolOutput }
  | { readonly ok: false; readonly error: ToolError };

// -----------------------------------------------------------------------------
// Workspace path safety (shared guard contract)
// -----------------------------------------------------------------------------

/** The outcome of resolving a supplied path against the workspace roots. */
export type PathResolution =
  | { readonly ok: true; readonly canonicalPath: string; readonly root: string }
  | { readonly ok: false; readonly error: "out-of-scope" | "no-workspace" };

/**
 * Single choke point for file-path safety (Requirement 4). Implemented later; the
 * interface is shared here because `ToolContext` depends on it.
 */
export interface WorkspacePathGuard {
  /** Current workspace folder filesystem paths. */
  roots(): string[];
  /** Normalize `.`/`..` and symlinks, then check the path is within a root. */
  resolve(inputPath: string): PathResolution;
}

// -----------------------------------------------------------------------------
// Coding tool execution contract
// -----------------------------------------------------------------------------

/** Ambient context supplied to each Coding_Tool at execution time. */
export interface ToolContext {
  /** Shared path-safety guard for file operations. */
  readonly guard: WorkspacePathGuard;
  /** The active workspace execution profile, if one exists. */
  readonly profile: ExecutionProfile | undefined;
  /** Aborted when the tool's timeout elapses (Requirement 3.7). */
  readonly signal: AbortSignal;
}

/** A Coding_Tool executed inside the VS Code workspace context. */
export interface CodingTool {
  /** Identifier matching the corresponding ToolDefinition. */
  readonly id: string;
  /** Execute the tool with untrusted input and the ambient context. */
  execute(input: unknown, ctx: ToolContext): Promise<ToolOutput>;
}

// -----------------------------------------------------------------------------
// WebSocket frames (layered on the existing WSFrame envelope)
// -----------------------------------------------------------------------------

/** Descriptor for a single tool advertised in a registration frame. */
export interface RegisteredToolDescriptor {
  readonly id: string;
  readonly description: string;
  readonly inputSchema: JSONSchema;
}

/** Payload of a `tool.register` frame (ext→engine). */
export interface ToolRegisterData {
  /** The complete set of enabled tools; empty when none is enabled (Requirement 2.5). */
  readonly tools: RegisteredToolDescriptor[];
}

/**
 * `tool.register` frame sent from the extension to the engine to advertise the
 * currently enabled tool set (Requirement 2.1, 2.2, 2.3, 2.5).
 */
export interface ToolRegisterFrame extends WSFrame<ToolRegisterData> {
  v: number;
  type: "tool.register";
  data: ToolRegisterData;
}

/** Payload of a `tool.call` frame (engine→ext). */
export interface ToolCallData {
  readonly tool: string;
  readonly input: unknown;
}

/**
 * `tool.call` frame received from the engine. `id` is the correlation identifier
 * echoed back on the corresponding `tool.result` (Requirement 3.2, 3.8, 3.9).
 */
export interface ToolCallFrame extends WSFrame<ToolCallData> {
  type: "tool.call";
  id: string;
  data: ToolCallData;
}

/**
 * `tool.result` frame returned to the engine, carrying the originating correlation
 * identifier and the tool result (Requirement 3.2, 3.9).
 */
export interface ToolResultFrame extends WSFrame<ToolResult> {
  v: number;
  type: "tool.result";
  id: string;
  data: ToolResult;
}

/** Payload of a `profile.set` frame (ext→engine). */
export interface ProfileSetData {
  readonly profile: ExecutionProfile;
}

/**
 * `profile.set` frame supplying the current execution profile to the engine on
 * connect and on edit (Requirement 11.5, 11.8).
 */
export interface ProfileSetFrame extends WSFrame<ProfileSetData> {
  v: number;
  type: "profile.set";
  data: ProfileSetData;
}

// -----------------------------------------------------------------------------
// Handshake frames (additive; no existing frame types are changed)
// -----------------------------------------------------------------------------

/** Payload of a `client.hello` frame (ext→engine). */
export interface ClientHelloData {
  /** Previously-assigned Client_ID to re-present on reconnect, if any. */
  readonly clientId?: string;
}

/**
 * `client.hello` frame sent from the extension to the engine to begin the
 * handshake, optionally re-presenting a Client_ID persisted from a prior
 * connection (Requirement 9.3).
 */
export interface ClientHelloFrame extends WSFrame<ClientHelloData> {
  v: number;
  type: "client.hello";
  data: ClientHelloData;
}

/** Payload of a `client.hello.ack` frame (engine→ext). */
export interface ClientHelloAckData {
  /** The assigned or validated Client_ID for this connection. */
  readonly clientId: string;
}

/**
 * `client.hello.ack` frame confirming the handshake completed and granting the
 * connection its Client_ID (Requirement 9.3).
 */
export interface ClientHelloAckFrame extends WSFrame<ClientHelloAckData> {
  v: number;
  type: "client.hello.ack";
  data: ClientHelloAckData;
}

/** Payload of a `client.hello.reject` frame (engine→ext). */
export interface ClientHelloRejectData {
  /** Reason the handshake was rejected; the engine then closes the socket. */
  readonly reason: "client_id_in_use";
}

/**
 * `client.hello.reject` frame sent when the requested Client_ID is already
 * held by another active connection (Requirement 9.3).
 */
export interface ClientHelloRejectFrame extends WSFrame<ClientHelloRejectData> {
  v: number;
  type: "client.hello.reject";
  data: ClientHelloRejectData;
}
