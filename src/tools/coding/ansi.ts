// Shared ANSI/VT control-sequence stripping, used wherever raw terminal
// shell-integration output is captured for display (the visible-terminal
// CommandRunner and the "#Terminal" context-mention output tracker).

/** Strip ANSI/VT control sequences from captured shell-integration output. */
export function stripAnsi(text: string): string {
  // CSI sequences (colours, cursor moves) and OSC sequences (titles, hyperlinks).
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-Z\\-_]/g, "");
}
