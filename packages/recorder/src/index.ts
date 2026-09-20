import type { ActionTapeEvent, JsonObject } from "@actiontape/core";

export const TAPE_SCHEMA_VERSION = "1.0";

export interface Tape {
  schemaVersion: typeof TAPE_SCHEMA_VERSION;
  events: ActionTapeEvent[];
  metadata?: JsonObject;
}

export class TapeRecorder {
  private readonly recorded: ActionTapeEvent[] = [];

  record(event: ActionTapeEvent): void {
    this.recorded.push(event);
  }

  get size(): number {
    return this.recorded.length;
  }

  events(): readonly ActionTapeEvent[] {
    return this.recorded;
  }

  toTape(metadata?: JsonObject): Tape {
    const tape: Tape = {
      schemaVersion: TAPE_SCHEMA_VERSION,
      events: [...this.recorded],
    };
    if (metadata !== undefined) tape.metadata = metadata;
    return tape;
  }

  toJSON(): string {
    return JSON.stringify(this.toTape());
  }
}
