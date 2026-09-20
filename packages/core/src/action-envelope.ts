import { randomUUID } from "node:crypto";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

export const ACTION_ENVELOPE_SCHEMA_VERSION = "1.0";

export type ActionDirection = "outbound" | "inbound";

export interface ActionError {
  code: string;
  message: string;
  data?: JsonValue;
}

export interface ActionEnvelope {
  schemaVersion: typeof ACTION_ENVELOPE_SCHEMA_VERSION;
  id: string;
  timestamp: string;
  protocol: string;
  direction: ActionDirection;
  sessionId: string;
  operation: string;
  target: string;
  arguments: JsonObject;
  result?: JsonValue;
  error?: ActionError;
  metadata?: JsonObject;
}

export interface ActionEnvelopeInit {
  protocol: string;
  sessionId: string;
  operation: string;
  target: string;
  id?: string;
  timestamp?: string;
  direction?: ActionDirection;
  arguments?: JsonObject;
  result?: JsonValue;
  error?: ActionError;
  metadata?: JsonObject;
}

export function createActionEnvelope(init: ActionEnvelopeInit): ActionEnvelope {
  const envelope: ActionEnvelope = {
    schemaVersion: ACTION_ENVELOPE_SCHEMA_VERSION,
    id: init.id ?? randomUUID(),
    timestamp: init.timestamp ?? new Date().toISOString(),
    protocol: init.protocol,
    direction: init.direction ?? "outbound",
    sessionId: init.sessionId,
    operation: init.operation,
    target: init.target,
    arguments: init.arguments ?? {},
  };
  if (init.result !== undefined) envelope.result = init.result;
  if (init.error !== undefined) envelope.error = init.error;
  if (init.metadata !== undefined) envelope.metadata = init.metadata;
  return envelope;
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return true;
    case "object":
      return Array.isArray(value)
        ? value.every(isJsonValue)
        : Object.values(value).every(isJsonValue);
    default:
      return false;
  }
}

export function isJsonObject(value: unknown): value is JsonObject {
  return isJsonValue(value) && typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isActionError(value: unknown): value is ActionError {
  return (
    isJsonObject(value) &&
    typeof value.code === "string" &&
    typeof value.message === "string" &&
    (value.data === undefined || isJsonValue(value.data))
  );
}

export function isActionEnvelope(value: unknown): value is ActionEnvelope {
  return (
    isJsonObject(value) &&
    value.schemaVersion === ACTION_ENVELOPE_SCHEMA_VERSION &&
    typeof value.id === "string" &&
    typeof value.timestamp === "string" &&
    typeof value.protocol === "string" &&
    (value.direction === "outbound" || value.direction === "inbound") &&
    typeof value.sessionId === "string" &&
    typeof value.operation === "string" &&
    typeof value.target === "string" &&
    isJsonObject(value.arguments) &&
    (value.result === undefined || isJsonValue(value.result)) &&
    (value.error === undefined || isActionError(value.error)) &&
    (value.metadata === undefined || isJsonObject(value.metadata))
  );
}

export function parseActionEnvelope(json: string): ActionEnvelope {
  const value: unknown = JSON.parse(json);
  if (!isActionEnvelope(value)) {
    throw new Error("Invalid ActionEnvelope JSON");
  }
  return value;
}
