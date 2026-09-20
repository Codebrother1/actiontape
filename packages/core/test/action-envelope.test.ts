import { describe, expect, it } from "vitest";
import {
  ACTION_ENVELOPE_SCHEMA_VERSION,
  createActionEnvelope,
  isActionEnvelope,
  parseActionEnvelope,
} from "../src/index.js";

describe("ActionEnvelope", () => {
  it("constructs a valid envelope with defaults", () => {
    const envelope = createActionEnvelope({
      protocol: "mcp",
      sessionId: "session-1",
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
      sessionId: "session-1",
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
      sessionId: "session-1",
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
          sessionId: "s",
          operation: "op",
          target: "t",
        }),
        schemaVersion: "999",
      }),
    ).toBe(false);
    expect(() => parseActionEnvelope("{}")).toThrow("Invalid ActionEnvelope JSON");
    expect(() => parseActionEnvelope("not json")).toThrow();
  });
});
