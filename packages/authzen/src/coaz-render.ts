import { isJsonObject, type JsonObject, type JsonValue } from "@actiontape/core";
import { evaluateCoazExpression } from "./cel.js";
import { CoazMappingError } from "./errors.js";
import type {
  AuthzenAccessEvaluationsRequest,
  CoazRenderResult,
  CoazRenderWarning,
  CoazSubjectAnchor,
} from "./coaz-types.js";
import type {
  AuthzenAccessEvaluationRequest,
  AuthzenAction,
  AuthzenResource,
  AuthzenSubject,
} from "./types.js";

export interface CoazRenderVariables {
  params: JsonObject;
  token: JsonObject;
}

const OMIT_FIELD = Symbol("actiontape.coaz.omitField");
type Rendered = JsonValue | typeof OMIT_FIELD;

const EVALUATION_FIELDS = new Set(["subject", "action", "resource", "context"]);
const EVALUATIONS_FIELDS = new Set(["subject", "action", "resource", "context", "evaluations"]);

// Recursively renders a declared mapping template. "$x" evaluates CEL "x",
// "$$x" is the literal "$x", other strings are literal. Returns OMIT_FIELD for
// a top-level optional-absent expression so callers can drop the property.
function renderTemplate(node: JsonValue, vars: CoazRenderVariables, path: string): Rendered {
  if (node === null || typeof node === "boolean" || typeof node === "number") {
    return node;
  }
  if (typeof node === "string") {
    if (!node.startsWith("$")) return node;
    if (node.startsWith("$$")) return node.slice(1);
    const result = evaluateCoazExpression(node.slice(1), vars, path);
    return result.kind === "omitted" ? OMIT_FIELD : result.value;
  }
  if (Array.isArray(node)) {
    const out: JsonValue[] = [];
    for (let i = 0; i < node.length; i++) {
      const rendered = renderTemplate(node[i] as JsonValue, vars, `${path}[${i}]`);
      if (rendered === OMIT_FIELD) {
        throw new CoazMappingError(`${path}[${i}]: optional value has no value inside an array`);
      }
      out.push(rendered);
    }
    return out;
  }
  const out: JsonObject = {};
  for (const [key, child] of Object.entries(node)) {
    const rendered = renderTemplate(child, vars, `${path}.${key}`);
    if (rendered !== OMIT_FIELD) out[key] = rendered;
  }
  return out;
}

function requireEntity(value: JsonValue | undefined, name: string, path: string): JsonObject {
  if (value === undefined) {
    throw new CoazMappingError(`${path}: missing required ${name}`);
  }
  if (!isJsonObject(value)) {
    throw new CoazMappingError(`${path}: ${name} must be a JSON object`);
  }
  return value;
}

function optionalEntity(
  value: JsonValue | undefined,
  name: string,
  path: string,
): JsonObject | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) {
    throw new CoazMappingError(`${path}: ${name} must be a JSON object`);
  }
  return value;
}

function requireNonEmptyString(value: JsonValue | undefined, field: string, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CoazMappingError(`${path}: ${field} must be a non-empty string`);
  }
  return value;
}

function validateSubject(entity: JsonObject, path: string): AuthzenSubject {
  const subject: AuthzenSubject = {
    type: requireNonEmptyString(entity.type, "subject.type", path),
    id: requireNonEmptyString(entity.id, "subject.id", path),
  };
  if (entity.properties !== undefined) {
    if (!isJsonObject(entity.properties)) {
      throw new CoazMappingError(`${path}: subject.properties must be a JSON object`);
    }
    subject.properties = entity.properties;
  }
  return subject;
}

function validateAction(entity: JsonObject, path: string): AuthzenAction {
  const action: AuthzenAction = {
    name: requireNonEmptyString(entity.name, "action.name", path),
  };
  if (entity.properties !== undefined) {
    if (!isJsonObject(entity.properties)) {
      throw new CoazMappingError(`${path}: action.properties must be a JSON object`);
    }
    action.properties = entity.properties;
  }
  return action;
}

