import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import WebSocket from "ws";
import {
  RuntimeInfo, Workspace, Thread, Message, ModelConfig, WSFrame,
} from "./types";
import { discoverEngine } from "./discovery";

/**
 * Client for the local Subconscious engine API.
 *
 * REST calls cover discrete reads/commands; a single WebSocket carries live
 * engine events (message.created, thread.created, ...) and streaming chat.
 * Emits:
 *   - "event"   (frame)  every inbound frame
 *   - "status"  ("connected" | "disconnected")
 */
export class EngineClient extends EventEmitter {
  private info?: RuntimeInfo;
  private ws?: WebSocket;
  private closing = false;

  get baseUrl(): string {
    if (!this.info) {
      throw new Error("Engine client is not connected.");
    }
    return `http://${this.info.host}:${this.info.port}/api/v1`;
  }

  /** Discover (and optionally start) the engine, then open the WebSocket. */
  async connect(): Promise<void> {
    this.closing = false;
    this.info = await discoverEngine();
    await this.openSocket();
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const info = this.info!;
      const url = `ws://${info.host}:${info.port}/api/v1/events?token=${encodeURIComponent(info.token)}`;
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.on("open", () => {
        this.emit("status", "connected");
        resolve();
      });
      ws.on("message", (raw) => {
        try {
          const frame = JSON.parse(raw.toString()) as WSFrame;
          this.emit("event", frame);
        } catch {
          /* ignore malformed frame */
        }
      });
      ws.on("error", (err) => reject(err));
      ws.on("close", () => {
        this.emit("status", "disconnected");
        if (!this.closing) {
          // Best-effort reconnect after a short delay.
          setTimeout(() => this.connect().catch(() => undefined), 2000);
        }
      });
    });
  }

  dispose(): void {
    this.closing = true;
    this.ws?.close();
    this.ws = undefined;
  }

  // ── REST ───────────────────────────────────────────────────────────────────
  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.info!.token}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
    });
    if (!res.ok) {
      throw new Error(`Engine API ${path} failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as T;
  }

  listWorkspaces(): Promise<Workspace[]> {
    return this.request<Workspace[]>("/workspaces");
  }

  listThreads(workspaceUuid: string): Promise<Thread[]> {
    return this.request<Thread[]>(`/workspaces/${workspaceUuid}/threads`);
  }

  listMessages(threadUuid: string): Promise<Message[]> {
    return this.request<Message[]>(`/threads/${threadUuid}/messages`);
  }

  listModels(): Promise<ModelConfig[]> {
    return this.request<ModelConfig[]>("/models");
  }

  createThread(workspaceUuid: string, title?: string): Promise<Thread> {
    return this.request<Thread>("/threads", {
      method: "POST",
      body: JSON.stringify({ workspace_uuid: workspaceUuid, title }),
    });
  }

  // ── Chat (WebSocket) ─────────────────────────────────────────────────────────
  /** Send a user message; assistant deltas arrive as "event" frames (chat.delta). */
  sendChat(threadUuid: string, content: string, modelId?: string): string {
    const id = randomUUID();
    const data: Record<string, unknown> = { thread_uuid: threadUuid, content };
    if (modelId) {
      data.model_id = modelId;
    }
    const frame: WSFrame = { v: 1, type: "chat.send", id, data };
    this.ws?.send(JSON.stringify(frame));
    return id;
  }
}
