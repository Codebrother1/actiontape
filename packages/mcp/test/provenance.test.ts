import { describe, expect, it } from "vitest";
import { createWireRecord } from "../src/wire-record.js";
import { normalizeMcpTape } from "../src/normalize.js";
import { extractMcpToolCatalogs } from "../src/catalog.js";
import { McpProvenanceError, resolveToolMappingProvenance } from "../src/provenance.js";
import type { TapeEntry } from "../src/tape-reader.js";

let seq = 0;
const reset = () => {
  seq = 0;
};
const rec = (direction: "client_to_server" | "server_to_client", raw: unknown): TapeEntry => ({
  line: 0,
  raw: "",
  record: createWireRecord({
    recordingId: "prov",
    sequence: seq++,
    direction,
    raw: JSON.stringify(raw),
  }),
});
const c2s = (raw: unknown) => rec("client_to_server", raw);
const s2c = (raw: unknown) => rec("server_to_client", raw);

const listReq = (id: number, cursor?: string) =>
  c2s({
    jsonrpc: "2.0",
    id,
    method: "tools/list",
    ...(cursor !== undefined ? { params: { cursor } } : {}),
  });
const listRes = (id: number, result: unknown) => s2c({ jsonrpc: "2.0", id, result });
const callReq = (id: number, name: string) =>
  c2s({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } });
