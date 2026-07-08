# Subconscious Code — Project Spec

> A VS Code–compatible coding agent extension that acts as a client of the local
> Subconscious **engine** (`../subconscious`), sharing one local data source with the
> Flet desktop UI. Cross-machine sync is handled later by the engine itself over a direct
> peer-to-peer link, with the server used only to introduce peers — never to relay chat.
> **Status:** draft v2 · scope = first milestone (chat UI + workspace/thread selection,
> single shared local data source)

---

## 1. Goal

Build a VS Code extension, **Subconscious Code**, that provides a coding-focused chat
interface and reads/writes its conversation data through the locally running Subconscious
engine. Because the engine is the single source of truth on the machine, the extension and
the Flet UI see the same workspaces, threads, and messages with no duplication and no
local sync.

This milestone excludes: agent tool-calling, model configuration UI, and any cross-machine
sync (WebRTC). It proves the engine-as-local-service architecture, the client transport,
and the UI shell.

### Success criteria
- With the engine running, the extension lists the same **workspaces** and **threads** as
  the Flet UI.
- Select a workspace + thread and view its message history.
- Send a message from the extension; it persists via the engine and appears in the Flet UI
  (and vice-versa) without a second copy of the data.
- State survives restarts of either client because the data lives in the engine's DB.

---

## 2. Architecture

### 2.1 Core principle: the engine is a local service
The Subconscious engine already runs headless, separate from the Flet UI. Promote it to a
long-lived **local daemon** that owns the SQLite database and exposes a localhost API.
Every UI — Flet, VS Code, future clients — is a *client* of that engine.

```
┌──────────────────────────────┐
│ VS Code: Subconscious Code   │
│   Extension Host (Node/TS)   │── localhost ──┐
│   Webview (chat UI)          │   WS + REST   │
│   Coding tools (file edits)  │◀─ tool RPC ─┐ │
└──────────────────────────────┘             │ ▼
                                       ┌─────────────────────────────┐
                                       │ Subconscious Engine (daemon)│
┌──────────────────────────────┐      │   Local API (127.0.0.1)     │
│ Subconscious Flet UI         │      │   Engine core (engine.py)   │
│   in-process client          │─────▶│   Sync module (Phase 2)     │
└──────────────────────────────┘      │   SQLite  ◀── single source │
                                       └─────────────────────────────┘
```

- **No local duplication or sync.** There is exactly one DB on the machine. The extension
  holds no chat database; it queries and mutates through the engine.
- **Conflict prevention lives in the engine.** All writes funnel through it, so ordering
  and integrity are enforced in one place.
- **Coding tools live in the extension.** File reads/edits must run in the VS Code
  workspace context, so the extension owns them — kept separate from the engine's own
  general-purpose tools. (Wiring is post-milestone-1; see §6.)

### 2.2 Cross-machine sync (Phase 2, deferred)
When two engines (different machines, same or shared identity) need to sync, the engine's
**sync module** establishes a **direct peer-to-peer connection** and replicates at the data
layer. The `subconscious-server` is used only to **introduce** the peers using its existing
JWT/identity and to exchange connection setup (signaling). Chat content never transits the
server, consistent with the local-first principle in the server `SPEC.md` §10.

```
Engine A ◀══════ direct P2P data channel (chat data) ══════▶ Engine B
   │  SDP/ICE only                                              │
   └──────────────▶  subconscious-server (auth + broker)  ◀─────┘
                      introduces peers, never relays chat
```

Transport for the direct link is a Phase 2 decision (WebRTC via `aiortc`, or a direct
authenticated TLS socket when reachable). It is intentionally out of scope here and is
fully contained inside the engine — neither UI changes when it lands.

---

## 3. Local engine API (client transport)

The engine exposes a loopback-only API consumed by the extension.

- **REST** for discrete reads/commands:
  - `GET /workspaces`, `GET /workspaces/{uuid}/threads`
  - `GET /threads/{uuid}/messages`
  - `POST /threads` (create), `PATCH /threads/{uuid}` (rename/select model)
- **WebSocket** (`/events`) for live updates + streaming chat:
  - Server→client events: `message.created`, `thread.created`, `thread.updated`,
    `workspace.updated` — so the extension stays in sync with changes made in the Flet UI.
  - Client→server commands: `chat.send` (streams assistant tokens back as deltas, reusing
    the engine's existing `stream_chat`).

This mirrors what the Flet UI does in-process today, just over a socket. The engine already
has FastAPI in the project (see prior `api/chat.py` work), so this extends an existing path.

### 3.1 Discovery & auth (local)
- On startup the engine writes a runtime file in its `data_dir`, e.g.
  `runtime.json` → `{ "port": 8771, "token": "<random>", "pid": 1234, "version": "vX" }`.
- The extension reads this file to find the port and obtain a per-session bearer token.
- The API **binds to `127.0.0.1` only**, rejects non-loopback origins, and requires the
  local token — so other processes/users on the box can't connect.
- If no runtime file / engine isn't running: the extension prompts the user (and may offer
  to spawn `subconscious engine` in the background). Auto-spawn is optional for milestone 1.

