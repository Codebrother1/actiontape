import type { ActionDirection, JsonValue } from "@actiontape/core";

export const CONTRACT_VERSION = "1.0";

export interface ActionMatch {
  protocol?: string;
  direction?: ActionDirection;
  operation?: string;
  target?: string;
}

export type ContractRuleType = "deny" | "max_calls" | "require_argument";

export interface DenyRule {
  id: string;
  type: "deny";
  match?: ActionMatch;
}

export interface MaxCallsRule {
  id: string;
  type: "max_calls";
  match?: ActionMatch;
  max: number;
}

export type RequireArgumentOperator = "exists" | "equals";

export interface RequireArgumentRule {
  id: string;
  type: "require_argument";
  match?: ActionMatch;
  path: string;
  operator: RequireArgumentOperator;
  value?: JsonValue;
}

export type ContractRule = DenyRule | MaxCallsRule | RequireArgumentRule;

export interface ActionContract {
  contractVersion: typeof CONTRACT_VERSION;
  rules: ContractRule[];
}

export interface ContractViolation {
  ruleId: string;
  ruleType: ContractRuleType;
  message: string;
  actionIds: string[];
}

export interface ContractEvaluation {
  ok: boolean;
  violations: ContractViolation[];
}
