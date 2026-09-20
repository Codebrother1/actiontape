import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { NormalizationDiagnostic } from "./diagnostics.js";
import { isMcpWireRecord, type McpWireRecord } from "./wire-record.js";

export interface TapeEntry {
  line: number;
  raw: string;
  record?: McpWireRecord;
  diagnostic?: NormalizationDiagnostic;
}

export function parseTapeLine(raw: string, line: number): TapeEntry {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    return {
      line,
      raw,
      diagnostic: {
        code: "malformed_jsonl",
        message: `line ${line}: invalid JSON (${err instanceof Error ? err.message : String(err)})`,
        line,
      },
    };
  }
  if (!isMcpWireRecord(value)) {
    return {
      line,
      raw,
      diagnostic: {
        code: "invalid_wire_record",
        message: `line ${line}: JSON value is not a valid MCP wire record`,
        line,
      },
    };
  }
  return { line, raw, record: value };
}

export async function* readTape(input: Readable): AsyncGenerator<TapeEntry> {
  const rl = createInterface({ input, crlfDelay: Infinity });
  let line = 0;
  for await (const raw of rl) {
    line += 1;
    yield parseTapeLine(raw, line);
  }
}

export function readTapeFile(path: string): AsyncGenerator<TapeEntry> {
  return readTape(createReadStream(path, { encoding: "utf8" }));
}
