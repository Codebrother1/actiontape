import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
