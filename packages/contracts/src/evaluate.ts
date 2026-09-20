import type { ActionEnvelope, JsonValue } from "@actiontape/core";
import { jsonEquals, matchesAction, resolvePointer } from "./match.js";
import type { ActionContract, ContractEvaluation, ContractViolation } from "./types.js";

export function evaluateContract(
  contract: ActionContract,
  actions: readonly ActionEnvelope[],
): ContractEvaluation {
  const violations: ContractViolation[] = [];

  for (const rule of contract.rules) {
    const matched = actions.filter((a) => matchesAction(rule.match, a));

    if (rule.type === "deny") {
      for (const action of matched) {
        violations.push({
          ruleId: rule.id,
          ruleType: rule.type,
          message: `denied action ${action.id} — ${action.operation} ${action.target}`,
          actionIds: [action.id],
        });
      }
    } else if (rule.type === "max_calls") {
      if (matched.length > rule.max) {
        violations.push({
          ruleId: rule.id,
          ruleType: rule.type,
          message:
            `call budget exceeded: ${matched.length} matching actions, ` +
            `max ${rule.max} — ids: ${matched.map((a) => a.id).join(", ")}`,
          actionIds: matched.map((a) => a.id),
        });
      }
    } else {
      for (const action of matched) {
        const resolved = resolvePointer(action.arguments, rule.path);
        if (rule.operator === "exists") {
          if (!resolved.found) {
            violations.push({
              ruleId: rule.id,
              ruleType: rule.type,
              message: `${action.id} — ${rule.path} is missing`,
              actionIds: [action.id],
            });
          }
        } else {
          const expected = rule.value as JsonValue;
          if (!resolved.found || !jsonEquals(resolved.value as JsonValue, expected)) {
            violations.push({
              ruleId: rule.id,
              ruleType: rule.type,
              message:
                `${action.id} — ${rule.path} expected ${JSON.stringify(expected)}, ` +
                `observed ${resolved.found ? JSON.stringify(resolved.value) : "<missing>"}`,
              actionIds: [action.id],
            });
          }
        }
      }
    }
  }

  return { ok: violations.length === 0, violations };
}
