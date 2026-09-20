import { randomUUID } from "node:crypto";
import { isJsonObject, isJsonValue, type JsonValue } from "@actiontape/core";

export const MCP_WIRE_RECORD_SCHEMA_VERSION = "0.1-experimental";

export type McpWireTransport = "stdio";

export type McpWireDirection = "client_to_server" | "server_to_client";

export type WireParseResult =
  { status: "ok"; value: JsonValue } | { status: "error"; message: string };

export interface McpWireRecord {
  schemaVersion: typeof MCP_WIRE_RECORD_SCHEMA_VERSION;
  recordingId: string;
  sequence: number;
  timestamp: string;
  transport: McpWireTransport;
  direction: McpWireDirection;
  raw: string;
  parse: WireParseResult;
}

export interface McpWireRecordInit {
  recordingId: string;
  sequence: number;
  direction: McpWireDirection;
  raw: string;
  timestamp?: string;
}

export function parseWireLine(raw: string): WireParseResult {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isJsonValue(value)) {
      return { status: "error", message: "parsed value is not JSON-safe" };
    }
    return { status: "ok", value };
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

export function createWireRecord(init: McpWireRecordInit): McpWireRecord {
  return {
    schemaVersion: MCP_WIRE_RECORD_SCHEMA_VERSION,
    recordingId: init.recordingId,
    sequence: init.sequence,
    timestamp: init.timestamp ?? new Date().toISOString(),
    transport: "stdio",
    direction: init.direction,
    raw: init.raw,
    parse: parseWireLine(init.raw),
  };
}

export function newRecordingId(): string {
  return randomUUID();
}

export function isWireParseResult(value: unknown): value is WireParseResult {
  return (
    isJsonObject(value) &&
    ((value.status === "ok" && isJsonValue(value.value)) ||
      (value.status === "error" && typeof value.message === "string"))
  );
}

export function isMcpWireRecord(value: unknown): value is McpWireRecord {
  return (
    isJsonObject(value) &&
    value.schemaVersion === MCP_WIRE_RECORD_SCHEMA_VERSION &&
    typeof value.recordingId === "string" &&
    typeof value.sequence === "number" &&
    Number.isInteger(value.sequence) &&
    typeof value.timestamp === "string" &&
    value.transport === "stdio" &&
    (value.direction === "client_to_server" || value.direction === "server_to_client") &&
    typeof value.raw === "string" &&
    isWireParseResult(value.parse)
  );
}
