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
