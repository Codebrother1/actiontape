import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isActionEnvelope } from "@actiontape/core";
import { createWireRecord } from "@actiontape/mcp";
import { CLI_VERSION, main, type CliIo } from "../src/index.js";

const EMIT_SERVER = fileURLToPath(
  new URL("../../mcp/test/fixtures/emit-server.mjs", import.meta.url),
);

function captureIo(): { io: CliIo; lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    io: { log: (line) => lines.push(line), error: (line) => errors.push(line) },
  };
}

function sink(): { stream: Writable; text: () => string } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  });
  return { stream, text: () => Buffer.concat(chunks).toString("utf8") };
}

describe("actiontape cli", () => {
  it("prints version", async () => {
    const { io, lines } = captureIo();
    expect(await main(["--version"], io)).toBe(0);
    expect(lines[0]).toContain(CLI_VERSION);
  });

  it("prints help with exit code 0", async () => {
    const { io, lines } = captureIo();
    expect(await main([], io)).toBe(0);
    expect(await main(["--help"], io)).toBe(0);
    expect(lines.join("\n")).toContain("Usage:");
  });

  it("exits non-zero on unknown arguments", async () => {
    const { io } = captureIo();
    expect(await main(["--bogus"], io)).toBe(1);
  });

  it("rejects record without --out", async () => {
    const { io, errors } = captureIo();
    expect(await main(["record", "--", "node", "x.js"], io)).toBe(2);
    expect(errors.join("\n")).toContain("--out");
  });

  it("rejects record without the -- separator", async () => {
    const { io } = captureIo();
    expect(await main(["record", "--out", "tape.agentlog", "node", "x.js"], io)).toBe(2);
  });

  it("rejects record with an empty command", async () => {
    const { io } = captureIo();
    expect(await main(["record", "--out", "tape.agentlog", "--"], io)).toBe(2);
  });

  it("rejects record with an unknown option", async () => {
    const { io, errors } = captureIo();
    expect(await main(["record", "--out", "t.agentlog", "--bogus", "--", "node"], io)).toBe(2);
    expect(errors.join("\n")).toContain("unknown option");
  });

  it("records a real child process to a JSONL tape", async () => {
    const dir = await mkdtemp(join(tmpdir(), "actiontape-cli-"));
    const tapePath = join(dir, "run.agentlog");
    const { io } = captureIo();
    const out = sink();
    const err = sink();

    const code = await main(
      ["record", "--out", tapePath, "--", process.execPath, EMIT_SERVER, "0"],
      { ...io, in: Readable.from([]), out: out.stream, err: err.stream },
    );

    expect(code).toBe(0);
    expect(out.text()).toBe(
      '{"jsonrpc":"2.0","id":"emit-1","result":{"ok":true}}\nthis is not json\n',
    );
    expect(err.text()).toBe("emit-server diagnostic output\n");
    const lines = (await readFile(tapePath, "utf8")).trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const record = JSON.parse(line) as Record<string, unknown>;
      expect(record.transport).toBe("stdio");
      expect(record.direction).toBe("server_to_client");
      expect(typeof record.raw).toBe("string");
    }
  }, 15000);

  it("propagates a non-zero child exit code", async () => {
    const dir = await mkdtemp(join(tmpdir(), "actiontape-cli-"));
    const { io } = captureIo();
    const code = await main(
      ["record", "--out", join(dir, "run.agentlog"), "--", process.execPath, EMIT_SERVER, "9"],
      { ...io, in: Readable.from([]), out: sink().stream, err: sink().stream },
    );
    expect(code).toBe(9);
  }, 15000);

  it("fails cleanly when the command cannot be spawned", async () => {
    const dir = await mkdtemp(join(tmpdir(), "actiontape-cli-"));
    const { io, errors } = captureIo();
    const code = await main(
      ["record", "--out", join(dir, "run.agentlog"), "--", "no-such-command-xyz"],
      { ...io, in: Readable.from([]), out: sink().stream, err: sink().stream },
    );
    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("actiontape record:");
  }, 15000);
});

