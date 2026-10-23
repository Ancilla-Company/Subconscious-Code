import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import WebSocket from "ws";
import {
  RuntimeInfo, Workspace, Thread, Message, ModelConfig, WSFrame,
  AccountSession, HiveSnapshot,
} from "./types";
import type {
  ToolCallFrame,
  ProfileSetFrame,
  ClientHelloFrame,
  ClientHelloAckFrame,
  ClientHelloRejectFrame,
} from "../tools/types";
import type { ExecutionProfile } from "../env/types";
import { discoverEngine } from "./discovery";

/** Wire-envelope version stamped on outgoing frames the client originates. */
const FRAME_VERSION = 1;

/**
 * The minimal surface of the `ToolHost` that {@link EngineClient} routes tool RPC to.
 * Kept structural so the engine layer does not depend on the concrete `ToolHost`
 * (and does not pull `vscode` into its unit tests); the wiring layer supplies the
 * real host, which already exposes `handleCall` and `sendRegistration`.
 */
export interface ToolCallRouter {
  /** Handle an inbound `tool.call` frame (never throws; replies with a `tool.result`). */
  handleCall(frame: ToolCallFrame): void | Promise<void>;
  /** Build and send the current `tool.register` frame (skips when the socket is closed). */
  sendRegistration(): void;
}

/**
 * A subscribe-only change event. Structurally compatible with `vscode.Event<void>`
 * (as exposed by `ToolRegistry.onDidChange`), so the registry's event can be passed
 * directly without the engine layer importing `vscode`.
 */
export type ChangeSubscribe = (listener: () => void) => { dispose(): void };

/**
 * Supplies the currently selected default model id. Applied to `chat.send` frames
 * that do not override the model (Requirement 8.7).
 */
export type DefaultModelProvider = () => string | null | undefined;

/**
 * Supplies the current workspace execution profile to advertise to the engine on
 * connect (Requirement 11.5) and on edit (Requirement 11.8).
 */
export type ExecutionProfileProvider = () => ExecutionProfile | undefined;

/**
 * Persists the handshake-assigned Client_ID so it can be re-presented on a later
 * `client.hello` (e.g. after a reconnect or extension restart). The existing
 * `ConfigStore` (backed by `context.globalState`) satisfies this structurally.
 *
 * _Requirements: 1.5, 9.3_
 */
export interface ClientIdStore {
  /** The Client_ID persisted from a prior handshake, or `undefined` if none. */
  loadClientId(): string | undefined;
  /** Persist the Client_ID assigned/validated by the engine's `client.hello.ack`. */
  saveClientId(clientId: string): Promise<void>;
}

/** The outcome of a single `client.hello` round trip. */
type HelloOutcome =
  | { readonly kind: "ack"; readonly clientId: string }
  | { readonly kind: "reject"; readonly reason: string };

/**
 * Client for the local Subconscious engine API.
 *
 * REST calls cover discrete reads/commands; a single WebSocket carries live
 * engine events (message.created, thread.created, ...) and streaming chat.
 * Emits:
 *   - "event"   (frame)  every inbound frame
 *   - "status"  ("connected" | "disconnected")
 *
 * The client also carries the agent tool-callback contract: it satisfies the
 * `ToolFrameTransport` surface ({@link send} / {@link isOpen}) that `ToolHost`
 * writes through, routes inbound `tool.call` frames to an attached
 * {@link ToolCallRouter}, (re-)sends tool registration on every connection and on
 * registry change, and supplies the execution profile via a `profile.set` frame.
 */
export class EngineClient extends EventEmitter {
  private info?: RuntimeInfo;
  /** Who this client tells the engine it is (`client_type=vscode`). */
  private identity: { type: string; name: string; version?: string } = {
    type: "vscode",
    name: "VS Code",
  };
  private ws?: WebSocket;
  private closing = false;
  /** Pending auto-reconnect; cancelled by {@link dispose} and by an explicit {@link connect}. */
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  /** Sockets closed on purpose by {@link dispose}; their close event never triggers a reconnect. */
  private readonly retired = new WeakSet<WebSocket>();

