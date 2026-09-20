import { parse as parseYaml } from "yaml";
import { isJsonObject, type ActionDirection, type JsonObject } from "@actiontape/core";
import { ContractParseError } from "./errors.js";
import { isValidPointer } from "./match.js";
import {
  CONTRACT_VERSION,
  type ActionContract,
  type ActionMatch,
  type ContractRule,
  type ContractRuleType,
} from "./types.js";

const TOP_LEVEL_FIELDS = new Set(["contractVersion", "rules"]);
const MATCH_FIELDS = new Set(["protocol", "direction", "operation", "target"]);
const DIRECTIONS = new Set(["inbound", "outbound"]);
const RULE_TYPES = new Set(["deny", "max_calls", "require_argument"]);
const OPERATORS = new Set(["exists", "equals"]);

const RULE_FIELDS: Record<string, Set<string>> = {
  deny: new Set(["id", "type", "match"]),
  max_calls: new Set(["id", "type", "match", "max"]),
  require_argument: new Set(["id", "type", "match", "path", "operator", "value"]),
};

function validateMatch(raw: unknown, ctx: string, issues: string[]): ActionMatch | undefined {
  if (raw === undefined) return undefined;
  if (!isJsonObject(raw)) {
    issues.push(`${ctx}: match must be an object`);
    return undefined;
  }
  const match: ActionMatch = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!MATCH_FIELDS.has(key)) {
      issues.push(`${ctx}: unknown match field "${key}"`);
      continue;
    }
    if (typeof value !== "string") {
      issues.push(`${ctx}: match.${key} must be a string`);
      continue;
    }
    if (key === "protocol") match.protocol = value;
    else if (key === "operation") match.operation = value;
    else if (key === "target") match.target = value;
    else {
      if (!DIRECTIONS.has(value)) {
        issues.push(`${ctx}: match.direction must be "inbound" or "outbound"`);
        continue;
      }
      match.direction = value as ActionDirection;
    }
  }
  return match;
}

function validateRule(raw: JsonObject, index: number, issues: string[]): ContractRule | undefined {
  const ctx = `rules[${index}]`;
  const id = raw.id;
  if (typeof id !== "string" || id.length === 0) {
    issues.push(`${ctx}: missing or invalid rule id`);
  }
  const type = raw.type;
  if (typeof type !== "string" || !RULE_TYPES.has(type)) {
    issues.push(`${ctx}: unsupported rule type ${JSON.stringify(type)}`);
    return undefined;
  }
  const ruleType = type as ContractRuleType;
  for (const key of Object.keys(raw)) {
    if (!RULE_FIELDS[ruleType]!.has(key)) {
      issues.push(`${ctx} (${String(id)}): field "${key}" is not allowed for type "${type}"`);
    }
  }
  const match = validateMatch(raw.match, `${ctx} (${String(id)})`, issues);
  const base = { id: String(id), ...(match ? { match } : {}) };

  if (ruleType === "deny") {
    return { ...base, type: ruleType };
  }
  if (ruleType === "max_calls") {
    if (typeof raw.max !== "number" || !Number.isInteger(raw.max) || raw.max < 0) {
      issues.push(`${ctx} (${String(id)}): max must be a non-negative integer`);
      return undefined;
    }
    return { ...base, type: ruleType, max: raw.max };
  }

  if (typeof raw.path !== "string" || !isValidPointer(raw.path)) {
    issues.push(`${ctx} (${String(id)}): path must be a valid JSON pointer`);
    return undefined;
  }
  const operator = raw.operator;
  if (typeof operator !== "string" || !OPERATORS.has(operator)) {
    issues.push(`${ctx} (${String(id)}): operator must be "exists" or "equals"`);
    return undefined;
  }
  const hasValue = Object.prototype.hasOwnProperty.call(raw, "value");
  if (operator === "equals" && !hasValue) {
    issues.push(`${ctx} (${String(id)}): operator "equals" requires a value field`);
    return undefined;
  }
  if (operator === "exists" && hasValue) {
    issues.push(`${ctx} (${String(id)}): operator "exists" does not accept a value field`);
    return undefined;
  }
  return {
    ...base,
    type: ruleType,
    path: raw.path,
    operator: operator as "exists" | "equals",
    ...(operator === "equals" ? { value: raw.value } : {}),
  };
}

export function parseContract(text: string): ActionContract {
  let doc: unknown;
  try {
    doc = parseYaml(text, { strict: true, uniqueKeys: true });
  } catch (err) {
    throw new ContractParseError(
      `YAML parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const issues: string[] = [];
  if (!isJsonObject(doc)) {
    throw new ContractParseError("contract document must be a YAML/JSON object");
  }
  for (const key of Object.keys(doc)) {
    if (!TOP_LEVEL_FIELDS.has(key)) issues.push(`unknown top-level field "${key}"`);
  }
  if (doc.contractVersion !== CONTRACT_VERSION) {
    issues.push(`unsupported contractVersion ${JSON.stringify(doc.contractVersion)}`);
  }
  const rules = doc.rules;
  if (!Array.isArray(rules)) {
    issues.push("rules is required and must be an array");
  } else {
    const seen = new Set<string>();
    const parsed: ContractRule[] = [];
    rules.forEach((raw, index) => {
      if (!isJsonObject(raw)) {
        issues.push(`rules[${index}]: rule must be an object`);
        return;
      }
      const rule = validateRule(raw, index, issues);
      if (rule) {
        if (seen.has(rule.id)) {
          issues.push(`rules[${index}]: duplicate rule id "${rule.id}"`);
          return;
        }
        seen.add(rule.id);
        parsed.push(rule);
      }
    });
    if (issues.length === 0) {
      return { contractVersion: CONTRACT_VERSION, rules: parsed };
    }
  }
  throw new ContractParseError(issues);
}
