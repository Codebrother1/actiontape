import { describe, expect, it } from "vitest";
import type { JsonObject } from "@actiontape/core";
import { CoazMappingError, evaluateCoazExpression, renderCoazMapping } from "../src/index.js";

const PARAMS: JsonObject = {
  name: "get_customer",
  arguments: {
    id: "cust-12345",
    case: "case-67890",
    amount: 12000,
    currency: "USD",
    account: "acct-1",
    labels: ["bug", "urgent"],
    metadata: { repository: "demo", private: false },
  },
};
const TOKEN: JsonObject = {
  sub: "alice@example.com",
  client_id: "agent-123",
  roles: ["user", "treasury"],
};

function vars(params: JsonObject = PARAMS, token: JsonObject = TOKEN) {
  return { params, token };
}

describe("evaluateCoazExpression", () => {
  it("evaluates basic and nested selections", () => {
    expect(evaluateCoazExpression("token.sub", vars())).toEqual({
      kind: "value",
      value: "alice@example.com",
    });
    expect(evaluateCoazExpression("params.arguments.id", vars())).toEqual({
      kind: "value",
      value: "cust-12345",
    });
  });

  it("returns booleans, doubles, and aggregates", () => {
    expect(evaluateCoazExpression("params.arguments.amount > 10000", vars())).toEqual({
      kind: "value",
      value: true,
    });
    expect(evaluateCoazExpression("1.5", vars())).toEqual({ kind: "value", value: 1.5 });
    expect(evaluateCoazExpression("params.arguments.labels", vars())).toEqual({
      kind: "value",
      value: ["bug", "urgent"],
    });
    expect(evaluateCoazExpression("params.arguments.metadata", vars())).toEqual({
      kind: "value",
      value: { repository: "demo", private: false },
    });
  });

  it("converts safe-range CEL integers to JSON numbers", () => {
    expect(evaluateCoazExpression("1", vars())).toEqual({ kind: "value", value: 1 });
    expect(evaluateCoazExpression("1 + 2", vars())).toEqual({ kind: "value", value: 3 });
  });

  it("rejects CEL integers outside the safe JSON range", () => {
    expect(() => evaluateCoazExpression("9007199254740993", vars())).toThrow(CoazMappingError);
    expect(() => evaluateCoazExpression("9007199254740992", vars())).toThrow(CoazMappingError);
  });

  it("distinguishes optional absent from present falsy values", () => {
    const absent = evaluateCoazExpression("token.?client_id", vars(PARAMS, { sub: "a" }));
    expect(absent).toEqual({ kind: "omitted" });
    for (const value of [null, false, 0, ""]) {
      const result = evaluateCoazExpression(
        "token.?client_id",
        vars(PARAMS, { sub: "a", client_id: value }),
      );
      expect(result).toEqual({ kind: "value", value });
    }
  });

  it("fails on missing plain selections", () => {
    expect(() => evaluateCoazExpression("token.client_id", vars(PARAMS, { sub: "a" }))).toThrow(
      CoazMappingError,
    );
    expect(() => evaluateCoazExpression("params.arguments.missing", vars())).toThrow(
      CoazMappingError,
    );
  });

  it("fails on malformed CEL and unregistered variables", () => {
    expect(() => evaluateCoazExpression("token.sub ??", vars())).toThrow(CoazMappingError);
    expect(() => evaluateCoazExpression("foo.bar", vars())).toThrow(CoazMappingError);
  });

  it("blocks host-object escape probes", () => {
    for (const probe of [
      "params.constructor",
      "params.__proto__",
      "token.constructor",
      "token.toString",
      "params.constructor.constructor",
      'params.constructor.constructor("return 1")',
      'params.hasOwnProperty("arguments")',
    ]) {
      expect(() => evaluateCoazExpression(probe, vars()), probe).toThrow(CoazMappingError);
    }
  });

  it("keeps command-looking strings inert", () => {
    const params: JsonObject = {
      name: "x",
      arguments: { cmd: "$(touch /tmp/actiontape-owned)" },
    };
    const result = evaluateCoazExpression("params.arguments.cmd", vars(params));
    expect(result).toEqual({ kind: "value", value: "$(touch /tmp/actiontape-owned)" });
  });

  it("enforces input depth, node, container, and string budgets", () => {
    const deep: JsonObject = {};
    let cursor = deep;
    for (let i = 0; i < 60; i++) {
      const next: JsonObject = {};
      cursor.a = next;
      cursor = next;
    }
    expect(() => evaluateCoazExpression("params.name", vars(deep))).toThrow(CoazMappingError);

    const wide: JsonObject = {};
    for (let k = 0; k < 6; k++) {
      wide[`k${k}`] = Array.from({ length: 4000 }, () => 1);
    }
    expect(() => evaluateCoazExpression("params.name", vars(wide))).toThrow(CoazMappingError);

    const oversized: JsonObject = { list: Array.from({ length: 5001 }, () => 0) };
    expect(() => evaluateCoazExpression("params.name", vars(oversized))).toThrow(CoazMappingError);

    const bigString: JsonObject = { blob: "x".repeat(1_000_001) };
    expect(() => evaluateCoazExpression("params.name", vars(bigString))).toThrow(CoazMappingError);
  });
});