function validateResource(entity: JsonObject, path: string): AuthzenResource {
  const resource: AuthzenResource = {
    type: requireNonEmptyString(entity.type, "resource.type", path),
    id: requireNonEmptyString(entity.id, "resource.id", path),
  };
  if (entity.properties !== undefined) {
    if (!isJsonObject(entity.properties)) {
      throw new CoazMappingError(`${path}: resource.properties must be a JSON object`);
    }
    resource.properties = entity.properties;
  }
  return resource;
}

function validateContext(value: JsonValue | undefined, path: string): JsonObject | undefined {
  if (value === undefined) return undefined;
  if (!isJsonObject(value)) {
    throw new CoazMappingError(`${path}: context must be a JSON object`);
  }
  return value;
}

// Applies COAZ declared-subject defaults (identity / token.sub) and validates.
// Returns the subject plus its anchoring status relative to the supplied
// simulated token.sub claim.
function resolveSubject(
  rendered: JsonObject | undefined,
  tokenSub: string,
  path: string,
  warnings: CoazRenderWarning[],
): { subject: AuthzenSubject; anchor: CoazSubjectAnchor } {
  const merged: JsonObject = rendered ? { ...rendered } : {};
  if (merged.id === undefined) merged.id = tokenSub;
  if (merged.type === undefined) merged.type = "identity";
  const subject = validateSubject(merged, `${path}.subject`);
  const anchor: CoazSubjectAnchor =
    subject.id === tokenSub ? "matches_token_sub" : "subject_id_override";
  if (anchor === "subject_id_override") {
    warnings.push({
      code: "subject_id_override",
      message: `${path}.subject: declared subject.id does not match the supplied token.sub`,
    });
  }
  return { subject, anchor };
}

function rejectUnknownFields(
  envelope: JsonObject,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(envelope)) {
    if (!allowed.has(key)) {
      throw new CoazMappingError(`${path}: unexpected field "${key}"`);
    }
  }
}

function renderSingleEnvelope(
  envelope: JsonObject,
  tokenSub: string,
  warnings: CoazRenderWarning[],
): { request: AuthzenAccessEvaluationRequest; anchor: CoazSubjectAnchor } {
  const path = "evaluation";
  const { subject, anchor } = resolveSubject(
    optionalEntity(envelope.subject, "subject", path),
    tokenSub,
    path,
    warnings,
  );
  const request: AuthzenAccessEvaluationRequest = {
    subject,
    action: validateAction(requireEntity(envelope.action, "action", path), `${path}.action`),
    resource: validateResource(
      requireEntity(envelope.resource, "resource", path),
      `${path}.resource`,
    ),
  };
  const context = validateContext(envelope.context, `${path}.context`);
  if (context !== undefined) request.context = context;
  return { request, anchor };
}

