import { describe, expect, it } from "vitest";
import { createActionEnvelope, type ActionEnvelope, type JsonObject } from "@actiontape/core";
import {
  ContractParseError,
  evaluateContract,
  parseContract,
  resolvePointer,
  targetGlobMatches,
} from "../src/index.js";

let counter = 0;
function action(init: {
  id?: string;
  target?: string;
  operation?: string;
  protocol?: string;
  direction?: "outbound" | "inbound";
  arguments?: JsonObject;
}): ActionEnvelope {
  counter += 1;
  return createActionEnvelope({
    id: init.id ?? `a-${counter}`,
    timestamp: "2026-01-01T00:00:00.000Z",
    recordingId: "rec-test",
    protocol: init.protocol ?? "mcp",
    direction: init.direction ?? "outbound",
    operation: init.operation ?? "tools/call",
    target: init.target ?? "noop",
    arguments: init.arguments ?? {},
  });
}

describe("parseContract", () => {
  it("parses valid YAML", () => {
    const c = parseContract(`
contractVersion: "1.0"
rules:
  - id: no-delete
    type: deny
    match:
      protocol: mcp
      operation: tools/call
      target: "delete_*"
`);
    expect(c.contractVersion).toBe("1.0");
    expect(c.rules).toHaveLength(1);
    expect(c.rules[0]).toMatchObject({ id: "no-delete", type: "deny" });
  });

  it("parses valid JSON (JSON is valid YAML)", () => {
    const c = parseContract(
      JSON.stringify({
        contractVersion: "1.0",
        rules: [{ id: "r", type: "max_calls", max: 3 }],
      }),
    );
    expect(c.rules[0]).toMatchObject({ id: "r", type: "max_calls", max: 3 });
  });

  it("rejects unsupported contractVersion", () => {
    expect(() => parseContract(`contractVersion: "2.0"\nrules: []`)).toThrow(ContractParseError);
  });

  it("rejects missing rules and non-array rules", () => {
    expect(() => parseContract(`contractVersion: "1.0"`)).toThrow(ContractParseError);
    expect(() => parseContract(`contractVersion: "1.0"\nrules: nope`)).toThrow(ContractParseError);
  });

  it("rejects duplicate rule ids", () => {
    expect(() =>
      parseContract(`
contractVersion: "1.0"
rules:
  - { id: a, type: deny }
  - { id: a, type: deny }
`),
    ).toThrow(/duplicate rule id/);
  });

  it("rejects unsupported rule types including typos", () => {
    expect(() =>
      parseContract(`contractVersion: "1.0"\nrules: [{ id: x, type: max_callz, max: 1 }]`),
    ).toThrow(/unsupported rule type/);
  });

  it("rejects missing rule id", () => {
    expect(() => parseContract(`contractVersion: "1.0"\nrules: [{ type: deny }]`)).toThrow(
      /rule id/,
    );
  });

  it("rejects unknown top-level, rule, and match fields", () => {
    expect(() => parseContract(`contractVersion: "1.0"\nextra: 1\nrules: []`)).toThrow(
      /unknown top-level/,
    );
    expect(() =>
      parseContract(`contractVersion: "1.0"\nrules: [{ id: a, type: deny, bogus: 1 }]`),
    ).toThrow(/not allowed/);
    expect(() =>
      parseContract(
        `contractVersion: "1.0"\nrules: [{ id: a, type: deny, match: { targte: "x" } }]`,
      ),
    ).toThrow(/unknown match field/);
  });

  it("rejects invalid direction, max, pointer, and equals-without-value", () => {
    expect(() =>
      parseContract(
        `contractVersion: "1.0"\nrules: [{ id: a, type: deny, match: { direction: "sideways" } }]`,
      ),
    ).toThrow(/direction/);
    expect(() =>
      parseContract(`contractVersion: "1.0"\nrules: [{ id: a, type: max_calls, max: -1 }]`),
    ).toThrow(/max/);
    expect(() =>
      parseContract(`contractVersion: "1.0"\nrules: [{ id: a, type: max_calls, max: 1.5 }]`),
    ).toThrow(/max/);
    expect(() =>
      parseContract(
        `contractVersion: "1.0"\nrules: [{ id: a, type: require_argument, path: "no-slash", operator: exists }]`,
      ),
    ).toThrow(/pointer/);
    expect(() =>
      parseContract(
        `contractVersion: "1.0"\nrules: [{ id: a, type: require_argument, path: "/x", operator: equals }]`,
      ),
    ).toThrow(/requires a value/);
    expect(() =>
      parseContract(
        `contractVersion: "1.0"\nrules: [{ id: a, type: require_argument, path: "/x", operator: exists, value: 1 }]`,
      ),
    ).toThrow(/does not accept/);
  });

  it("never executes YAML content and rejects executable-style tags", () => {
    // Unknown/executable-style tags must be rejected, not interpreted.
    expect(() => parseContract(`contractVersion: "1.0"\nrules: !foo [1]`)).toThrow();
    expect(() =>
      parseContract(`contractVersion: "1.0"\nrules: !!js/function 'function(){return 1}'`),
    ).toThrow();
    // Command-like text inside a contract is inert data, never a shell invocation.
    const parsed = parseContract(
      `contractVersion: "1.0"\nrules:\n  - id: a\n    type: deny\n    match:\n      target: "$(touch /tmp/actiontape-pwned)"`,
    );
    expect(parsed.rules[0]).toMatchObject({
      type: "deny",
      match: { target: "$(touch /tmp/actiontape-pwned)" },
    });
  });
});

