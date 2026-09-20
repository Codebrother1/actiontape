import { existsSync } from "node:fs";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
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

describe("actiontape check", () => {
  async function writeTape(dir: string, raws: string[]): Promise<string> {
    const tapePath = join(dir, "tape.agentlog");
    const lines = raws.map((raw, i) =>
      JSON.stringify(
        createWireRecord({
          recordingId: "rec-check",
          sequence: i,
          direction: i % 2 === 0 ? "client_to_server" : "server_to_client",
          raw,
        }),
      ),
    );
    await writeFile(tapePath, lines.join("\n") + "\n", "utf8");
    return tapePath;
  }

  async function writeContract(dir: string, text: string): Promise<string> {
    const contractPath = join(dir, "contract.yaml");
    await writeFile(contractPath, text, "utf8");
    return contractPath;
  }

  const PR_CALL = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "create_pull_request", arguments: { base: "main", title: "x" } },
  });
  const PR_RESULT = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { resultType: "complete", content: [] },
  });
  const PASSING_CONTRACT = `contractVersion: "1.0"
rules:
  - id: no-delete
    type: deny
    match:
      target: "delete_*"
  - id: budget
    type: max_calls
    max: 5
  - id: pr-base
    type: require_argument
    match:
      target: create_pull_request
    path: /base
    operator: equals
    value: main
`;

  it("exits 0 on a passing contract", async () => {
    const dir = await mkdtemp(join(tmpdir(), "actiontape-check-"));
    const tape = await writeTape(dir, [PR_CALL, PR_RESULT]);
    const contract = await writeContract(dir, PASSING_CONTRACT);
    const { io, lines } = captureIo();
    expect(await main(["check", tape, "--contract", contract], io)).toBe(0);
    expect(lines.join("\n")).toContain("PASS");
    expect(lines.join("\n")).toContain("violations: 0");
  });

  it("exits 1 on contract violations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "actiontape-check-"));
    const tape = await writeTape(dir, [PR_CALL, PR_RESULT]);
    const contract = await writeContract(
      dir,
      `contractVersion: "1.0"\nrules:\n  - id: pr-base\n    type: require_argument\n    match:\n      target: create_pull_request\n    path: /base\n    operator: equals\n    value: develop\n`,
    );
    const { io, lines } = captureIo();
    expect(await main(["check", tape, "--contract", contract], io)).toBe(1);
    const output = lines.join("\n");
    expect(output).toContain("FAIL");
    expect(output).toContain("[pr-base]");
    expect(output).toContain('"develop"');
  });

  it("exits 2 on a malformed contract", async () => {
    const dir = await mkdtemp(join(tmpdir(), "actiontape-check-"));
    const tape = await writeTape(dir, [PR_CALL, PR_RESULT]);
    const contract = await writeContract(dir, `contractVersion: "9.9"\nrules: nope\n`);
    const { io, errors } = captureIo();
    expect(await main(["check", tape, "--contract", contract], io)).toBe(2);
    expect(errors.join("\n")).toContain("actiontape check:");
  });

  it("exits 2 when the tape produces normalization diagnostics", async () => {
    const dir = await mkdtemp(join(tmpdir(), "actiontape-check-"));
    const orphan = JSON.stringify({ jsonrpc: "2.0", id: 99, result: {} });
    const tapePath = join(dir, "tape.agentlog");
    await writeFile(
      tapePath,
      JSON.stringify(
        createWireRecord({
          recordingId: "rec-check",
          sequence: 0,
          direction: "server_to_client",
          raw: orphan,
        }),
      ) + "\n",
      "utf8",
    );
    const contract = await writeContract(dir, PASSING_CONTRACT);
    const { io, errors } = captureIo();
    expect(await main(["check", tapePath, "--contract", contract], io)).toBe(2);
    expect(errors.join("\n")).toContain("unmatched_response");
  });

  it("emits exactly one JSON object with --json on pass, fail, and error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "actiontape-check-"));
    const tape = await writeTape(dir, [PR_CALL, PR_RESULT]);
    const pass = await writeContract(dir, PASSING_CONTRACT);
    const failContract = await writeFile(
      join(dir, "fail.yaml"),
      `contractVersion: "1.0"\nrules: [{ id: d, type: deny }]\n`,
      "utf8",
    ).then(() => join(dir, "fail.yaml"));
    const bad = join(dir, "bad.yaml");
    await writeFile(bad, "contractVersion: 0\nrules: nope\n", "utf8");

    const runJson = async (contractPath: string) => {
      const out = sink();
      const { io } = captureIo();
      const code = await main(["check", "--json", tape, "--contract", contractPath], {
        ...io,
        out: out.stream,
      });
      const text = out.text();
      const parsed = JSON.parse(text) as Record<string, unknown>;
      return { code, text, parsed };
    };

    const p = await runJson(pass);
    expect(p.code).toBe(0);
    expect(p.parsed.status).toBe("pass");
    expect(p.parsed.violations).toEqual([]);

    const f = await runJson(failContract);
    expect(f.code).toBe(1);
    expect(f.parsed.status).toBe("fail");
    expect(f.parsed.violationCount).toBe(1);

    const e = await runJson(bad);
    expect(e.code).toBe(2);
    expect(e.parsed.status).toBe("error");
    expect(typeof e.parsed.error).toBe("string");

    for (const r of [p, f, e]) {
      expect(r.text.trim().split("\n")).toHaveLength(1);
    }
  });

  it("treats command-like strings in tapes and contracts as inert data", async () => {
    const dir = await mkdtemp(join(tmpdir(), "actiontape-check-"));
    const marker = join(dir, "should-never-exist");
    const evilCall = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "run", arguments: { cmd: `touch ${marker}` } },
    });
    const evilResult = JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} });
    const tape = await writeTape(dir, [evilCall, evilResult]);
    const contract = await writeContract(
      dir,
      `contractVersion: "1.0"\nrules:\n  - id: r\n    type: require_argument\n    path: /cmd\n    operator: equals\n    value: "touch ${marker}"\n`,
    );
    const { io } = captureIo();
    expect(await main(["check", tape, "--contract", contract], io)).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });

  it("exits 2 with a clean single JSON object for non-JSON contract values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "actiontape-check-"));
    const tape = await writeTape(dir, [PR_CALL, PR_RESULT]);
    const contract = await writeContract(
      dir,
      `contractVersion: "1.0"\nrules:\n  - id: r\n    type: require_argument\n    path: /base\n    operator: equals\n    value: .nan\n`,
    );
    const out = sink();
    const { io, errors } = captureIo();
    const code = await main(["check", "--json", tape, "--contract", contract], {
      ...io,
      out: out.stream,
    });
    expect(code).toBe(2);
    const text = out.text();
    expect(text.trim().split("\n")).toHaveLength(1);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed.status).toBe("error");
    expect(typeof parsed.error).toBe("string");
    // No stack trace through normal CLI output.
    expect(errors.join("\n")).not.toMatch(/\n\s+at /);
    expect(errors.join("\n")).toContain("JSON-compatible");
  });

  it("rejects check without --contract and with unknown options", async () => {
    const { io, errors } = captureIo();
    expect(await main(["check", "some.agentlog"], io)).toBe(2);
    expect(await main(["check", "--bogus"], io)).toBe(2);
    expect(errors.join("\n")).toContain("--contract");
  });
});

