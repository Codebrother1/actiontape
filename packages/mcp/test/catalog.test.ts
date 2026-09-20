import { describe, expect, it } from "vitest";
import { createWireRecord } from "../src/wire-record.js";
import { normalizeMcpTape } from "../src/normalize.js";
import { extractMcpToolCatalogs } from "../src/catalog.js";
import type { TapeEntry } from "../src/tape-reader.js";

let seq = 0;
function c2s(raw: unknown): TapeEntry {
  return {
    line: 0,
    raw: "",
    record: createWireRecord({
      recordingId: "cat",
      sequence: seq++,
      direction: "client_to_server",
      raw: JSON.stringify(raw),
    }),
  };
}
function s2c(raw: unknown): TapeEntry {
  return {
    line: 0,
    raw: "",
    record: createWireRecord({
      recordingId: "cat",
      sequence: seq++,
      direction: "server_to_client",
      raw: JSON.stringify(raw),
    }),
  };
}
const listReq = (id: string | number, cursor?: string) =>
  c2s({
    jsonrpc: "2.0",
    id,
    method: "tools/list",
    ...(cursor !== undefined ? { params: { cursor } } : {}),
  });
const listRes = (id: string | number, result: unknown) => s2c({ jsonrpc: "2.0", id, result });
const listErr = (id: string | number) =>
  s2c({ jsonrpc: "2.0", id, error: { code: -32603, message: "internal" } });
const tool = (name: string, inputSchema?: unknown) => ({
  name,
  ...(inputSchema !== undefined ? { inputSchema } : { inputSchema: { type: "object" } }),
});
const changed = () => s2c({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });

function reset() {
  seq = 0;
}

describe("extractMcpToolCatalogs", () => {
  it("extracts a one-page tools/list catalog", () => {
    reset();
    const t = [listReq(1), listRes(1, { tools: [tool("a"), tool("b")] })];
    const r = extractMcpToolCatalogs(t);
    expect(r.diagnostics).toEqual([]);
    expect(r.catalogs).toHaveLength(1);
    expect(r.catalogs[0]).toMatchObject({ pageCount: 1 });
    expect(r.catalogs[0]!.tools.map((x) => x.name)).toEqual(["a", "b"]);
    expect(r.catalogs[0]!.completedAtSequence).toBeGreaterThan(r.catalogs[0]!.requestSequence);
  });

  it("accepts modern and legacy result shapes, preserving cache fields", () => {
    reset();
    const modern = [
      listReq(1),
      listRes(1, {
        resultType: "complete",
        tools: [tool("m")],
        ttlMs: 5000,
        cacheScope: "session",
      }),
    ];
    const r1 = extractMcpToolCatalogs(modern);
    expect(r1.catalogs[0]).toMatchObject({ ttlMs: 5000, cacheScope: "session" });
    reset();
    const legacy = [listReq(1), listRes(1, { tools: [tool("l")] })];
    const r2 = extractMcpToolCatalogs(legacy);
    expect(r2.catalogs[0]!.tools[0]!.name).toBe("l");
    expect(r2.catalogs[0]!.ttlMs).toBeUndefined();
  });

  it("keeps numeric and string JSON-RPC ids distinct", () => {
    reset();
    const t = [
      listReq(1),
      listReq("1"),
      listRes("1", { tools: [tool("str")] }),
      listRes(1, { tools: [tool("num")] }),
    ];
    const r = extractMcpToolCatalogs(t);
    expect(r.diagnostics).toEqual([]);
    expect(r.catalogs).toHaveLength(2);
    expect(r.catalogs[0]!.tools[0]!.name).toBe("str");
    expect(r.catalogs[1]!.tools[0]!.name).toBe("num");
  });

  it("diagnoses unmatched list responses, missing responses, and error responses", () => {
    reset();
    const orphan = extractMcpToolCatalogs([listRes(9, { tools: [tool("x")] })]);
    expect(orphan.diagnostics.map((d) => d.code)).toEqual(["unmatched_list_response"]);
    expect(orphan.catalogs).toEqual([]);

    reset();
    const noRes = extractMcpToolCatalogs([listReq(1)]);
    expect(noRes.diagnostics.map((d) => d.code)).toEqual(["incomplete_list_request"]);

    reset();
    const failed = extractMcpToolCatalogs([listReq(1), listErr(1)]);
    expect(failed.diagnostics.map((d) => d.code)).toEqual(["list_error"]);
    expect(failed.catalogs).toEqual([]);
  });

  it("diagnoses malformed results, tools, mappings, and duplicate names", () => {
    reset();
    const badTools = extractMcpToolCatalogs([listReq(1), listRes(1, { tools: "nope" })]);
    expect(badTools.diagnostics.map((d) => d.code)).toEqual(["malformed_list_result"]);

    reset();
    const badTool = extractMcpToolCatalogs([
      listReq(1),
      listRes(1, { tools: [{ description: "no name" }, tool("ok")] }),
    ]);
    expect(badTool.diagnostics.map((d) => d.code)).toEqual(["malformed_tool"]);
    expect(badTool.catalogs[0]!.tools.map((t) => t.name)).toEqual(["ok"]);

    reset();
    const badMapping = extractMcpToolCatalogs([
      listReq(1),
      listRes(1, { tools: [tool("t", { type: "object", "x-authzen-mapping": "evil string" })] }),
    ]);
    expect(badMapping.diagnostics.map((d) => d.code)).toEqual(["malformed_mapping"]);
    expect(badMapping.catalogs[0]!.tools[0]!.mappingMalformed).toBe(true);
    expect(badMapping.catalogs[0]!.tools[0]!.declaredMapping).toBeUndefined();

    reset();
    const dup = extractMcpToolCatalogs([listReq(1), listRes(1, { tools: [tool("a"), tool("a")] })]);
    expect(dup.diagnostics.map((d) => d.code)).toEqual(["duplicate_tool_name"]);
    expect(dup.catalogs[0]!.tools).toHaveLength(1);
  });

  it("allows id reuse after a list response completes", () => {
    reset();
    const t = [
      listReq(1),
      listRes(1, { tools: [tool("a")] }),
      listReq(1),
      listRes(1, { tools: [tool("b")] }),
    ];
    const r = extractMcpToolCatalogs(t);
    expect(r.diagnostics).toEqual([]);
    expect(r.catalogs).toHaveLength(2);
  });

  it("preserves inputSchema and raw x-authzen-mapping verbatim", () => {
    reset();
    const mapping = {
      evaluation: "subject.id == user && resource.id == 'x'",
      weird: "$(touch /tmp/actiontape-owned)",
    };
    const schema = {
      type: "object",
      properties: { p: { type: "string" } },
      "x-authzen-mapping": mapping,
    };
    const t = [listReq(1), listRes(1, { tools: [tool("get_customer", schema)] })];
    const r = extractMcpToolCatalogs(t);
    expect(r.diagnostics).toEqual([]);
    expect(r.catalogs[0]!.tools[0]!.inputSchema).toEqual(schema);
    expect(r.catalogs[0]!.tools[0]!.declaredMapping).toEqual(mapping);
  });
});