---

## 4. Data model

The engine's existing ORM (`../subconscious/src/subconscious/db/models.py`) is unchanged for
this milestone: Networks → Workspace → Thread → Message. The extension does not redefine the
schema; it consumes DTOs from the local API.

### 4.1 Stable UUIDs (needed for Phase 2, cheap to add now)
`Workspace` and `Networks` already have `uuid`. `Thread` and `Message` use only autoincrement
`id`, which will collide once two engines sync. Add `uuid` (string, unique, default `uuid4`)
to `Thread` and `Message` and expose `uuid` (not local `id`) in all API DTOs. Implement as
additive `ALTER TABLE` in `db/session.py::init_models`, following the migration pattern
already there. This is not required for single-machine operation but avoids a breaking change
later and gives the extension stable identifiers immediately.

---

## 5. VS Code extension structure

```
subconscious-code/
├── package.json                 # manifest: view container, commands, settings
├── tsconfig.json
├── src/
│   ├── extension.ts             # activate(): connect to engine, register views
│   ├── engine/
│   │   ├── discovery.ts         # read runtime.json (port + token)
│   │   ├── client.ts            # REST + WebSocket client to the local engine
│   │   └── types.ts             # DTOs mirroring engine API shapes
│   ├── panel/
│   │   └── chatPanel.ts         # webview host + postMessage bridge
│   ├── tools/                   # coding tools (file read/edit) — wired post-M1
│   └── webview/
│       ├── main.ts              # chat UI logic
│       └── ui/                  # message list, composer, workspace/thread pickers
└── project_spec.md
```

- **View:** an Activity Bar container "Subconscious" with a chat webview and a
  workspace/thread selector.
- **Commands:** `subconscious.connect`, `subconscious.newThread`,
  `subconscious.selectWorkspace`, `subconscious.reconnect`.
- **Settings:** `subconscious.enginePort` (override discovery),
  `subconscious.autoStartEngine`.
- **Security:** strict webview CSP + nonce; treat all engine-pushed payloads as data, not
  code; the engine API is loopback + token gated.

---

## 6. Coding agent & tools (post-milestone-1 direction)

Milestone 1 is pure chat passthrough — no tools. The intended end state for coding tasks:

- The **agent loop runs in the engine** (it already orchestrates models via pydantic-ai).
- The **extension registers coding tools** (read file, apply edit/diff, list workspace,
  run task) with the engine over the WebSocket on connect.
- When the model requests a coding tool, the engine issues a **tool-callback RPC** to the
  extension, which executes it in the live VS Code workspace and returns the result.
- This keeps one agent implementation while ensuring editor operations run where the code
  actually is. The engine's own general tools remain separate and unaffected.

> Alternative considered: run the agent loop client-side in the extension and use the engine
> only as a model/data gateway. Rejected as the default because it duplicates orchestration,
> but kept open if coding latency or offline behaviour demands it.

---

## 7. Engine-side additions (`../subconscious`)

- Promote the engine to a supervised local daemon with the loopback API (§3) and the
  `runtime.json` discovery file.
- Add event emission on write paths (`save_message`, `get_or_create_thread`, workspace/thread
  setters) so connected clients receive `*.created/updated` events.
- Add `uuid` to `Thread`/`Message` (§4.1).
- Stub a `sync/` module boundary for Phase 2 (engine-to-engine), with no transport yet.

---

## 8. Milestones

1. **Engine local API** — loopback REST + WebSocket, `runtime.json` discovery, token auth.
2. **Extension client** — discover + connect to engine; render workspace/thread lists.
3. **Chat passthrough** — view history, send message, stream assistant deltas via the engine;
   live `message.created` updates reflected from the Flet UI and back.
4. **UUIDs + DTOs** — add Thread/Message UUIDs and expose them through the API.
5. **Hardening** — reconnect, engine-not-running UX, restart persistence.
6. *(Phase 2)* **Engine sync module** — server-brokered peer introduction + direct P2P
   replication. Separate spec.

---

## 9. Open questions
- Should the extension auto-spawn the engine when it isn't running, or only connect to an
  already-running instance?
- Local API token lifetime/rotation — per engine start, or persisted in `data_dir`?
- Phase 2 direct-link transport: WebRTC (`aiortc`) for NAT traversal vs. direct TLS socket
  on reachable networks.
- Coding agent loop: confirm engine-side loop + tool-callback RPC (§6) as the committed
  approach before building tools.
