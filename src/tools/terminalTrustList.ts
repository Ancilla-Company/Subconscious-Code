// Feature: agent-tools-and-settings — settings.json-backed terminal trust list.
//
// Implements the `TerminalAllowlist` contract the `ApprovalManager` evaluates per
// Command_Segment (Requirement 10.5, 10.6) from two user-editable VS Code settings,
// mirroring the Kiro/Copilot-style trust list convention:
//
//   - `subconscious.trustedCommands` — glob patterns ("*" matches any run of
//     characters) checked against the full segment string. A segment matching any
//     pattern is auto-approvable.
//   - `subconscious.commandDenylist` — case-insensitive substring patterns checked
//     BEFORE the trust list. A segment matching any denylist pattern is never
//     auto-approvable, regardless of the trust list (denylist always wins).
//
// Both lists are read live from `vscode.workspace.getConfiguration` on every
// `covers()` call so edits to `.vscode/settings.json` (or the user/global settings)
// take effect immediately without requiring a reload — consistent with how
// `applySettings` already treats `subconscious.*` settings as live overrides.
//
// This module is intentionally free of any dependency beyond the injected settings
// reader, so it can be exercised outside the VS Code host.

import type { TerminalAllowlist } from "./approvalManager";

/** Reads the two trust-list settings; the production reader wraps `vscode.workspace`. */
export interface TrustListSettingsReader {
  trustedCommands(): readonly string[];
  commandDenylist(): readonly string[];
}

/** Escape every regex metacharacter in `text` except the glob wildcard handling below. */
function escapeRegExpLiteral(text: string): string {
  return text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/**
 * Convert a glob pattern (only `*` is treated specially, matching any run of zero or
 * more characters) into an anchored, case-insensitive `RegExp` matched against the
 * whole segment string.
 */
function globToRegExp(glob: string): RegExp {
  const pattern = glob
    .split("*")
    .map((part) => escapeRegExpLiteral(part))
    .join(".*");
  return new RegExp(`^${pattern}$`, "i");
}

/**
 * A {@link TerminalAllowlist} backed by the live `subconscious.trustedCommands` /
 * `subconscious.commandDenylist` settings. A Command_Segment is covered (auto-
 * approvable) iff it matches at least one trusted-command glob AND matches no
 * denylist substring — the denylist is checked first and always wins.
 */
export class SettingsTerminalAllowlist implements TerminalAllowlist {
  public constructor(private readonly settings: TrustListSettingsReader) {}

  public covers(segment: string): boolean {
    const trimmed = segment.trim();
    if (trimmed.length === 0) {
      return false;
    }

    const denylist = this.settings.commandDenylist();
    const lowerSegment = trimmed.toLowerCase();
    for (const pattern of denylist) {
      const needle = pattern.trim().toLowerCase();
      if (needle.length > 0 && lowerSegment.includes(needle)) {
        return false; // Denylist match always forces confirmation.
      }
    }

    const trusted = this.settings.trustedCommands();
    for (const pattern of trusted) {
      const glob = pattern.trim();
      if (glob.length === 0) {
        continue;
      }
      if (globToRegExp(glob).test(trimmed)) {
        return true;
      }
    }

    return false;
  }
}