describe("renderCoazMapping string rules", () => {
  const envelope = (value: JsonObject): JsonObject => ({ evaluation: value });
  const base = {
    action: { name: "t" },
    resource: { type: "r", id: "r1" },
  };

  it("passes literal strings through", () => {
    const result = renderCoazMapping(envelope({ ...base, context: { kind: "customer" } }), vars());
    expect(result.kind).toBe("evaluation");
    if (result.kind === "evaluation") {
      expect(result.request.context).toEqual({ kind: "customer" });
    }
  });

  it("unescapes $$ to a single literal dollar", () => {
    const result = renderCoazMapping(
      envelope({ ...base, context: { price: "$$50", ref: "$$token.sub" } }),
      vars(),
    );
    if (result.kind === "evaluation") {
      expect(result.request.context).toEqual({ price: "$50", ref: "$token.sub" });
    }
  });

  it("rejects a bare $ as an expression", () => {
    expect(() => renderCoazMapping(envelope({ ...base, context: { bad: "$" } }), vars())).toThrow(
      CoazMappingError,
    );
  });

  it("rejects an optional-absent result inside an array", () => {
    expect(() =>
      renderCoazMapping(
        envelope({ ...base, context: { items: ["$token.?client_id", "x"] } }),
        vars(PARAMS, { sub: "a" }),
      ),
    ).toThrow(CoazMappingError);
  });
});

describe("renderCoazMapping evaluation envelope", () => {
  const GET_CUSTOMER: JsonObject = {
    evaluation: {
      subject: { type: "identity", id: "$token.sub" },
      action: { name: "get_customer" },
      resource: { type: "customer", id: "$params.arguments.id" },
      context: {
        agent: "$token.?client_id",
        case: "$params.arguments.case",
      },
    },
  };

  it("renders the COAZ get_customer example exactly", () => {
    const result = renderCoazMapping(GET_CUSTOMER, vars());
    expect(result.kind).toBe("evaluation");
    expect(result.subjectAnchor).toBe("matches_token_sub");
    expect(result.warnings).toEqual([]);
    expect(result.request).toEqual({
      subject: { type: "identity", id: "alice@example.com" },
      action: { name: "get_customer" },
      resource: { type: "customer", id: "cust-12345" },
      context: { agent: "agent-123", case: "case-67890" },
    });
  });

  it("omits optional-absent context fields", () => {
    const token: JsonObject = { sub: "alice@example.com", roles: ["user"] };
    const result = renderCoazMapping(GET_CUSTOMER, vars(PARAMS, token));
    if (result.kind === "evaluation") {
      expect(result.request.context).toEqual({ case: "case-67890" });
      expect("agent" in (result.request.context ?? {})).toBe(false);
    }
  });

  it("renders conditional declared mappings", () => {
    const mapping: JsonObject = {
      evaluation: {
        subject: {
          type: '$token.roles.exists(r, r == "treasury") ? "treasury_user" : "standard_user"',
          id: "$token.sub",
        },
        action: {
          name: '$params.arguments.amount > 10000 ? "transfer_high" : "transfer_standard"',
        },
        resource: {
          type: "account",
          id: "$params.arguments.account",
          properties: {
            currency: "$params.arguments.currency",
            rail: '$params.arguments.currency == "USD" ? "domestic_transfer" : "international_transfer"',
          },
        },
        context: { agent: "$token.?client_id" },
      },
    };
    const result = renderCoazMapping(mapping, vars());
    if (result.kind !== "evaluation") throw new Error("expected evaluation");
    expect(result.request).toEqual({
      subject: { type: "treasury_user", id: "alice@example.com" },
      action: { name: "transfer_high" },
      resource: {
        type: "account",
        id: "acct-1",
        properties: { currency: "USD", rail: "domestic_transfer" },
      },
      context: { agent: "agent-123" },
    });

    const low = renderCoazMapping(
      mapping,
      vars(
        {
          name: "transfer",
          arguments: { amount: 5000, currency: "EUR", account: "acct-2" },
        },
        { sub: "bob@example.com", roles: ["user"] },
      ),
    );
    if (low.kind !== "evaluation") throw new Error("expected evaluation");
    expect(low.request.subject).toEqual({ type: "standard_user", id: "bob@example.com" });
    expect(low.request.action).toEqual({ name: "transfer_standard" });
    expect(low.request.resource.properties).toEqual({
      currency: "EUR",
      rail: "international_transfer",
    });
    expect(low.request.context).toEqual({});
  });
});

