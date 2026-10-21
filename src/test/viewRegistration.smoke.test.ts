// Feature: agent-tools-and-settings — view-registration & styling smoke test.
//
// This is NOT one of the numbered correctness properties from design.md. It is a
// PURE-MODULE (Node/Mocha) smoke test for task 13.6, asserting two things without
// launching a VS Code extension host (a nested host crashes the editor host):
//
//   1. View registration — both new webview surfaces are contributed under the
//      `subconscious` activity-bar container as `type: "webview"` views with the
//      ids the provider classes declare (`ToolsView.viewType` /
//      `SettingsView.viewType`), and the two agent configuration properties exist
//      with the correct min/max/default (Requirements 7.1, 8.1).
//
//   2. Styling — the webview media (`media/main.css`, `media/tools.js`,
//      `media/settings.js`) carries NO hard-coded colours: no hex literals and no
//      rgb()/rgba()/hsl()/hsla() literals outside of `var(--vscode-*)` fallbacks.
//      Every colour therefore resolves from a VS Code theme token (Theme Token
//      Styling), so the surfaces render correctly under any theme.
//
// `vscodeStub` is imported FIRST so the `import * as vscode` in the provider
// modules resolves to the lightweight Node stub before those modules load.
import "./vscodeStub";

import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";

import { ToolsController } from "../panel/toolsController";
import { SettingsView } from "../panel/settingsView";

/** Extension root (two levels up from the compiled `out/test/` location). */
const EXTENSION_ROOT = path.resolve(__dirname, "..", "..");

interface ViewContribution {
  readonly id: string;
  readonly name: string;
  readonly type: string;
}

interface ConfigProperty {
  readonly type: string;
  readonly default: number;
  readonly minimum: number;
  readonly maximum: number;
}

interface Command {
  readonly command: string;
  readonly title: string;
}

interface PackageJson {
  readonly contributes: {
    readonly views: Record<string, ViewContribution[]>;
    readonly commands: Command[];
    readonly configuration: {
      readonly properties: Record<string, ConfigProperty>;
    };
  };
}

function readPackageJson(): PackageJson {
  const raw = fs.readFileSync(path.join(EXTENSION_ROOT, "package.json"), "utf8");
  return JSON.parse(raw) as PackageJson;
}

function readMedia(fileName: string): string {
  return fs.readFileSync(path.join(EXTENSION_ROOT, "media", fileName), "utf8");
}

/**
 * Remove every balanced `var(...)` expression (including nested `var()` and their
 * fallback contents) from a stylesheet. Colour literals that appear only as the
 * last-resort fallback of a theme token (e.g. `var(--vscode-widget-shadow,
 * rgba(0,0,0,0.36))`) are therefore stripped and NOT treated as hard-coded — matching
 * the rule "no rgb()/rgba()/hsl() literals outside of var(--vscode-*) fallbacks".
 */
function stripVarExpressions(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const varStart = css.indexOf("var(", i);
    if (varStart === -1) {
      out += css.slice(i);
      break;
    }
    out += css.slice(i, varStart);
    // Walk to the paren that balances this `var(`.
    let depth = 0;
    let j = varStart + 3; // position of the '(' in "var("
    for (; j < css.length; j++) {
      const ch = css[j];
      if (ch === "(") {
        depth++;
      } else if (ch === ")") {
        depth--;
        if (depth === 0) {
          j++; // consume the closing paren
          break;
        }
      }
    }
    i = j;
  }
  return out;
}

