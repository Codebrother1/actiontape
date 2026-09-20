import {
  createActionEnvelope,
  isJsonObject,
  type ActionEnvelope,
  type JsonObject,
  type JsonValue,
} from "@actiontape/core";
import type { NormalizationDiagnostic } from "./diagnostics.js";
import type { TapeEntry } from "./tape-reader.js";
import type { McpWireRecord } from "./wire-record.js";

export type McpResponseKind =
  | "success"
  | "jsonrpc_error"
  | "tool_error"
  | "input_required"
  | "unknown_result_type"
  | "incomplete";

export interface McpActionMetadata {
  requestId: string | number;
  requestSequence: number;
  responseSequence?: number;
  responseKind: McpResponseKind;
  resultType?: string;
  observedResult?: JsonValue;
  invalidArguments?: JsonValue;
  requestParams?: JsonObject;
}

export interface NormalizationResult {
  actions: ActionEnvelope[];
  diagnostics: NormalizationDiagnostic[];
}

function requestIdKey(id: string | number): string {
  return `${typeof id}:${id}`;
}

function isRequestId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isInteger(value));
}

function toolErrorMessage(result: JsonObject): string {
  const content = result.content;
  if (Array.isArray(content)) {
    for (const item of content) {
      if (isJsonObject(item) && item.type === "text" && typeof item.text === "string") {
        return item.text;
      }
    }
  }
  return "tool execution error";
}

interface PendingCall {
  envelope: ActionEnvelope;
  mcp: JsonObject;
  sequence: number;
  line: number;
}

function classifyAndApply(
  pending: PendingCall,
  msg: JsonObject,
  response: McpWireRecord,
  diagnose: (d: NormalizationDiagnostic) => void,
  line: number,
): void {
  const { envelope, mcp } = pending;
  mcp.responseSequence = response.sequence;

  const errorValue = msg.error;
  if (errorValue !== undefined) {
    mcp.responseKind = "jsonrpc_error";
    if (isJsonObject(errorValue)) {
      const code = errorValue.code;
      const message = errorValue.message;
      envelope.error = {
        code:
          typeof code === "string" || typeof code === "number"
            ? String(code)
            : "mcp.protocol_error",
        message: typeof message === "string" ? message : "MCP protocol error",
        data: errorValue,
      };
    } else {
      envelope.error = {
        code: "mcp.protocol_error",
        message: "MCP protocol error",
        data: errorValue,
      };
    }
    return;
  }

  const result = msg.result;
  if (!isJsonObject(result)) {
    mcp.responseKind = "success";
    envelope.result = result === undefined ? null : result;
    return;
  }

  const resultType = result.resultType;
  if (resultType === undefined || resultType === "complete") {
    if (result.isError === true) {
      mcp.responseKind = "tool_error";
      if (resultType !== undefined) mcp.resultType = resultType;
      envelope.error = {
        code: "mcp.tool_execution_error",
        message: toolErrorMessage(result),
        data: result,
      };
    } else {
      mcp.responseKind = "success";
      if (resultType !== undefined) mcp.resultType = resultType;
      envelope.result = result;
    }
    return;
  }
  if (resultType === "input_required") {
    mcp.responseKind = "input_required";
    mcp.resultType = resultType;
    mcp.observedResult = result;
    return;
  }
  mcp.responseKind = "unknown_result_type";
  mcp.resultType = typeof resultType === "string" ? resultType : JSON.stringify(resultType);
  mcp.observedResult = result;
  diagnose({
    code: "unknown_result_type",
    message: `line ${line}: tools/call result has unknown resultType ${JSON.stringify(resultType)}`,
    line,
    sequence: response.sequence,
  });
}

