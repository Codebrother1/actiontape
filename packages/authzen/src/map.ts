import type { ActionEnvelope } from "@actiontape/core";
import { AuthzenMappingError } from "./errors.js";
import type { AuthzenAccessEvaluationRequest } from "./types.js";

export interface AuthzenIdentity {
  subjectId: string;
  agentId?: string;
}

// COAZ-MCP Draft 1 DEFAULT tools/call mapping. The default mapping authorizes
// the tool itself: arguments, results, recording ids, and MCP metadata are
// intentionally NOT transmitted. Argument-aware authorization requires a
// declared x-authzen-mapping, which is not implemented yet.
export function mapMcpToolCallToAuthzen(
  action: ActionEnvelope,
  identity: AuthzenIdentity,
): AuthzenAccessEvaluationRequest {
  if (identity.subjectId.length === 0) {
    throw new AuthzenMappingError("subjectId must be a non-empty string");
  }
  if (action.protocol !== "mcp") {
    throw new AuthzenMappingError(
      `action ${action.id}: unsupported protocol "${action.protocol}" (expected "mcp")`,
    );
  }
  if (action.direction !== "outbound") {
    throw new AuthzenMappingError(
      `action ${action.id}: unsupported direction "${action.direction}" (expected "outbound")`,
    );
  }
  if (action.operation !== "tools/call") {
    throw new AuthzenMappingError(
      `action ${action.id}: unsupported operation "${action.operation}" (expected "tools/call")`,
    );
  }
  if (action.target.length === 0) {
    throw new AuthzenMappingError(`action ${action.id}: empty tool target`);
  }

  const request: AuthzenAccessEvaluationRequest = {
    subject: { type: "identity", id: identity.subjectId },
    action: { name: "tools/call" },
    resource: { type: "tool", id: action.target },
  };
  if (identity.agentId !== undefined) {
    request.context = { agent: identity.agentId };
  }
  return request;
}
