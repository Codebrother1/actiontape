import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { once } from "node:events";
import { dirname } from "node:path";
import type { McpWireRecord } from "./wire-record.js";

export class JsonlTapeWriter {
  private constructor(private readonly stream: WriteStream) {}

  static async open(path: string): Promise<JsonlTapeWriter> {
    await mkdir(dirname(path), { recursive: true });
    return new JsonlTapeWriter(createWriteStream(path, { encoding: "utf8" }));
  }

  writeRecord(record: McpWireRecord): void {
    this.stream.write(JSON.stringify(record) + "\n");
  }

  async close(): Promise<void> {
    this.stream.end();
    await once(this.stream, "finish");
  }
}