describe("actiontape authzen", () => {
  async function writeTape(dir: string, raws: string[]): Promise<string> {
    const tapePath = join(dir, "tape.agentlog");
    const lines = raws.map((raw, i) =>
      JSON.stringify(
        createWireRecord({
          recordingId: "rec-az",
          sequence: i,
          direction: i % 2 === 0 ? "client_to_server" : "server_to_client",
          raw,
        }),
      ),
    );
    await writeFile(tapePath, lines.join("\n") + "\n", "utf8");
    return tapePath;
  }

  const call = (id: number, name: string, args: Record<string, unknown> = {}) =>
    JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const ok = (id: number) =>
    JSON.stringify({ jsonrpc: "2.0", id, result: { resultType: "complete", content: [] } });

  async function writeThreeToolTape(dir: string): Promise<string> {
    return writeTape(dir, [
      call(1, "get_weather", { location: "NYC" }),
      ok(1),
      call(2, "delete_file", { path: "/tmp/x" }),
      ok(2),
      call(3, "search", { q: "abc" }),
      ok(3),
    ]);
  }

  describe("export", () => {
    it("emits one default-mapped JSONL request per action", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-az-"));
      const tape = await writeThreeToolTape(dir);
      const out = sink();
      const { io } = captureIo();
      const code = await main(
        ["authzen", "export", tape, "--subject-id", "alice@example.com", "--agent-id", "bot-1"],
        { ...io, out: out.stream },
      );
      expect(code).toBe(0);
      const lines = out.text().trim().split("\n");
      expect(lines).toHaveLength(3);
      const reqs = lines.map(
        (l) => JSON.parse(l) as { resource: { id: string }; context?: unknown },
      );
      expect(reqs[0]).toEqual({
        subject: { type: "identity", id: "alice@example.com" },
        action: { name: "tools/call" },
        resource: { type: "tool", id: "get_weather" },
        context: { agent: "bot-1" },
      });
      expect(reqs.map((r) => r.resource.id)).toEqual(["get_weather", "delete_file", "search"]);
      // Tool arguments must not leak into the exported requests.
      for (const l of lines) {
        expect(l).not.toContain("NYC");
        expect(l).not.toContain("/tmp/x");
        expect(l).not.toContain("abc");
        expect(l).not.toContain("arguments");
      }
    });

    it("omits context without --agent-id and requires --subject-id", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-az-"));
      const tape = await writeTape(dir, [call(1, "t"), ok(1)]);
      const out = sink();
      const { io, errors } = captureIo();
      expect(
        await main(["authzen", "export", tape, "--subject-id", "s"], { ...io, out: out.stream }),
      ).toBe(0);
      const req = JSON.parse(out.text().trim()) as Record<string, unknown>;
      expect(req.context).toBeUndefined();
      expect(await main(["authzen", "export", tape], io)).toBe(2);
      expect(errors.join("\n")).toContain("--subject-id");
    });

    it("fails closed on normalization diagnostics and emits nothing", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-az-"));
      const tapePath = join(dir, "tape.agentlog");
      await writeFile(tapePath, "garbage\n", "utf8");
      const out = sink();
      const { io, errors } = captureIo();
      expect(
        await main(["authzen", "export", tapePath, "--subject-id", "s"], {
          ...io,
          out: out.stream,
        }),
      ).toBe(2);
      expect(out.text()).toBe("");
      expect(errors.join("\n")).toContain("malformed_jsonl");
    });

    it("succeeds with empty output for a tape with no tool calls", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-az-"));
      const initReq = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const initRes = JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} });
      const tape = await writeTape(dir, [initReq, initRes]);
      const out = sink();
      const { io } = captureIo();
      expect(
        await main(["authzen", "export", tape, "--subject-id", "s"], { ...io, out: out.stream }),
      ).toBe(0);
      expect(out.text()).toBe("");
    });
  });

  describe("simulate", () => {
    let pdp: Server | undefined;
    const requests: { resource: { id: string } }[] = [];

    async function startPdp(
      handler: (body: { resource: { id: string } }, res: ServerResponse) => void,
    ): Promise<string> {
      pdp = createServer((req: IncomingMessage, res: ServerResponse) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
            resource: { id: string };
          };
          requests.push(body);
          handler(body, res);
        });
      });
      await new Promise<void>((r) => pdp!.listen(0, "127.0.0.1", r));
      const port = (pdp!.address() as AddressInfo).port;
      return `http://127.0.0.1:${port}/access/v1/evaluation`;
    }
    const stopPdp = () => new Promise((r) => pdp?.close(r));

    it("exits 0 when all permitted, 1 when any denied, preserving order", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-az-"));
      const tape = await writeThreeToolTape(dir);

      const all = await startPdp((_b, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ decision: true }));
      });
      const { io, lines } = captureIo();
      const code = await main(
        ["authzen", "simulate", tape, "--endpoint", all, "--subject-id", "alice"],
        io,
      );
      expect(code).toBe(0);
      const output = lines.join("\n");
      expect(output).toContain("AUTHZEN PASS");
      expect(output).toContain("permitted: 3");
      expect(requests).toHaveLength(3);
      await stopPdp();
      requests.length = 0;

      const deny = await startPdp((b, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ decision: b.resource.id !== "delete_file" }));
      });
      const { io: io2, lines: lines2 } = captureIo();
      const code2 = await main(
        ["authzen", "simulate", tape, "--endpoint", deny, "--subject-id", "alice"],
        io2,
      );
      expect(code2).toBe(1);
      const out2 = lines2.join("\n");
      expect(out2).toContain("AUTHZEN DENY");
      expect(out2).toContain("denied: 1");
      expect(out2).toContain("DENY delete_file");
      // Deny does not stop later evaluations: all 3 reached the PDP in order.
      expect(requests.map((r) => r.resource.id)).toEqual(["get_weather", "delete_file", "search"]);
      // No tool arguments reach the PDP.
      for (const r of requests) {
        expect(JSON.stringify(r)).not.toContain("/tmp/x");
        expect(JSON.stringify(r)).not.toContain("arguments");
      }
      await stopPdp();
      requests.length = 0;
    });

    it("exits 2 on PDP failure and stops further requests", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-az-"));
      const tape = await writeThreeToolTape(dir);
      const url = await startPdp((b, res) => {
        res.writeHead(b.resource.id === "get_weather" ? 200 : 500);
        res.end(JSON.stringify({ decision: true }));
      });
      const { io, errors } = captureIo();
      expect(
        await main(["authzen", "simulate", tape, "--endpoint", url, "--subject-id", "s"], io),
      ).toBe(2);
      expect(requests).toHaveLength(2); // failed closed after HTTP 500
      expect(errors.join("\n")).toContain("HTTP 500");
      await stopPdp();
      requests.length = 0;
    });

    it("exits 2 on normalization diagnostics without contacting the PDP", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-az-"));
      const tapePath = join(dir, "tape.agentlog");
      await writeFile(tapePath, "garbage\n", "utf8");
      const url = await startPdp((_b, res) => res.end(JSON.stringify({ decision: true })));
      const { io } = captureIo();
      expect(
        await main(["authzen", "simulate", tapePath, "--endpoint", url, "--subject-id", "s"], io),
      ).toBe(2);
      expect(requests).toHaveLength(0);
      await stopPdp();
    });

    it("emits exactly one JSON object for pass, deny, and error", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-az-"));
      const tape = await writeThreeToolTape(dir);

      const runJson = async (endpoint: string) => {
        const out = sink();
        const { io } = captureIo();
        const code = await main(
          ["authzen", "simulate", "--json", tape, "--endpoint", endpoint, "--subject-id", "s"],
          { ...io, out: out.stream },
        );
        const text = out.text();
        return { code, parsed: JSON.parse(text) as Record<string, unknown>, text };
      };

      const permit = await startPdp((_b, res) => res.end(JSON.stringify({ decision: true })));
      const p = await runJson(permit);
      expect(p.code).toBe(0);
      expect(p.parsed.status).toBe("pass");
      expect(p.parsed.permitCount).toBe(3);
      await stopPdp();
      requests.length = 0;

      const deny = await startPdp((b, res) =>
        res.end(JSON.stringify({ decision: b.resource.id !== "search" })),
      );
      const d = await runJson(deny);
      expect(d.code).toBe(1);
      expect(d.parsed.status).toBe("deny");
      expect(d.parsed.denyCount).toBe(1);
      await stopPdp();
      requests.length = 0;

      const broken = await startPdp((_b, res) => res.end("not json"));
      const e = await runJson(broken);
      expect(e.code).toBe(2);
      expect(e.parsed.status).toBe("error");
      expect(typeof e.parsed.error).toBe("string");
      await stopPdp();
      requests.length = 0;

      for (const r of [p, d, e]) {
        expect(r.text.trim().split("\n")).toHaveLength(1);
      }
    });

    it("exits 2 on missing endpoint, bad scheme, and timeout", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-az-"));
      const tape = await writeTape(dir, [call(1, "t"), ok(1)]);
      const { io, errors } = captureIo();
      expect(await main(["authzen", "simulate", tape, "--subject-id", "s"], io)).toBe(2);
      expect(errors.join("\n")).toContain("--endpoint");

      expect(
        await main(
          ["authzen", "simulate", tape, "--endpoint", "file:///x", "--subject-id", "s"],
          io,
        ),
      ).toBe(2);

      const slow = await startPdp(() => {});
      expect(
        await main(
          [
            "authzen",
            "simulate",
            tape,
            "--endpoint",
            slow,
            "--subject-id",
            "s",
            "--timeout-ms",
            "50",
          ],
          io,
        ),
      ).toBe(2);
      expect(errors.join("\n")).toContain("timed out");
      await stopPdp();
    });
  });

  describe("plan", () => {
    async function writeDirTape(
      dir: string,
      msgs: [dir: "client_to_server" | "server_to_client", raw: unknown][],
    ): Promise<string> {
      const tapePath = join(dir, "tape.agentlog");
      const lines = msgs.map(([direction, raw], i) =>
        JSON.stringify(
          createWireRecord({
            recordingId: "rec-plan",
            sequence: i,
            direction,
            raw: JSON.stringify(raw),
          }),
        ),
      );
      await writeFile(tapePath, lines.join("\n") + "\n", "utf8");
      return tapePath;
    }
    const req = (id: number, method: string, params?: unknown) =>
      ({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }) as const;
    const res = (id: number, result: unknown) => ({ jsonrpc: "2.0", id, result }) as const;
    const call = (id: number, name: string, args: Record<string, unknown> = {}) =>
      req(id, "tools/call", { name, arguments: args });
    const tool = (name: string, mapping?: unknown) => ({
      name,
      inputSchema: {
        type: "object",
        ...(mapping !== undefined ? { "x-authzen-mapping": mapping } : {}),
      },
    });

    it("exit 0 when all actions have known provenance (declared + default)", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-plan-"));
      const tape = await writeDirTape(dir, [
        ["client_to_server", req(1, "tools/list")],
        [
          "server_to_client",
          res(1, { tools: [tool("get_customer", { evaluation: "x" }), tool("get_weather")] }),
        ],
        ["client_to_server", call(2, "get_customer")],
        ["server_to_client", res(2, {})],
        ["client_to_server", call(3, "get_weather")],
        ["server_to_client", res(3, {})],
      ]);
      const { io, lines } = captureIo();
      expect(await main(["authzen", "plan", tape], io)).toBe(0);
      const out = lines.join("\n");
      expect(out).toContain("declared: 1");
      expect(out).toContain("default-confirmed: 1");
      expect(out).toContain("DECLARED get_customer");
      expect(out).toContain("DEFAULT  get_weather");
      expect(out).not.toContain("evaluation");
    });

    it("exit 1 with unknown provenance when no catalog exists", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-plan-"));
      const tape = await writeDirTape(dir, [
        ["client_to_server", call(1, "mystery", { evil: "$(touch /tmp/x)" })],
        ["server_to_client", res(1, {})],
      ]);
      const { io, lines } = captureIo();
      expect(await main(["authzen", "plan", tape], io)).toBe(1);
      const out = lines.join("\n");
      expect(out).toContain("unknown: 1");
      expect(out).toContain("no completed catalog");
      expect(out).not.toContain("/tmp/x");
    });

    it("exit 1 when catalog was invalidated before the call", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-plan-"));
      const tape = await writeDirTape(dir, [
        ["client_to_server", req(1, "tools/list")],
        ["server_to_client", res(1, { tools: [tool("a")] })],
        ["server_to_client", req(0, "notifications/tools/list_changed")],
        ["client_to_server", call(2, "a")],
        ["server_to_client", res(2, {})],
      ]);
      const { io, lines } = captureIo();
      expect(await main(["authzen", "plan", tape], io)).toBe(1);
      expect(lines.join("\n")).toContain("invalidated");
    });

    it("resolves a tool from the second page of a paginated catalog", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-plan-"));
      const tape = await writeDirTape(dir, [
        ["client_to_server", req(1, "tools/list")],
        ["server_to_client", res(1, { tools: [tool("a")], nextCursor: "c1" })],
        ["client_to_server", req(2, "tools/list", { cursor: "c1" })],
        ["server_to_client", res(2, { tools: [tool("deep_tool")] })],
        ["client_to_server", call(3, "deep_tool")],
        ["server_to_client", res(3, {})],
      ]);
      const { io, lines } = captureIo();
      expect(await main(["authzen", "plan", tape], io)).toBe(0);
      expect(lines.join("\n")).toContain("DEFAULT  deep_tool");
    });

    it("exit 2 on normalization diagnostics, with clean --json error object", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-plan-"));
      const tapePath = join(dir, "tape.agentlog");
      await writeFile(tapePath, "garbage\n", "utf8");
      const out = sink();
      const { io, errors } = captureIo();
      expect(await main(["authzen", "plan", "--json", tapePath], { ...io, out: out.stream })).toBe(
        2,
      );
      const parsed = JSON.parse(out.text()) as Record<string, unknown>;
      expect(out.text().trim().split("\n")).toHaveLength(1);
      expect(parsed.status).toBe("error");
      expect(errors.join("\n")).toContain("malformed_jsonl");
      expect(errors.join("\n")).not.toMatch(/\n\s+at /);
    });

    it("--json emits exactly one object for complete and incomplete plans", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-plan-"));
      const complete = await writeDirTape(dir, [
        ["client_to_server", req(1, "tools/list")],
        ["server_to_client", res(1, { tools: [tool("t", { evaluation: "e" })] })],
        ["client_to_server", call(2, "t")],
        ["server_to_client", res(2, {})],
      ]);
      const incomplete = await (async () => {
        const p = join(dir, "tape2.agentlog");
        const lines = [
          JSON.stringify(
            createWireRecord({
              recordingId: "rec-plan",
              sequence: 0,
              direction: "client_to_server",
              raw: JSON.stringify(call(1, "t")),
            }),
          ),
          JSON.stringify(
            createWireRecord({
              recordingId: "rec-plan",
              sequence: 1,
              direction: "server_to_client",
              raw: JSON.stringify(res(1, {})),
            }),
          ),
        ];
        await writeFile(p, lines.join("\n") + "\n", "utf8");
        return p;
      })();

      const runJson = async (tape: string) => {
        const out = sink();
        const { io } = captureIo();
        const code = await main(["authzen", "plan", "--json", tape], { ...io, out: out.stream });
        const text = out.text();
        expect(text.trim().split("\n")).toHaveLength(1);
        return { code, parsed: JSON.parse(text) as Record<string, unknown> };
      };

      const c = await runJson(complete);
      expect(c.code).toBe(0);
      expect(c.parsed.status).toBe("complete");
      expect((c.parsed.actions as { declaredMapping: unknown }[])[0]!.declaredMapping).toEqual({
        evaluation: "e",
      });

      const i = await runJson(incomplete);
      expect(i.code).toBe(1);
      expect(i.parsed.status).toBe("incomplete");
      expect(i.parsed.unknownCount).toBe(1);
    });

    it("treats suspicious mapping content as inert data", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-plan-"));
      const marker = join(dir, "never-created");
      const tape = await writeDirTape(dir, [
        ["client_to_server", req(1, "tools/list")],
        [
          "server_to_client",
          res(1, { tools: [tool("t", { eval: `$(touch ${marker})`, fn: "function(){}" })] }),
        ],
        ["client_to_server", call(2, "t")],
        ["server_to_client", res(2, {})],
      ]);
      const out = sink();
      const { io } = captureIo();
      expect(await main(["authzen", "plan", "--json", tape], { ...io, out: out.stream })).toBe(0);
      expect(existsSync(marker)).toBe(false);
      // human output never dumps the mapping body
      const { io: io2, lines: lines2 } = captureIo();
      await main(["authzen", "plan", tape], io2);
      expect(lines2.join("\n")).not.toContain("touch");
      expect(out.text()).toContain("touch"); // json may carry the raw mapping as data
    });

    it("ambiguous pagination yields UNKNOWN, never declared/default", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-plan-"));
      const tape = await writeDirTape(dir, [
        ["client_to_server", req(1, "tools/list")],
        ["server_to_client", res(1, { tools: [tool("a")], nextCursor: "collision" })],
        ["client_to_server", req(2, "tools/list")],
        ["server_to_client", res(2, { tools: [tool("b")], nextCursor: "collision" })],
        ["client_to_server", req(3, "tools/list", { cursor: "collision" })],
        ["server_to_client", res(3, { tools: [tool("c")] })],
        ["client_to_server", call(4, "a")],
        ["server_to_client", res(4, {})],
      ]);
      const out = sink();
      const { io } = captureIo();
      // Ambiguity is evidence-insufficiency, not an operational failure.
      const code = await main(["authzen", "plan", "--json", tape], { ...io, out: out.stream });
      expect(code).toBe(1);
      const parsed = JSON.parse(out.text()) as Record<string, unknown>;
      expect(out.text().trim().split("\n")).toHaveLength(1);
      expect(parsed.status).toBe("incomplete");
      expect((parsed.actions as { mappingSource: string }[])[0]!.mappingSource).toBe("unknown");
    });

    it("exit 0 with zero counts when the tape has no tool calls", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-plan-"));
      const tape = await writeDirTape(dir, [
        ["client_to_server", req(1, "tools/list")],
        ["server_to_client", res(1, { tools: [tool("a")] })],
      ]);
      const { io, lines } = captureIo();
      expect(await main(["authzen", "plan", tape], io)).toBe(0);
      expect(lines.join("\n")).toContain("actions: 0");
    });
  });

  describe("render", () => {
    async function writeDirTape(
      dir: string,
      msgs: [dir: "client_to_server" | "server_to_client", raw: unknown][],
    ): Promise<string> {
      const tapePath = join(dir, `tape-${msgs.length}-${Date.now()}.agentlog`);
      const lines = msgs.map(([direction, raw], i) =>
        JSON.stringify(
          createWireRecord({
            recordingId: "rec-render",
            sequence: i,
            direction,
            raw: JSON.stringify(raw),
          }),
        ),
      );
      await writeFile(tapePath, lines.join("\n") + "\n", "utf8");
      return tapePath;
    }
    const req = (id: number, method: string, params?: unknown) =>
      ({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }) as const;
    const res = (id: number, result: unknown) => ({ jsonrpc: "2.0", id, result }) as const;
    const call = (id: number, name: string, args: Record<string, unknown> = {}) =>
      req(id, "tools/call", { name, arguments: args });
    const tool = (name: string, mapping?: unknown) => ({
      name,
      inputSchema: {
        type: "object",
        ...(mapping !== undefined ? { "x-authzen-mapping": mapping } : {}),
      },
    });
    const catalog = (...tools: unknown[]) => ({ tools });

    async function writeClaims(dir: string, claims: unknown): Promise<string> {
      const p = join(dir, `claims-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
      await writeFile(p, typeof claims === "string" ? claims : JSON.stringify(claims), "utf8");
      return p;
    }
    const CLAIMS = { sub: "alice@example.com", client_id: "agent-demo" };

    const GET_CUSTOMER_MAPPING = {
      evaluation: {
        subject: { type: "identity", id: "$token.sub" },
        action: { name: "get_customer" },
        resource: { type: "customer", id: "$params.arguments.id" },
        context: { agent: "$token.?client_id" },
      },
    };

    async function runJson(tape: string, claims: string) {
      const out = sink();
      const { io, errors } = captureIo();
      const code = await main(["authzen", "render", "--json", tape, "--token-claims", claims], {
        ...io,
        out: out.stream,
      });
      const text = out.text();
      expect(text.trim().split("\n")).toHaveLength(1);
      return {
        code,
        errors,
        parsed: JSON.parse(text) as Record<string, unknown> & {
          actions: Record<string, unknown>[];
        },
      };
    }

    it("renders declared and default requests, exit 0", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-render-"));
      const tape = await writeDirTape(dir, [
        ["client_to_server", req(1, "tools/list")],
        [
          "server_to_client",
          res(1, catalog(tool("get_customer", GET_CUSTOMER_MAPPING), tool("get_weather"))),
        ],
        ["client_to_server", call(2, "get_customer", { id: "cust-123" })],
        ["server_to_client", res(2, {})],
        ["client_to_server", call(3, "get_weather", { location: "Dallas" })],
        ["server_to_client", res(3, {})],
      ]);
      const claims = await writeClaims(dir, CLAIMS);
      const { io, lines } = captureIo();
      expect(await main(["authzen", "render", tape, "--token-claims", claims], io)).toBe(0);
      const out = lines.join("\n");
      expect(out).toContain("declared: 1");
      expect(out).toContain("default: 1");
      expect(out).toContain("requests: 2");
      expect(out).toContain("DECLARED get_customer");
      expect(out).toContain("DEFAULT  get_weather");
      // human output never carries arguments, claims, mapping, or request bodies
      expect(out).not.toContain("cust-123");
      expect(out).not.toContain("alice@example.com");
      expect(out).not.toContain("Dallas");

      const j = await runJson(tape, claims);
      expect(j.code).toBe(0);
      expect(j.parsed.status).toBe("complete");
      expect(j.parsed.requestCount).toBe(2);
      const [cust, weather] = j.parsed.actions;
      expect(cust!.status).toBe("rendered_declared");
      expect(cust!.envelope).toBe("evaluation");
      expect(cust!.decisionCount).toBe(1);
      expect(cust!.request).toEqual({
        subject: { type: "identity", id: "alice@example.com" },
        action: { name: "get_customer" },
        resource: { type: "customer", id: "cust-123" },
        context: { agent: "agent-demo" },
      });
      expect(weather!.status).toBe("rendered_default");
      expect(weather!.request).toEqual({
        subject: { type: "identity", id: "alice@example.com" },
        action: { name: "tools/call" },
        resource: { type: "tool", id: "get_weather" },
        context: { agent: "agent-demo" },
      });
      // never leaks raw token claims / mapping / inputSchema / arguments
      const raw = JSON.stringify(j.parsed);
      expect(raw).not.toContain('"roles"');
      expect(raw).not.toContain("inputSchema");
      expect(raw).not.toContain("x-authzen-mapping");
      expect(raw).not.toContain("Dallas");
    });

    it("exit 1 with UNKNOWN when no catalog exists", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-render-"));
      const tape = await writeDirTape(dir, [
        ["client_to_server", call(1, "mystery")],
        ["server_to_client", res(1, {})],
      ]);
      const claims = await writeClaims(dir, CLAIMS);
      const j = await runJson(tape, claims);
      expect(j.code).toBe(1);
      expect(j.parsed.status).toBe("incomplete");
      const [a] = j.parsed.actions;
      expect(a!.status).toBe("unknown");
      expect(a!.request).toBeNull();
      expect(a!.reason).toBe("no_catalog");
    });

    it("continues past a per-action mapping error, exit 1", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-render-"));
      const badMapping = {
        evaluation: {
          action: { name: "x" },
          resource: { type: "r", id: "$params.arguments.missing" },
        },
      };
      const tape = await writeDirTape(dir, [
        ["client_to_server", req(1, "tools/list")],
        [
          "server_to_client",
          res(
            1,
            catalog(
              tool("get_customer", GET_CUSTOMER_MAPPING),
              tool("broken", badMapping),
              tool("plain"),
            ),
          ),
        ],
        ["client_to_server", call(2, "get_customer", { id: "cust-1" })],
        ["server_to_client", res(2, {})],
        ["client_to_server", call(3, "broken")],
        ["server_to_client", res(3, {})],
        ["client_to_server", call(4, "plain")],
        ["server_to_client", res(4, {})],
      ]);
      const claims = await writeClaims(dir, CLAIMS);
      const j = await runJson(tape, claims);
      expect(j.code).toBe(1);
      expect(j.parsed.actions.map((a) => a.status)).toEqual([
        "rendered_declared",
        "mapping_error",
        "rendered_default",
      ]);
      expect(j.parsed.actions[1]!.reason).toContain("missing");
    });

    it("uses exact historical request params including requestState/inputResponses", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-render-"));
      const mapping = {
        evaluation: {
          action: { name: "interactive_tool" },
          resource: {
            type: "interaction",
            id: "$params.requestState",
            properties: { approval: "$params.inputResponses.approval" },
          },
        },
      };
      const tape = await writeDirTape(dir, [
        ["client_to_server", req(1, "tools/list")],
        ["server_to_client", res(1, catalog(tool("interactive_tool", mapping)))],
        [
          "client_to_server",
          req(2, "tools/call", {
            name: "interactive_tool",
            arguments: { answer: "yes" },
            requestState: "opaque-state-123",
            inputResponses: { approval: "confirmed" },
            _meta: { note: "x" },
          }),
        ],
        ["server_to_client", res(2, {})],
      ]);
      const claims = await writeClaims(dir, CLAIMS);
      const j = await runJson(tape, claims);
      expect(j.code).toBe(0);
      const req0 = j.parsed.actions[0]!.request as Record<string, unknown>;
      expect(req0.resource).toEqual({
        type: "interaction",
        id: "opaque-state-123",
        properties: { approval: "confirmed" },
      });
    });

    it("renders each MRTR round with its own historical params", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-render-"));
      const mapping = {
        evaluation: {
          action: { name: "interactive_tool" },
          resource: { type: "interaction", id: "$params.requestState" },
        },
      };
      const tape = await writeDirTape(dir, [
        ["client_to_server", req(1, "tools/list")],
        ["server_to_client", res(1, catalog(tool("interactive_tool", mapping)))],
        [
          "client_to_server",
          req(2, "tools/call", {
            name: "interactive_tool",
            arguments: {},
            requestState: "round-1",
          }),
        ],
        ["server_to_client", res(2, { resultType: "input_required" })],
        [
          "client_to_server",
          req(3, "tools/call", {
            name: "interactive_tool",
            arguments: { answer: "yes" },
            requestState: "round-2",
          }),
        ],
        ["server_to_client", res(3, { resultType: "complete" })],
      ]);
      const claims = await writeClaims(dir, CLAIMS);
      const j = await runJson(tape, claims);
      expect(j.code).toBe(0);
      expect(j.parsed.actions).toHaveLength(2);
      const resources = j.parsed.actions.map(
        (a) => (a.request as { resource: { id: string } }).resource.id,
      );
      expect(resources).toEqual(["round-1", "round-2"]);
    });

    it("uses the catalog version applicable at each call's time", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-render-"));
      const mappingA = {
        evaluation: {
          action: { name: "t" },
          resource: { type: "version", id: '$"v1"' },
        },
      };
      const mappingB = {
        evaluation: {
          action: { name: "t" },
          resource: { type: "version", id: '$"v2"' },
        },
      };
      const tape = await writeDirTape(dir, [
        ["client_to_server", req(1, "tools/list")],
        ["server_to_client", res(1, catalog(tool("x", mappingA)))],
        ["client_to_server", call(2, "x")],
        ["server_to_client", res(2, {})],
        ["client_to_server", req(3, "tools/list")],
        ["server_to_client", res(3, catalog(tool("x", mappingB)))],
        ["client_to_server", call(4, "x")],
        ["server_to_client", res(4, {})],
      ]);
      const claims = await writeClaims(dir, CLAIMS);
      const j = await runJson(tape, claims);
      expect(j.code).toBe(0);
      const ids = j.parsed.actions.map(
        (a) => (a.request as { resource: { id: string } }).resource.id,
      );
      expect(ids).toEqual(["v1", "v2"]);
    });

    it("follows declared->default and default->declared catalog changes", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-render-"));
      const tape = await writeDirTape(dir, [
        ["client_to_server", req(1, "tools/list")],
        ["server_to_client", res(1, catalog(tool("x", GET_CUSTOMER_MAPPING)))],
        ["client_to_server", call(2, "x", { id: "cust-9" })],
        ["server_to_client", res(2, {})],
        ["client_to_server", req(3, "tools/list")],
        ["server_to_client", res(3, catalog(tool("x")))],
        ["client_to_server", call(4, "x", { id: "cust-9" })],
        ["server_to_client", res(4, {})],
      ]);
      const claims = await writeClaims(dir, CLAIMS);
      const j = await runJson(tape, claims);
      expect(j.code).toBe(0);
      expect(j.parsed.actions.map((a) => a.status)).toEqual([
        "rendered_declared",
        "rendered_default",
      ]);

      const tape2 = await writeDirTape(dir, [
        ["client_to_server", req(1, "tools/list")],
        ["server_to_client", res(1, catalog(tool("x")))],
        ["client_to_server", call(2, "x")],
        ["server_to_client", res(2, {})],
        ["client_to_server", req(3, "tools/list")],
        [
          "server_to_client",
          res(
            3,
            catalog(
              tool("x", {
                evaluation: {
                  action: { name: "x" },
                  resource: { type: "r", id: '$"fixed"' },
                },
              }),
            ),
          ),
        ],
        ["client_to_server", call(4, "x")],
        ["server_to_client", res(4, {})],
      ]);
      const j2 = await runJson(tape2, claims);
      expect(j2.parsed.actions.map((a) => a.status)).toEqual([
        "rendered_default",
        "rendered_declared",
      ]);
    });

    it("keeps calls UNKNOWN during a stale interval, renders after refresh", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-render-"));
      const tape = await writeDirTape(dir, [
        ["client_to_server", req(1, "tools/list")],
        ["server_to_client", res(1, catalog(tool("a")))],
        ["server_to_client", req(0, "notifications/tools/list_changed")],
        ["client_to_server", call(2, "a")],
        ["server_to_client", res(2, {})],
        ["client_to_server", req(3, "tools/list")],
        ["server_to_client", res(3, catalog(tool("a")))],
        ["client_to_server", call(4, "a")],
        ["server_to_client", res(4, {})],
      ]);
      const claims = await writeClaims(dir, CLAIMS);
      const j = await runJson(tape, claims);
      expect(j.code).toBe(1);
      expect(j.parsed.actions.map((a) => a.status)).toEqual(["unknown", "rendered_default"]);
    });

    it("renders an evaluations envelope with decisionCount and one request", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-render-"));
      const copyMapping = {
        evaluations: {
          subject: { type: "identity", id: "$token.sub" },
          evaluations: [
            {
              action: { name: "read" },
              resource: { type: "file", id: "$params.arguments.source" },
            },
            {
              action: { name: "write" },
              resource: { type: "file", id: "$params.arguments.dest" },
            },
          ],
        },
      };
      const tape = await writeDirTape(dir, [
        ["client_to_server", req(1, "tools/list")],
        ["server_to_client", res(1, catalog(tool("copy", copyMapping)))],
        ["client_to_server", call(2, "copy", { source: "/a", dest: "/b" })],
        ["server_to_client", res(2, {})],
      ]);
      const claims = await writeClaims(dir, CLAIMS);
      const j = await runJson(tape, claims);
      expect(j.code).toBe(0);
      const a = j.parsed.actions[0]!;
      expect(a.status).toBe("rendered_declared");
      expect(a.envelope).toBe("evaluations");
      expect(a.decisionCount).toBe(2);
      expect(j.parsed.requestCount).toBe(1);
      const { io, lines } = captureIo();
      await main(["authzen", "render", tape, "--token-claims", claims], io);
      expect(lines.join("\n")).toContain("evaluations (2 decisions)");
    });

    it("reports subject override as a warning, still exit 0", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-render-"));
      const mapping = {
        evaluation: {
          subject: { type: "identity", id: '$"other@example.com"' },
          action: { name: "t" },
          resource: { type: "r", id: '$"r1"' },
        },
      };
      const tape = await writeDirTape(dir, [
        ["client_to_server", req(1, "tools/list")],
        ["server_to_client", res(1, catalog(tool("t", mapping)))],
        ["client_to_server", call(2, "t")],
        ["server_to_client", res(2, {})],
      ]);
      const claims = await writeClaims(dir, CLAIMS);
      const j = await runJson(tape, claims);
      expect(j.code).toBe(0);
      expect(j.parsed.status).toBe("complete");
      expect(j.parsed.actions[0]!.warnings).toEqual([
        expect.objectContaining({ code: "subject_id_override" }),
      ]);
    });

    it("rejects malformed, scalar, oversized, and missing token claims", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-render-"));
      const tape = await writeDirTape(dir, [
        ["client_to_server", req(1, "tools/list")],
        ["server_to_client", res(1, catalog(tool("a")))],
        ["client_to_server", call(2, "a")],
        ["server_to_client", res(2, {})],
      ]);
      const malformed = await writeClaims(dir, "{not json");
      const scalar = await writeClaims(dir, '"just a string"');
      const oversized = join(dir, "big.json");
      await writeFile(oversized, `{"sub":"${"x".repeat(3 * 1024 * 1024)}"}`, "utf8");

      const out = sink();
      const { io } = captureIo();
      const run = (claims: string) =>
        main(["authzen", "render", "--json", tape, "--token-claims", claims], {
          ...io,
          out: out.stream,
        });
      expect(await run(malformed)).toBe(2);
      expect(await run(scalar)).toBe(2);
      expect(await run(oversized)).toBe(2);
      expect(await run(join(dir, "nonexistent.json"))).toBe(2);

      const { io: io2, errors } = captureIo();
      expect(await main(["authzen", "render", tape], io2)).toBe(2);
      expect(errors.join("\n")).toContain("--token-claims");
    });

    it("token.sub invalid produces per-action mapping errors, not a crash", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-render-"));
      const tape = await writeDirTape(dir, [
        ["client_to_server", req(1, "tools/list")],
        ["server_to_client", res(1, catalog(tool("a")))],
        ["client_to_server", call(2, "a")],
        ["server_to_client", res(2, {})],
      ]);
      const claims = await writeClaims(dir, { sub: 42 });
      const j = await runJson(tape, claims);
      expect(j.code).toBe(1);
      expect(j.parsed.actions[0]!.status).toBe("mapping_error");
      expect(j.parsed.actions[0]!.reason).toContain("token.sub");
    });

    it("non-string client_id is a mapping error for default mapping only", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-render-"));
      const tape = await writeDirTape(dir, [
        ["client_to_server", req(1, "tools/list")],
        ["server_to_client", res(1, catalog(tool("a"), tool("cust", GET_CUSTOMER_MAPPING)))],
        ["client_to_server", call(2, "a")],
        ["server_to_client", res(2, {})],
        ["client_to_server", call(3, "cust", { id: "c" })],
        ["server_to_client", res(3, {})],
      ]);
      const claims = await writeClaims(dir, { sub: "s@x", client_id: 42 });
      const j = await runJson(tape, claims);
      expect(j.code).toBe(1);
      expect(j.parsed.actions[0]!.status).toBe("mapping_error");
      expect(j.parsed.actions[0]!.reason).toContain("client_id");
      // declared mapping still renders; $token.?client_id treats 42 as present
      expect(j.parsed.actions[1]!.status).toBe("rendered_declared");
    });

    it("unsafe CEL integer result is a per-action mapping error", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-render-"));
      const mapping = {
        evaluation: {
          action: { name: "t" },
          resource: { type: "r", id: '$"r1"' },
          context: { n: "$9007199254740993" },
        },
      };
      const tape = await writeDirTape(dir, [
        ["client_to_server", req(1, "tools/list")],
        ["server_to_client", res(1, catalog(tool("t", mapping)))],
        ["client_to_server", call(2, "t")],
        ["server_to_client", res(2, {})],
      ]);
      const claims = await writeClaims(dir, CLAIMS);
      const j = await runJson(tape, claims);
      expect(j.code).toBe(1);
      expect(j.parsed.actions[0]!.status).toBe("mapping_error");
    });

    it("exit 2 on normalization diagnostics with clean --json error object", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-render-"));
      const tapePath = join(dir, "tape.agentlog");
      await writeFile(tapePath, "garbage\n", "utf8");
      const claims = await writeClaims(dir, CLAIMS);
      const j = await runJson(tapePath, claims);
      expect(j.code).toBe(2);
      expect(j.parsed.status).toBe("error");
      expect(j.errors.join("\n")).toContain("malformed_jsonl");
      expect(j.errors.join("\n")).not.toMatch(/\n\s+at /);
    });

    it("keeps command-looking strings inert across args, claims, and mapping", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-render-"));
      const marker = join(dir, "never-created");
      const mapping = {
        evaluation: {
          action: { name: "t" },
          resource: { type: "r", id: "$params.arguments.cmd" },
          context: { lit: `$$(touch ${marker})` },
        },
      };
      const tape = await writeDirTape(dir, [
        ["client_to_server", req(1, "tools/list")],
        ["server_to_client", res(1, catalog(tool("t", mapping)))],
        ["client_to_server", call(2, "t", { cmd: `$(touch ${marker})` })],
        ["server_to_client", res(2, {})],
      ]);
      const claims = await writeClaims(dir, { sub: "s@x", note: `$(touch ${marker})` });
      const j = await runJson(tape, claims);
      expect(j.code).toBe(0);
      expect(existsSync(marker)).toBe(false);
      // the rendered request may contain the literal projected value as data
      const req0 = j.parsed.actions[0]!.request as { context: { lit: string } };
      expect(req0.context.lit).toBe(`$(touch ${marker})`);
    });

    it("exit 0 with zero counts when the tape has no tool calls", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-render-"));
      const tape = await writeDirTape(dir, [
        ["client_to_server", req(1, "tools/list")],
        ["server_to_client", res(1, catalog(tool("a")))],
      ]);
      const claims = await writeClaims(dir, CLAIMS);
      const j = await runJson(tape, claims);
      expect(j.code).toBe(0);
      expect(j.parsed.status).toBe("complete");
      expect(j.parsed.actionCount).toBe(0);
      expect(j.parsed.requestCount).toBe(0);
    });
  });
  describe("audit", () => {
    async function writeDirTape(
      dir: string,
      msgs: [dir: "client_to_server" | "server_to_client", raw: unknown][],
      name = "tape",
    ): Promise<string> {
      const tapePath = join(dir, `${name}-${msgs.length}-${Date.now()}.agentlog`);
      const lines = msgs.map(([direction, raw], i) =>
        JSON.stringify(
          createWireRecord({
            recordingId: "rec-audit",
            sequence: i,
            direction,
            raw: JSON.stringify(raw),
          }),
        ),
      );
      await writeFile(tapePath, lines.join("\n") + "\n", "utf8");
      return tapePath;
    }
    const req = (id: number, method: string, params?: unknown) =>
      ({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) }) as const;
    const res = (id: number, result: unknown) => ({ jsonrpc: "2.0", id, result }) as const;
    const call = (id: number, name: string, args: Record<string, unknown> = {}) =>
      req(id, "tools/call", { name, arguments: args });
    const tool = (name: string, mapping?: unknown) => ({
      name,
      inputSchema: {
        type: "object",
        ...(mapping !== undefined ? { "x-authzen-mapping": mapping } : {}),
      },
    });
    const catalog = (...tools: unknown[]) => ({ tools });

    async function writeClaims(dir: string, claims: unknown): Promise<string> {
      const p = join(dir, `claims-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
      await writeFile(p, typeof claims === "string" ? claims : JSON.stringify(claims), "utf8");
      return p;
    }
    const CLAIMS = { sub: "alice@example.com", client_id: "agent-demo" };

    const GET_CUSTOMER_MAPPING = {
      evaluation: {
        subject: { type: "identity", id: "$token.sub" },
        action: { name: "get_customer" },
        resource: { type: "customer", id: "$params.arguments.id" },
        context: { agent: "$token.?client_id" },
      },
    };
    const COPY_MAPPING = {
      evaluations: {
        subject: { type: "identity", id: "$token.sub" },
        evaluations: [
          { action: { name: "read" }, resource: { type: "file", id: "$params.arguments.source" } },
          { action: { name: "write" }, resource: { type: "file", id: "$params.arguments.dest" } },
        ],
      },
    };

    interface CapturedRequest {
      path?: string;
      body: Record<string, unknown>;
    }

    const pdps: Server[] = [];
    afterEach(async () => {
      while (pdps.length > 0) {
        const pdp = pdps.pop()!;
        await new Promise<void>((r) => pdp.close(() => r()));
      }
    });

    async function startPdp(
      handler: (body: Record<string, unknown>, res: ServerResponse, path: string) => void,
    ): Promise<{ url: string; evalUrl: string; batchUrl: string; captured: CapturedRequest[] }> {
      const captured: CapturedRequest[] = [];
      const pdp = createServer((req: IncomingMessage, res: ServerResponse) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
            string,
            unknown
          >;
          captured.push({ path: req.url, body });
          handler(body, res, req.url ?? "");
        });
      });
      pdps.push(pdp);
      await new Promise<void>((r) => pdp.listen(0, "127.0.0.1", r));
      const port = (pdp.address() as AddressInfo).port;
      return {
        url: `http://127.0.0.1:${port}`,
        evalUrl: `http://127.0.0.1:${port}/access/v1/evaluation`,
        batchUrl: `http://127.0.0.1:${port}/access/v1/evaluations`,
        captured,
      };
    }

    async function runAuditJson(tape: string, claims: string, extra: string[] = []) {
      const out = sink();
      const { io, errors } = captureIo();
      const code = await main(
        ["authzen", "audit", "--json", tape, "--token-claims", claims, ...extra],
        { ...io, out: out.stream },
      );
      const text = out.text();
      expect(text.trim().split("\n")).toHaveLength(1);
      return {
        code,
        errors,
        parsed: JSON.parse(text) as Record<string, unknown> & {
          actions: Record<string, unknown>[];
        },
      };
    }

    const permitAll = (_b: Record<string, unknown>, res: ServerResponse) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ decision: true }));
    };

    it("permits rendered actions against a single-decision PDP, exit 0", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-audit-"));
      const tape = await writeDirTape(dir, [
        ["client_to_server", req(1, "tools/list")],
        [
          "server_to_client",
          res(1, catalog(tool("get_customer", GET_CUSTOMER_MAPPING), tool("get_weather"))),
        ],
        ["client_to_server", call(2, "get_customer", { id: "cust-1" })],
        ["server_to_client", res(2, {})],
        ["client_to_server", call(3, "get_weather")],
        ["server_to_client", res(3, {})],
      ]);
      const claims = await writeClaims(dir, CLAIMS);
      const pdp = await startPdp(permitAll);
      const j = await runAuditJson(tape, claims, ["--evaluation-endpoint", pdp.evalUrl]);
      expect(j.code).toBe(0);
      expect(j.parsed.status).toBe("pass");
      expect(j.parsed.permitCount).toBe(2);
      expect(j.parsed.decisionCount).toBe(2);
      expect(j.parsed.pdpRequestCount).toBe(2);
      expect(pdp.captured).toHaveLength(2);
      expect(pdp.captured[0]!.path).toContain("/access/v1/evaluation");
      expect(pdp.captured[0]!.body.resource).toEqual({ type: "customer", id: "cust-1" });
      expect(pdp.captured[1]!.body.action).toEqual({ name: "tools/call" });
      expect(JSON.stringify(j.parsed)).not.toContain("cust-1");
    });

    it("deny is exit 1 and does not stop later actions; context preserved", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-audit-"));
      const tape = await writeDirTape(dir, [
        ["client_to_server", req(1, "tools/list")],
        ["server_to_client", res(1, catalog(tool("a"), tool("b"), tool("c")))],
        ["client_to_server", call(2, "a")],
        ["server_to_client", res(2, {})],
        ["client_to_server", call(3, "b")],
        ["server_to_client", res(3, {})],
        ["client_to_server", call(4, "c")],
        ["server_to_client", res(4, {})],
      ]);
      const claims = await writeClaims(dir, CLAIMS);
      const pdp = await startPdp((body, res) => {
        const rid = (body.resource as { id: string }).id;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          rid === "b"
            ? JSON.stringify({ decision: false, context: { why: "no" } })
            : JSON.stringify({ decision: true }),
        );
      });
      const j = await runAuditJson(tape, claims, ["--evaluation-endpoint", pdp.evalUrl]);
      expect(j.code).toBe(1);
      expect(j.parsed.status).toBe("deny");
      expect(j.parsed.actions.map((a) => a.status)).toEqual(["permit", "deny", "permit"]);
      expect(j.parsed.actions[1]!.decisions).toEqual([{ decision: false, context: { why: "no" } }]);
      expect(pdp.captured).toHaveLength(3);
    });

    it("native evaluations endpoint: one request, ordered decisions", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-audit-"));
      const tape = await writeDirTape(dir, [
        ["client_to_server", req(1, "tools/list")],
        ["server_to_client", res(1, catalog(tool("copy", COPY_MAPPING)))],
        ["client_to_server", call(2, "copy", { source: "/a", dest: "/b" })],
        ["server_to_client", res(2, {})],
      ]);
      const claims = await writeClaims(dir, CLAIMS);
      const pdp = await startPdp((_b, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ evaluations: [{ decision: true }, { decision: false }] }));
      });
      const j = await runAuditJson(tape, claims, [
        "--evaluation-endpoint",
        pdp.evalUrl,
        "--evaluations-endpoint",
        pdp.batchUrl,
      ]);
      expect(j.code).toBe(1);
      expect(j.parsed.status).toBe("deny");
      const a = j.parsed.actions[0]!;
      expect(a.pdpRequestCount).toBe(1);
      expect(a.decisionCount).toBe(2);
      expect(a.decisions).toEqual([
        { decision: true, context: null },
        { decision: false, context: null },
      ]);
      expect(pdp.captured).toHaveLength(1);
      expect(pdp.captured[0]!.path).toContain("/access/v1/evaluations");
    });

    it("fallback expands evaluations into ordered individual requests", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-audit-"));
      const tape = await writeDirTape(dir, [
        ["client_to_server", req(1, "tools/list")],
        ["server_to_client", res(1, catalog(tool("copy", COPY_MAPPING)))],
        ["client_to_server", call(2, "copy", { source: "/a", dest: "/b" })],
        ["server_to_client", res(2, {})],
      ]);
      const claims = await writeClaims(dir, CLAIMS);
      const pdp = await startPdp((body, res) => {
        const rid = (body.resource as { id: string }).id;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ decision: rid === "/a" }));
      });
      const j = await runAuditJson(tape, claims, ["--evaluation-endpoint", pdp.evalUrl]);
      expect(j.code).toBe(1);
      const a = j.parsed.actions[0]!;
      expect(a.status).toBe("deny");
      expect(a.pdpRequestCount).toBe(2);
      expect(a.decisionCount).toBe(2);
      expect(pdp.captured.map((c) => c.path)).toEqual([
        expect.stringContaining("/access/v1/evaluation"),
        expect.stringContaining("/access/v1/evaluation"),
      ]);
      expect((pdp.captured[0]!.body.resource as { id: string }).id).toBe("/a");
      expect((pdp.captured[1]!.body.resource as { id: string }).id).toBe("/b");
      for (const c of pdp.captured) {
        expect(c.body.subject).toEqual({ type: "identity", id: "alice@example.com" });
        expect(c.body).not.toHaveProperty("evaluations");
      }
    });

    it("mixed history: unknown/mapping_error skip PDP, deny retained, incomplete", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-audit-"));
      const badMapping = {
        evaluation: {
          action: { name: "x" },
          resource: { type: "r", id: "$params.arguments.nope" },
        },
      };
      const tape = await writeDirTape(dir, [
        ["client_to_server", req(1, "tools/list")],
        [
          "server_to_client",
          res(
            1,
            catalog(
              tool("ok1", GET_CUSTOMER_MAPPING),
              tool("plain"),
              tool("broken", badMapping),
              tool("ok2", COPY_MAPPING),
            ),
          ),
        ],
        ["client_to_server", call(2, "ok1", { id: "c1" })],
        ["server_to_client", res(2, {})],
        ["client_to_server", call(3, "plain")],
        ["server_to_client", res(3, {})],
        ["client_to_server", call(4, "ghost")],
        ["server_to_client", res(4, {})],
        ["client_to_server", call(5, "broken")],
        ["server_to_client", res(5, {})],
        ["client_to_server", call(6, "ok2", { source: "/a", dest: "/b" })],
        ["server_to_client", res(6, {})],
      ]);
      const claims = await writeClaims(dir, CLAIMS);
      const pdp = await startPdp((body, res, path) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        if (path.includes("evaluations") || Array.isArray(body.evaluations)) {
          res.end(JSON.stringify({ evaluations: [{ decision: true }, { decision: true }] }));
        } else {
          const rid = (body.resource as { id: string }).id;
          res.end(JSON.stringify({ decision: rid !== "plain" }));
        }
      });
      const j = await runAuditJson(tape, claims, [
        "--evaluation-endpoint",
        pdp.evalUrl,
        "--evaluations-endpoint",
        pdp.batchUrl,
      ]);
      expect(j.code).toBe(1);
      expect(j.parsed.status).toBe("incomplete");
      expect(j.parsed.actions.map((a) => a.status)).toEqual([
        "permit",
        "deny",
        "unknown",
        "mapping_error",
        "permit",
      ]);
      expect(j.parsed.denyCount).toBe(1);
      expect(j.parsed.unknownCount).toBe(1);
      expect(j.parsed.mappingErrorCount).toBe(1);
      expect(j.parsed.permitCount).toBe(2);
      expect(j.parsed.pdpRequestCount).toBe(3);
      expect(pdp.captured).toHaveLength(3);
    });

    it("fatal PDP error stops later requests and marks them not_evaluated", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-audit-"));
      const tape = await writeDirTape(dir, [
        ["client_to_server", req(1, "tools/list")],
        ["server_to_client", res(1, catalog(tool("a"), tool("b"), tool("c")))],
        ["client_to_server", call(2, "a")],
        ["server_to_client", res(2, {})],
        ["client_to_server", call(3, "b")],
        ["server_to_client", res(3, {})],
        ["client_to_server", call(4, "c")],
        ["server_to_client", res(4, {})],
      ]);
      const claims = await writeClaims(dir, CLAIMS);
      const pdp = await startPdp((body, res) => {
        const rid = (body.resource as { id: string }).id;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(rid === "b" ? "not json" : JSON.stringify({ decision: true }));
      });
      const j = await runAuditJson(tape, claims, ["--evaluation-endpoint", pdp.evalUrl]);
      expect(j.code).toBe(2);
      expect(j.parsed.status).toBe("error");
      expect(j.parsed.actions.map((a) => a.status)).toEqual([
        "permit",
        "not_evaluated",
        "not_evaluated",
      ]);
      expect(j.parsed.pdpRequestCount).toBe(2);
      expect(j.parsed.decisionCount).toBe(1);
      expect(pdp.captured).toHaveLength(2);
      expect(j.errors.join("\n")).not.toMatch(/\n\s+at /);
    });

    it("fatal tape/token failures send zero PDP requests", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-audit-"));
      const pdp = await startPdp(permitAll);
      const tapePath = join(dir, "bad.agentlog");
      await writeFile(tapePath, "garbage\n", "utf8");
      const claims = await writeClaims(dir, CLAIMS);
      const j = await runAuditJson(tapePath, claims, ["--evaluation-endpoint", pdp.evalUrl]);
      expect(j.code).toBe(2);
      expect(pdp.captured).toHaveLength(0);

      const tape = await writeDirTape(dir, [
        ["client_to_server", req(1, "tools/list")],
        ["server_to_client", res(1, catalog(tool("a")))],
        ["client_to_server", call(2, "a")],
        ["server_to_client", res(2, {})],
      ]);
      const malformed = await writeClaims(dir, "{nope");
      const j2 = await runAuditJson(tape, malformed, ["--evaluation-endpoint", pdp.evalUrl]);
      expect(j2.code).toBe(2);
      expect(pdp.captured).toHaveLength(0);
    });

    it("rejects non-http endpoints and bad flags before any PDP contact", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-audit-"));
      const tape = await writeDirTape(dir, [
        ["client_to_server", req(1, "tools/list")],
        ["server_to_client", res(1, catalog(tool("a")))],
        ["client_to_server", call(2, "a")],
        ["server_to_client", res(2, {})],
      ]);
      const claims = await writeClaims(dir, CLAIMS);
      const { io, errors } = captureIo();
      expect(
        await main(
          [
            "authzen",
            "audit",
            tape,
            "--token-claims",
            claims,
            "--evaluation-endpoint",
            "file:///x",
          ],
          io,
        ),
      ).toBe(2);
      expect(
        await main(
          [
            "authzen",
            "audit",
            tape,
            "--token-claims",
            claims,
            "--evaluation-endpoint",
            "http://x",
            "--timeout-ms",
            "0",
          ],
          io,
        ),
      ).toBe(2);
      expect(await main(["authzen", "audit", tape, "--token-claims", claims], io)).toBe(2);
      expect(errors.join("\n")).toContain("--evaluation-endpoint");
    });

    it("exit 0 pass with zero tool calls and no PDP requests", async () => {
      const dir = await mkdtemp(join(tmpdir(), "actiontape-audit-"));
      const tape = await writeDirTape(dir, [
        ["client_to_server", req(1, "tools/list")],
        ["server_to_client", res(1, catalog(tool("a")))],
      ]);
      const claims = await writeClaims(dir, CLAIMS);
      const pdp = await startPdp(permitAll);
      const j = await runAuditJson(tape, claims, ["--evaluation-endpoint", pdp.evalUrl]);
      expect(j.code).toBe(0);
      expect(j.parsed.status).toBe("pass");
      expect(j.parsed.pdpRequestCount).toBe(0);
      expect(pdp.captured).toHaveLength(0);
    });
  });
});
