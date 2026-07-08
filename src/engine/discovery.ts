import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import * as http from "http";
import { spawn } from "child_process";
import * as vscode from "vscode";
import { RuntimeInfo } from "./types";

const RUNTIME_FILE = "runtime.json";

let output: vscode.OutputChannel | undefined;
function log(message: string): void {
  if (!output) {
    output = vscode.window.createOutputChannel("Subconscious");
  }
  output.appendLine(`[discovery] ${message}`);
}

/** Platform default data directory, optionally the dev variant. */
function baseDataDir(dev: boolean): string {
  const home = os.homedir();
  let base: string;
  if (process.platform === "win32") {
    base = path.join(process.env.APPDATA ?? home, "Subconscious");
  } else if (process.platform === "darwin") {
    base = path.join(home, "Library", "Application Support", "Subconscious");
  } else {
    base = process.env.XDG_CONFIG_HOME
      ? path.join(process.env.XDG_CONFIG_HOME, "subconscious")
      : path.join(home, ".config", "subconscious");
  }
  return dev ? `${base}-dev` : base;
}

/** The data directory used when spawning a new engine. */
export function resolveDataDir(): string {
  const cfg = vscode.workspace.getConfiguration("subconscious");
  const override = (cfg.get<string>("dataDir") || "").trim();
  if (override) {
    return override;
  }
  return baseDataDir(cfg.get<boolean>("dev") ?? false);
}

/**
 * Candidate data directories to probe for a running engine. An explicit
 * override wins; otherwise try both the configured mode and its opposite so a
 * dev daemon is still found when the extension defaults to non-dev (and vice
 * versa).
 */
function candidateDataDirs(): string[] {
  const cfg = vscode.workspace.getConfiguration("subconscious");
  const override = (cfg.get<string>("dataDir") || "").trim();
  if (override) {
    return [override];
  }
  const dev = cfg.get<boolean>("dev") ?? false;
  return dev
    ? [baseDataDir(true), baseDataDir(false)]
    : [baseDataDir(false), baseDataDir(true)];
}

function readRuntimeInfoAt(dir: string): RuntimeInfo | undefined {
  try {
    const raw = fs.readFileSync(path.join(dir, RUNTIME_FILE), "utf-8");
    const info = JSON.parse(raw) as RuntimeInfo;
    if (info && info.port && info.token) {
      return info;
    }
  } catch {
    /* missing or unreadable */
  }
  return undefined;
}

/**
 * Probe the engine's health endpoint using the Node http module (avoids any
 * dependency on a global fetch implementation in the extension host).
 */
function isReachable(info: RuntimeInfo): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: info.host || "127.0.0.1", port: info.port, path: "/api/v1/health", timeout: 1500 },
      (res) => {
        res.resume();
        resolve((res.statusCode ?? 500) < 400);
      },
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Search all candidate dirs and return the first reachable engine. */
async function findRunningEngine(): Promise<RuntimeInfo | undefined> {
  for (const dir of candidateDataDirs()) {
    const info = readRuntimeInfoAt(dir);
    if (!info) {
      log(`no ${RUNTIME_FILE} in ${dir}`);
      continue;
    }
    if (await isReachable(info)) {
      log(`connected to engine at 127.0.0.1:${info.port} (from ${dir})`);
      return info;
    }
    log(`stale ${RUNTIME_FILE} in ${dir} (port ${info.port} not responding)`);
  }
  return undefined;
}

/** Spawn the engine as a detached background process. */
function spawnEngine(): void {
  const cfg = vscode.workspace.getConfiguration("subconscious");
  const command = cfg.get<string>("engineCommand") || "subconscious";
  const dev = cfg.get<boolean>("dev") ?? false;
  const args = dev ? ["--dev", "engine"] : ["engine"];
  log(`starting engine: ${command} ${args.join(" ")}`);
  const child = spawn(command, args, {
    detached: true,
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  child.unref();
}

/**
 * Return a reachable engine's RuntimeInfo. If none is running and
 * autoStartEngine is enabled, spawn one and wait for it to come up.
 */
export async function discoverEngine(timeoutMs = 20000): Promise<RuntimeInfo> {
  const existing = await findRunningEngine();
  if (existing) {
    return existing;
  }

  const cfg = vscode.workspace.getConfiguration("subconscious");
  if (!(cfg.get<boolean>("autoStartEngine") ?? true)) {
    throw new Error("Subconscious engine is not running and auto-start is disabled.");
  }

  spawnEngine();

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(500);
    const info = await findRunningEngine();
    if (info) {
      return info;
    }
  }
  throw new Error("Timed out waiting for the Subconscious engine to start.");
}
