import { randomUUID } from "node:crypto";
import { isJsonValue, type JsonValue } from "@actiontape/core";

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
