# Subconscious Code

A VS Code extension that provides a coding-focused chat interface backed by the local
[Subconscious](../subconscious) engine. It shares workspaces, threads, and messages with
the Subconscious desktop app because both connect to the **same local engine** — there is
no separate database and no local sync.

See [`project_spec.md`](./project_spec.md) for the full design.

## How it works

- The engine runs as a local daemon and exposes a loopback-only REST + WebSocket API.
- On startup the engine writes `runtime.json` (port + session token) into its data
  directory. This extension discovers the engine from that file.
- If the engine isn't running, the extension starts it (`subconscious engine`) when
  `subconscious.autoStartEngine` is enabled.
- Chat data is read and written through the engine; the agent loop runs in the engine.

## Develop

```
npm install
npm run compile      # or: npm run watch
```

Then press **F5** ("Run Extension") to launch an Extension Development Host. Open the
**Subconscious** view in the activity bar.

> Requires the `subconscious` CLI on your PATH (or set `subconscious.engineCommand`).
> Use `subconscious.dev: true` to connect to the `--dev` engine instance.

## Settings

| Setting | Default | Description |
|---|---|---|
| `subconscious.autoStartEngine` | `true` | Start the engine if it isn't running. |
| `subconscious.engineCommand` | `subconscious` | Command used to launch the engine. |
| `subconscious.dev` | `false` | Use the `-dev` data dir / pass `--dev` when spawning. |
| `subconscious.dataDir` | `""` | Override the data directory used for discovery. |

## Testing

Three tiers, all compiled from `src/**/*.test.ts` to `out/` (`npm run compile`, or keep `npm: watch` running).

| Tier | Files | Run | Needs |
|---|---|---|---|
| Unit | `*.test.ts` (not `.vscode.`/`.live.`) | `npm run test:unit` (plain Node, canonical and fast) | nothing |
| Host | `*.vscode.test.ts` | `npm run test:host` (`vscode-test --label host`) | downloads VS Code into `.vscode-test/` (git-ignored) |
| Live | `src/test/live/*.live.test.ts` | `npm run test:live` or task **Test: Live (Code)** | a running stack, see below |

`npm run test:unit` never loads the live files (`.mocharc.json` and `scripts/run-unit-tests.js` skip `*.live.test.js`).

### Live (end-to-end) tests

They drive the real extension modules (`EngineClient`, discovery, `ConfigStore`, `ToolRegistry`/`ToolHost`) against a
real engine started by the sibling repo's `scripts/live_stack.py` (real server + real engine, throw-away data and
secrets). They are always collected, and skip with
`live test: start the stack with the task "Live: Start stack" (or set SC_LIVE_STACK=<path to stack.json>)` when no stack
is reachable. The stack file is `$env:SC_LIVE_STACK`, else `../subconscious/build/live-stack/stack.json`; its engine
must answer `GET /api/v1/health`.

Tasks (`.vscode/tasks.json`, Terminal > Run Task):

- **Live: Start stack**: background; ready when it prints `LIVE-STACK-READY`. `python ..\subconscious\scripts\live_stack.py --no-webrtc`.
- **Live: Stop stack**: `python ..\subconscious\scripts\live_stack.py --stop`.
- **Test: Live (Code)**: starts the stack, then `npm run test:live` with `SC_LIVE_STACK` set. The stack is left running; stop it with the stop task.

From a terminal:

```powershell
python ..\subconscious\scripts\live_stack.py --no-webrtc    # leave running (or use SC_LIVE_STACK_DIR=<dir> for a private copy)
$env:SC_LIVE_STACK = '..\subconscious\build\live-stack\stack.json'
npm run test:live
python ..\subconscious\scripts\live_stack.py --stop
```

### Testing panel

Install **Extension Test Runner** (`ms-vscode.extension-test-runner`, recommended in `.vscode/extensions.json`). It reads
`.vscode-test.mjs`, which defines three entries that show up as top-level nodes in the Testing panel:
`host`, `unit` (the Node unit tests, run inside the VS Code host through the same runner) and `live`.
The runner uses the default build task (`npm: watch`, `tsc -watch`) so the panel always runs fresh `out/`.
The live entry needs the stack running first (start it with the task above); without it the tests show as skipped.
CLI equivalents: `npx vscode-test --label unit|host|live`.