describe("actiontape inspect", () => {
  async function writeTape(dir: string, raws: string[]): Promise<string> {
    const tapePath = join(dir, "tape.agentlog");
    const lines = raws.map((raw, i) =>
      JSON.stringify(
        createWireRecord({
          recordingId: "rec-cli",
          sequence: i,
          direction: i % 2 === 0 ? "client_to_server" : "server_to_client",
          raw,
        }),
      ),
    );
    await writeFile(tapePath, lines.join("\n") + "\n", "utf8");
    return tapePath;
  }

  const CALL = JSON.stringify({
    jsonrpc: "2.0",
    id: "call-1",
    method: "tools/call",
    params: { name: "get_weather", arguments: { location: "New York" } },
  });
  const RESULT = JSON.stringify({
    jsonrpc: "2.0",
    id: "call-1",
    result: { resultType: "complete", content: [{ type: "text", text: "72 F" }] },
  });

  it("prints human-readable action inspection", async () => {
    const dir = await mkdtemp(join(tmpdir(), "actiontape-inspect-"));
    const tape = await writeTape(dir, [CALL, RESULT]);
    const { io, lines } = captureIo();
    expect(await main(["inspect", tape], io)).toBe(0);
    const output = lines.join("\n");
    expect(output).toContain("actions: 1");
    expect(output).toContain("#1 tools/call get_weather — success");
    expect(output).toContain('jsonrpc id: "call-1"');
    expect(output).toContain('"location":"New York"');
  });

  it("emits clean ActionEnvelope JSONL on stdout with --json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "actiontape-inspect-"));
    const tape = await writeTape(dir, [CALL, RESULT]);
    const out = sink();
    const { io, lines } = captureIo();
    const code = await main(["inspect", "--json", tape], { ...io, out: out.stream });
    expect(code).toBe(0);
    expect(lines).toEqual([]);
    const parsed = out
      .text()
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as unknown);
    expect(parsed).toHaveLength(1);
    expect(isActionEnvelope(parsed[0])).toBe(true);
    const action = parsed[0] as Record<string, unknown>;
    expect(action.target).toBe("get_weather");
  });

  it("sends diagnostics to stderr while --json stdout stays clean", async () => {
    const dir = await mkdtemp(join(tmpdir(), "actiontape-inspect-"));
    const tapePath = join(dir, "tape.agentlog");
    const valid = JSON.stringify(
      createWireRecord({ recordingId: "r", sequence: 0, direction: "client_to_server", raw: CALL }),
    );
    await writeFile(tapePath, "garbage line\n" + valid + "\n", "utf8");
    const out = sink();
    const { io, errors } = captureIo();
    expect(await main(["inspect", "--json", tapePath], { ...io, out: out.stream })).toBe(0);
    expect(errors.join("\n")).toContain("malformed_jsonl");
    for (const line of out.text().trim().split("\n")) {
      expect(isActionEnvelope(JSON.parse(line))).toBe(true);
    }
  });

  it("does not execute command-like strings embedded in the tape", async () => {
    const dir = await mkdtemp(join(tmpdir(), "actiontape-inspect-"));
    const marker = join(dir, "should-never-exist");
    const evilCall = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "run", arguments: { cmd: `touch ${marker}` } },
    });
    const tape = await writeTape(dir, [evilCall]);
    const { io, lines } = captureIo();
    expect(await main(["inspect", tape], io)).toBe(0);
    expect(lines.join("\n")).toContain("touch");
    expect(existsSync(marker)).toBe(false);
  });

  it("fails on missing tape path and unreadable files", async () => {
    const { io, errors } = captureIo();
    expect(await main(["inspect"], io)).toBe(2);
    expect(await main(["inspect", "/nonexistent/nope.agentlog"], io)).toBe(1);
    expect(errors.join("\n")).toContain("inspect");
  });

  it("fails on unknown inspect options", async () => {
    const { io } = captureIo();
    expect(await main(["inspect", "--bogus", "x"], io)).toBe(2);
  });
});
