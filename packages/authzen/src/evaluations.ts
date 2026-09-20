import { AuthzenMappingError } from "./errors.js";
import type { AuthzenAccessEvaluationRequest } from "./types.js";
import type { AuthzenAccessEvaluationsRequest } from "./coaz-types.js";

// Expands an AuthZEN Access Evaluations request into effective individual
// Access Evaluation requests using AuthZEN 1.0 field-level default semantics:
// each entry overrides the same-named top-level field as a whole object —
// there is no deep merge of subject/action/resource/context. Order is
// preserved and the input request is not mutated.
export function expandAccessEvaluationsRequest(
  request: AuthzenAccessEvaluationsRequest,
): AuthzenAccessEvaluationRequest[] {
  return request.evaluations.map((entry, i) => {
    const action = entry.action ?? request.action;
    const resource = entry.resource ?? request.resource;
    if (action === undefined) {
      throw new AuthzenMappingError(`evaluations[${i}]: no effective action`);
    }
    if (resource === undefined) {
      throw new AuthzenMappingError(`evaluations[${i}]: no effective resource`);
    }
    const expanded: AuthzenAccessEvaluationRequest = {
      subject: entry.subject ?? request.subject,
      action,
      resource,
    };
    const context = entry.context ?? request.context;
    if (context !== undefined) expanded.context = context;
    return expanded;
  });
}
