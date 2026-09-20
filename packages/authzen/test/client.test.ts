import { createServer, type Server, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateAccess, AuthzenRequestError } from "../src/index.js";
import type { AuthzenAccessEvaluationRequest } from "../src/index.js";

const REQUEST: AuthzenAccessEvaluationRequest = {
  subject: { type: "identity", id: "alice@example.com" },
  action: { name: "tools/call" },
  resource: { type: "tool", id: "get_weather" },
};

interface Captured {
  method?: string;
  contentType?: string;
  accept?: string;
  body?: unknown;
}

let server: Server | undefined;
afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r));
  server = undefined;
});

async function startPdp(
  handler: (req: IncomingMessage, body: string, res: import("node:http").ServerResponse) => void,
): Promise<{ url: string; captured: Captured[] }> {
  const captured: Captured[] = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      try {
        captured.push({
          method: req.method,
          contentType: req.headers["content-type"],
          accept: req.headers.accept,
          body: JSON.parse(body),
        });
      } catch {
        captured.push({ method: req.method, body });
      }
      handler(req, body, res);
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const port = (server!.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/access/v1/evaluation`, captured };
}

const json = (res: import("node:http").ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

describe("evaluateAccess", () => {
  it("POSTs the exact request JSON and parses a permit decision", async () => {
    const { url, captured } = await startPdp((_req, _body, res) => json(res, { decision: true }));
    const d = await evaluateAccess(url, REQUEST);
    expect(d).toEqual({ decision: true });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.method).toBe("POST");
    expect(captured[0]!.contentType).toBe("application/json");
    expect(captured[0]!.accept).toBe("application/json");
    expect(captured[0]!.body).toEqual(REQUEST);
  });

  it("accepts deny decisions and optional context objects", async () => {
    const { url } = await startPdp((_r, _b, res) =>
      json(res, { decision: false, context: { reason: "policy-7" } }),
    );
    expect(await evaluateAccess(url, REQUEST)).toEqual({
      decision: false,
      context: { reason: "policy-7" },
    });
  });

  it("rejects redirects, 4xx, and 5xx", async () => {
    const { url } = await startPdp((_r, _b, res) => {
      res.writeHead(302, { Location: "/other" });
      res.end();
    });
    await expect(evaluateAccess(url, REQUEST)).rejects.toThrow(AuthzenRequestError);

    const { url: url400 } = await startPdp((_r, _b, res) => json(res, {}, 400));
    await expect(evaluateAccess(url400, REQUEST)).rejects.toThrow(/HTTP 400/);
  });

  it("rejects malformed and non-conforming responses", async () => {
    const cases: [string, unknown, number][] = [
      ["malformed json", "not-json{", 200],
      ["json array", [1, 2], 200],
      ["missing decision", { context: {} }, 200],
      ["string decision", { decision: "yes" }, 200],
      ["invalid context", { decision: true, context: "oops" }, 200],
      ["http 500", { decision: true }, 500],
    ];
    for (const [name, body, status] of cases) {
      const { url } = await startPdp((_r, _b, res) => json(res, body, status));
      await expect(evaluateAccess(url, REQUEST), name).rejects.toThrow(AuthzenRequestError);
      await new Promise((r) => server!.close(r));
      server = undefined;
    }
  });

  it("times out and reports unreachable endpoints", async () => {
    const { url } = await startPdp(() => {
      /* never respond */
    });
    await expect(evaluateAccess(url, REQUEST, { timeoutMs: 50 })).rejects.toThrow(/timed out/);
    await expect(
      evaluateAccess("http://127.0.0.1:1/nope", REQUEST, { timeoutMs: 1000 }),
    ).rejects.toThrow(AuthzenRequestError);
  });

  it("rejects malformed URLs and non-http(s) schemes", async () => {
    await expect(evaluateAccess("not a url", REQUEST)).rejects.toThrow(/invalid endpoint/);
    await expect(evaluateAccess("file:///etc/passwd", REQUEST)).rejects.toThrow(/scheme/);
    await expect(evaluateAccess("ftp://x", REQUEST)).rejects.toThrow(/scheme/);
  });
});