// MCP 2026-07-28 multi-round-trip calls are normalized as one ActionEnvelope
// per actual tools/call wire request. Logical MRTR grouping is deferred
// because safe correlation across rounds cannot always be inferred.
export function normalizeMcpTape(entries: Iterable<TapeEntry>): NormalizationResult {
  const actions: ActionEnvelope[] = [];
  const diagnostics: NormalizationDiagnostic[] = [];
  const pending = new Map<string, PendingCall>();
  const ignoredRequests = new Map<string, { sequence: number; line: number }>();

  const diagnose = (d: NormalizationDiagnostic): void => {
    diagnostics.push(d);
  };

  const startAction = (
    record: McpWireRecord,
    line: number,
    name: string,
    args: JsonObject,
    extras: {
      requestId: string | number;
      paramsExtra?: JsonObject;
      invalidArguments?: JsonValue;
      responseKind?: McpResponseKind;
    },
  ): PendingCall => {
    const mcp: JsonObject = {
      requestId: extras.requestId,
      requestSequence: record.sequence,
      responseKind: extras.responseKind ?? "incomplete",
    };
    if (extras.paramsExtra && Object.keys(extras.paramsExtra).length > 0) {
      mcp.requestParams = extras.paramsExtra;
    }
    if (extras.invalidArguments !== undefined) mcp.invalidArguments = extras.invalidArguments;
    const envelope = createActionEnvelope({
      id: `mcp:${record.recordingId}:${record.sequence}`,
      timestamp: record.timestamp,
      protocol: "mcp",
      direction: "outbound",
      recordingId: record.recordingId,
      operation: "tools/call",
      target: name,
      arguments: args,
      metadata: { mcp },
    });
    actions.push(envelope);
    return { envelope, mcp, sequence: record.sequence, line };
  };

  for (const entry of entries) {
    if (entry.diagnostic) {
      diagnose(entry.diagnostic);
      continue;
    }
    const record = entry.record;
    if (!record || record.parse.status !== "ok" || !isJsonObject(record.parse.value)) {
      continue;
    }
    const msg = record.parse.value;

    if (record.direction === "client_to_server") {
      if (msg.method !== "tools/call") {
        // Non-tool JSON-RPC requests (initialize, tools/list, ...) are tracked
        // only so their responses are not misdiagnosed as orphans.
        if (
          msg.jsonrpc === "2.0" &&
          isRequestId(msg.id) &&
          !ignoredRequests.has(requestIdKey(msg.id))
        ) {
          ignoredRequests.set(requestIdKey(msg.id), {
            sequence: record.sequence,
            line: entry.line,
          });
        }
        continue;
      }
      const params = msg.params;
      if (msg.jsonrpc !== "2.0" || !isRequestId(msg.id) || !isJsonObject(params)) {
        diagnose({
          code: "invalid_tools_call_request",
          message: `line ${entry.line}: tools/call is not a well-formed JSON-RPC 2.0 request`,
          line: entry.line,
          sequence: record.sequence,
        });
        continue;
      }
      if (typeof params.name !== "string") {
        diagnose({
          code: "invalid_tools_call_request",
          message: `line ${entry.line}: tools/call params.name is not a string`,
          line: entry.line,
          sequence: record.sequence,
        });
        continue;
      }

      let args: JsonObject = {};
      let invalidArguments: JsonValue | undefined;
      if (params.arguments === undefined) {
        args = {};
      } else if (isJsonObject(params.arguments)) {
        args = params.arguments;
      } else {
        invalidArguments = params.arguments;
        diagnose({
          code: "invalid_tools_call_request",
          message: `line ${entry.line}: tools/call params.arguments is not a JSON object`,
          line: entry.line,
          sequence: record.sequence,
        });
      }

      const paramsExtra: JsonObject = {};
      for (const [key, value] of Object.entries(params)) {
        if (key !== "name" && key !== "arguments") paramsExtra[key] = value;
      }

      const key = requestIdKey(msg.id);
      if (pending.has(key)) {
        const first = pending.get(key)!;
        diagnose({
          code: "duplicate_request_id",
          message:
            `line ${entry.line}: tools/call reuses JSON-RPC id ${JSON.stringify(msg.id)} ` +
            `while the request at sequence ${first.sequence} is still outstanding`,
          line: entry.line,
          sequence: record.sequence,
        });
        startAction(record, entry.line, params.name, args, {
          requestId: msg.id,
          paramsExtra,
          invalidArguments,
        });
        continue;
      }
      pending.set(
        key,
        startAction(record, entry.line, params.name, args, {
          requestId: msg.id,
          paramsExtra,
          invalidArguments,
        }),
      );
      continue;
    }

    const isResponse =
      msg.method === undefined && (msg.result !== undefined || msg.error !== undefined);
    if (!isResponse) continue;
    if (!isRequestId(msg.id)) {
      diagnose({
        code: "unmatched_response",
        message: `line ${entry.line}: response has no usable JSON-RPC id`,
        line: entry.line,
        sequence: record.sequence,
      });
      continue;
    }
    const key = requestIdKey(msg.id);
    const match = pending.get(key);
    if (!match && ignoredRequests.delete(key)) {
      continue;
    }
    if (!match) {
      diagnose({
        code: "unmatched_response",
        message: `line ${entry.line}: response id ${JSON.stringify(msg.id)} has no pending tools/call request`,
        line: entry.line,
        sequence: record.sequence,
      });
      continue;
    }
    pending.delete(key);
    classifyAndApply(match, msg, record, diagnose, entry.line);
  }

  for (const orphan of pending.values()) {
    diagnose({
      code: "incomplete_call",
      message: `tools/call at sequence ${orphan.sequence} (line ${orphan.line}) had no matching response at end of tape`,
      line: orphan.line,
      sequence: orphan.sequence,
    });
  }

  return { actions, diagnostics };
}
