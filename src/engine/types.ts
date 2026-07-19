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

export interface ModelConfig {
  id: string;
  alias?: string | null;
  provider?: string | null;
  model?: string | null;
  system_prompt?: string | null;
  base_url?: string | null;
  is_default: boolean;
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
