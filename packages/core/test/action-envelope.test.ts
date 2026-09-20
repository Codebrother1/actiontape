import { describe, expect, it } from "vitest";
import {
  ACTION_ENVELOPE_SCHEMA_VERSION,
  createActionEnvelope,
  isActionEnvelope,
  isJsonValue,
  parseActionEnvelope,
} from "../src/index.js";

describe("ActionEnvelope", () => {
  it("constructs a valid envelope with defaults", () => {
    const envelope = createActionEnvelope({
      protocol: "mcp",
      recordingId: "recording-1",
      operation: "tools/call",
      target: "filesystem/read_file",
      arguments: { path: "/tmp/a.txt" },
    });

    expect(envelope.schemaVersion).toBe(ACTION_ENVELOPE_SCHEMA_VERSION);
    expect(envelope.id).toBeTruthy();
    expect(envelope.timestamp).toBeTruthy();
    expect(envelope.direction).toBe("outbound");
    expect(envelope.arguments).toEqual({ path: "/tmp/a.txt" });
    expect(isActionEnvelope(envelope)).toBe(true);
  });

  it("survives JSON.stringify -> JSON.parse without losing structure", () => {
    const envelope = createActionEnvelope({
      protocol: "mcp",
      recordingId: "recording-1",
      operation: "tools/call",
      target: "filesystem/read_file",
      arguments: { path: "/tmp/a.txt", options: { encoding: "utf8", retries: 2 } },
      result: { content: "hello", bytes: 5 },
      metadata: { agent: "test-agent", attempt: 1 },
    });

    const restored: unknown = JSON.parse(JSON.stringify(envelope));
    expect(restored).toEqual(envelope);
    expect(isActionEnvelope(restored)).toBe(true);
    expect(parseActionEnvelope(JSON.stringify(envelope))).toEqual(envelope);
  });

  it("represents a failed action via error", () => {
    const envelope = createActionEnvelope({
      protocol: "mcp",
      recordingId: "recording-1",
      operation: "tools/call",
      target: "filesystem/read_file",
      arguments: { path: "/missing" },
      error: { code: "ENOENT", message: "file not found", data: { path: "/missing" } },
    });

    expect(envelope.error?.code).toBe("ENOENT");
    expect(envelope.result).toBeUndefined();
    expect(isActionEnvelope(envelope)).toBe(true);
    expect(parseActionEnvelope(JSON.stringify(envelope)).error?.message).toBe("file not found");
  });

  it("rejects values that are not valid envelopes", () => {
    expect(isActionEnvelope(null)).toBe(false);
    expect(isActionEnvelope("envelope")).toBe(false);
    expect(isActionEnvelope({})).toBe(false);
    expect(
      isActionEnvelope({
        ...createActionEnvelope({
          protocol: "mcp",
          recordingId: "s",
          operation: "op",
          target: "t",
        }),
        schemaVersion: "999",
      }),
    ).toBe(false);
    expect(() => parseActionEnvelope("{}")).toThrow("Invalid ActionEnvelope JSON");
    expect(() => parseActionEnvelope("not json")).toThrow();
  });

  it("rejects non-JSON values that would silently corrupt on serialization", () => {
    class NotJson {
      x = 1;
    }
    const base = () =>
      createActionEnvelope({
        protocol: "mcp",
        recordingId: "s",
        operation: "op",
        target: "t",
      });

    const withMap = { ...base(), arguments: new Map([["k", "v"]]) };
    const withDate = { ...base(), metadata: { at: new Date() } };
    const withClass = { ...base(), result: new NotJson() };
    const withNan = { ...base(), result: NaN };
    const withInfinity = { ...base(), result: Infinity };
    const withNested = { ...base(), arguments: { ok: 1, bad: new Set([1]) } };
    const withFn = { ...base(), arguments: { cb: () => 1 } };
    const withUndefined = { ...base(), arguments: { missing: undefined } };

    for (const candidate of [
      withMap,
      withDate,
      withClass,
      withNan,
      withInfinity,
      withNested,
      withFn,
      withUndefined,
    ]) {
      expect(isActionEnvelope(candidate)).toBe(false);
    }
  });

  it("rejects sparse arrays whose holes would serialize as null", () => {
    expect(isJsonValue(new Array(1))).toBe(false);
    const sparse = [1, 2, 3];
    delete sparse[1];
    expect(isJsonValue(sparse)).toBe(false);
    expect(isJsonValue({ hole: new Array(2) })).toBe(false);
    expect(isJsonValue([1, "a", null, [2, { b: true }]])).toBe(true);
  });

  it("rejects cyclic objects without crashing", () => {
    const cyclic: Record<string, unknown> = { name: "x" };
    cyclic.self = cyclic;
    const cyclicArray: unknown[] = [1];
    cyclicArray.push(cyclicArray);
    const shared = { v: 1 };
    const diamond = { a: shared, b: [shared, shared] };

    expect(isJsonValue(cyclic)).toBe(false);
    expect(isJsonValue(cyclicArray)).toBe(false);
    expect(isJsonValue({ nested: { inner: cyclic } })).toBe(false);
    expect(isJsonValue(diamond)).toBe(true);

    const envelope = createActionEnvelope({
      protocol: "mcp",
      recordingId: "s",
      operation: "op",
      target: "t",
    });
    expect(isActionEnvelope({ ...envelope, arguments: cyclic })).toBe(false);
  });

  it("rejects envelopes carrying both result and error", () => {
    const base = () =>
      createActionEnvelope({
        protocol: "mcp",
        recordingId: "s",
        operation: "op",
        target: "t",
      });

    expect(isActionEnvelope({ ...base(), result: { ok: true } })).toBe(true);
    expect(isActionEnvelope({ ...base(), error: { code: "E", message: "m" } })).toBe(true);
    expect(isActionEnvelope(base())).toBe(true);
    expect(
      isActionEnvelope({ ...base(), result: { ok: true }, error: { code: "E", message: "m" } }),
    ).toBe(false);
    expect(() =>
      createActionEnvelope({
        protocol: "mcp",
        recordingId: "s",
        operation: "op",
        target: "t",
        result: { ok: true },
        error: { code: "E", message: "m" },
      }),
    ).toThrow("both result and error");
  });
});