// A hex colour literal: #rgb, #rgba, #rrggbb, or #rrggbbaa.
const HEX_COLOR = /#[0-9a-fA-F]{3,8}\b/;
// A functional colour literal: rgb(), rgba(), hsl(), hsla().
const FUNCTIONAL_COLOR = /\b(?:rgba?|hsla?)\s*\(/i;

/** Find the first hard-coded colour (outside `var()` fallbacks) in a source string. */
function firstHardCodedColor(source: string): string | undefined {
  const stripped = stripVarExpressions(source);
  const hex = stripped.match(HEX_COLOR);
  if (hex) {
    return hex[0];
  }
  const fn = stripped.match(FUNCTIONAL_COLOR);
  if (fn) {
    return fn[0];
  }
  return undefined;
}

describe("view registration & styling smoke", () => {
  describe("registration (Requirements 7.1, 8.1)", () => {
    it("contributes the chat webview view (and no sidebar settings view)", () => {
      const pkg = readPackageJson();
      const views = pkg.contributes.views.subconscious;
      assert.ok(Array.isArray(views), "expected a `subconscious` views container");

      const byId = new Map(views.map((v) => [v.id, v]));

      const chat = byId.get("subconscious.chat");
      assert.ok(chat, "expected a `subconscious.chat` view contribution");
      assert.strictEqual(chat.type, "webview");

      assert.ok(
        !byId.has("subconscious.settings"),
        "settings open in the editor area, not as a sidebar view",
      );
    });

    it("no longer contributes a sidebar tools view (relocated to the editor-area page)", () => {
      const pkg = readPackageJson();
      const ids = new Set(pkg.contributes.views.subconscious.map((v) => v.id));
      assert.ok(
        !ids.has("subconscious.tools"),
        "the sidebar `subconscious.tools` view should be removed",
      );
    });

    it("contributes the `subconscious.configureTools` command that opens the tools page", () => {
      const pkg = readPackageJson();
      const commands = new Set(pkg.contributes.commands.map((c) => c.command));
      assert.ok(
        commands.has("subconscious.configureTools"),
        "package.json missing the subconscious.configureTools command",
      );
    });

    it("opens settings as an editor-area page through `subconscious.openSettings`", () => {
      const pkg = readPackageJson();
      const commands = new Set(pkg.contributes.commands.map((c) => c.command));

      assert.strictEqual(SettingsView.viewType, "subconscious.settingsPanel");
      assert.ok(commands.has("subconscious.openSettings"), "missing openSettings command");
      // The Configure Tools controller drives the editor-area page (no sidebar view).
      assert.strictEqual(typeof ToolsController, "function");
    });

    it("declares the agent configuration properties with correct bounds", () => {
      const props = readPackageJson().contributes.configuration.properties;

      const timeout = props["subconscious.toolTimeoutSeconds"];
      assert.ok(timeout, "expected subconscious.toolTimeoutSeconds");
      assert.strictEqual(timeout.type, "number");
      assert.strictEqual(timeout.default, 120);
      assert.strictEqual(timeout.minimum, 5);
      assert.strictEqual(timeout.maximum, 600);

      const maxRead = props["subconscious.maxReadBytes"];
      assert.ok(maxRead, "expected subconscious.maxReadBytes");
      assert.strictEqual(maxRead.type, "number");
      assert.strictEqual(maxRead.default, 10_485_760);
      assert.strictEqual(maxRead.minimum, 1024);
      assert.strictEqual(maxRead.maximum, 104_857_600);
    });
  });

  describe("styling — theme tokens only (Requirements 7.5, 8.8, 11.14)", () => {
    it("main.css has no hard-coded colours outside var() fallbacks", () => {
      const found = firstHardCodedColor(readMedia("main.css"));
      assert.strictEqual(
        found,
        undefined,
        `main.css contains a hard-coded colour: ${found}`
      );
    });

    it("tools.js has no hard-coded colours in inline styles", () => {
      const found = firstHardCodedColor(readMedia("tools.js"));
      assert.strictEqual(
        found,
        undefined,
        `tools.js contains a hard-coded colour: ${found}`
      );
    });

    it("settings.js has no hard-coded colours in inline styles", () => {
      const found = firstHardCodedColor(readMedia("settings.js"));
      assert.strictEqual(
        found,
        undefined,
        `settings.js contains a hard-coded colour: ${found}`
      );
    });

    it("every colour-bearing declaration in main.css references a --vscode- token", () => {
      const css = readMedia("main.css");
      // Colour-bearing property declarations (background/color/border/box-shadow/etc.)
      // must reference a theme token. We scan declarations whose value mentions a
      // colour concept and assert a `--vscode-` token is present.
      const declarations = css
        .split(/[;{}]/)
        .map((d) => d.trim())
        .filter((d) => /^(background|background-color|color|border|border-[a-z]+|box-shadow|outline|fill|stroke)\b/i.test(d));

      for (const decl of declarations) {
        const value = decl.slice(decl.indexOf(":") + 1).trim();
        // Declarations that carry no colour concept (pure geometry keywords such as
        // `1px solid transparent`, `none`, `inherit`, numeric-only) are exempt.
        const mentionsColor =
          /--vscode-/.test(value) || HEX_COLOR.test(value) || FUNCTIONAL_COLOR.test(value);
        if (!mentionsColor) {
          continue;
        }
        assert.ok(
          /--vscode-/.test(value),
          `colour declaration without a theme token: "${decl}"`
        );
      }
    });
  });
});