  /** Attached tool-callback router; inbound `tool.call` frames are dispatched here. */
  private toolHost?: ToolCallRouter;
  /** Subscription to the tool registry's change event (re-register on change). */
  private registryChangeSub?: { dispose(): void };
  /** Provides the default model id applied to un-overridden `chat.send` frames. */
  private defaultModelProvider?: DefaultModelProvider;
  /** Provides the execution profile advertised to the engine on connect. */
  private profileProvider?: ExecutionProfileProvider;
  /** Persists/retrieves the handshake Client_ID across reconnects (R1.5, R9.3). */
  private clientIdStore?: ClientIdStore;
  /**
   * Set after a `client.hello.reject`; the next `client.hello` this connection sends
   * omits any requested id, so the retry (on the following reconnect) is treated as a
   * fresh handshake rather than repeating the conflicting id (R1.5).
   */
  private forceFreshHelloOnNextAttempt = false;

  /** Set the extension version reported to the engine as `client_version`. */
  setClientVersion(version: string): void {
    this.identity = { ...this.identity, version };
  }

  /** Version of the connected engine (from its `runtime.json`), if known. */
  get engineVersion(): string | undefined {
    return this.info?.version;
  }

  get baseUrl(): string {
    if (!this.info) {
      throw new Error("Engine client is not connected.");
    }
    return `http://${this.info.host}:${this.info.port}/api/v1`;
  }

  /** Discover (and optionally start) the engine, then open the WebSocket. */
  async connect(): Promise<void> {
    this.closing = false;
    this.clearReconnectTimer();
    this.info = await discoverEngine();
    try {
      await this.openSocket();
    } catch (err) {
      // Two windows share the persisted Client_ID (globalState), so the second window's
      // hello is rejected as "already in use". A reject already arms a fresh handshake
      // (no requested id), so retry once right away instead of surfacing an error and
      // waiting for the 2 s auto-reconnect (live test (b)).
      if (!this.forceFreshHelloOnNextAttempt || this.closing) {
        throw err;
      }
      await this.openSocket();
    }
  }

  private openSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const info = this.info!;
      // The engine lists connected clients by type (tray menu, device list), so say
      // who this is. The auth token is the only secret in the query.
      const query = new URLSearchParams({
        token: info.token,
        client_type: this.identity.type,
        client_name: this.identity.name,
      });
      if (this.identity.version) {
        query.set("client_version", this.identity.version);
      }
      const url = `ws://${info.host}:${info.port}/api/v1/events?${query.toString()}`;
      const ws = new WebSocket(url);
      this.ws = ws;

      // Gates whether an inbound frame is treated as part of the `client.hello`
      // handshake or as an ordinary post-handshake frame (R1.5, R9.3). Scoped to
      // this socket instance so a fresh reconnect always starts a fresh handshake.
      let handshakeComplete = false;

