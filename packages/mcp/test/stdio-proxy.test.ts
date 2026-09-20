import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JsonlTapeWriter, runStdioProxy } from "../src/index.js";

const NODE = process.execPath;
const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));
const ECHO_SERVER = join(FIXTURES, "echo-server.mjs");
const EMIT_SERVER = join(FIXTURES, "emit-server.mjs");

const MCP_2026_DISCOVER = JSON.stringify({
  jsonrpc: "2.0",
  id: "discover-1",
  method: "server/discover",
  params: {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientInfo": { name: "actiontape-test", version: "0.0.0" },
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  },
});

const MCP_LEGACY_INITIALIZE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "actiontape-test", version: "0.0.0" },
  },
});

function collector(): { stream: Writable; text: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  });
  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
}

describe("runStdioProxy", () => {
  it("records client_to_server and server_to_client traffic for an echo server", async () => {
    const out = collector();
    const err = collector();
    const input = Readable.from([Buffer.from(`${MCP_2026_DISCOVER}\n${MCP_LEGACY_INITIALIZE}\n`)]);

    const result = await runStdioProxy({
      command: NODE,
      args: [ECHO_SERVER],
      input,
      output: out.stream,
      stderr: err.stream,
    });

    expect(result.exitCode).toBe(0);
    expect(result.records).toHaveLength(4);
    expect(result.records.map((r) => r.direction)).toEqual([
      "client_to_server",
      "client_to_server",
      "server_to_client",
      "server_to_client",
    ]);
    expect(result.records.map((r) => r.sequence)).toEqual([0, 1, 2, 3]);
    expect(result.records.every((r) => r.transport === "stdio")).toBe(true);
    expect(result.records.every((r) => r.recordingId === result.records[0]!.recordingId)).toBe(
      true,
    );
    expect(result.records[0]!.raw).toBe(MCP_2026_DISCOVER);
    expect(result.records[0]!.parse).toEqual({
      status: "ok",
      value: JSON.parse(MCP_2026_DISCOVER),
    });
    expect(out.text()).toBe(`${MCP_2026_DISCOVER}\n${MCP_LEGACY_INITIALIZE}\n`);
  });

  it("keeps a monotonically increasing sequence across both directions", async () => {
    const out = collector();
    const input = Readable.from([
      Buffer.from('{"jsonrpc":"2.0","id":1,"method":"ping"}\n'),
      Buffer.from('{"jsonrpc":"2.0","id":2,"method":"ping"}\n'),
    ]);
    const result = await runStdioProxy({
      command: NODE,
      args: [ECHO_SERVER],
      input,
      output: out.stream,
      stderr: collector().stream,
    });
    const sequences = result.records.map((r) => r.sequence);
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it("records a message split across arbitrary input chunks including a split multibyte char", async () => {
    const line = '{"jsonrpc":"2.0","id":"x","method":"ping","params":{"note":"héllo 🙂"}}';
    const payload = Buffer.from(line + "\n", "utf8");
    const cut = payload.indexOf(0xf0);
    const out = collector();
    const input = Readable.from([
      payload.subarray(0, 5),
      payload.subarray(5, cut + 2),
      payload.subarray(cut + 2),
    ]);

    const result = await runStdioProxy({
      command: NODE,
      args: [ECHO_SERVER],
      input,
      output: out.stream,
      stderr: collector().stream,
    });

    const sent = result.records.filter((r) => r.direction === "client_to_server");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.raw).toBe(line);
    expect(sent[0]!.parse.status).toBe("ok");
    expect(out.text()).toBe(line + "\n");
  });

  it("forwards invalid JSON unchanged and records a parse error", async () => {
    const out = collector();
    const err = collector();
    const input = Readable.from([Buffer.from("this is not json\n")]);

    const result = await runStdioProxy({
      command: NODE,
      args: [ECHO_SERVER],
      input,
      output: out.stream,
      stderr: err.stream,
    });

    expect(out.text()).toBe("this is not json\n");
    const sent = result.records.filter((r) => r.direction === "client_to_server");
    const echoed = result.records.filter((r) => r.direction === "server_to_client");
    expect(sent[0]!.raw).toBe("this is not json");
    expect(sent[0]!.parse.status).toBe("error");
    expect(echoed[0]!.parse.status).toBe("error");
  });

  it("passes child stderr to the parent stderr stream without recording it", async () => {
    const out = collector();
    const err = collector();
    const input = Readable.from([]);

    const result = await runStdioProxy({
      command: NODE,
      args: [EMIT_SERVER, "0"],
      input,
      output: out.stream,
      stderr: err.stream,
    });

    expect(result.exitCode).toBe(0);
    expect(err.text()).toContain("emit-server diagnostic output");
    expect(result.records.every((r) => !r.raw.includes("diagnostic"))).toBe(true);
    expect(result.records.some((r) => r.parse.status === "error")).toBe(true);
  });

  it("does not contaminate parent stdout with ActionTape output", async () => {
    const out = collector();
    const input = Readable.from([]);
    const result = await runStdioProxy({
      command: NODE,
      args: [EMIT_SERVER, "0"],
      input,
      output: out.stream,
      stderr: collector().stream,
    });
    expect(result.exitCode).toBe(0);
    expect(out.text()).toBe(
      '{"jsonrpc":"2.0","id":"emit-1","result":{"ok":true}}\nthis is not json\n',
    );
  });

  it("propagates the child exit code", async () => {
    const result = await runStdioProxy({
      command: NODE,
      args: [EMIT_SERVER, "7"],
      input: Readable.from([]),
      output: collector().stream,
      stderr: collector().stream,
    });
    expect(result.exitCode).toBe(7);
  });

  it("rejects cleanly when the command cannot be spawned", async () => {
    await expect(
      runStdioProxy({
        command: "actiontape-definitely-not-a-command-xyz",
        input: Readable.from([]),
        output: collector().stream,
        stderr: collector().stream,
      }),
    ).rejects.toThrow();
  });

  it("writes one independently parseable JSON record per JSONL line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "actiontape-test-"));
    const tapePath = join(dir, "tape.agentlog");
    const writer = await JsonlTapeWriter.open(tapePath);
    const input = Readable.from([Buffer.from(`${MCP_2026_DISCOVER}\n`)]);

    const result = await runStdioProxy({
      command: NODE,
      args: [ECHO_SERVER],
      input,
      output: collector().stream,
      stderr: collector().stream,
      onRecord: (record) => writer.writeRecord(record),
    });
    await writer.close();

    const lines = (await readFile(tapePath, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    const parsed = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    for (const record of parsed) {
      expect(record.schemaVersion).toBe("0.1-experimental");
      expect(record.recordingId).toBe(result.records[0]!.recordingId);
      expect(typeof record.sequence).toBe("number");
      expect(typeof record.timestamp).toBe("string");
      expect(record.transport).toBe("stdio");
      expect(["client_to_server", "server_to_client"]).toContain(record.direction);
      expect(typeof record.raw).toBe("string");
      expect(record.parse).toMatchObject({ status: "ok" });
    }
    expect(parsed[0]!.sequence as number).toBeLessThan(parsed[1]!.sequence as number);
  });
});