function renderMultiEnvelope(
  envelope: JsonObject,
  vars: CoazRenderVariables,
  tokenSub: string,
  warnings: CoazRenderWarning[],
): { request: AuthzenAccessEvaluationsRequest; anchor: CoazSubjectAnchor } {
  const path = "evaluations";
  rejectUnknownFields(envelope, EVALUATIONS_FIELDS, path);
  const rawEvaluations = envelope.evaluations;
  if (!Array.isArray(rawEvaluations) || rawEvaluations.length === 0) {
    throw new CoazMappingError(`${path}: evaluations must be a non-empty array`);
  }
  for (let i = 0; i < rawEvaluations.length; i++) {
    const entry = rawEvaluations[i];
    if (!isJsonObject(entry)) {
      throw new CoazMappingError(`${path}.evaluations[${i}]: entry must be a JSON object`);
    }
    // COAZ rule: per-evaluation subjects are prohibited; the top-level
    // subject applies to all evaluations.
    if ("subject" in entry) {
      throw new CoazMappingError(
        `${path}.evaluations[${i}]: per-evaluation subject is not allowed`,
      );
    }
    rejectUnknownFields(
      entry,
      new Set(["action", "resource", "context"]),
      `${path}.evaluations[${i}]`,
    );
  }

  const rendered = renderTemplate(envelope, vars, path);
  if (!isJsonObject(rendered)) {
    throw new CoazMappingError(`${path}: envelope did not render to a JSON object`);
  }

  const { subject, anchor } = resolveSubject(
    optionalEntity(rendered.subject, "subject", path),
    tokenSub,
    path,
    warnings,
  );
  const topAction = optionalEntity(rendered.action, "action", path);
  const topResource = optionalEntity(rendered.resource, "resource", path);
  const topContext = validateContext(rendered.context, `${path}.context`);

  const request: AuthzenAccessEvaluationsRequest = { subject, evaluations: [] };
  if (topAction !== undefined) {
    request.action = validateAction(topAction, `${path}.action`);
  }
  if (topResource !== undefined) {
    request.resource = validateResource(topResource, `${path}.resource`);
  }
  if (topContext !== undefined) request.context = topContext;

  const entries = rendered.evaluations;
  if (!Array.isArray(entries)) {
    throw new CoazMappingError(`${path}.evaluations: did not render to an array`);
  }
  for (let i = 0; i < entries.length; i++) {
    const entryPath = `${path}.evaluations[${i}]`;
    const entry = entries[i];
    if (!isJsonObject(entry)) {
      throw new CoazMappingError(`${entryPath}: entry did not render to a JSON object`);
    }
    // AuthZEN evaluations semantics: entry fields override same-named
    // top-level defaults field-by-field; no deep merge.
    const entryAction = optionalEntity(entry.action, "action", entryPath);
    const entryResource = optionalEntity(entry.resource, "resource", entryPath);
    const entryContext = validateContext(entry.context, `${entryPath}.context`);
    const effectiveAction = entryAction ?? topAction;
    const effectiveResource = entryResource ?? topResource;
    if (effectiveAction === undefined) {
      throw new CoazMappingError(`${entryPath}: missing required action`);
    }
    if (effectiveResource === undefined) {
      throw new CoazMappingError(`${entryPath}: missing required resource`);
    }

    const outEntry: AuthzenAccessEvaluationsRequest["evaluations"][number] = {};
    if (entryAction !== undefined) {
      outEntry.action = validateAction(entryAction, `${entryPath}.action`);
    }
    if (entryResource !== undefined) {
      outEntry.resource = validateResource(entryResource, `${entryPath}.resource`);
    }
    if (entryContext !== undefined) outEntry.context = entryContext;
    request.evaluations.push(outEntry);
  }
  return { request, anchor };
}

// Renders a declared COAZ-MCP x-authzen-mapping against recorded tool-call
// params and simulated token claims into a validated AuthZEN request.
// Pure and deterministic: no PDP contact, no JWT validation, no execution.
export function renderCoazMapping(
  mapping: JsonObject,
  variables: CoazRenderVariables,
): CoazRenderResult {
  const tokenSub = variables.token.sub;
  if (typeof tokenSub !== "string" || tokenSub.length === 0) {
    throw new CoazMappingError("token.sub must be a non-empty string");
  }
  const hasSingle = "evaluation" in mapping;
  const hasMulti = "evaluations" in mapping;
  if (hasSingle === hasMulti) {
    throw new CoazMappingError('mapping must contain exactly one of "evaluation" or "evaluations"');
  }
  for (const key of Object.keys(mapping)) {
    if (key !== "evaluation" && key !== "evaluations") {
      throw new CoazMappingError(`mapping: unexpected top-level field "${key}"`);
    }
  }
  const warnings: CoazRenderWarning[] = [];
  if (hasSingle) {
    const envelope = mapping.evaluation;
    if (!isJsonObject(envelope)) {
      throw new CoazMappingError("mapping.evaluation: envelope must be a JSON object");
    }
    rejectUnknownFields(envelope, EVALUATION_FIELDS, "evaluation");
    const rendered = renderTemplate(envelope, variables, "evaluation");
    if (!isJsonObject(rendered)) {
      throw new CoazMappingError("evaluation: envelope did not render to a JSON object");
    }
    const { request, anchor } = renderSingleEnvelope(rendered, tokenSub, warnings);
    return { kind: "evaluation", request, warnings, subjectAnchor: anchor };
  }
  const envelope = mapping.evaluations;
  if (!isJsonObject(envelope)) {
    throw new CoazMappingError("mapping.evaluations: envelope must be a JSON object");
  }
  const { request, anchor } = renderMultiEnvelope(envelope, variables, tokenSub, warnings);
  return { kind: "evaluations", request, warnings, subjectAnchor: anchor };
}
