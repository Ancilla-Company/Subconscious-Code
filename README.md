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
