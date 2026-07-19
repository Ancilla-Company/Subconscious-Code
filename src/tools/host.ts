// Feature: agent-tools-and-settings — the tool-callback dispatch layer (ToolHost).
//
// The ToolHost is the extension side of the Tool_Callback_RPC. It receives `tool.call`
// frames from the engine, validates and dispatches them to the matching Coding_Tool,
// and returns a `tool.result` frame that echoes the originating correlation id. It also
// builds and sends the `tool.register` frame advertising the currently enabled tool set.
//
// Responsibilities (per the task and Requirements 1.5, 1.6, 2.1–2.3, 2.5, 3.1–3.9,
// 6.7, 6.8):
//
//  - Validate that an incoming `tool.call` frame carries both a tool identifier and a
//    correlation identifier; a frame missing either yields a `malformed-request` error
//    and the connection is kept open (R3.3).
//  - Look up the target tool in the ToolRegistry; an unknown identifier yields an
//    `unknown-tool` error (R1.6, R3.4).
//  - Reject a tool that is present but disabled with a `tool-disabled` error (R3.5).
//  - Validate the untrusted input against the tool's JSON input schema before execution;
//    a violation yields a `validation` error naming the offending field, and the tool's
//    `execute` is never invoked (R1.5, R6.7, R6.8).
//  - Dispatch the call to the tool under an `AbortController` timeout (default 120s,
//    clamped to the 5–600s range); exceeding the deadline aborts the tool and yields a
//    `timeout` error (R3.7).
//  - Wrap any error raised by the tool: a thrown `ToolExecutionError` carries a typed
//    `ToolError` used directly; any other throw becomes a generic `execution` error
//    (R3.6).
//  - Echo the correlation id from the originating `tool.call` on every `tool.result`
//    (R3.2, R3.8, R3.9), tracking in-flight calls in a map keyed by that id so
//    concurrent calls never cross wires.
//  - Build the `tool.register` frame from the registry's `enabledDefinitions()`
//    (R2.1–2.3, 2.5); skip the send when the socket is not open and rely on a resend on
//    the next connection (R2.6).
//  - Never tear down the socket on a tool failure — every failure path returns a typed
//    `tool.result` and leaves the connection open (R3.3–R3.7).
//
// The host is decoupled from `vscode` and from the concrete `EngineClient`: it sends
// frames through an injected {@link ToolFrameTransport} and builds each tool's
// {@link ToolContext} through an injected factory, so the dispatch/validation/timeout
// logic can be exercised outside the VS Code host. Wiring to the live `EngineClient`
// is performed by a later task.
//
// _Requirements: 1.5, 1.6, 2.1, 2.2, 2.3, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 6.7, 6.8_

import { isToolExecutionError } from "./errors";
import type { ToolRegistry } from "./registry";
import type {
  CodingTool,
  JSONSchema,
  RegisteredToolDescriptor,
  ToolCallFrame,
  ToolContext,
  ToolDefinition,
  ToolError,
  ToolRegisterFrame,
  ToolResult,
  ToolResultFrame,
} from "./types";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

/** Wire-envelope version stamped on outgoing frames. */
const FRAME_VERSION = 1;

/** Default tool timeout in milliseconds (Requirement 3.7). */
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;

/** Lower bound of the configurable tool timeout, in milliseconds (Requirement 3.7). */
export const MIN_TOOL_TIMEOUT_MS = 5_000;

/** Upper bound of the configurable tool timeout, in milliseconds (Requirement 3.7). */
export const MAX_TOOL_TIMEOUT_MS = 600_000;

/**
 * Clamp a requested tool timeout into the supported range. A non-finite request
 * (NaN/±Infinity) falls back to the default; otherwise the value is floored and bounded
 * to [{@link MIN_TOOL_TIMEOUT_MS}, {@link MAX_TOOL_TIMEOUT_MS}].
 */
