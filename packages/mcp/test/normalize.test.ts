import { describe, expect, it } from "vitest";
import {
  isJsonObject,
  type ActionEnvelope,
  type JsonObject,
  type JsonValue,
} from "@actiontape/core";
import {
  createWireRecord,
  getMcpToolCallRequestParams,
  McpRequestParamsError,
  normalizeMcpTape,
  type McpWireDirection,
  type TapeEntry,
} from "../src/index.js";

const RID = "rec-test";

function wire(direction: McpWireDirection, payload: unknown, sequence: number): TapeEntry {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    line: sequence + 1,
    raw,
    record: createWireRecord({ recordingId: RID, sequence, direction, raw }),
  };
}

function callRequest(
  sequence: number,
  id: string | number,
  params: JsonObject = { name: "get_weather", arguments: { location: "New York" } },
): TapeEntry {
  return wire("client_to_server", { jsonrpc: "2.0", id, method: "tools/call", params }, sequence);
}

function resultResponse(sequence: number, id: string | number, result: JsonValue): TapeEntry {
  return wire("server_to_client", { jsonrpc: "2.0", id, result }, sequence);
}

function errorResponse(sequence: number, id: string | number, error: JsonObject): TapeEntry {
  return wire("server_to_client", { jsonrpc: "2.0", id, error }, sequence);
}

function mcpMeta(action: ActionEnvelope): JsonObject {
  const m = action.metadata?.mcp;
  if (!isJsonObject(m)) throw new Error("action is missing metadata.mcp");
  return m;
}

const COMPLETE_RESULT: JsonObject = {
  resultType: "complete",
  content: [{ type: "text", text: "72 F" }],
  isError: false,
};