describe("target glob matching", () => {
  it("matches exact, prefix, suffix, middle, and all wildcards", () => {
    expect(targetGlobMatches("delete_file", "delete_file")).toBe(true);
    expect(targetGlobMatches("delete_file", "delete_other")).toBe(false);
    expect(targetGlobMatches("delete_*", "delete_file")).toBe(true);
    expect(targetGlobMatches("delete_*", "delete_")).toBe(true);
    expect(targetGlobMatches("*.txt", "notes.txt")).toBe(true);
    expect(targetGlobMatches("git*push", "git.push")).toBe(true);
    expect(targetGlobMatches("git*push", "git.pull")).toBe(false);
    expect(targetGlobMatches("git*push", "git.force.push")).toBe(true);
    expect(targetGlobMatches("*", "anything.at-all")).toBe(true);
    expect(targetGlobMatches("a*b*c", "aXXbYYc")).toBe(true);
  });

  it("treats regex-significant characters literally", () => {
    expect(targetGlobMatches("github.*", "github.create_issue")).toBe(true);
    expect(targetGlobMatches("github.*", "githubXcreate_issue")).toBe(false);
    expect(targetGlobMatches("a.b+c(d)", "a.b+c(d)")).toBe(true);
    expect(targetGlobMatches("a.b+c(d)", "aXb+c(d)")).toBe(false);
  });
});