      ws.on("open", () => {
        this.sendHello();
      });
      ws.on("message", (raw) => {
        let frame: WSFrame;
        try {
          frame = JSON.parse(raw.toString()) as WSFrame;
        } catch {
          return; /* ignore malformed frame */
        }

        if (!handshakeComplete) {
          const outcome = this.readHelloOutcome(frame);
          if (outcome === undefined) {
            // Any frame other than `client.hello.ack`/`client.hello.reject` arriving
            // before the handshake completes is dropped (mirrors the engine-side
            // gating of `tool.register`/`chat.send` until its own handshake finishes).
            return;
          }
          handshakeComplete = true;
          if (outcome.kind === "reject") {
            // Treat a reject as a fresh handshake going forward: the next attempt
            // presents no requested Client_ID (R1.5). The engine closes the socket
            // after a reject; the existing `close` handler schedules the retry.
            this.forceFreshHelloOnNextAttempt = true;
            reject(new Error(`Engine rejected client.hello: ${outcome.reason}`));
            return;
          }
          void this.clientIdStore
            ?.saveClientId(outcome.clientId)
            .catch(() => undefined);
          this.emit("status", "connected");
          this.onConnected();
          resolve();
          return;
        }

        // Route engine→ext tool-callback RPC to the attached ToolHost (R3.1). The
        // frame is still emitted as an "event" for observers; no UI listener acts on
        // `tool.call`, so this is side-effect free for the chat view.
        if (frame.type === "tool.call" && this.toolHost !== undefined) {
          void Promise.resolve(
            this.toolHost.handleCall(frame as ToolCallFrame),
          ).catch(() => undefined);
        }
        this.emit("event", frame);
      });
      ws.on("error", (err) => reject(err));
      ws.on("close", () => {
        // A socket that was replaced by a newer one (dispose() then connect()) must not
        // report a disconnect or schedule a reconnect: that would open a second, parallel
        // connection (live test (c)).
        if (this.ws !== undefined && this.ws !== ws) {
          return;
        }
        this.emit("status", "disconnected");
        // `retired` covers the window between dispose() and the next connect() finishing
        // discovery (this.ws is unset, closing already false again).
        if (!this.closing && !this.retired.has(ws)) {
          // Best-effort reconnect after a short delay.
          this.clearReconnectTimer();
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = undefined;
            void this.connect().catch(() => undefined);
          }, 2000);
        }
      });
    });
  }

  /** Parse a `client.hello.ack`/`client.hello.reject` frame; `undefined` for any other type. */
  private readHelloOutcome(frame: WSFrame): HelloOutcome | undefined {
    if (frame.type === "client.hello.ack") {
      const ack = frame as ClientHelloAckFrame;
      return { kind: "ack", clientId: ack.data.clientId };
    }
    if (frame.type === "client.hello.reject") {
      const rejectFrame = frame as ClientHelloRejectFrame;
      return { kind: "reject", reason: rejectFrame.data.reason };
    }
    return undefined;
  }

  /**
   * Begin the handshake on a freshly-opened socket: send `client.hello`, re-presenting
   * the persisted Client_ID (if any) unless the previous attempt was rejected, in
   * which case this attempt omits it (R1.5, R9.3).
   */
  private sendHello(): void {
    const requestedId = this.forceFreshHelloOnNextAttempt
      ? undefined
      : this.clientIdStore?.loadClientId();
    this.forceFreshHelloOnNextAttempt = false;
    const frame: ClientHelloFrame = {
      v: FRAME_VERSION,
      type: "client.hello",
      data: requestedId !== undefined ? { clientId: requestedId } : {},
    };
    this.send(frame);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  dispose(): void {
    this.closing = true;
    this.clearReconnectTimer();
    if (this.ws !== undefined) {
      this.retired.add(this.ws);
    }
    this.registryChangeSub?.dispose();
    this.registryChangeSub = undefined;
    this.ws?.close();
    this.ws = undefined;
  }

  // ── Agent tool-callback wiring ───────────────────────────────────────────────

  /**
   * Attach the tool-callback router and subscribe to the registry's change event.
   *
   * Inbound `tool.call` frames are routed to `host.handleCall`. Registration is
   * (re-)sent on every `connected` transition (Requirement 2.1, 2.4) and whenever the
   * enabled set changes (Requirement 2.2). When the socket is closed, `sendRegistration`
   * is a no-op and the registry retains the enabled set, so the next `connected`
   * transition re-sends the current set (Requirement 2.6).
   *
   * @param host            The tool-callback router (the concrete `ToolHost`).
   * @param onRegistryChange The registry's `onDidChange` subscribe function.
   */
  attachToolHost(host: ToolCallRouter, onRegistryChange: ChangeSubscribe): void {
    this.toolHost = host;
    this.registryChangeSub?.dispose();
    this.registryChangeSub = onRegistryChange(() => host.sendRegistration());
  }

  /** Set the provider of the default model id for un-overridden `chat.send` frames (R8.7). */
  setDefaultModelProvider(provider: DefaultModelProvider): void {
    this.defaultModelProvider = provider;
  }

  /** Set the provider of the execution profile advertised on connect (R11.5). */
  setExecutionProfileProvider(provider: ExecutionProfileProvider): void {
    this.profileProvider = provider;
  }

  /**
   * Attach the store used to persist the handshake-assigned Client_ID and to
   * re-present it on a later `client.hello` (Requirement 1.5, 9.3). The existing
   * `ConfigStore` (backed by `context.globalState`) satisfies this interface.
   */
  setClientIdStore(store: ClientIdStore): void {
    this.clientIdStore = store;
  }

  /** Whether the WebSocket is currently open (part of the `ToolFrameTransport` surface). */
  isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Send a frame over the WebSocket when it is open; a send attempted while the
   * socket is closed is silently dropped (the caller retries on reconnect). This is
   * the single outbound write path and the `ToolFrameTransport.send` implementation.
   */
  send(frame: WSFrame): void {
    if (this.isOpen()) {
      this.ws!.send(JSON.stringify(frame));
    }
  }

  /**
   * Supply the current execution profile to the engine (Requirement 11.5, 11.8).
   * Sent on connect and whenever the profile is edited.
   */
  sendProfile(profile: ExecutionProfile): void {
    const frame: ProfileSetFrame = {
      v: FRAME_VERSION,
      type: "profile.set",
      data: { profile },
    };
    this.send(frame);
  }

  /**
   * Run on every successful `connected` transition: re-register the enabled tool set
   * (R2.1, R2.4, R2.6) and advertise the current execution profile (R11.5).
   */
  private onConnected(): void {
    this.toolHost?.sendRegistration();
    const profile = this.profileProvider?.();
    if (profile !== undefined) {
      this.sendProfile(profile);
    }
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
      // Account and hive routes explain themselves in `{"error": "..."}`; prefer that.
      let detail = "";
      try {
        const body = (await res.json()) as { error?: unknown };
        if (typeof body.error === "string") {
          detail = body.error;
        }
      } catch {
        /* no JSON body */
      }
      throw new Error(
        detail || `Engine API ${path} failed: ${res.status} ${res.statusText}`,
      );
    }
    return (await res.json()) as T;
  }

  // ── Account and hive (the engine owns the server session) ───────────────────

  /** The engine's cloud account session (`GET /account/session`). */
  getAccountSession(): Promise<AccountSession> {
    return this.request<AccountSession>("/account/session");
  }

  /** Sign the engine in to the account; the engine keeps the session. */
  login(email: string, password: string, deviceName: string): Promise<AccountSession> {
    return this.request<AccountSession>("/account/login", {
      method: "POST",
      body: JSON.stringify({ email, password, device_name: deviceName }),
    });
  }

  logout(): Promise<AccountSession> {
    return this.request<AccountSession>("/account/logout", { method: "POST", body: "{}" });
  }

  /** This engine's hive state and the account's devices (`GET /hive/nodes`). */
  getHiveSnapshot(): Promise<HiveSnapshot> {
    return this.request<HiveSnapshot>("/hive/nodes");
  }

  /** Reconnect the engine to the server now and report why if it is still offline. */
  refreshHive(): Promise<HiveSnapshot> {
    return this.request<HiveSnapshot>("/hive/refresh", { method: "POST", body: "{}" });
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
  /**
   * Send a user message; assistant deltas arrive as "event" frames (chat.delta).
   *
   * When the caller does not supply a `modelId`, the selected default model id (from
   * the attached {@link DefaultModelProvider}) is applied to the outgoing frame; an
   * explicit `modelId` always overrides the default (Requirement 8.7).
   */
  sendChat(
    threadUuid: string,
    content: string,
    modelId?: string,
    contextBlocks?: readonly string[],
  ): string {
    const id = randomUUID();
    const data: Record<string, unknown> = { thread_uuid: threadUuid, content };
    // Resolved "#" mention context travels in its own field, NOT inlined into
    // `content`: the engine prompts the model with context + content but persists
    // only `content`, so the chat transcript shows what the user typed instead of
    // the full inlined contents of every attached file.
    if (contextBlocks !== undefined && contextBlocks.length > 0) {
      data.context_blocks = [...contextBlocks];
    }
    const effectiveModelId = modelId ?? this.defaultModelProvider?.() ?? undefined;
    if (effectiveModelId) {
      data.model_id = effectiveModelId;
    }
    const frame: WSFrame = { v: FRAME_VERSION, type: "chat.send", id, data };
    this.send(frame);
    return id;
  }

  /**
   * Stop an in-flight turn (the composer's stop button). The engine cancels the
   * agent run, persists whatever the model had already said, and replies with a
   * terminal `chat.done` carrying `cancelled: true` so the UI returns to idle.
   *
   * @param turnId The `chat.send` correlation id to stop; when omitted the engine
   *               stops every turn currently running on this connection.
   */
  cancelChat(turnId?: string): void {
    const frame: WSFrame = {
      v: FRAME_VERSION,
      type: "chat.cancel",
      id: turnId,
      data: turnId !== undefined ? { turn_id: turnId } : {},
    };
    this.send(frame);
  }
}
