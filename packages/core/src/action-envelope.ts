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
  recordingId: string;
  operation: string;
  target: string;
  arguments: JsonObject;
  result?: JsonValue;
  error?: ActionError;
  metadata?: JsonObject;
}

export interface ActionEnvelopeInit {
  protocol: string;
  recordingId: string;
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
  if (init.result !== undefined && init.error !== undefined) {
    throw new Error("ActionEnvelope cannot carry both result and error");
  }
  const envelope: ActionEnvelope = {
    schemaVersion: ACTION_ENVELOPE_SCHEMA_VERSION,
    id: init.id ?? randomUUID(),
    timestamp: init.timestamp ?? new Date().toISOString(),
    protocol: init.protocol,
    direction: init.direction ?? "outbound",
    recordingId: init.recordingId,
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
  return isJsonValueInner(value, new Set());
}

function isJsonValueInner(value: unknown, path: Set<object>): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object": {
      if (path.has(value)) return false;
      if (Array.isArray(value)) {
        path.add(value);
        try {
          for (let i = 0; i < value.length; i++) {
            if (!(i in value) || !isJsonValueInner(value[i], path)) return false;
          }
          return true;
        } finally {
          path.delete(value);
        }
      }
      const proto: unknown = Object.getPrototypeOf(value);
      if (proto !== null && proto !== Object.prototype) return false;
      path.add(value);
      try {
        return Object.values(value).every((v) => isJsonValueInner(v, path));
      } finally {
        path.delete(value);
      }
    }
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
    typeof value.recordingId === "string" &&
    typeof value.operation === "string" &&
    typeof value.target === "string" &&
    isJsonObject(value.arguments) &&
    (value.result === undefined || isJsonValue(value.result)) &&
    (value.error === undefined || isActionError(value.error)) &&
    !(value.result !== undefined && value.error !== undefined) &&
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
