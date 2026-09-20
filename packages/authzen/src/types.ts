import type { JsonObject } from "@actiontape/core";

export const AUTHZEN_SIMULATION_SCHEMA_VERSION = "1.0";

export interface AuthzenSubject {
  type: string;
  id: string;
  properties?: JsonObject;
}

export interface AuthzenAction {
  name: string;
  properties?: JsonObject;
}

export interface AuthzenResource {
  type: string;
  id: string;
  properties?: JsonObject;
}

export interface AuthzenAccessEvaluationRequest {
  subject: AuthzenSubject;
  action: AuthzenAction;
  resource: AuthzenResource;
  context?: JsonObject;
}

export interface AuthzenDecision {
  decision: boolean;
  context?: JsonObject;
}

export interface AuthzenSimulationDecision {
  actionId: string;
  target: string;
  decision: boolean;
  context: JsonObject | null;
}

export interface AuthzenSimulationResult {
  decisions: AuthzenSimulationDecision[];
}