export function clampTimeoutMs(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_TOOL_TIMEOUT_MS;
  }
  const floored = Math.floor(requested);
  if (floored < MIN_TOOL_TIMEOUT_MS) {
    return MIN_TOOL_TIMEOUT_MS;
  }
  if (floored > MAX_TOOL_TIMEOUT_MS) {
    return MAX_TOOL_TIMEOUT_MS;
  }
  return floored;
}

// -----------------------------------------------------------------------------
// Injected collaborators
// -----------------------------------------------------------------------------

/**
 * The minimal outbound transport the host writes frames to. The concrete
 * `EngineClient` is adapted onto this surface by the wiring task; tests supply a fake.
 * `send` transmits a frame; `isOpen` reports whether the socket is currently open so a
 * registration attempt can be skipped and retried on the next connection (R2.6).
 */
export interface ToolFrameTransport {
  send(frame: ToolRegisterFrame | ToolResultFrame): void;
  isOpen(): boolean;
}

/**
 * An observable tool-activity event, emitted so a UI (the chat view) can render a
 * tool call as an expandable card. `start` fires as soon as a well-formed call is
 * dispatched; `end` fires with the outcome (success summary or typed error).
 */
export type ToolEvent =
  | { readonly phase: "start"; readonly callId: string; readonly tool: string; readonly input: unknown }
  | {
      readonly phase: "end";
      readonly callId: string;
      readonly tool: string;
      readonly ok: boolean;
      readonly errorKind?: ToolError["kind"];
      readonly summary: string;
      readonly detail: string;
    };

/** Construction options for {@link ToolHost}. */
export interface ToolHostOptions {
  /** The tool catalogue used for lookup, enabled checks, and registration. */
  readonly registry: ToolRegistry;
  /** The Coding_Tool implementations, indexed here by their `id`. */
  readonly tools: readonly CodingTool[];
  /** Outbound frame transport (adapts the EngineClient in production). */
  readonly transport: ToolFrameTransport;
  /** Builds the per-call {@link ToolContext} given the call's abort signal. */
  readonly createContext: (signal: AbortSignal) => ToolContext;
  /**
   * Tool execution timeout in milliseconds. Clamped to the 5–600s range; defaults to
   * {@link DEFAULT_TOOL_TIMEOUT_MS} when omitted.
   */
  readonly timeoutMs?: number;
  /** Optional observer notified of tool-call start/end (for the chat UI cards). */
  readonly onToolEvent?: (event: ToolEvent) => void;
}

/** The longest single-line summary shown in a tool card header. */
const SUMMARY_MAX_CHARS = 200;

/** Reduce output to a short single-line summary for a tool card header. */
function summarize(content: string): string {
  const firstLine = content.split(/\r?\n/, 1)[0] ?? "";
  return firstLine.length > SUMMARY_MAX_CHARS
    ? `${firstLine.slice(0, SUMMARY_MAX_CHARS - 1)}…`
    : firstLine;
}

// -----------------------------------------------------------------------------
// Input-schema validation
// -----------------------------------------------------------------------------

/** The outcome of validating an untrusted input against a tool's JSON schema. */
type ValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly field?: string; readonly message: string };

/**
 * Validate an untrusted `value` against a {@link JSONSchema}, returning the offending
 * field name on failure (Requirement 6.7, 6.8). Covers the schema subset used by the
 * built-in tool definitions: object/array/string/number/integer/boolean/null typing,
 * `required` presence, `properties` recursion, `enum` membership, and
 * `additionalProperties: false`.
 *
 * @param value  The untrusted input to validate.
 * @param schema The tool's declared input schema.
 * @param field  The field name of `value` relative to its parent (empty at the root).
 */
