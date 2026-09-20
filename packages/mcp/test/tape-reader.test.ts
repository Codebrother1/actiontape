import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createWireRecord, readTape, type TapeEntry } from "../src/index.js";

function wireLine(
  direction: "client_to_server" | "server_to_client",
  raw: string,
  sequence: number,
) {
  return JSON.stringify(createWireRecord({ recordingId: "rec-1", sequence, direction, raw }));
}

async function collect(text: string): Promise<TapeEntry[]> {
  const entries: TapeEntry[] = [];
  for await (const entry of readTape(Readable.from([text]))) {
    entries.push(entry);
  }
  return entries;
}

describe("readTape", () => {
  it("reads one wire record per JSONL line", async () => {
    const entries = await collect(
      [wireLine("client_to_server", '{"a":1}', 0), wireLine("server_to_client", '{"b":2}', 1)].join(
        "\n",
      ) + "\n",
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]!.record?.sequence).toBe(0);
    expect(entries[1]!.record?.direction).toBe("server_to_client");
  });

  it("reports malformed JSONL with line numbers and still processes later lines", async () => {
    const entries = await collect(
      [
        wireLine("client_to_server", '{"a":1}', 0),
        "this is not json",
        wireLine("server_to_client", '{"b":2}', 2),
      ].join("\n"),
    );
    expect(entries).toHaveLength(3);
    expect(entries[1]!.diagnostic?.code).toBe("malformed_jsonl");
    expect(entries[1]!.diagnostic?.line).toBe(2);
    expect(entries[2]!.record?.sequence).toBe(2);
  });

  it("reports structurally invalid wire records", async () => {
    const invalid = JSON.stringify({ schemaVersion: "0.1-experimental", direction: "sideways" });
    const entries = await collect(invalid + "\n" + wireLine("client_to_server", "{}", 1));
    expect(entries[0]!.diagnostic?.code).toBe("invalid_wire_record");
    expect(entries[0]!.record).toBeUndefined();
    expect(entries[1]!.record).toBeDefined();
  });

  it("handles CRLF line endings", async () => {
    const entries = await collect(wireLine("client_to_server", "{}", 0) + "\r\n");
    expect(entries[0]!.record?.raw).toBe("{}");
  });
});
