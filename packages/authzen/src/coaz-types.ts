import type { JsonObject } from "@actiontape/core";
import type {
  AuthzenAccessEvaluationRequest,
  AuthzenAction,
  AuthzenResource,
  AuthzenSubject,
} from "./types.js";

export interface AuthzenEvaluationEntry {
  // AuthZEN permits a per-entry subject override even though the COAZ-MCP
  // renderer prohibits declaring one.
  subject?: AuthzenSubject;
  action?: AuthzenAction;
  resource?: AuthzenResource;
  context?: JsonObject;
}

// AuthZEN Access Evaluations request shape: a shared top-level subject plus
// top-level defaults, with per-entry overrides inside `evaluations`.
export interface AuthzenAccessEvaluationsRequest {
  subject: AuthzenSubject;
  action?: AuthzenAction;
  resource?: AuthzenResource;
  context?: JsonObject;
  evaluations: AuthzenEvaluationEntry[];
}

export type CoazSubjectAnchor = "matches_token_sub" | "subject_id_override";

export interface CoazRenderWarning {
  code: "subject_id_override";
  message: string;
}

export type CoazRenderResult =
  | {
      readonly kind: "evaluation";
      readonly request: AuthzenAccessEvaluationRequest;
      readonly warnings: CoazRenderWarning[];
      readonly subjectAnchor: CoazSubjectAnchor;
    }
  | {
      readonly kind: "evaluations";
      readonly request: AuthzenAccessEvaluationsRequest;
      readonly warnings: CoazRenderWarning[];
      readonly subjectAnchor: CoazSubjectAnchor;
    };