describe("normalizeMcpTape", () => {
  it("normalizes a simple successful tools/call", () => {
    const { actions, diagnostics } = normalizeMcpTape([
      callRequest(0, "call-1"),
      resultResponse(1, "call-1", COMPLETE_RESULT),
    ]);
    expect(diagnostics).toEqual([]);
    expect(actions).toHaveLength(1);
    const a = actions[0]!;
    expect(a.protocol).toBe("mcp");
    expect(a.operation).toBe("tools/call");
    expect(a.target).toBe("get_weather");
    expect(a.arguments).toEqual({ location: "New York" });
    expect(a.recordingId).toBe(RID);
    expect(a.result).toEqual(COMPLETE_RESULT);
    expect(a.error).toBeUndefined();
    const m = mcpMeta(a);
    expect(m.responseKind).toBe("success");
    expect(m.resultType).toBe("complete");
    expect(m.requestSequence).toBe(0);
    expect(m.responseSequence).toBe(1);
    expect(m.requestId).toBe("call-1");
  });

  it("handles numeric JSON-RPC ids", () => {
    const { actions } = normalizeMcpTape([
      callRequest(0, 2),
      resultResponse(1, 2, COMPLETE_RESULT),
    ]);
    expect(mcpMeta(actions[0]!).responseKind).toBe("success");
    expect(mcpMeta(actions[0]!).requestId).toBe(2);
  });

  it('does not conflate numeric id 1 with string id "1"', () => {
    const { actions, diagnostics } = normalizeMcpTape([
      callRequest(0, 1, { name: "tool_a" }),
      callRequest(1, "1", { name: "tool_b" }),
      resultResponse(2, "1", { result: "for-string" }),
      resultResponse(3, 1, { result: "for-number" }),
    ]);
    expect(diagnostics).toEqual([]);
    expect(actions[0]!.target).toBe("tool_a");
    expect(actions[1]!.target).toBe("tool_b");
    expect(actions[0]!.result).toEqual({ result: "for-number" });
    expect(actions[1]!.result).toEqual({ result: "for-string" });
  });

  it("correlates out-of-order responses across concurrent requests", () => {
    const { actions, diagnostics } = normalizeMcpTape([
      callRequest(0, "a", { name: "first_tool" }),
      callRequest(1, "b", { name: "second_tool" }),
      resultResponse(2, "b", { ok: "b" }),
      resultResponse(3, "a", { ok: "a" }),
    ]);
    expect(diagnostics).toEqual([]);
    expect(actions[0]!.result).toEqual({ ok: "a" });
    expect(actions[1]!.result).toEqual({ ok: "b" });
  });

  it("allows legal reuse of an id after its earlier request completed", () => {
    const { actions, diagnostics } = normalizeMcpTape([
      callRequest(0, 7, { name: "first" }),
      resultResponse(1, 7, { r: 1 }),
      callRequest(2, 7, { name: "second" }),
      resultResponse(3, 7, { r: 2 }),
    ]);
    expect(diagnostics).toEqual([]);
    expect(actions).toHaveLength(2);
    expect(actions[0]!.result).toEqual({ r: 1 });
    expect(actions[1]!.result).toEqual({ r: 2 });
    expect(mcpMeta(actions[1]!).responseKind).toBe("success");
  });

  it("diagnoses a duplicate outstanding id without corrupting the first request", () => {
    const { actions, diagnostics } = normalizeMcpTape([
      callRequest(0, 5, { name: "first" }),
      callRequest(1, 5, { name: "second" }),
      resultResponse(2, 5, { r: 1 }),
    ]);
    expect(diagnostics.map((d) => d.code)).toEqual(["duplicate_request_id"]);
    expect(actions).toHaveLength(2);
    expect(actions[0]!.result).toEqual({ r: 1 });
    expect(mcpMeta(actions[0]!).responseKind).toBe("success");
    expect(actions[1]!.result).toBeUndefined();
    expect(mcpMeta(actions[1]!).responseKind).toBe("incomplete");
  });

  it("maps a JSON-RPC error response to ActionEnvelope.error", () => {
    const { actions } = normalizeMcpTape([
      callRequest(0, 3),
      errorResponse(1, 3, { code: -32602, message: "Unknown tool", data: { name: "nope" } }),
    ]);
    const a = actions[0]!;
    expect(a.error?.code).toBe("-32602");
    expect(a.error?.message).toBe("Unknown tool");
    expect(a.error?.data).toEqual({
      code: -32602,
      message: "Unknown tool",
      data: { name: "nope" },
    });
    expect(a.result).toBeUndefined();
    expect(mcpMeta(a).responseKind).toBe("jsonrpc_error");
  });

  it("maps result.isError === true to a tool execution error, not a protocol error", () => {
    const result: JsonObject = {
      resultType: "complete",
      isError: true,
      content: [{ type: "text", text: "disk full" }],
    };
    const { actions } = normalizeMcpTape([callRequest(0, "x"), resultResponse(1, "x", result)]);
    const a = actions[0]!;
    expect(a.error?.code).toBe("mcp.tool_execution_error");
    expect(a.error?.message).toBe("disk full");
    expect(a.error?.data).toEqual(result);
    expect(a.result).toBeUndefined();
    expect(mcpMeta(a).responseKind).toBe("tool_error");
  });

  it("treats a legacy result without resultType as complete", () => {
    const legacy = { content: [{ type: "text", text: "ok" }] };
    const { actions, diagnostics } = normalizeMcpTape([
      callRequest(0, 1),
      resultResponse(1, 1, legacy),
    ]);
    expect(diagnostics).toEqual([]);
    expect(actions[0]!.result).toEqual(legacy);
    expect(mcpMeta(actions[0]!).responseKind).toBe("success");
  });

  it("marks resultType input_required without classifying it as success", () => {
    const result = { resultType: "input_required", inputRequests: [{ name: "confirm" }] };
    const { actions, diagnostics } = normalizeMcpTape([
      callRequest(0, "c1"),
      resultResponse(1, "c1", result),
    ]);
    expect(diagnostics).toEqual([]);
    const a = actions[0]!;
    expect(a.result).toBeUndefined();
    expect(a.error).toBeUndefined();
    expect(mcpMeta(a).responseKind).toBe("input_required");
    expect(mcpMeta(a).observedResult).toEqual(result);
  });

  it("diagnoses an unknown resultType without calling it success", () => {
    const result = { resultType: "streaming", partial: true };
    const { actions, diagnostics } = normalizeMcpTape([
      callRequest(0, 1),
      resultResponse(1, 1, result),
    ]);
    expect(diagnostics.map((d) => d.code)).toEqual(["unknown_result_type"]);
    const a = actions[0]!;
    expect(a.result).toBeUndefined();
    expect(mcpMeta(a).responseKind).toBe("unknown_result_type");
    expect(mcpMeta(a).observedResult).toEqual(result);
  });

  it("reports an outstanding request at EOF as incomplete", () => {
    const { actions, diagnostics } = normalizeMcpTape([callRequest(0, "lonely")]);
    expect(diagnostics.map((d) => d.code)).toEqual(["incomplete_call"]);
    const a = actions[0]!;
    expect(a.result).toBeUndefined();
    expect(a.error).toBeUndefined();
    expect(mcpMeta(a).responseKind).toBe("incomplete");
    expect(mcpMeta(a).responseSequence).toBeUndefined();
  });

  it("diagnoses a response with no pending request", () => {
    const { actions, diagnostics } = normalizeMcpTape([
      resultResponse(0, 99, { ok: true }),
      callRequest(1, "a"),
      resultResponse(2, "a", { ok: "a" }),
    ]);
    expect(diagnostics.map((d) => d.code)).toEqual(["unmatched_response"]);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.result).toEqual({ ok: "a" });
  });

  it("defaults absent params.arguments to an empty object", () => {
    const { actions, diagnostics } = normalizeMcpTape([
      callRequest(0, 1, { name: "list_things" }),
      resultResponse(1, 1, COMPLETE_RESULT),
    ]);
    expect(diagnostics).toEqual([]);
    expect(actions[0]!.arguments).toEqual({});
  });

  it("diagnoses non-object params.arguments without pretending the call was valid", () => {
    const { actions, diagnostics } = normalizeMcpTape([
      callRequest(0, 1, { name: "bad_args", arguments: "not-an-object" }),
      resultResponse(1, 1, COMPLETE_RESULT),
    ]);
    expect(diagnostics.map((d) => d.code)).toEqual(["invalid_tools_call_request"]);
    const a = actions[0]!;
    expect(a.arguments).toEqual({});
    expect(mcpMeta(a).invalidArguments).toBe("not-an-object");
    expect(mcpMeta(a).responseKind).toBe("success");
  });

  it("rejects malformed tools/call requests", () => {
    const { actions, diagnostics } = normalizeMcpTape([
      wire("client_to_server", { jsonrpc: "2.0", method: "tools/call", params: { name: "x" } }, 0),
      wire(
        "client_to_server",
        { jsonrpc: "2.0", id: 1.5, method: "tools/call", params: { name: "x" } },
        1,
      ),
      wire("client_to_server", { jsonrpc: "2.0", id: 1, method: "tools/call" }, 2),
      wire(
        "client_to_server",
        { jsonrpc: "1.0", id: 1, method: "tools/call", params: { name: "x" } },
        3,
      ),
    ]);
    expect(actions).toHaveLength(0);
    expect(diagnostics).toHaveLength(4);
    expect(diagnostics.every((d) => d.code === "invalid_tools_call_request")).toBe(true);
  });

  it("ignores non-tools/call traffic and parse failures", () => {
    const { actions, diagnostics } = normalizeMcpTape([
      wire("client_to_server", { jsonrpc: "2.0", id: 1, method: "initialize" }, 0),
      wire("server_to_client", { jsonrpc: "2.0", method: "notifications/progress" }, 1),
      wire("client_to_server", "not json at all", 2),
      wire("server_to_client", "also not json", 3),
    ]);
    expect(actions).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it("produces deterministic action ids across repeated normalization", () => {
    const tape = [callRequest(0, "call-1"), resultResponse(1, "call-1", COMPLETE_RESULT)];
    const first = normalizeMcpTape(tape).actions.map((a) => a.id);
    const second = normalizeMcpTape(tape).actions.map((a) => a.id);
    expect(first).toEqual(second);
    expect(first[0]).toBe(`mcp:${RID}:0`);
  });

  it("preserves current-style tools/call params under metadata.mcp.requestParams", () => {
    const params: JsonObject = {
      name: "get_weather",
      arguments: { location: "NYC" },
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "actiontape-test", version: "0.0.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
      requestState: { attempt: 1 },
      inputResponses: [],
    };
    const { actions } = normalizeMcpTape([
      callRequest(0, "call-1", params),
      resultResponse(1, "call-1", COMPLETE_RESULT),
    ]);
    expect(mcpMeta(actions[0]!).requestParams).toEqual(params);
  });

  it("normalizes a legacy tools/call without modern _meta", () => {
    const { actions, diagnostics } = normalizeMcpTape([
      callRequest(0, 1, { name: "read_file", arguments: { path: "/a" } }),
      resultResponse(1, 1, { content: [{ type: "text", text: "data" }] }),
    ]);
    expect(diagnostics).toEqual([]);
    expect(actions[0]!.target).toBe("read_file");
    expect(mcpMeta(actions[0]!).responseKind).toBe("success");
  });
});

describe("ignored non-tools/call requests", () => {
  const initRequest = (seq: number, id: string | number) =>
    wire("client_to_server", { jsonrpc: "2.0", id, method: "initialize", params: {} }, seq);

  it("produces no actions and no diagnostics for initialize request/response", () => {
    const { actions, diagnostics } = normalizeMcpTape([
      initRequest(0, 1),
      resultResponse(1, 1, { protocolVersion: "2026-07-28" }),
    ]);
    expect(actions).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it("produces no actions and no diagnostics for modern server/discover", () => {
    const { actions, diagnostics } = normalizeMcpTape([
      wire(
        "client_to_server",
        {
          jsonrpc: "2.0",
          id: "discover-1",
          method: "server/discover",
          params: {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        },
        0,
      ),
      resultResponse(1, "discover-1", { protocolVersion: "2026-07-28", serverInfo: {} }),
    ]);
    expect(actions).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it("produces no actions and no diagnostics for tools/list", () => {
    const { actions, diagnostics } = normalizeMcpTape([
      wire("client_to_server", { jsonrpc: "2.0", id: "l1", method: "tools/list" }, 0),
      resultResponse(1, "l1", { tools: [] }),
    ]);
    expect(actions).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it("ignores initialize but still normalizes a following tools/call", () => {
    const { actions, diagnostics } = normalizeMcpTape([
      initRequest(0, 0),
      resultResponse(1, 0, { protocolVersion: "2026-07-28" }),
      callRequest(2, "call-1"),
      resultResponse(3, "call-1", COMPLETE_RESULT),
    ]);
    expect(diagnostics).toEqual([]);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.target).toBe("get_weather");
    expect(mcpMeta(actions[0]!).responseKind).toBe("success");
  });

  it("still diagnoses a genuinely orphaned response", () => {
    const { diagnostics } = normalizeMcpTape([
      initRequest(0, 1),
      resultResponse(1, 1, { ok: true }),
      resultResponse(2, 42, { ok: true }),
    ]);
    expect(diagnostics.map((d) => d.code)).toEqual(["unmatched_response"]);
    expect(diagnostics[0]!.line).toBe(3);
  });

  it("keeps ignored request ids type-sensitive", () => {
    const { diagnostics } = normalizeMcpTape([
      initRequest(0, 1),
      resultResponse(1, "1", { ok: true }),
    ]);
    expect(diagnostics.map((d) => d.code)).toEqual(["unmatched_response"]);
  });

  it("allows id reuse after an ignored request completes", () => {
    const { actions, diagnostics } = normalizeMcpTape([
      initRequest(0, 9),
      resultResponse(1, 9, { ok: true }),
      callRequest(2, 9, { name: "reused" }),
      resultResponse(3, 9, { ok: "call" }),
    ]);
    expect(diagnostics).toEqual([]);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.result).toEqual({ ok: "call" });
  });
});

describe("MCP 2026-07-28 multi-round-trip calls", () => {
  const modernMeta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "actiontape-test", version: "0.0.0" },
    "io.modelcontextprotocol/clientCapabilities": {},
  };

  it("represents each wire round as an independent ActionEnvelope", () => {
    const requestState = { nonce: "rs-abc-123" };
    const { actions, diagnostics } = normalizeMcpTape([
      wire(
        "client_to_server",
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "deploy",
            arguments: { env: "prod" },
            _meta: modernMeta,
          },
        },
        0,
      ),
      resultResponse(1, 2, {
        resultType: "input_required",
        inputRequests: [{ name: "confirm_deployment" }],
        requestState,
      }),
      wire(
        "client_to_server",
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "deploy",
            arguments: { env: "prod" },
            inputResponses: [{ name: "confirm_deployment", value: "yes" }],
            requestState,
            _meta: modernMeta,
          },
        },
        2,
      ),
      resultResponse(3, 3, { resultType: "complete", content: [{ type: "text", text: "done" }] }),
    ]);

    expect(diagnostics).toEqual([]);
    expect(actions).toHaveLength(2);

    const [first, second] = actions as [ActionEnvelope, ActionEnvelope];
    expect(first.id).toBe(`mcp:${RID}:0`);
    expect(second.id).toBe(`mcp:${RID}:2`);

    expect(mcpMeta(first).responseKind).toBe("input_required");
    expect(mcpMeta(first).resultType).toBe("input_required");
    expect(mcpMeta(first).observedResult).toMatchObject({ requestState });
    expect(first.result).toBeUndefined();
    expect(first.error).toBeUndefined();

    expect(mcpMeta(second).responseKind).toBe("success");
    expect(second.result).toEqual({
      resultType: "complete",
      content: [{ type: "text", text: "done" }],
    });
    expect(second.error).toBeUndefined();

    expect(mcpMeta(second).requestParams).toMatchObject({
      requestState,
      inputResponses: [{ name: "confirm_deployment", value: "yes" }],
    });
  });

  it("returns verbatim request params via getMcpToolCallRequestParams", () => {
    const params: JsonObject = {
      name: "interactive_tool",
      arguments: { answer: "yes" },
      requestState: "opaque-state-123",
      inputResponses: { approval: "confirmed" },
      _meta: { k: "v" },
    };
    const { actions } = normalizeMcpTape([
      callRequest(0, "call-1", params),
      resultResponse(1, "call-1", COMPLETE_RESULT),
    ]);
    expect(getMcpToolCallRequestParams(actions[0]!)).toEqual(params);
  });

  it("rejects getMcpToolCallRequestParams for actions without recorded params", () => {
    const { actions } = normalizeMcpTape([
      callRequest(0, "call-1"),
      resultResponse(1, "call-1", COMPLETE_RESULT),
    ]);
    const broken = { ...actions[0]!, metadata: {} };
    expect(() => getMcpToolCallRequestParams(broken)).toThrow(McpRequestParamsError);
    const nonMcp = { ...actions[0]!, protocol: "other" };
    expect(() => getMcpToolCallRequestParams(nonMcp)).toThrow(McpRequestParamsError);
  });
});