export function validateAgainstSchema(
  value: unknown,
  schema: JSONSchema,
  field = "",
): ValidationResult {
  const named = field.length > 0 ? field : undefined;

  if (schema.enum !== undefined) {
    if (!schema.enum.some((candidate) => candidate === value)) {
      return {
        ok: false,
        field: named,
        message: `Value for '${field || "input"}' is not one of the permitted values.`,
      };
    }
  }

  switch (schema.type) {
    case "object":
      return validateObject(value, schema, field);
    case "array":
      return validateArray(value, schema, field);
    case "string":
      return typeof value === "string"
        ? { ok: true }
        : typeMismatch(field, "string");
    case "number":
      return typeof value === "number" && Number.isFinite(value)
        ? { ok: true }
        : typeMismatch(field, "number");
    case "integer":
      return typeof value === "number" && Number.isInteger(value)
        ? { ok: true }
        : typeMismatch(field, "integer");
    case "boolean":
      return typeof value === "boolean"
        ? { ok: true }
        : typeMismatch(field, "boolean");
    case "null":
      return value === null ? { ok: true } : typeMismatch(field, "null");
    default:
      // No declared type: only enum/required constraints (checked above) apply.
      return { ok: true };
  }
}

/** Validate an object value against an object schema. */
function validateObject(
  value: unknown,
  schema: JSONSchema,
  field: string,
): ValidationResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return typeMismatch(field, "object");
  }
  const record = value as Record<string, unknown>;

  // Required fields must be present (Requirement 1.5, 6.8).
  for (const requiredField of schema.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(record, requiredField)) {
      return {
        ok: false,
        field: requiredField,
        message: `Missing required field '${requiredField}'.`,
      };
    }
  }

  const properties = schema.properties ?? {};

  // Reject unexpected keys when additionalProperties is false.
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(record)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        return {
          ok: false,
          field: key,
          message: `Unexpected field '${key}'.`,
        };
      }
    }
  }

  // Validate each present, described property.
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      const nested = validateAgainstSchema(record[key], propertySchema, key);
      if (!nested.ok) {
        return nested;
      }
    }
  }

  return { ok: true };
}

/** Validate an array value against an array schema. */
function validateArray(
  value: unknown,
  schema: JSONSchema,
  field: string,
): ValidationResult {
  if (!Array.isArray(value)) {
    return typeMismatch(field, "array");
  }
  if (schema.items !== undefined) {
    for (let index = 0; index < value.length; index += 1) {
      const nested = validateAgainstSchema(
        value[index],
        schema.items,
        field.length > 0 ? `${field}[${index}]` : `[${index}]`,
      );
      if (!nested.ok) {
        return nested;
      }
    }
  }
  return { ok: true };
}

/** Build a type-mismatch validation failure naming the offending field. */
function typeMismatch(field: string, expected: string): ValidationResult {
  return {
    ok: false,
    field: field.length > 0 ? field : undefined,
    message: `Field '${field || "input"}' must be of type ${expected}.`,
  };
}

// -----------------------------------------------------------------------------
// ToolHost
// -----------------------------------------------------------------------------

/**
 * Dispatches engine `tool.call` frames to Coding_Tools and returns `tool.result`
 * frames, and builds/sends `tool.register` frames from the enabled tool set. Owns
 * correlation-id echoing and per-call abort/timeout handling.
 */
export class ToolHost {
  private readonly registry: ToolRegistry;
  /** Built-in tool implementations, fixed for the host's lifetime. */
  private readonly builtinToolsById: ReadonlyMap<string, CodingTool>;
  /** Dynamic (MCP-provided) tool implementations, replaced wholesale on refresh. */
  private dynamicToolsById: ReadonlyMap<string, CodingTool> = new Map();
  private readonly transport: ToolFrameTransport;
  private readonly createContext: (signal: AbortSignal) => ToolContext;
  private readonly timeoutMs: number;
  private readonly onToolEvent?: (event: ToolEvent) => void;

  /** In-flight calls keyed by correlation id, each with its abort controller (R3.8). */
  private readonly inflightControllers = new Map<string, AbortController>();

