import { createActionEnvelope } from "@actiontape/core";
import type { ActionRequestedEvent, RecordingStartedEvent } from "@actiontape/core";
import { describe, expect, it } from "vitest";
import { TAPE_SCHEMA_VERSION, TapeRecorder } from "../src/index.js";

describe("TapeRecorder", () => {
  it("records events into a serializable tape", () => {
    const recorder = new TapeRecorder();

    const started: RecordingStartedEvent = {
      id: "event-1",
      type: "recording.started",
      timestamp: "2026-01-01T00:00:00.000Z",
      recordingId: "recording-1",
      protocol: "mcp",
    };
    const requested: ActionRequestedEvent = {
      id: "event-2",
      type: "action.requested",
      timestamp: "2026-01-01T00:00:01.000Z",
      recordingId: "recording-1",
      envelope: createActionEnvelope({
        protocol: "mcp",
        recordingId: "recording-1",
        operation: "tools/call",
        target: "filesystem/read_file",
        arguments: { path: "/tmp/a.txt" },
      }),
    };

    recorder.record(started);
    recorder.record(requested);

    expect(recorder.size).toBe(2);
    expect(recorder.events()).toEqual([started, requested]);

    const tape = recorder.toTape({ purpose: "test" });
    expect(tape.schemaVersion).toBe(TAPE_SCHEMA_VERSION);
    expect(tape.events).toHaveLength(2);

    const restored: unknown = JSON.parse(JSON.stringify(tape));
    expect(restored).toEqual(tape);
  });
});
