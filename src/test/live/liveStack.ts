// Shared support for the live (end-to-end) tier: attach to a RUNNING stack
// (`scripts/live_stack.py` in the sibling `subconscious` repo) and give the REAL extension
// modules (EngineClient, discovery, ToolHost, ConfigStore) what they need to run in plain Node.
//
// The only fake here is the `vscode` module (not present outside the extension host): it
// answers `subconscious.dataDir` with the live engine's data directory so the extension's
// REAL discovery code finds the live engine through its `runtime.json`, and it keeps
// `autoStartEngine` off so a live test can never spawn a stray engine process.
//
// Import this module BEFORE any `../../engine/*` or `../../tools/*` module.

import Module = require("module");
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { EventEmitter } from "events";

/** Why a live test did not run (printed once per suite; mocha shows the tests as pending). */
export const SKIP_MESSAGE =
  'live test: start the stack with the task "Live: Start stack" (or set SC_LIVE_STACK=<path to stack.json>)';

// -----------------------------------------------------------------------------
// vscode shim (installed once, outermost `Module._load` hook)
// -----------------------------------------------------------------------------

let activeDataDir = "";

/** Point the extension's discovery at a data directory (the live engine's). */
export function setDiscoveryDataDir(dir: string): void {
  activeDataDir = dir;
}

class ShimEventEmitter<T> {
  private readonly listeners = new Set<(event: T) => unknown>();
  public readonly event = (listener: (event: T) => unknown): { dispose(): void } => {
    this.listeners.add(listener);
    return { dispose: (): void => void this.listeners.delete(listener) };
  };
  public fire(data: T): void {
    for (const listener of [...this.listeners]) {
      listener(data);
    }
  }
  public dispose(): void {
    this.listeners.clear();
  }
}

const shimSettings: Record<string, unknown> = {
  autoStartEngine: false,
  dev: false,
  engineCommand: "subconscious-live-tests-must-not-spawn-this",
};

const vscodeShim = {
  EventEmitter: ShimEventEmitter,
  workspace: {
    getConfiguration: (): { get: <T>(key: string, fallback?: T) => T | undefined } => ({
      get: <T>(key: string, fallback?: T): T | undefined => {
        if (key === "dataDir") {
          return activeDataDir as unknown as T;
        }
        return key in shimSettings ? (shimSettings[key] as T) : fallback;
      },
    }),
  },
  window: {
    createOutputChannel: (): { appendLine(line: string): void; dispose(): void } => ({
      appendLine: (): void => undefined,
      dispose: (): void => undefined,
    }),
  },
};

interface LoaderModule {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  __subconsciousLiveShimInstalled?: boolean;
}

const loader = Module as unknown as LoaderModule;
if (!loader.__subconsciousLiveShimInstalled) {
  const originalLoad = loader._load.bind(loader);
  loader._load = function liveLoad(request: string, parent: unknown, isMain: boolean): unknown {
    return request === "vscode" ? vscodeShim : originalLoad(request, parent, isMain);
  };
  loader.__subconsciousLiveShimInstalled = true;
}

// -----------------------------------------------------------------------------
// Stack discovery and gating
// -----------------------------------------------------------------------------

export interface LiveEngine {
  readonly name: string;
  readonly url: string;
  readonly token: string;
  readonly nodeId: string;
  readonly dataDir: string;
}

export interface LiveStack {
  readonly file: string;
  readonly serverUrl: string;
  readonly engine: LiveEngine;
}

/** `SC_LIVE_STACK`, else the sibling repo's default `build/live-stack/stack.json`. */
export function stackFilePath(): string {
  const fromEnv = (process.env.SC_LIVE_STACK ?? "").trim();
  // out/test/live -> repo root is three levels up; the sibling repo sits next to it.
  return fromEnv || path.resolve(__dirname, "..", "..", "..", "..", "subconscious", "build", "live-stack", "stack.json");
}

function httpStatus(url: string, timeoutMs = 3000): Promise<number | undefined> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", () => resolve(undefined));
    req.on("timeout", () => {
      req.destroy();
      resolve(undefined);
    });
  });
}

/** The running stack, or `undefined` (no file, unreadable, or the engine is not healthy). */
export async function resolveLiveStack(): Promise<LiveStack | undefined> {
  const file = stackFilePath();
  let doc: any;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return undefined;
  }
  const engine = Array.isArray(doc?.engines) ? doc.engines[0] : undefined;
  if (!engine || typeof engine.url !== "string" || typeof engine.token !== "string") {
    return undefined;
  }
  if ((await httpStatus(`${engine.url}/api/v1/health`)) !== 200) {
    return undefined;
  }
  return {
    file,
    serverUrl: String(doc?.server?.url ?? ""),
    engine: {
      name: String(engine.name ?? "engine"),
      url: engine.url,
      token: engine.token,
      nodeId: String(engine.nodeId ?? ""),
      dataDir: String(engine.dataDir ?? ""),
    },
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `check` until it returns a truthy value; throws with `what` on timeout. */
export async function waitFor<T>(
  check: () => Promise<T | undefined | false> | T | undefined | false,
  what: string,
  timeoutMs = 20_000,
  stepMs = 150,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}`);
    }
    await sleep(stepMs);
  }
}

/** Resolve on the next emission of `event` that satisfies `match`. */
export function nextEvent<T = unknown>(
  emitter: EventEmitter,
  event: string,
  match: (value: T) => boolean = () => true,
  timeoutMs = 15_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, listener);
      reject(new Error(`timed out after ${timeoutMs} ms waiting for "${event}"`));
    }, timeoutMs);
    const listener = (value: T): void => {
      if (match(value)) {
        clearTimeout(timer);
        emitter.off(event, listener);
        resolve(value);
      }
    };
    emitter.on(event, listener);
  });
}

/** Authenticated JSON request to the live engine's REST API (master token). */
export async function engineRest<T>(stack: LiveStack, route: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${stack.engine.url}/api/v1${route}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${stack.engine.token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    throw new Error(`engine ${route} failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

export interface EngineDeviceNode {
  readonly id: string;
  readonly local?: boolean;
  readonly clients: readonly string[];
}

/** The engine's own device list (`GET /hive/nodes`), keyed by node id. */
export async function engineNodes(stack: LiveStack): Promise<Map<string, EngineDeviceNode>> {
  const body = await engineRest<{ nodes: EngineDeviceNode[] }>(stack, "/hive/nodes");
  return new Map(body.nodes.map((node) => [node.id, node]));
}

/** Labels of the clients the engine currently lists as local on its own node. */
export async function localClientLabels(stack: LiveStack): Promise<readonly string[]> {
  return (await engineNodes(stack)).get(stack.engine.nodeId)?.clients ?? [];
}

/** Create a workspace on the dev Echo model; returns its uuid. */
export async function makeWorkspace(stack: LiveStack, name: string): Promise<string> {
  const ws = await engineRest<{ uuid: string }>(stack, "/workspaces", {
    method: "POST",
    body: JSON.stringify({ name, defaultModelId: "echo" }),
  });
  return ws.uuid;
}
