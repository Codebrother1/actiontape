import type { ActionEnvelope, JsonObject } from "./action-envelope.js";

export const ACTION_TAPE_EVENT_TYPES = [
  "session.started",
  "action.requested",
  "action.completed",
  "action.failed",
  "session.ended",
] as const;

export type ActionTapeEventType = (typeof ACTION_TAPE_EVENT_TYPES)[number];

interface ActionTapeEventBase {
  id: string;
  type: ActionTapeEventType;
  timestamp: string;
  sessionId: string;
  metadata?: JsonObject;
}

export interface SessionStartedEvent extends ActionTapeEventBase {
  type: "session.started";
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

export interface SessionEndedEvent extends ActionTapeEventBase {
  type: "session.ended";
  reason?: string;
}

export type ActionTapeEvent =
  | SessionStartedEvent
  | ActionRequestedEvent
  | ActionCompletedEvent
  | ActionFailedEvent
  | SessionEndedEvent;
