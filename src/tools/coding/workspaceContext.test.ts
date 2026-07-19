// Feature: agent-tools-and-settings — unit tests for the workspace/IDE meta tool.
//
// Pure-module Node/Mocha test: the VS Code interaction is injected, so the output
// formatting is verified without the extension host. `vscodeStub` is imported first so
// the module-level `import * as vscode` in `workspaceContext.ts` resolves.
import "../../test/vscodeStub";

import * as assert from "assert";

import {
  GetWorkspaceContextTool,
  type WorkspaceContextData,
} from "./workspaceContext";

function tool(data: WorkspaceContextData): GetWorkspaceContextTool {
  return new GetWorkspaceContextTool(() => data);
}

const BASE = {
  appName: "Visual Studio Code",
  ideVersion: "1.99.0",
  platform: "win32",
  openFiles: [] as string[],
};

describe("GetWorkspaceContextTool", () => {
  it("reports a single workspace root with its path", async () => {
    const out = await tool({
      ...BASE,
      roots: [{ name: "Subconscious", path: "c:/code/Ancilla/Subconscious" }],
      activeFile: "c:/code/Ancilla/Subconscious/readme.md",
    }).execute();

    assert.match(out.content, /Workspace: Subconscious \(c:\/code\/Ancilla\/Subconscious\)/);
    assert.match(out.content, /Active file: c:\/code\/Ancilla\/Subconscious\/readme\.md/);
    assert.strictEqual((out.data as { primaryRoot: string }).primaryRoot, "c:/code/Ancilla/Subconscious");
    assert.strictEqual((out.data as { multiRoot: boolean }).multiRoot, false);
  });

  it("reports a multi-root workspace", async () => {
    const out = await tool({
      ...BASE,
      roots: [
        { name: "a", path: "/a" },
        { name: "b", path: "/b" },
      ],
    }).execute();

    assert.match(out.content, /Multi-root workspace \(2 folders\)/);
    assert.strictEqual((out.data as { multiRoot: boolean }).multiRoot, true);
    assert.match(out.content, /Active file: \(none\)/);
  });

  it("reports when no workspace folder is open", async () => {
    const out = await tool({ ...BASE, roots: [] }).execute();
    assert.match(out.content, /No workspace folder is open/);
    assert.strictEqual((out.data as { primaryRoot: string | null }).primaryRoot, null);
  });

  it("includes the editor name, version, and platform", async () => {
    const out = await tool({ ...BASE, roots: [{ name: "x", path: "/x" }] }).execute();
    assert.match(out.content, /Visual Studio Code 1\.99\.0 on win32/);
  });
});
