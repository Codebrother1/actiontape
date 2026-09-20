import { isJsonObject } from "@actiontape/core";
import { AuthzenRequestError } from "./errors.js";
import type { AuthzenAccessEvaluationRequest, AuthzenDecision } from "./types.js";

export const AUTHZEN_DEFAULT_TIMEOUT_MS = 5000;

export interface EvaluateAccessOptions {
  timeoutMs?: number;
}

export async function evaluateAccess(
  endpoint: string,
  request: AuthzenAccessEvaluationRequest,
  options: EvaluateAccessOptions = {},
): Promise<AuthzenDecision> {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new AuthzenRequestError(`invalid endpoint URL: ${endpoint}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new AuthzenRequestError(`unsupported endpoint scheme "${url.protocol}"`);
  }

  const timeoutMs = options.timeoutMs ?? AUTHZEN_DEFAULT_TIMEOUT_MS;
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
  if (typeof body.decision !== "boolean") {
    throw new AuthzenRequestError("PDP response missing boolean decision");
  }
  if (body.context !== undefined && !isJsonObject(body.context)) {
    throw new AuthzenRequestError("PDP response context is not a JSON object");
  }
  const decision: AuthzenDecision = { decision: body.decision };
  if (body.context !== undefined) decision.context = body.context;
  return decision;
}
