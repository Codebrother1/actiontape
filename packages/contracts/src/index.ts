import type { ActionEnvelope } from "@actiontape/core";

export interface ContractViolation {
  message: string;
}

export interface ContractResult {
  contract: string;
  ok: boolean;
  violations: ContractViolation[];
}

export interface ActionContract {
  name: string;
  check(envelope: ActionEnvelope): readonly (ContractViolation | string)[];
}

export function evaluateContract(
  contract: ActionContract,
  envelope: ActionEnvelope,
): ContractResult {
  const violations = contract
    .check(envelope)
    .map((violation) => (typeof violation === "string" ? { message: violation } : violation));
  return { contract: contract.name, ok: violations.length === 0, violations };
}
