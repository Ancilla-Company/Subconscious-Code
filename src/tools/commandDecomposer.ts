// Shell-aware command decomposition for the agent-tools-and-settings feature.
//
// The Run_Terminal_Tool must never let a compound command line smuggle an
// unapproved command past the Approval_Manager. This module is the pure,
// input-driven tokenizer that splits a raw command string into its constituent
// Command_Segments so each can be surfaced and approved individually.
//
// It splits on the target shell's control operators (`&&`, `||`, `;`, `|`, `&`,
// and newlines for POSIX; the cmd/PowerShell equivalents), expands subshell `( )`
// and grouping `{ }` constructs into the segments they contain, and treats any
// operator that appears inside quotes or immediately after an escape character as
// literal text rather than a separator. When the string cannot be decomposed
// (unbalanced quotes, an unterminated escape, or unmatched grouping delimiters) it
// returns `ok: false` with a reason so the caller prompts for the whole string.
//
// _Requirements: 10.1, 10.7_

/** The target shell whose quoting/escaping/operator rules apply. */
export type ShellKind = "posix" | "cmd" | "powershell";

/** The reason a command string could not be decomposed (Requirement 10.7). */
export type DecompositionFailure =
  | "unbalanced-quote"
  | "unterminated-escape"
  | "unmatched-delimiter";

/**
 * The outcome of decomposing a command string. On success, `segments` holds the
 * individual Command_Segments (never containing empty entries). On failure, `ok`
 * is `false`, `segments` is empty, and `reason` identifies why decomposition
 * failed (Requirement 10.7).
 */
export interface DecompositionResult {
  readonly ok: boolean;
  readonly segments: string[];
  readonly reason?: DecompositionFailure;
}

/** Pure shell-aware tokenizer that splits a command string into Command_Segments. */
export interface CommandDecomposer {
  decompose(command: string, shell: ShellKind): DecompositionResult;
}

/** Per-shell lexical rules governing quotes, escapes, and control operators. */
interface ShellSyntax {
  /** Control operators, ordered longest-first so multi-char operators win. */
  readonly operators: readonly string[];
  /** The escape character recognized outside quotes, or `null` if none. */
  readonly escapeChar: string | null;
  /** Whether a single quote opens a literal single-quoted string. */
  readonly singleQuote: boolean;
  /** Whether a double quote opens a double-quoted string. */
  readonly doubleQuote: boolean;
  /** Whether the escape character is honoured inside double quotes. */
  readonly escapeInDouble: boolean;
}

const POSIX_SYNTAX: ShellSyntax = {
  operators: ["&&", "||", "|", ";", "&", "\n"],
  escapeChar: "\\",
  singleQuote: true,
  doubleQuote: true,
  escapeInDouble: true,
};

const CMD_SYNTAX: ShellSyntax = {
  operators: ["&&", "||", "|", "&", "\n"],
  escapeChar: "^",
  singleQuote: false,
  doubleQuote: true,
  escapeInDouble: false,
};

const POWERSHELL_SYNTAX: ShellSyntax = {
  operators: ["&&", "||", "|", ";", "&", "\n"],
  escapeChar: "`",
  singleQuote: true,
  doubleQuote: true,
  escapeInDouble: true,
};

function syntaxFor(shell: ShellKind): ShellSyntax {
  switch (shell) {
    case "posix":
      return POSIX_SYNTAX;
    case "cmd":
      return CMD_SYNTAX;
    case "powershell":
      return POWERSHELL_SYNTAX;
    default: {
      // Exhaustiveness guard: a new ShellKind must be handled explicitly.
      const unreachable: never = shell;
      throw new Error(`Unsupported shell kind: ${String(unreachable)}`);
    }
  }
}

type QuoteState = "normal" | "single" | "double";

/** The default {@link CommandDecomposer} implementation. */
export class ShellCommandDecomposer implements CommandDecomposer {
  public decompose(command: string, shell: ShellKind): DecompositionResult {
    const syntax = syntaxFor(shell);
    const segments: string[] = [];
    const delimiterStack: string[] = [];

    let quote: QuoteState = "normal";
    let escapePending = false;
    let buffer = "";
    let i = 0;

    const flush = (): void => {
      const trimmed = buffer.trim();
      if (trimmed.length > 0) {
        segments.push(trimmed);
      }
      buffer = "";
    };

    while (i < command.length) {
      const c = command[i];

      // A pending escape consumes the next character literally.
      if (escapePending) {
        buffer += c;
        escapePending = false;
        i += 1;
        continue;
      }

      if (quote === "single") {
        // Single quotes are fully literal; only the matching quote closes them.
        buffer += c;
        if (c === "'") {
          quote = "normal";
        }
        i += 1;
        continue;
      }

      if (quote === "double") {
        if (syntax.escapeInDouble && c === syntax.escapeChar) {
          buffer += c;
          escapePending = true;
          i += 1;
          continue;
        }
        buffer += c;
        if (c === '"') {
          quote = "normal";
        }
        i += 1;
        continue;
      }

      // quote === "normal" below.

      if (syntax.escapeChar !== null && c === syntax.escapeChar) {
        buffer += c;
        escapePending = true;
        i += 1;
        continue;
      }

      if (syntax.singleQuote && c === "'") {
        buffer += c;
        quote = "single";
        i += 1;
        continue;
      }

      if (syntax.doubleQuote && c === '"') {
        buffer += c;
        quote = "double";
        i += 1;
        continue;
      }

      // Grouping delimiters: expand their contents into standalone segments.
      if (c === "(" || c === "{") {
        flush();
        delimiterStack.push(c);
        i += 1;
        continue;
      }

      if (c === ")") {
        if (delimiterStack[delimiterStack.length - 1] !== "(") {
          return { ok: false, segments: [], reason: "unmatched-delimiter" };
        }
        delimiterStack.pop();
        flush();
        i += 1;
        continue;
      }

      if (c === "}") {
        if (delimiterStack[delimiterStack.length - 1] !== "{") {
          return { ok: false, segments: [], reason: "unmatched-delimiter" };
        }
        delimiterStack.pop();
        flush();
        i += 1;
        continue;
      }

      const operator = matchOperator(command, i, syntax.operators);
      if (operator !== null) {
        flush();
        i += operator.length;
        continue;
      }

      buffer += c;
      i += 1;
    }

    if (escapePending) {
      return { ok: false, segments: [], reason: "unterminated-escape" };
    }
    if (quote !== "normal") {
      return { ok: false, segments: [], reason: "unbalanced-quote" };
    }
    if (delimiterStack.length > 0) {
      return { ok: false, segments: [], reason: "unmatched-delimiter" };
    }

    flush();
    return { ok: true, segments };
  }
}

/**
 * Return the control operator that begins at `index`, or `null` if none matches.
 * Operators are tested longest-first so multi-character operators (`&&`, `||`)
 * win over their single-character prefixes (`&`, `|`).
 */
function matchOperator(
  command: string,
  index: number,
  operators: readonly string[],
): string | null {
  for (const operator of operators) {
    if (command.startsWith(operator, index)) {
      return operator;
    }
  }
  return null;
}