  public constructor(options: ToolHostOptions) {
    this.registry = options.registry;
    this.builtinToolsById = new Map(options.tools.map((tool) => [tool.id, tool]));
    this.transport = options.transport;
    this.createContext = options.createContext;
    this.timeoutMs = clampTimeoutMs(options.timeoutMs);
    this.onToolEvent = options.onToolEvent;
  }

  /**
   * Replace the set of dynamic (MCP-provided) tool implementations. Paired with
   * `ToolRegistry.updateDynamicTools`, which advertises the matching definitions; the
   * registry's `onDidChange` then re-registers the enabled set with the engine.
   */
  public setDynamicTools(tools: readonly CodingTool[]): void {
    this.dynamicToolsById = new Map(tools.map((tool) => [tool.id, tool]));
  }

  /** Resolve a tool implementation by id: built-in first, then dynamic (MCP). */
  private toolFor(id: string): CodingTool | undefined {
    return this.builtinToolsById.get(id) ?? this.dynamicToolsById.get(id);
  }

  /** The currently in-flight calls, keyed by correlation id (read-only view). */
  public get inflight(): ReadonlyMap<string, AbortController> {
    return this.inflightControllers;
  }

  /**
   * Build the `tool.register` frame from the registry's currently enabled definitions
   * (Requirement 2.1–2.3, 2.5). The tool list is empty when no tool is enabled.
   */
  public buildRegistrationFrame(): ToolRegisterFrame {
    const tools: RegisteredToolDescriptor[] = this.registry
      .enabledDefinitions()
      .map((def) => ({
        id: def.id,
        description: def.description,
        inputSchema: def.inputSchema,
      }));
    return { v: FRAME_VERSION, type: "tool.register", data: { tools } };
  }

  /**
   * Build and send the `tool.register` frame advertising the enabled tool set
   * (Requirement 2.1, 2.2, 2.4). When the socket is not open the send is skipped; the
   * registry retains the enabled set and the wiring layer resends on the next
   * connection (Requirement 2.6).
   */
  public sendRegistration(): void {
    if (!this.transport.isOpen()) {
      return;
    }
    this.transport.send(this.buildRegistrationFrame());
  }

  /**
   * Handle an inbound `tool.call` frame: validate, dispatch, and send a `tool.result`
   * frame echoing the correlation id. Never throws and never tears down the socket; every
   * outcome — success or typed failure — is returned as a `tool.result` (R3.2–R3.9).
   */
  public async handleCall(frame: ToolCallFrame): Promise<void> {
    const correlationId = typeof frame?.id === "string" ? frame.id : "";
    const toolId =
      frame?.data !== undefined && typeof frame.data.tool === "string"
        ? frame.data.tool
        : undefined;

    // R3.3: a frame missing a correlation id and/or a tool id is malformed.
    if (correlationId.length === 0 || toolId === undefined || toolId.length === 0) {
      this.sendResult(correlationId, {
        ok: false,
        error: {
          kind: "malformed-request",
          message:
            "tool.call frame must include a non-empty correlation id and tool identifier.",
        },
      });
      return;
    }

    this.onToolEvent?.({
      phase: "start",
      callId: correlationId,
      tool: toolId,
      input: frame.data.input,
    });

    const result = await this.resolveResult(correlationId, toolId, frame.data.input);
    this.emitEnd(correlationId, toolId, result);
    this.sendResult(correlationId, result);
  }

