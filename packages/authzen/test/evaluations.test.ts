import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuthzenMappingError,
  AuthzenRequestError,
  evaluateAccessMany,
  expandAccessEvaluationsRequest,
} from "../src/index.js";
import type { AuthzenAccessEvaluationsRequest } from "../src/index.js";

const BATCH: AuthzenAccessEvaluationsRequest = {
  subject: { type: "identity", id: "alice@example.com" },
  action: { name: "read" },
  evaluations: [
    { resource: { type: "file", id: "/a" } },
    { action: { name: "write" }, resource: { type: "file", id: "/b" } },
  ],
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
  handler: (req: IncomingMessage, body: string, res: ServerResponse) => void,
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
  return { url: `http://127.0.0.1:${port}/access/v1/evaluations`, captured };
}

const json = (res: ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

describe("evaluateAccessMany", () => {
  it("POSTs the exact batch request and returns ordered decisions", async () => {
    const { url, captured } = await startPdp((_req, _body, res) =>
      json(res, {
        evaluations: [{ decision: true }, { decision: false, context: { reason: "policy" } }],
      }),
    );
    const decisions = await evaluateAccessMany(url, BATCH);
    expect(decisions).toEqual([
      { decision: true },
      { decision: false, context: { reason: "policy" } },
    ]);
    expect(captured).toHaveLength(1);
    expect(captured[0]!.method).toBe("POST");
    expect(captured[0]!.contentType).toBe("application/json");
    expect(captured[0]!.accept).toBe("application/json");
    expect(captured[0]!.body).toEqual(BATCH);
  });

  it("ignores a top-level decision when evaluations is present", async () => {
    const { url } = await startPdp((_req, _body, res) =>
      json(res, { decision: false, evaluations: [{ decision: true }, { decision: true }] }),
    );
    const decisions = await evaluateAccessMany(url, BATCH);
    expect(decisions.map((d) => d.decision)).toEqual([true, true]);
  });

  it("rejects missing, non-array, or count-mismatched evaluations", async () => {
    for (const body of [
      { decision: true },
      { evaluations: "yes" },
      { evaluations: [{ decision: true }] },
      { evaluations: [{ decision: true }, { decision: true }, { decision: true }] },
    ]) {
      const { url } = await startPdp((_req, _b, res) => json(res, body));
      await expect(evaluateAccessMany(url, BATCH)).rejects.toThrow(AuthzenRequestError);
      await new Promise((r) => server!.close(r));
      server = undefined;
    }
  });

  it("rejects malformed decision entries and invalid context", async () => {
    for (const entry of [
      { decision: "yes" },
      {},
      { decision: true, context: "nope" },
      { decision: true, context: [1] },
    ]) {
      const { url } = await startPdp((_req, _b, res) =>
        json(res, { evaluations: [entry, { decision: true }] }),
      );
      await expect(evaluateAccessMany(url, BATCH)).rejects.toThrow(AuthzenRequestError);
      await new Promise((r) => server!.close(r));
      server = undefined;
    }
  });

  it("rejects malformed JSON, non-object bodies, HTTP errors, redirects, timeouts, unreachable hosts, bad schemes", async () => {
    const cases: unknown[] = ["not json", [1, 2], "scalar"];
    for (const body of cases) {
      const { url } = await startPdp((_req, _b, res) => json(res, body));
      await expect(evaluateAccessMany(url, BATCH)).rejects.toThrow(AuthzenRequestError);
      await new Promise((r) => server!.close(r));
      server = undefined;
    }

    {
      const { url } = await startPdp((_req, _b, res) => json(res, { error: "x" }, 400));
      await expect(evaluateAccessMany(url, BATCH)).rejects.toThrow(AuthzenRequestError);
      await new Promise((r) => server!.close(r));
      server = undefined;
    }
    {
      const { url } = await startPdp((_req, _b, res) => json(res, { error: "x" }, 500));
      await expect(evaluateAccessMany(url, BATCH)).rejects.toThrow(AuthzenRequestError);
      await new Promise((r) => server!.close(r));
      server = undefined;
    }
    {
      const { url } = await startPdp((_req, _b, res) => {
        res.writeHead(302, { Location: "http://example.com/" });
        res.end();
      });
      await expect(evaluateAccessMany(url, BATCH)).rejects.toThrow(AuthzenRequestError);
      await new Promise((r) => server!.close(r));
      server = undefined;
    }
    {
      const { url } = await startPdp((_req, _b, res) => {
        setTimeout(() => json(res, { evaluations: [] }), 200);
      });
      await expect(evaluateAccessMany(url, BATCH, { timeoutMs: 50 })).rejects.toThrow(
        AuthzenRequestError,
      );
      await new Promise((r) => server!.close(r));
      server = undefined;
    }
    await expect(
      evaluateAccessMany("http://127.0.0.1:1/nope", BATCH, { timeoutMs: 500 }),
    ).rejects.toThrow(AuthzenRequestError);
    await expect(evaluateAccessMany("file:///tmp/x", BATCH)).rejects.toThrow(AuthzenRequestError);
    await expect(evaluateAccessMany("not a url", BATCH)).rejects.toThrow(AuthzenRequestError);
  });
});

describe("expandAccessEvaluationsRequest", () => {
  const top = {
    subject: { type: "identity", id: "alice@example.com" },
    action: { name: "read" },
    resource: { type: "file", id: "/shared" },
    context: { region: "us" },
  };

  it("inherits top-level defaults and applies whole-object overrides", () => {
    const req: AuthzenAccessEvaluationsRequest = {
      ...top,
      evaluations: [
        {},
        { action: { name: "write" }, context: { region: "eu", extra: 1 } },
        { resource: { type: "file", id: "/other" } },
      ],
    };
    const expanded = expandAccessEvaluationsRequest(req);
    expect(expanded).toEqual([
      top,
      {
        subject: top.subject,
        action: { name: "write" },
        resource: top.resource,
        context: { region: "eu", extra: 1 },
      },
      {
        subject: top.subject,
        action: top.action,
        resource: { type: "file", id: "/other" },
        context: top.context,
      },
    ]);
    // no deep merge of context
    expect(expanded[1]!.context).toEqual({ region: "eu", extra: 1 });
  });

  it("honors a per-entry subject and omits context when unset", () => {
    const req: AuthzenAccessEvaluationsRequest = {
      subject: top.subject,
      action: top.action,
      resource: top.resource,
      evaluations: [{ subject: { type: "service", id: "svc-1" } }],
    };
    const expanded = expandAccessEvaluationsRequest(req);
    expect(expanded[0]!.subject).toEqual({ type: "service", id: "svc-1" });
    expect("context" in expanded[0]!).toBe(false);
  });

  it("preserves order and does not mutate the request", () => {
    const req: AuthzenAccessEvaluationsRequest = {
      subject: top.subject,
      evaluations: [
        { action: top.action, resource: { type: "f", id: "1" } },
        { action: top.action, resource: { type: "f", id: "2" } },
        { action: top.action, resource: { type: "f", id: "3" } },
      ],
    };
    const snapshot = structuredClone(req);
    const expanded = expandAccessEvaluationsRequest(req);
    expect(req).toEqual(snapshot);
    expect(expanded.map((r) => r.resource.id)).toEqual(["1", "2", "3"]);
  });

  it("rejects entries with no effective action or resource", () => {
    const noAction: AuthzenAccessEvaluationsRequest = {
      subject: top.subject,
      resource: top.resource,
      evaluations: [{}],
    };
    expect(() => expandAccessEvaluationsRequest(noAction)).toThrow(AuthzenMappingError);
    const noResource: AuthzenAccessEvaluationsRequest = {
      subject: top.subject,
      action: top.action,
      evaluations: [{}],
    };
    expect(() => expandAccessEvaluationsRequest(noResource)).toThrow(AuthzenMappingError);
  });
});
