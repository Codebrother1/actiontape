import { describe, expect, it } from "vitest";
import { createActionEnvelope } from "../src/index.js";
import type {
  ActionCompletedEvent,
  ActionFailedEvent,
  ActionRequestedEvent,
  ActionTapeEvent,
  SessionEndedEvent,
  SessionStartedEvent,
} from "../src/index.js";

const SESSION_ID = "session-1";

function buildTape(): ActionTapeEvent[] {
  const requestedEnvelope = createActionEnvelope({
    id: "action-1",
    timestamp: "2026-01-01T00:00:00.000Z",
    protocol: "mcp",
    sessionId: SESSION_ID,
    operation: "tools/call",
    target: "filesystem/read_file",
    arguments: { path: "/tmp/a.txt" },
  });

  const started: SessionStartedEvent = {
    id: "event-1",
    type: "session.started",
    timestamp: "2026-01-01T00:00:00.000Z",
    sessionId: SESSION_ID,
    protocol: "mcp",
  };
  const requested: ActionRequestedEvent = {
    id: "event-2",
    type: "action.requested",
    timestamp: "2026-01-01T00:00:01.000Z",
    sessionId: SESSION_ID,
    envelope: requestedEnvelope,
  };
  const completed: ActionCompletedEvent = {
    id: "event-3",
    type: "action.completed",
    timestamp: "2026-01-01T00:00:02.000Z",
    sessionId: SESSION_ID,
    envelope: { ...requestedEnvelope, result: { content: "hello" } },
  };
  const failed: ActionFailedEvent = {
    id: "event-4",
    type: "action.failed",
    timestamp: "2026-01-01T00:00:03.000Z",
    sessionId: SESSION_ID,
    envelope: {
      ...requestedEnvelope,
      id: "action-2",
      error: { code: "ENOENT", message: "file not found" },
    },
  };
  const ended: SessionEndedEvent = {
    id: "event-5",
    type: "session.ended",
    timestamp: "2026-01-01T00:00:04.000Z",
    sessionId: SESSION_ID,
    reason: "agent finished",
  };
  return [started, requested, completed, failed, ended];
}

describe("ActionTapeEvent", () => {
  it("represents a full session lifecycle", () => {
    const events = buildTape();
    expect(events.map((e) => e.type)).toEqual([
      "session.started",
      "action.requested",
      "action.completed",
      "action.failed",
      "session.ended",
    ]);
  });

  it("distinguishes successful and failed actions", () => {
    const events = buildTape();
    const completed = events.find((e) => e.type === "action.completed");
    const failed = events.find((e) => e.type === "action.failed");

    expect(completed?.type).toBe("action.completed");
    if (completed?.type === "action.completed") {
      expect(completed.envelope.result).toEqual({ content: "hello" });
    }
    if (failed?.type === "action.failed") {
      expect(failed.envelope.error?.code).toBe("ENOENT");
    }
  });

  it("survives JSON.stringify -> JSON.parse", () => {
    const events = buildTape();
    const restored: unknown = JSON.parse(JSON.stringify(events));
    expect(restored).toEqual(events);
  });
});
