import type { ActionEnvelope } from "@actiontape/core";
import { mapMcpToolCallToAuthzen, type AuthzenIdentity } from "./map.js";
import type {
  AuthzenAccessEvaluationRequest,
  AuthzenDecision,
  AuthzenSimulationResult,
} from "./types.js";

export type AuthzenEvaluator = (
  request: AuthzenAccessEvaluationRequest,
  action: ActionEnvelope,
) => Promise<AuthzenDecision>;

// Historical simulation over recorded actions: sequential, in input order,
// one Access Evaluation per ActionEnvelope. A deny decision is a successful
// evaluation and does not stop the run; mapping or transport errors throw and
// fail closed (callers stop further PDP requests). MRTR wire rounds evaluate
// independently — no logical grouping.
export async function simulateAuthzen(
  actions: readonly ActionEnvelope[],
  identity: AuthzenIdentity,
  evaluator: AuthzenEvaluator,
): Promise<AuthzenSimulationResult> {
  const result: AuthzenSimulationResult = { decisions: [] };
  for (const action of actions) {
    const request = mapMcpToolCallToAuthzen(action, identity);
    const decision = await evaluator(request, action);
    result.decisions.push({
      actionId: action.id,
      target: action.target,
      decision: decision.decision,
      context: decision.context ?? null,
    });
  }
  return result;
}
