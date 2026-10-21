// Wire shapes shared with the engine's local API (see ../subconscious api/schemas.py).

export interface RuntimeInfo {
  host: string;
  port: number;
  token: string;
  pid: number;
  version: string;
  node_id?: string | null;
}

export interface Workspace {
  uuid: string;
  name: string;
  description?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface Thread {
  uuid: string;
  workspace_uuid: string;
  title?: string | null;
  description?: string | null;
  default_model_id?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface Message {
  uuid: string;
  thread_uuid: string;
  role: string;
  content: string;
  created_at?: string | null;
}

/** What a model can do; `null`/absent means unknown (not the same as false). */
export interface ModelCapabilities {
  chat?: boolean | null;
  tool_calling?: boolean | null;
  vision?: boolean | null;
  [flag: string]: unknown;
}

/** One entry of `GET /api/v1/models`. */
export interface ModelConfig {
  id: string;
  /** The model's display name (current engines). */
  name?: string | null;
  description?: string | null;
  capabilities?: ModelCapabilities | null;
  /** Legacy fields sent by older engines. */
  alias?: string | null;
  provider?: string | null;
  model?: string | null;
  system_prompt?: string | null;
  base_url?: string | null;
  is_default?: boolean;
}

/** `GET /api/v1/account/session` (and the login/logout replies). */
export interface AccountSession {
  authenticated: boolean;
  user?: { email?: string; display_name?: string | null; [key: string]: unknown } | null;
  notice?: string;
}

/** One device on the account, as listed by the engine. */
export interface HiveNode {
  id: string;
  name?: string;
  kind?: string;
  platform?: string;
  status?: string;
  online?: boolean;
  local?: boolean;
  trusted?: boolean;
  clients?: string[];
}

/** `GET /api/v1/hive/nodes` and `POST /api/v1/hive/refresh`. */
export interface HiveSnapshot {
  enabled?: boolean;
  /** e.g. "running", "signed_out", "hive_mismatch", "stopped". */
  state: string;
  detail?: string;
  node_id?: string | null;
  nodes: HiveNode[];
  /** Why this engine is offline, when it is. */
  problem?: string;
}

// WebSocket envelope (both directions).
export interface WSFrame<T = any> {
  v?: number;
  type: string;
  id?: string;
  data?: T;
}

// ── Agent tool-callback + profile frames ─────────────────────────────────────
//
// The agent-tools-and-settings feature layers four additional frame types on the
// existing `WSFrame` envelope:
//
//   - `tool.register` (ext→engine): advertises the currently enabled tool set.
//   - `tool.call`     (engine→ext): invokes a tool with a correlation id + input.
//   - `tool.result`   (ext→engine): returns the result echoing the correlation id.
//   - `profile.set`   (ext→engine): supplies the workspace execution profile.
//
// The concrete payload shapes are declared once in `../tools/types` (alongside the
// tool vocabulary they belong to). They are re-exported here — the engine wire
// layer — so callers wiring the transport can import every frame shape from a
// single place without duplicating the declarations. These are type-only
// re-exports, so they add nothing at runtime and introduce no import cycle.
export type {
  ToolRegisterFrame,
  ToolRegisterData,
  RegisteredToolDescriptor,
  ToolCallFrame,
  ToolCallData,
  ToolResultFrame,
  ProfileSetFrame,
  ProfileSetData,
} from "../tools/types";

/** The set of tool-callback / profile frame `type` discriminants (Requirement 2, 3, 11.5). */
export type AgentFrameType =
  | "tool.register"
  | "tool.call"
  | "tool.result"
  | "profile.set";