describe("pagination", () => {
  it("composes two- and three-page catalogs in wire order", () => {
    reset();
    const t = [
      listReq(1),
      listRes(1, { tools: [tool("A"), tool("B")], nextCursor: "abc" }),
      listReq(2, "abc"),
      listRes(2, { tools: [tool("C")] }),
      listReq(3),
      listRes(3, { tools: [tool("X")], nextCursor: "p2" }),
      listReq(4, "p2"),
      listRes(4, { tools: [], nextCursor: "p3" }),
      listReq(5, "p3"),
      listRes(5, { tools: [tool("Y")] }),
    ];
    const r = extractMcpToolCatalogs(t);
    expect(r.diagnostics).toEqual([]);
    expect(r.catalogs).toHaveLength(2);
    expect(r.catalogs[0]!.pageCount).toBe(2);
    expect(r.catalogs[0]!.tools.map((x) => x.name)).toEqual(["A", "B", "C"]);
    expect(r.catalogs[1]!.pageCount).toBe(3);
    expect(r.catalogs[1]!.tools.map((x) => x.name)).toEqual(["X", "Y"]);
  });

  it("marks missing continuations, wrong cursors, and repeated cursors incomplete", () => {
    reset();
    const missing = extractMcpToolCatalogs([
      listReq(1),
      listRes(1, { tools: [tool("A")], nextCursor: "abc" }),
    ]);
    expect(missing.catalogs).toEqual([]);
    expect(missing.diagnostics.map((d) => d.code)).toEqual(["incomplete_catalog"]);
    expect(missing.incomplete).toHaveLength(1);

    reset();
    const wrong = extractMcpToolCatalogs([
      listReq(1),
      listRes(1, { tools: [tool("A")], nextCursor: "abc" }),
      listReq(2, "WRONG"),
      listRes(2, { tools: [tool("B")] }),
    ]);
    expect(wrong.diagnostics.map((d) => d.code)).toContain("cursor_mismatch");
    expect(wrong.catalogs).toEqual([]);

    reset();
    const loop = extractMcpToolCatalogs([
      listReq(1),
      listRes(1, { tools: [tool("A")], nextCursor: "abc" }),
      listReq(2, "abc"),
      listRes(2, { tools: [tool("B")], nextCursor: "abc" }),
    ]);
    expect(loop.diagnostics.map((d) => d.code)).toContain("cursor_reuse");
    expect(loop.catalogs).toEqual([]);
  });

  it("diagnoses duplicate tool names across pages", () => {
    reset();
    const t = [
      listReq(1),
      listRes(1, { tools: [tool("A")], nextCursor: "c1" }),
      listReq(2, "c1"),
      listRes(2, { tools: [tool("A"), tool("B")] }),
    ];
    const r = extractMcpToolCatalogs(t);
    expect(r.diagnostics.map((d) => d.code)).toEqual(["duplicate_tool_name"]);
    expect(r.catalogs[0]!.tools.map((x) => x.name)).toEqual(["A", "B"]);
  });
});

describe("timeline / invalidation", () => {
  const callReq = (id: number, name: string) =>
    c2s({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });
  const callRes = (id: number) => s2c({ jsonrpc: "2.0", id, result: { resultType: "complete" } });

  it("invalidates the latest catalog on tools/list_changed until refreshed", () => {
    reset();
    const t = [
      listReq(1),
      listRes(1, { tools: [tool("a")] }),
      changed(),
      callReq(2, "a"),
      callRes(2),
    ];
    const r = extractMcpToolCatalogs(t);
    expect(r.catalogs[0]!.invalidatedAtSequence).toBeTypeOf("number");

    const { actions } = normalizeMcpTape(t);
    // resolver check happens in provenance tests; here assert timeline state
    expect(actions).toHaveLength(1);
  });

  it("a refreshed catalog supersedes invalidation", () => {
    reset();
    const t = [
      listReq(1),
      listRes(1, { tools: [tool("a")] }),
      changed(),
      listReq(2),
      listRes(2, { tools: [tool("a"), tool("b")] }),
      callReq(3, "b"),
      callRes(3),
    ];
    const r = extractMcpToolCatalogs(t);
    expect(r.catalogs).toHaveLength(2);
    expect(r.catalogs[0]!.invalidatedAtSequence).toBeTypeOf("number");
    expect(r.catalogs[1]!.invalidatedAtSequence).toBeUndefined();
  });
});
