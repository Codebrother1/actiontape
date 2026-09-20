import { Environment, Optional } from "@marcbachmann/cel-js";
import { isJsonValue, type JsonObject, type JsonValue } from "@actiontape/core";
import { CoazMappingError } from "./errors.js";

// Structural parse limits for declared-mapping expressions. These bound the
// expression itself; they do not bound iteration over input data, so inputs
// are separately budgeted by assertCelInputBudget below.
const CEL_PARSE_LIMITS = {
  maxAstNodes: 1000,
  maxDepth: 50,
  maxListElements: 100,
  maxMapEntries: 100,
  maxCallArguments: 16,
} as const;

export const CEL_INPUT_MAX_DEPTH = 50;
export const CEL_INPUT_MAX_NODES = 20_000;
export const CEL_INPUT_MAX_CONTAINER_ENTRIES = 5_000;
export const CEL_INPUT_MAX_STRING_LENGTH = 1_000_000;

// Closed-world environment: only params and token exist, no host functions or
// constants are registered, and unlisted variables fail at evaluation time.
const celEnvironment = new Environment({
  unlistedVariablesAreDyn: false,
  homogeneousAggregateLiterals: false,
  enableOptionalTypes: true,
  limits: CEL_PARSE_LIMITS,
})
  .registerVariable("params", "dyn")
  .registerVariable("token", "dyn");

export type CoazExpressionResult =
  { readonly kind: "value"; readonly value: JsonValue } | { readonly kind: "omitted" };

const OMIT = Symbol("actiontape.coaz.omit");
type Adapted = JsonValue | typeof OMIT;

// Deterministic resource budget over the input JSON documents. CEL expression
// limits do not bound iteration over arbitrarily large input collections.
function assertCelInputBudget(value: JsonValue, label: string): void {
  let nodes = 0;
  const inPath = new Set<object>();
  const walk = (v: JsonValue, depth: number, path: string): void => {
    if (depth > CEL_INPUT_MAX_DEPTH) {
      throw new CoazMappingError(`${label}${path}: exceeds max input depth ${CEL_INPUT_MAX_DEPTH}`);
    }
    if (++nodes > CEL_INPUT_MAX_NODES) {
      throw new CoazMappingError(`${label}: exceeds max input node count ${CEL_INPUT_MAX_NODES}`);
    }
    if (typeof v === "string") {
      if (v.length > CEL_INPUT_MAX_STRING_LENGTH) {
        throw new CoazMappingError(
          `${label}${path}: string exceeds max length ${CEL_INPUT_MAX_STRING_LENGTH}`,
        );
      }
      return;
    }
    if (v === null || typeof v !== "object") return;
    if (inPath.has(v)) {
      throw new CoazMappingError(`${label}${path}: cyclic input is not allowed`);
    }
    inPath.add(v);
    const entries = Array.isArray(v) ? v.length : Object.keys(v).length;
    if (entries > CEL_INPUT_MAX_CONTAINER_ENTRIES) {
      throw new CoazMappingError(
        `${label}${path}: container exceeds max entries ${CEL_INPUT_MAX_CONTAINER_ENTRIES}`,
      );
    }
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) walk(v[i] as JsonValue, depth + 1, `${path}[${i}]`);
    } else {
      for (const [key, child] of Object.entries(v)) {
        walk(child, depth + 1, `${path}.${key}`);
      }
    }
    inPath.delete(v);
  };
  walk(value, 0, "");
}

// Converts a cel-js runtime value into JSON data or the private OMIT sentinel.
// cel-js runtime objects (Optional, BigInt, non-plain objects) never escape.
function adaptCelValue(raw: unknown, path: string): Adapted {
  if (raw instanceof Optional) {
    if (!raw.hasValue()) return OMIT;
    return adaptCelValue(raw.value(), path);
  }
  if (raw === null || typeof raw === "string" || typeof raw === "boolean") {
    return raw;
  }
  if (typeof raw === "bigint") {
    if (raw >= BigInt(Number.MIN_SAFE_INTEGER) && raw <= BigInt(Number.MAX_SAFE_INTEGER)) {
      return Number(raw);
    }
    throw new CoazMappingError(`${path}: CEL integer result is outside the safe JSON number range`);
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) {
      throw new CoazMappingError(`${path}: CEL result is a non-finite number`);
    }
    return raw;
  }
  if (Array.isArray(raw)) {
    const out: JsonValue[] = [];
    for (let i = 0; i < raw.length; i++) {
      const el = adaptCelValue(raw[i], `${path}[${i}]`);
      if (el === OMIT) {
        throw new CoazMappingError(`${path}[${i}]: optional value has no value inside an array`);
      }
      out.push(el);
    }
    return out;
  }
  if (typeof raw === "object") {
    const proto: unknown = Object.getPrototypeOf(raw);
    if (proto !== null && proto !== Object.prototype) {
      throw new CoazMappingError(`${path}: CEL result is not JSON-compatible`);
    }
    const out: JsonObject = {};
    for (const [key, child] of Object.entries(raw)) {
      const adapted = adaptCelValue(child, `${path}.${key}`);
      if (adapted !== OMIT) out[key] = adapted;
    }
    return out;
  }
  throw new CoazMappingError(`${path}: CEL result is not JSON-compatible`);
}

// Evaluates a raw CEL expression (no COAZ "$" discriminator) against JSON
// params/token data. All cel-js failures are wrapped as CoazMappingError.
export function evaluateCoazExpression(
  expression: string,
  variables: { params: JsonObject; token: JsonObject },
  path = "expression",
): CoazExpressionResult {
  if (expression.length === 0) {
    throw new CoazMappingError(`${path}: empty CEL expression`);
  }
  assertCelInputBudget(variables.params, "params");
  assertCelInputBudget(variables.token, "token");
  let raw: unknown;
  try {
    raw = celEnvironment.evaluate(expression, {
      params: variables.params,
      token: variables.token,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new CoazMappingError(`${path}: CEL evaluation failed: ${message.split("\n")[0]}`);
  }
  const adapted = adaptCelValue(raw, path);
  if (adapted === OMIT) return { kind: "omitted" };
  if (!isJsonValue(adapted)) {
    throw new CoazMappingError(`${path}: CEL result is not JSON-compatible`);
  }
  return { kind: "value", value: adapted };
}