  /** Emit the terminal tool-activity event for a completed call (success or error). */
  private emitEnd(callId: string, tool: string, result: ToolResult): void {
    if (this.onToolEvent === undefined) {
      return;
    }
    if (result.ok) {
      const content = result.output.content ?? "";
      this.onToolEvent({
        phase: "end",
        callId,
        tool,
        ok: true,
        summary: summarize(content) || "Done",
        detail: content,
      });
    } else {
      this.onToolEvent({
        phase: "end",
        callId,
        tool,
        ok: false,
        errorKind: result.error.kind,
        summary: result.error.message,
        detail: result.error.message,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  /**
   * Resolve the {@link ToolResult} for a well-formed call: look up + enabled check +
   * input validation, then dispatch under a timeout. Pure of transport concerns.
   */
  private async resolveResult(
    correlationId: string,
    toolId: string,
    input: unknown,
  ): Promise<ToolResult> {
    const definition = this.registry.get(toolId);

    // R1.6, R3.4: unknown identifier.
    if (definition === undefined) {
      return {
        ok: false,
        error: {
          kind: "unknown-tool",
          message: `No tool is registered with id '${toolId}'.`,
        },
      };
    }

    // R3.5: present but disabled.
    if (!this.registry.isEnabled(toolId)) {
      return {
        ok: false,
        error: {
          kind: "tool-disabled",
          message: `Tool '${toolId}' is currently disabled.`,
        },
      };
    }

    // R1.5, R6.7, R6.8: validate untrusted input against the schema before execution.
    const validation = validateAgainstSchema(input, definition.inputSchema);
    if (!validation.ok) {
      return {
        ok: false,
        error: {
          kind: "validation",
          message: validation.message,
          ...(validation.field !== undefined ? { field: validation.field } : {}),
        },
      };
    }

    const tool = this.toolFor(toolId);
    if (tool === undefined) {
      // The registry advertises this tool but no implementation is wired: surface a
      // typed execution error rather than crashing the dispatch loop.
      return {
        ok: false,
        error: {
          kind: "execution",
          message: `Tool '${toolId}' has no registered implementation.`,
        },
      };
    }

    return this.dispatchWithTimeout(correlationId, definition, tool, input);
  }

  /**
   * Dispatch a validated call to its tool under an {@link AbortController} timeout
   * (Requirement 3.7). Tracks the controller in {@link inflightControllers} keyed by the
   * correlation id for the duration of the call, and maps any thrown error to a typed
   * {@link ToolError} (Requirement 3.6).
   */
  private async dispatchWithTimeout(
    correlationId: string,
    definition: ToolDefinition,
    tool: CodingTool,
    input: unknown,
  ): Promise<ToolResult> {
    const controller = new AbortController();
    this.inflightControllers.set(correlationId, controller);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutResult = new Promise<ToolResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({
          ok: false,
          error: {
            kind: "timeout",
            message: `Tool '${definition.id}' did not complete within ${this.timeoutMs} ms.`,
          },
        });
      }, this.timeoutMs);
      if (typeof timer.unref === "function") {
        timer.unref();
      }
    });

    const execution = this.executeTool(tool, input, controller.signal);

    try {
      return await Promise.race([execution, timeoutResult]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      this.inflightControllers.delete(correlationId);
    }
  }

  /**
   * Invoke a tool's `execute`, mapping success to an `ok` result and any throw to a
   * typed error: a {@link ToolExecutionError} carries its `ToolError` unchanged, while
   * any other throw becomes a generic `execution` error (Requirement 3.6).
   */
  private async executeTool(
    tool: CodingTool,
    input: unknown,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    try {
      const output = await tool.execute(input, this.createContext(signal));
      return { ok: true, output };
    } catch (cause) {
      return { ok: false, error: toToolError(cause) };
    }
  }

  /** Send a `tool.result` frame echoing the originating correlation id (R3.2, R3.9). */
  private sendResult(correlationId: string, result: ToolResult): void {
    const frame: ToolResultFrame = {
      v: FRAME_VERSION,
      type: "tool.result",
      id: correlationId,
      data: result,
    };
    this.transport.send(frame);
  }
}

/** Map an unknown thrown value into a typed {@link ToolError} (Requirement 3.6). */
function toToolError(cause: unknown): ToolError {
  if (isToolExecutionError(cause)) {
    return cause.toolError;
  }
  const message = cause instanceof Error ? cause.message : String(cause);
  return { kind: "execution", message };
}
