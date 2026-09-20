import { isJsonObject } from "@actiontape/core";
import { AuthzenRequestError } from "./errors.js";
import type { AuthzenAccessEvaluationRequest, AuthzenDecision } from "./types.js";
import type { AuthzenAccessEvaluationsRequest } from "./coaz-types.js";

export const AUTHZEN_DEFAULT_TIMEOUT_MS = 5000;

export interface EvaluateAccessOptions {
  timeoutMs?: number;
}

// Shared transport for AuthZEN POSTs: http/https only, no redirects, no
// cookies or credentials, no caller-supplied headers, one shot, per-request
// timeout. Returns the parsed JSON body as an untyped value for the caller's
// shape validation.
async function postForJson(endpoint: string, request: object, timeoutMs: number): Promise<unknown> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new AuthzenRequestError(`invalid endpoint URL: ${endpoint}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AuthzenRequestError(`unsupported endpoint scheme "${url.protocol}"`);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(request),
      redirect: "error",
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new AuthzenRequestError(`PDP request timed out after ${timeoutMs} ms`);
    }
    throw new AuthzenRequestError(
      `PDP request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new AuthzenRequestError(`PDP returned HTTP ${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new AuthzenRequestError("PDP response was not valid JSON");
  }
  if (!isJsonObject(body)) {
    throw new AuthzenRequestError("PDP response was not a JSON object");
  }
  return body;
}

function parseDecision(value: unknown, path: string): AuthzenDecision {
  if (!isJsonObject(value) || typeof value.decision !== "boolean") {
    throw new AuthzenRequestError(`${path}: missing boolean decision`);
  }
  if (value.context !== undefined && !isJsonObject(value.context)) {
    throw new AuthzenRequestError(`${path}: context is not a JSON object`);
  }
  const decision: AuthzenDecision = { decision: value.decision };
  if (value.context !== undefined) decision.context = value.context;
  return decision;
}

export async function evaluateAccess(
  endpoint: string,
  request: AuthzenAccessEvaluationRequest,
  options: EvaluateAccessOptions = {},
): Promise<AuthzenDecision> {
  const timeoutMs = options.timeoutMs ?? AUTHZEN_DEFAULT_TIMEOUT_MS;
  const body = await postForJson(endpoint, request, timeoutMs);
  return parseDecision(body, "PDP response");
}

// AuthZEN Access Evaluations API: one POST carrying the whole batch. The
// returned `evaluations` array must match the request's entries one-for-one —
// ActionTape's renderer does not emit short-circuit options, so a count
// mismatch means the response cannot be safely correlated and is fatal.
export async function evaluateAccessMany(
  endpoint: string,
  request: AuthzenAccessEvaluationsRequest,
  options: EvaluateAccessOptions = {},
): Promise<AuthzenDecision[]> {
  const timeoutMs = options.timeoutMs ?? AUTHZEN_DEFAULT_TIMEOUT_MS;
  const body = await postForJson(endpoint, request, timeoutMs);
  const evaluations = (body as { evaluations?: unknown }).evaluations;
  if (!Array.isArray(evaluations)) {
    throw new AuthzenRequestError("PDP response missing evaluations array");
  }
  if (evaluations.length !== request.evaluations.length) {
    throw new AuthzenRequestError(
      `PDP returned ${evaluations.length} decisions for ${request.evaluations.length} evaluations`,
    );
  }
  return evaluations.map((entry, i) => parseDecision(entry, `PDP response evaluations[${i}]`));
}