describe("renderCoazMapping subject defaults and anchoring", () => {
  const body = { action: { name: "t" }, resource: { type: "r", id: "x" } };

  it("defaults a missing subject to identity/token.sub", () => {
    const result = renderCoazMapping({ evaluation: { ...body } }, vars());
    if (result.kind === "evaluation") {
      expect(result.request.subject).toEqual({
        type: "identity",
        id: "alice@example.com",
      });
    }
    expect(result.subjectAnchor).toBe("matches_token_sub");
  });

  it("defaults missing subject.id and subject.type independently", () => {
    const result = renderCoazMapping({ evaluation: { ...body, subject: {} } }, vars());
    if (result.kind === "evaluation") {
      expect(result.request.subject).toEqual({
        type: "identity",
        id: "alice@example.com",
      });
    }
    const typed = renderCoazMapping(
      { evaluation: { ...body, subject: { type: "service" } } },
      vars(),
    );
    if (typed.kind === "evaluation") {
      expect(typed.request.subject).toEqual({
        type: "service",
        id: "alice@example.com",
      });
    }
  });

  it("warns but does not reject a declared subject override", () => {
    const result = renderCoazMapping(
      {
        evaluation: {
          ...body,
          subject: { type: "identity", id: "carol@example.com" },
        },
      },
      vars(),
    );
    expect(result.subjectAnchor).toBe("subject_id_override");
    expect(result.warnings).toEqual([expect.objectContaining({ code: "subject_id_override" })]);
    if (result.kind === "evaluation") {
      expect(result.request.subject.id).toBe("carol@example.com");
    }
  });
});

