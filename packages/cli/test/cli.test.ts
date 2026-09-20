import { existsSync } from "node:fs";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
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
});
