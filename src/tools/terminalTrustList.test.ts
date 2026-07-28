// Unit tests for `SettingsTerminalAllowlist` (settings.json-backed trust list).
//
// Covers: glob matching for `subconscious.trustedCommands`, substring matching for
// `subconscious.commandDenylist`, and that the denylist always wins over the trust
// list when both match the same segment.

import * as assert from "assert";

import { SettingsTerminalAllowlist } from "./terminalTrustList";
import type { TrustListSettingsReader } from "./terminalTrustList";

function readerWith(
  trusted: readonly string[],
  denied: readonly string[] = [],
): TrustListSettingsReader {
  return {
    trustedCommands: () => trusted,
    commandDenylist: () => denied,
  };
}

describe("SettingsTerminalAllowlist", () => {
  it("covers a segment matching a trusted glob", () => {
    const allowlist = new SettingsTerminalAllowlist(readerWith(["npm *", "git status"]));
    assert.strictEqual(allowlist.covers("npm install"), true);
    assert.strictEqual(allowlist.covers("git status"), true);
  });

  it("does not cover a segment matching no trusted glob", () => {
    const allowlist = new SettingsTerminalAllowlist(readerWith(["npm *"]));
    assert.strictEqual(allowlist.covers("git push"), false);
  });

  it("is case-insensitive for glob matching", () => {
    const allowlist = new SettingsTerminalAllowlist(readerWith(["NPM *"]));
    assert.strictEqual(allowlist.covers("npm run build"), true);
  });

  it("denylist substring match forces non-coverage regardless of trust list", () => {
    const allowlist = new SettingsTerminalAllowlist(
      readerWith(["git *"], ["git push"]),
    );
    assert.strictEqual(allowlist.covers("git push origin main"), false);
    assert.strictEqual(allowlist.covers("git status"), true);
  });

  it("denylist match is case-insensitive", () => {
    const allowlist = new SettingsTerminalAllowlist(
      readerWith(["rm *"], ["RM -RF"]),
    );
    assert.strictEqual(allowlist.covers("rm -rf ./dist"), false);
  });

  it("empty segment is never covered", () => {
    const allowlist = new SettingsTerminalAllowlist(readerWith(["*"]));
    assert.strictEqual(allowlist.covers("   "), false);
  });

  it("blank entries in either list are ignored", () => {
    const allowlist = new SettingsTerminalAllowlist(readerWith(["", "npm *"], [""]));
    assert.strictEqual(allowlist.covers("npm test"), true);
  });
});
