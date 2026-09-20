import { describe, expect, it } from "vitest";
import { createActionEnvelope, type ActionEnvelope, type JsonObject } from "@actiontape/core";
import {
  AuthzenMappingError,
  AuthzenRequestError,
  mapMcpToolCallToAuthzen,
  simulateAuthzen,
  type AuthzenIdentity,
} from "../src/index.js";

const IDENTITY: AuthzenIdentity = { subjectId: "alice@example.com" };

function toolCall(target: string, args: JsonObject = {}, extra?: Partial<ActionEnvelope>) {
  return createActionEnvelope({
    id: `act-${target}`,
    timestamp: "2026-01-01T00:00:00.000Z",
    recordingId: "rec-1",
    protocol: "mcp",
    direction: "outbound",
    operation: "tools/call",
    target,
    arguments: args,
    ...extra,
  });
}

describe("mapMcpToolCallToAuthzen (COAZ-MCP Draft 1 default tools/call)", () => {
  it("produces the exact default mapping", () => {
    const req = mapMcpToolCallToAuthzen(toolCall("get_weather"), IDENTITY);
    expect(req).toEqual({
      subject: { type: "identity", id: "alice@example.com" },
      action: { name: "tools/call" },
      resource: { type: "tool", id: "get_weather" },
    });
    expect(req.context).toBeUndefined();
  });

  it("adds agent context only when agentId is supplied", () => {
    const req = mapMcpToolCallToAuthzen(toolCall("search"), {
      subjectId: "alice@example.com",
      agentId: "my-agent",
    });
    expect(req.context).toEqual({ agent: "my-agent" });
  });

  it("never includes arguments, result, error, metadata, or recording ids", () => {
    const action = toolCall("delete_file", { path: "$(touch /tmp/pwned)", secret: "abc" });
    action.result = { ok: true };
    action.metadata = { mcp: { requestId: 7 } };
    const req = mapMcpToolCallToAuthzen(action, {
      subjectId: "alice@example.com",
      agentId: "agent-1",
    });
    const serialized = JSON.stringify(req);
    for (const leaked of [
      "pwned",
      "secret",
      "rec-1",
      "act-delete_file",
      "requestId",
      "arguments",
    ]) {
      expect(serialized).not.toContain(leaked);
    }
    expect(Object.keys(req).sort()).toEqual(["action", "context", "resource", "subject"]);
  });

  it("rejects empty subject id, empty target, and non-tool-call actions", () => {
    expect(() => mapMcpToolCallToAuthzen(toolCall("t"), { subjectId: "" })).toThrow(
      AuthzenMappingError,
    );
    expect(() => mapMcpToolCallToAuthzen(toolCall(""), IDENTITY)).toThrow(AuthzenMappingError);
    expect(() =>
      mapMcpToolCallToAuthzen(toolCall("t", {}, { protocol: "http" }), IDENTITY),
    ).toThrow(/protocol/);
    expect(() =>
      mapMcpToolCallToAuthzen(toolCall("t", {}, { direction: "inbound" }), IDENTITY),
    ).toThrow(/direction/);
    expect(() =>
      mapMcpToolCallToAuthzen(toolCall("t", {}, { operation: "tools/list" }), IDENTITY),
    ).toThrow(/operation/);
  });

  it("does not mutate the input envelope", () => {
    const action = toolCall("search", { q: "x" });
    const snapshot = JSON.stringify(action);
    mapMcpToolCallToAuthzen(action, IDENTITY);
    expect(JSON.stringify(action)).toBe(snapshot);
  });
});

describe("simulateAuthzen", () => {
  const actions = () => [toolCall("a"), toolCall("b"), toolCall("c")];

  it("evaluates sequentially in input order and continues after deny", async () => {
    const seen: string[] = [];
    const result = await simulateAuthzen(actions(), IDENTITY, async (req) => {
      seen.push(req.resource.id);
      return { decision: req.resource.id !== "b" };
    });
    expect(seen).toEqual(["a", "b", "c"]);
    expect(result.decisions.map((d) => d.decision)).toEqual([true, false, true]);
    expect(result.decisions.map((d) => d.actionId)).toEqual(["act-a", "act-b", "act-c"]);
  });

  it("preserves response context and defaults to null", async () => {
    const result = await simulateAuthzen(actions(), IDENTITY, async (req) =>
      req.resource.id === "a" ? { decision: true, context: { reason: "ok" } } : { decision: true },
    );
    expect(result.decisions[0]!.context).toEqual({ reason: "ok" });
    expect(result.decisions[1]!.context).toBeNull();
  });

  it("maps MRTR physical rounds as independent evaluations", async () => {
    const round1 = toolCall("purchase", { step: 1 });
    const round2 = toolCall("purchase", { step: 1, confirmed: true });
    const result = await simulateAuthzen([round1, round2], IDENTITY, async () => ({
      decision: true,
    }));
    expect(result.decisions).toHaveLength(2);
    expect(result.decisions.map((d) => d.actionId)).toEqual(["act-purchase", "act-purchase"]);
  });

  it("fails closed on evaluator errors and stops further requests", async () => {
    const seen: string[] = [];
    await expect(
      simulateAuthzen(actions(), IDENTITY, async (req) => {
        seen.push(req.resource.id);
        if (req.resource.id === "b") throw new AuthzenRequestError("PDP down");
        return { decision: true };
      }),
    ).rejects.toThrow(AuthzenRequestError);
    expect(seen).toEqual(["a", "b"]);
  });

  it("fails closed on mapping errors before evaluating", async () => {
    const bad = toolCall("t", {}, { operation: "tools/list" });
    await expect(
      simulateAuthzen([bad], IDENTITY, async () => ({ decision: true })),
    ).rejects.toThrow(AuthzenMappingError);
  });
});