describe("renderCoazMapping evaluations envelope", () => {
  const COPY: JsonObject = {
    evaluations: {
      subject: { type: "identity", id: "$token.sub" },
      context: { request_id: "$params.arguments.request_id" },
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
  const copyParams: JsonObject = {
    name: "copy_file",
    arguments: { source: "/a.txt", dest: "/b.txt", request_id: "req-9" },
  };

  it("renders ordered multi-evaluation requests with a shared subject", () => {
    const result = renderCoazMapping(COPY, vars(copyParams));
    expect(result.kind).toBe("evaluations");
    if (result.kind !== "evaluations") return;
    expect(result.request.subject).toEqual({
      type: "identity",
      id: "alice@example.com",
    });
    expect(result.request.context).toEqual({ request_id: "req-9" });
    expect(result.request.evaluations).toEqual([
      { action: { name: "read" }, resource: { type: "file", id: "/a.txt" } },
      { action: { name: "write" }, resource: { type: "file", id: "/b.txt" } },
    ]);
    for (const entry of result.request.evaluations) {
      expect("subject" in entry).toBe(false);
    }
  });

  it("rejects a per-evaluation subject", () => {
    const bad: JsonObject = {
      evaluations: {
        evaluations: [
          {
            subject: { type: "identity", id: "x" },
            action: { name: "read" },
            resource: { type: "file", id: "/a" },
          },
        ],
      },
    };
    expect(() => renderCoazMapping(bad, vars(copyParams))).toThrow(CoazMappingError);
  });

  it("uses top-level action/resource defaults per entry", () => {
    const mapping: JsonObject = {
      evaluations: {
        subject: { type: "identity", id: "$token.sub" },
        action: { name: "read" },
        evaluations: [
          { resource: { type: "file", id: "/a" } },
          {
            resource: { type: "file", id: "/b" },
            action: { name: "write" },
          },
        ],
      },
    };
    const result = renderCoazMapping(mapping, vars(copyParams));
    if (result.kind !== "evaluations") throw new Error("expected evaluations");
    expect(result.request.action).toEqual({ name: "read" });
    expect(result.request.evaluations).toHaveLength(2);
  });

  it("rejects an empty evaluations array", () => {
    expect(() => renderCoazMapping({ evaluations: { evaluations: [] } }, vars(copyParams))).toThrow(
      CoazMappingError,
    );
  });
});

describe("renderCoazMapping malformed mappings", () => {
  const body = { action: { name: "t" }, resource: { type: "r", id: "x" } };

  it("rejects missing, dual, unknown, or extra envelopes", () => {
    expect(() => renderCoazMapping({}, vars())).toThrow(CoazMappingError);
    expect(() => renderCoazMapping({ evaluation: body, evaluations: {} }, vars())).toThrow(
      CoazMappingError,
    );
    expect(() => renderCoazMapping({ bogus: body }, vars())).toThrow(CoazMappingError);
    expect(() => renderCoazMapping({ evaluation: body, extra: 1 }, vars())).toThrow(
      CoazMappingError,
    );
  });

  it("rejects non-object envelopes", () => {
    expect(() => renderCoazMapping({ evaluation: "x" }, vars())).toThrow(CoazMappingError);
  });

  it("rejects missing required entities and wrong field types", () => {
    expect(() => renderCoazMapping({ evaluation: { resource: body.resource } }, vars())).toThrow(
      CoazMappingError,
    );
    expect(() => renderCoazMapping({ evaluation: { action: body.action } }, vars())).toThrow(
      CoazMappingError,
    );
    expect(() =>
      renderCoazMapping({ evaluation: { ...body, action: { name: 5 } } }, vars()),
    ).toThrow(CoazMappingError);
    expect(() =>
      renderCoazMapping({ evaluation: { ...body, resource: { type: "r", id: 5 } } }, vars()),
    ).toThrow(CoazMappingError);
    expect(() =>
      renderCoazMapping({ evaluation: { ...body, subject: { id: "" } } }, vars()),
    ).toThrow(CoazMappingError);
    expect(() =>
      renderCoazMapping({ evaluation: { ...body, subject: { type: null } } }, vars()),
    ).toThrow(CoazMappingError);
  });

  it("rejects missing or non-string token.sub", () => {
    expect(() => renderCoazMapping({ evaluation: body }, vars(PARAMS, { client_id: "c" }))).toThrow(
      CoazMappingError,
    );
    expect(() => renderCoazMapping({ evaluation: body }, vars(PARAMS, { sub: 42 }))).toThrow(
      CoazMappingError,
    );
    expect(() => renderCoazMapping({ evaluation: body }, vars(PARAMS, { sub: "" }))).toThrow(
      CoazMappingError,
    );
  });

  it("rejects optional-absent required fields after defaults", () => {
    expect(() =>
      renderCoazMapping(
        {
          evaluation: {
            action: { name: "$token.?client_id" },
            resource: body.resource,
          },
        },
        vars(PARAMS, { sub: "a" }),
      ),
    ).toThrow(CoazMappingError);
    expect(() =>
      renderCoazMapping(
        {
          evaluation: {
            ...body,
            resource: { type: "r", id: "$token.?client_id" },
          },
        },
        vars(PARAMS, { sub: "a" }),
      ),
    ).toThrow(CoazMappingError);
  });
});

describe("renderCoazMapping determinism", () => {
  const MAPPING: JsonObject = {
    evaluation: {
      subject: { type: "identity", id: "$token.sub" },
      action: { name: "get_customer" },
      resource: { type: "customer", id: "$params.arguments.id" },
      context: { agent: "$token.?client_id" },
    },
  };

  it("does not mutate mapping, params, or token", () => {
    const mapping = structuredClone(MAPPING);
    const params = structuredClone(PARAMS);
    const token = structuredClone(TOKEN);
    const frozen = structuredClone({ mapping, params, token });
    renderCoazMapping(mapping, { params, token });
    expect({ mapping, params, token }).toEqual(frozen);
  });

  it("renders identical output on repeat", () => {
    const a = renderCoazMapping(structuredClone(MAPPING), vars());
    const b = renderCoazMapping(structuredClone(MAPPING), vars());
    expect(a).toEqual(b);
  });
});
