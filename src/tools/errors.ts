// Feature: agent-tools-and-settings — typed tool-execution errors.
//
// Coding_Tools signal failures by throwing a `ToolExecutionError` carrying a typed
// `ToolError` (the taxonomy declared in `./types`). The `ToolHost` (implemented in a
// later task) catches these and maps the carried `ToolError` straight into the
// `tool.result` frame it returns to the engine, keeping the WebSocket connection open
// (Requirement 3.3–3.7). Tools that throw an ordinary `Error` are wrapped by the host
// as a generic `execution` error.
//
// Because a `CodingTool.execute` returns `Promise<ToolOutput>` (success only), a
// thrown `ToolExecutionError` is the single, uniform channel for typed failures such
// as `out-of-scope`, `no-workspace`, `validation`, and `execution`.

import type { ToolError } from "./types";

/**
 * An error carrying a typed {@link ToolError}. Thrown by Coding_Tools and mapped by
 * the `ToolHost` into the returned `tool.result` frame.
 */
export class ToolExecutionError extends Error {
  /** The typed error payload returned to the engine. */
  public readonly toolError: ToolError;

  public constructor(toolError: ToolError) {
    super(toolError.message);
    this.name = "ToolExecutionError";
    this.toolError = toolError;
    // Restore the prototype chain for correct `instanceof` under transpilation to ES5.
    Object.setPrototypeOf(this, ToolExecutionError.prototype);
  }
}

/** Type guard: `value` is a {@link ToolExecutionError}. */
export function isToolExecutionError(value: unknown): value is ToolExecutionError {
  return value instanceof ToolExecutionError;
}