const callRes = (id: number) => s2c({ jsonrpc: "2.0", id, result: { resultType: "complete" } });
const changed = () => s2c({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
const tool = (name: string, mapping?: unknown) => ({
  name,
  inputSchema: {
    type: "object",
    ...(mapping !== undefined ? { "x-authzen-mapping": mapping } : {}),
  },
});

const MAPPING = { evaluation: "resource.id == 'x'" };

function analyze(entries: TapeEntry[]) {
  const { actions } = normalizeMcpTape(entries);
  const timeline = extractMcpToolCatalogs(entries);
  return {
    actions,
    timeline,
    provenance: actions.map((a) => resolveToolMappingProvenance(a, timeline)),
  };
}

describe("resolveToolMappingProvenance", () => {
  it("DECLARED when the catalog advertises x-authzen-mapping", () => {
    reset();
    const { provenance } = analyze([
      listReq(1),
      listRes(1, { tools: [tool("get_customer", MAPPING)] }),
      callReq(2, "get_customer"),
      callRes(2),
    ]);
    expect(provenance[0]).toMatchObject({
      mappingSource: "declared",
      reason: null,
      declaredMapping: MAPPING,
    });
    expect(provenance[0]!.catalogSequence).toBeTypeOf("number");
  });

  it("DEFAULT_CONFIRMED when the observed tool has no mapping", () => {
    reset();
    const { provenance } = analyze([
      listReq(1),
      listRes(1, { tools: [tool("get_weather")] }),
      callReq(2, "get_weather"),
      callRes(2),
    ]);
    expect(provenance[0]!.mappingSource).toBe("default_confirmed");
    expect(provenance[0]!.declaredMapping).toBeNull();
  });

  it("UNKNOWN with no_catalog when a call precedes any discovery", () => {
    reset();
    const { provenance } = analyze([callReq(1, "x"), callRes(1)]);
    expect(provenance[0]!.mappingSource).toBe("unknown");
    expect(provenance[0]!.reason).toBe("no_catalog");
    expect(provenance[0]!.catalogSequence).toBeNull();
  });

  it("UNKNOWN catalog_stale after tools/list_changed without refresh", () => {
    reset();
    const { provenance } = analyze([
      listReq(1),
      listRes(1, { tools: [tool("a")] }),
      changed(),
      callReq(2, "a"),
      callRes(2),
    ]);
    expect(provenance[0]!.reason).toBe("catalog_stale");
  });

  it("refresh after invalidation restores evidence", () => {
    reset();
    const { provenance } = analyze([
      listReq(1),
      listRes(1, { tools: [tool("a")] }),
      changed(),
      listReq(2),
      listRes(2, { tools: [tool("a")] }),
      callReq(3, "a"),
      callRes(3),
    ]);
    expect(provenance[0]!.mappingSource).toBe("default_confirmed");
  });

  it("catalog v1 declared / v2 no mapping → first DECLARED, second DEFAULT_CONFIRMED", () => {
    reset();
    const { provenance } = analyze([
      listReq(1),
      listRes(1, { tools: [tool("t", MAPPING)] }),
      callReq(2, "t"),
      callRes(2),
      listReq(3),
      listRes(3, { tools: [tool("t")] }),
      callReq(4, "t"),
      callRes(4),
    ]);
    expect(provenance.map((p) => p.mappingSource)).toEqual(["declared", "default_confirmed"]);
  });

  it("catalog v1 no mapping / v2 declared → first DEFAULT_CONFIRMED, second DECLARED", () => {
    reset();
    const { provenance } = analyze([
      listReq(1),
      listRes(1, { tools: [tool("t")] }),
      callReq(2, "t"),
      callRes(2),
      listReq(3),
      listRes(3, { tools: [tool("t", MAPPING)] }),
      callReq(4, "t"),
      callRes(4),
    ]);
    expect(provenance.map((p) => p.mappingSource)).toEqual(["default_confirmed", "declared"]);
  });

  it("tool missing from a complete catalog is UNKNOWN, not default", () => {
    reset();
    const { provenance } = analyze([
      listReq(1),
      listRes(1, { tools: [tool("other")] }),
      callReq(2, "missing_tool"),
      callRes(2),
    ]);
    expect(provenance[0]!.mappingSource).toBe("unknown");
    expect(provenance[0]!.reason).toBe("tool_not_in_catalog");
  });

  it("partial pagination never proves default — UNKNOWN partial_catalog", () => {
    reset();
    const { provenance } = analyze([
      listReq(1),
      listRes(1, { tools: [tool("a")], nextCursor: "p2" }),
      callReq(2, "a"),
      callRes(2),
    ]);
    expect(provenance[0]!.mappingSource).toBe("unknown");
    expect(provenance[0]!.reason).toBe("partial_catalog");
  });

  it("malformed x-authzen-mapping yields UNKNOWN, not declared or default", () => {
    reset();
    const { provenance } = analyze([
      listReq(1),
      listRes(1, { tools: [tool("t", "not-an-object")] }),
      callReq(2, "t"),
      callRes(2),
    ]);
    expect(provenance[0]!.mappingSource).toBe("unknown");
    expect(provenance[0]!.reason).toBe("malformed_mapping");
  });

  it("MRTR physical rounds resolve independently and inputs are not mutated", () => {
    reset();
    const entries = [
      listReq(1),
      listRes(1, { tools: [tool("t", MAPPING)] }),
      callReq(2, "t"),
      s2c({ jsonrpc: "2.0", id: 2, result: { resultType: "input_required" } }),
      callReq(3, "t"),
      callRes(3),
    ];
    const { actions, timeline, provenance } = analyze(entries);
    const snapshot = JSON.stringify(actions);
    expect(provenance.map((p) => p.mappingSource)).toEqual(["declared", "declared"]);
    expect(JSON.stringify(actions)).toBe(snapshot);
    expect(timeline.catalogs).toHaveLength(1);
  });

  it("ambiguous pagination never produces DECLARED or DEFAULT_CONFIRMED", () => {
    reset();
    const { provenance } = analyze([
      listReq(1),
      listRes(1, { tools: [tool("a", MAPPING)], nextCursor: "collision" }),
      listReq(2),
      listRes(2, { tools: [tool("b")], nextCursor: "collision" }),
      listReq(3, "collision"),
      listRes(3, { tools: [tool("c")] }),
      callReq(4, "a"),
      callRes(4),
    ]);
    // Central safety property: ambiguity must resolve to UNKNOWN, never to a
    // guessed declared/default provenance.
    expect(provenance[0]!.mappingSource).toBe("unknown");
    expect(provenance[0]!.reason).toBe("partial_catalog");
  });

  it("rejects non-tools/call or non-mcp envelopes", () => {
    reset();
    const { actions } = normalizeMcpTape([callReq(1, "t"), callRes(1)]);
    const action = actions[0]!;
    expect(() =>
      resolveToolMappingProvenance(
        { ...action, protocol: "http" },
        { catalogs: [], incomplete: [], diagnostics: [] },
      ),
    ).toThrow(McpProvenanceError);
    expect(() =>
      resolveToolMappingProvenance(
        { ...action, operation: "tools/list" },
        { catalogs: [], incomplete: [], diagnostics: [] },
      ),
    ).toThrow(McpProvenanceError);
    expect(() =>
      resolveToolMappingProvenance(
        { ...action, metadata: undefined },
        { catalogs: [], incomplete: [], diagnostics: [] },
      ),
    ).toThrow(McpProvenanceError);
  });
});
