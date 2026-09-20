import { isJsonObject, type ActionEnvelope, type JsonObject } from "@actiontape/core";
import type { McpCatalogTimeline } from "./catalog.js";

export class McpProvenanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpProvenanceError";
  }
}

export type McpMappingSource = "declared" | "default_confirmed" | "unknown";

export type McpMappingUnknownReason =
  "no_catalog" | "catalog_stale" | "partial_catalog" | "tool_not_in_catalog" | "malformed_mapping";

export interface McpToolMappingProvenance {
  actionId: string;
  toolName: string;
  mappingSource: McpMappingSource;
  reason: McpMappingUnknownReason | null;
  catalogSequence: number | null;
  declaredMapping: JsonObject | null;
}

// Resolves COAZ-MCP Draft 1 mapping provenance for one recorded tools/call:
// DECLARED when the latest complete non-stale catalog before the call
// advertised x-authzen-mapping for the tool, DEFAULT_CONFIRMED when it
// advertised the tool with no mapping, and UNKNOWN when the tape lacks enough
// evidence. UNKNOWN is never silently treated as the default mapping.
export function resolveToolMappingProvenance(
  action: ActionEnvelope,
  timeline: McpCatalogTimeline,
): McpToolMappingProvenance {
  if (action.protocol !== "mcp" || action.direction !== "outbound") {
    throw new McpProvenanceError(
      `action ${action.id}: mapping provenance requires an outbound mcp action`,
    );
  }
  if (action.operation !== "tools/call" || action.target.length === 0) {
    throw new McpProvenanceError(
      `action ${action.id}: mapping provenance requires a tools/call action with a tool target`,
    );
  }
  const mcp = isJsonObject(action.metadata?.mcp) ? action.metadata.mcp : undefined;
  const sequence = typeof mcp?.requestSequence === "number" ? mcp.requestSequence : undefined;
  if (sequence === undefined) {
    throw new McpProvenanceError(
      `action ${action.id}: missing mcp.requestSequence metadata — cannot order against catalogs`,
    );
  }

  const base: Omit<
    McpToolMappingProvenance,
    "mappingSource" | "reason" | "catalogSequence" | "declaredMapping"
  > = {
    actionId: action.id,
    toolName: action.target,
  };
  const unknown = (reason: McpMappingUnknownReason, catalogSequence: number | null = null) => ({
    ...base,
    mappingSource: "unknown" as const,
    reason,
    catalogSequence,
    declaredMapping: null,
  });

  // Latest catalog completed before the call and not stale at call time.
  let usable: McpCatalogTimeline["catalogs"][number] | undefined;
  for (const catalog of timeline.catalogs) {
    const beforeCall = catalog.completedAtSequence < sequence;
    const stale =
      catalog.invalidatedAtSequence !== undefined && catalog.invalidatedAtSequence < sequence;
    if (
      beforeCall &&
      !stale &&
      (!usable || catalog.completedAtSequence > usable.completedAtSequence)
    ) {
      usable = catalog;
    }
  }

  if (!usable) {
    const priorComplete = timeline.catalogs.filter((c) => c.completedAtSequence < sequence).at(-1);
    const lastIncomplete = timeline.incomplete
      .filter((i) => i.lastObservedSequence < sequence)
      .at(-1);
    if (
      lastIncomplete &&
      (!priorComplete ||
        lastIncomplete.lastObservedSequence >
          (priorComplete.invalidatedAtSequence ?? priorComplete.completedAtSequence))
    ) {
      return unknown("partial_catalog");
    }
    if (priorComplete?.invalidatedAtSequence !== undefined) return unknown("catalog_stale");
    if (lastIncomplete) return unknown("partial_catalog");
    return unknown("no_catalog");
  }

  const catalogSequence = usable.completedAtSequence;
  const tool = usable.tools.find((t) => t.name === action.target);
  if (!tool) return unknown("tool_not_in_catalog", catalogSequence);
  if (tool.mappingMalformed) return unknown("malformed_mapping", catalogSequence);
  if (tool.declaredMapping) {
    return {
      ...base,
      mappingSource: "declared",
      reason: null,
      catalogSequence,
      declaredMapping: tool.declaredMapping,
    };
  }
  return {
    ...base,
    mappingSource: "default_confirmed",
    reason: null,
    catalogSequence,
    declaredMapping: null,
  };
}
