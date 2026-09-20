import type { ActionEnvelope, JsonObject } from "./action-envelope.js";

export const ACTION_TAPE_EVENT_TYPES = [
  "recording.started",
  "action.requested",
  "action.completed",
  "action.failed",
  "recording.ended",
] as const;

export type ActionTapeEventType = (typeof ACTION_TAPE_EVENT_TYPES)[number];

interface ActionTapeEventBase {
  id: string;
  type: ActionTapeEventType;
  timestamp: string;
  recordingId: string;
  metadata?: JsonObject;
}

export interface RecordingStartedEvent extends ActionTapeEventBase {
  type: "recording.started";
  protocol: string;
}

export interface ActionRequestedEvent extends ActionTapeEventBase {
  type: "action.requested";
  envelope: ActionEnvelope;
}

export interface ActionCompletedEvent extends ActionTapeEventBase {
  type: "action.completed";
  envelope: ActionEnvelope;
}

export interface ActionFailedEvent extends ActionTapeEventBase {
  type: "action.failed";
  envelope: ActionEnvelope;
}

export interface RecordingEndedEvent extends ActionTapeEventBase {
  type: "recording.ended";
  reason?: string;
}

export type ActionTapeEvent =
  | RecordingStartedEvent
  | ActionRequestedEvent
  | ActionCompletedEvent
  | ActionFailedEvent
  | RecordingEndedEvent;
