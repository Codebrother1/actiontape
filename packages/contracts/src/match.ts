import { isJsonObject, type ActionEnvelope, type JsonValue } from "@actiontape/core";
import type { ActionMatch } from "./types.js";

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

function escapeRegExp(text: string): string {
  return text.replace(REGEX_META, "\\$&");
}

export function targetGlobMatches(glob: string, target: string): boolean {
  if (!glob.includes("*")) return glob === target;
  const pattern = `^${glob.split("*").map(escapeRegExp).join(".*")}$`;
  return new RegExp(pattern).test(target);
}

export function matchesAction(match: ActionMatch | undefined, action: ActionEnvelope): boolean {
  if (!match) return true;
  if (match.protocol !== undefined && match.protocol !== action.protocol) return false;
  if (match.direction !== undefined && match.direction !== action.direction) return false;
  if (match.operation !== undefined && match.operation !== action.operation) return false;
  if (match.target !== undefined && !targetGlobMatches(match.target, action.target)) return false;
  return true;
}

export function isValidPointer(path: string): boolean {
  if (path !== "" && !path.startsWith("/")) return false;
  for (const segment of path.split("/").slice(1)) {
    for (let i = 0; i < segment.length; i++) {
      if (segment[i] === "~" && segment[i + 1] !== "0" && segment[i + 1] !== "1") return false;
    }
  }
  return true;
}

const ARRAY_INDEX = /^(0|[1-9][0-9]*)$/;

function unescapeSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

export interface PointerResult {
  found: boolean;
  value?: JsonValue;
}

export function resolvePointer(root: JsonValue, path: string): PointerResult {
  let current: JsonValue = root;
  for (const raw of path.split("/").slice(1)) {
    const segment = unescapeSegment(raw);
    if (Array.isArray(current)) {
      if (!ARRAY_INDEX.test(segment)) return { found: false };
      const index = Number(segment);
      if (index >= current.length) return { found: false };
      current = current[index]!;
    } else if (isJsonObject(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return { found: false };
      current = current[segment]!;
    } else {
      return { found: false };
    }
  }
  return { found: true, value: current };
}

export function jsonEquals(a: JsonValue, b: JsonValue): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => jsonEquals(item, b[i]!))
    );
  }
  if (isJsonObject(a) && isJsonObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every(
        (key) => Object.prototype.hasOwnProperty.call(b, key) && jsonEquals(a[key]!, b[key]!),
      )
    );
  }
  return false;
}