describe("evaluateContract", () => {
  const evalOne = (yaml: string, actions: ActionEnvelope[]) =>
    evaluateContract(parseContract(yaml), actions);

  describe("match semantics", () => {
    it("matches protocol/direction/operation exactly and empty match matches all", () => {
      const actions = [
        action({ protocol: "mcp" }),
        action({ protocol: "other" }),
        action({ direction: "inbound" }),
      ];
      const c = parseContract(`
contractVersion: "1.0"
rules:
  - { id: d1, type: deny, match: { protocol: other } }
  - { id: d2, type: deny, match: { direction: inbound } }
  - { id: d3, type: deny, match: { operation: tools/call } }
`);
      const result = evaluateContract(c, actions);
      expect(result.violations.map((v) => v.ruleId)).toEqual(["d1", "d2", "d3", "d3", "d3"]);

      const all = evalOne(`contractVersion: "1.0"\nrules: [{ id: all, type: deny }]`, actions);
      expect(all.violations).toHaveLength(3);
    });
  });

  describe("deny", () => {
    const deny = `contractVersion: "1.0"\nrules: [{ id: no-delete, type: deny, match: { target: "delete_*" } }]`;
    it("passes with no matches", () => {
      expect(evalOne(deny, [action({ target: "read_file" })]).ok).toBe(true);
    });
    it("emits one violation per matching action in order", () => {
      const actions = [
        action({ id: "a1", target: "delete_file" }),
        action({ id: "a2", target: "read_file" }),
        action({ id: "a3", target: "delete_dir" }),
      ];
      const r = evalOne(deny, actions);
      expect(r.violations.map((v) => v.actionIds)).toEqual([["a1"], ["a3"]]);
      expect(r.violations[0]!.ruleType).toBe("deny");
      expect(r.violations[0]!.ruleId).toBe("no-delete");
    });
  });

  describe("max_calls", () => {
    const budget = (max: number) =>
      `contractVersion: "1.0"\nrules: [{ id: budget, type: max_calls, match: { operation: tools/call }, max: ${max} }]`;
    const three = () => [action({ id: "x1" }), action({ id: "x2" }), action({ id: "x3" })];

    it("passes on zero matches and at/below boundary", () => {
      expect(evalOne(budget(2), []).ok).toBe(true);
      expect(evalOne(budget(4), three()).ok).toBe(true);
      expect(evalOne(budget(3), three()).ok).toBe(true);
    });
    it("emits exactly one violation with all matched ids when exceeded", () => {
      const r = evalOne(budget(2), three());
      expect(r.violations).toHaveLength(1);
      expect(r.violations[0]!.actionIds).toEqual(["x1", "x2", "x3"]);
      expect(r.violations[0]!.message).toContain("max 2");
    });
  });

  describe("require_argument", () => {
    const rule = (path: string, operator: string, value?: string) =>
      `contractVersion: "1.0"\nrules: [{ id: req, type: require_argument, path: "${path}", operator: ${operator}${value !== undefined ? `, value: ${value}` : ""} }]`;

    it("passes when zero actions match", () => {
      const r = evalOne(
        `contractVersion: "1.0"\nrules: [{ id: req, type: require_argument, match: { target: nope }, path: "/x", operator: exists }]`,
        [action({})],
      );
      expect(r.ok).toBe(true);
    });

    it("supports exists on top-level, nested, and null values", () => {
      const a = action({ arguments: { repository: null, options: { private: true } } });
      expect(evalOne(rule("/repository", "exists"), [a]).ok).toBe(true);
      expect(evalOne(rule("/options/private", "exists"), [a]).ok).toBe(true);
      expect(evalOne(rule("/missing", "exists"), [a]).ok).toBe(false);
    });

    it("supports equals on strings, numbers, booleans, and null", () => {
      const a = action({ arguments: { s: "main", n: 42, b: false, z: null } });
      expect(evalOne(rule("/s", "equals", `"main"`), [a]).ok).toBe(true);
      expect(evalOne(rule("/s", "equals", `"develop"`), [a]).ok).toBe(false);
      expect(evalOne(rule("/n", "equals", "42"), [a]).ok).toBe(true);
      expect(evalOne(rule("/b", "equals", "false"), [a]).ok).toBe(true);
      expect(evalOne(rule("/z", "equals", "null"), [a]).ok).toBe(true);
    });

    it("compares objects structurally regardless of key order", () => {
      const a = action({ arguments: { repo: { owner: "o", name: "n", private: false } } });
      const r = evalOne(
        `contractVersion: "1.0"\nrules: [{ id: req, type: require_argument, path: "/repo", operator: equals, value: { name: "n", private: false, owner: "o" } }]`,
        [a],
      );
      expect(r.ok).toBe(true);
    });

    it("keeps array equality order-sensitive and supports index traversal", () => {
      const a = action({ arguments: { items: [{ name: "first" }, { name: "second" }] } });
      expect(evalOne(rule("/items/0/name", "equals", `"first"`), [a]).ok).toBe(true);
      expect(evalOne(rule("/items/2/name", "exists"), [a]).ok).toBe(false);
      const b = action({ arguments: { list: ["a", "b"] } });
      expect(
        evalOne(
          `contractVersion: "1.0"\nrules: [{ id: req, type: require_argument, path: "/list", operator: equals, value: ["b", "a"] }]`,
          [b],
        ).ok,
      ).toBe(false);
    });

    it("supports ~0 and ~1 JSON pointer escapes", () => {
      const a = action({ arguments: { "a/b": { "~key": 1 } } });
      expect(evalOne(rule("/a~1b/~0key", "equals", "1"), [a]).ok).toBe(true);
    });

    it("reports observed value in violation messages", () => {
      const a = action({ id: "act-9", arguments: { base: "develop" } });
      const r = evalOne(rule("/base", "equals", `"main"`), [a]);
      expect(r.violations[0]!.message).toContain('/base expected "main", observed "develop"');
      expect(r.violations[0]!.actionIds).toEqual(["act-9"]);
    });
  });

  describe("evaluation properties", () => {
    it("passes on an empty action list and does not mutate inputs", () => {
      const contract = parseContract(
        `contractVersion: "1.0"\nrules: [{ id: d, type: deny, match: { target: "*" } }]`,
      );
      const actions = [action({ arguments: { x: 1 } })];
      const snapshot = JSON.stringify(actions);
      const contractSnapshot = JSON.stringify(contract);
      const r = evaluateContract(contract, []);
      expect(r.ok).toBe(true);
      evaluateContract(contract, actions);
      expect(JSON.stringify(actions)).toBe(snapshot);
      expect(JSON.stringify(contract)).toBe(contractSnapshot);
    });
  });
});

describe("resolvePointer edge cases", () => {
  it("distinguishes missing from present-null and validates array indices", () => {
    const doc: JsonObject = { a: null, arr: ["x"] };
    expect(resolvePointer(doc, "/a")).toEqual({ found: true, value: null });
    expect(resolvePointer(doc, "/b").found).toBe(false);
    expect(resolvePointer(doc, "/arr/0").value).toBe("x");
    expect(resolvePointer(doc, "/arr/01").found).toBe(false);
    expect(resolvePointer(doc, "/arr/-").found).toBe(false);
    expect(resolvePointer(doc, "").found).toBe(true);
  });
});
