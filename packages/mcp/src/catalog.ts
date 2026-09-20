import { isJsonObject, type JsonObject } from "@actiontape/core";
import type { TapeEntry } from "./tape-reader.js";

export const MAX_CATALOG_PAGES = 100;

export interface McpToolDefinitionEvidence {
  name: string;
  inputSchema?: JsonObject;
  // Raw x-authzen-mapping object, preserved uninterpreted as evidence.
  declaredMapping?: JsonObject;
  // x-authzen-mapping was present but not a plain JSON object.
  mappingMalformed?: boolean;
  firstSeenSequence: number;
}

export interface McpToolCatalogSnapshot {
  requestSequence: number;
  completedAtSequence: number;
  pageCount: number;
  tools: McpToolDefinitionEvidence[];
  invalidatedAtSequence?: number;
  ttlMs?: number;
  cacheScope?: string;
}

export interface McpIncompleteCatalogEvidence {
  requestSequence: number;
  lastObservedSequence: number;
  pageCount: number;
}

export type McpCatalogDiagnosticCode =
  | "invalid_list_request"
  | "duplicate_list_request_id"
  | "unmatched_list_response"
  | "incomplete_list_request"
  | "list_error"
  | "malformed_list_result"
  | "malformed_tool"
  | "malformed_mapping"
  | "duplicate_tool_name"
  | "cursor_mismatch"
  | "cursor_reuse"
  | "page_limit_exceeded"
  | "incomplete_catalog";

export interface McpToolCatalogDiagnostic {
  code: McpCatalogDiagnosticCode;
  message: string;
  line?: number;
  sequence?: number;
}

export interface McpCatalogTimeline {
  catalogs: McpToolCatalogSnapshot[];
  incomplete: McpIncompleteCatalogEvidence[];
  diagnostics: McpToolCatalogDiagnostic[];
}

interface ChainState {
  requestSequence: number;
  pages: number;
  tools: McpToolDefinitionEvidence[];
  seenCursors: Set<string>;
  seenNames: Set<string>;
  nextCursor?: string;
  lastObservedSequence: number;
  ttlMs?: number;
  cacheScope?: string;
  dead?: boolean;
}

interface PendingListRequest {
  sequence: number;
  line: number;
  chain: ChainState | null;
}

function requestIdKey(id: string | number): string {
  return `${typeof id}:${id}`;
}

function isRequestId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isInteger(value));
}

// Extracts tools/list discovery evidence from a recorded tape. tools/list
// traffic is catalog evidence ABOUT mapping provenance — it never becomes
// ActionEnvelope actions. Everything stored here is inert JSON data:
// x-authzen-mapping objects are preserved verbatim and never evaluated.
export function extractMcpToolCatalogs(entries: Iterable<TapeEntry>): McpCatalogTimeline {
  const catalogs: McpToolCatalogSnapshot[] = [];
  const incomplete: McpIncompleteCatalogEvidence[] = [];
  const diagnostics: McpToolCatalogDiagnostic[] = [];
  const pending = new Map<string, PendingListRequest>();
  const openChains: ChainState[] = [];

  const diagnose = (d: McpToolCatalogDiagnostic): void => {
    diagnostics.push(d);
  };

  const killChain = (chain: ChainState): void => {
    chain.dead = true;
    incomplete.push({
      requestSequence: chain.requestSequence,
      lastObservedSequence: chain.lastObservedSequence,
      pageCount: chain.pages,
    });
  };

  const applyPage = (
    chain: ChainState,
    result: JsonObject,
    sequence: number,
    line: number,
  ): void => {
    const tools = result.tools;
    if (!Array.isArray(tools)) {
      diagnose({
        code: "malformed_list_result",
        message: `line ${line}: tools/list result has no tools array`,
        line,
        sequence,
      });
      killChain(chain);
      return;
    }
    if (chain.pages >= MAX_CATALOG_PAGES) {
      diagnose({
        code: "page_limit_exceeded",
        message: `line ${line}: tools/list pagination exceeded ${MAX_CATALOG_PAGES} pages`,
        line,
        sequence,
      });
      killChain(chain);
      return;
    }
    for (const tool of tools) {
      if (!isJsonObject(tool) || typeof tool.name !== "string") {
        diagnose({
          code: "malformed_tool",
          message: `line ${line}: tools/list entry is missing a string name`,
          line,
          sequence,
        });
        continue;
      }
      if (chain.seenNames.has(tool.name)) {
        diagnose({
          code: "duplicate_tool_name",
          message: `line ${line}: tools/list repeats tool name ${JSON.stringify(tool.name)}`,
          line,
          sequence,
        });
        continue;
      }
      chain.seenNames.add(tool.name);
      const evidence: McpToolDefinitionEvidence = {
        name: tool.name,
        firstSeenSequence: sequence,
      };
      if (tool.inputSchema !== undefined) {
        if (!isJsonObject(tool.inputSchema)) {
          diagnose({
            code: "malformed_tool",
            message: `line ${line}: tool ${JSON.stringify(tool.name)} inputSchema is not an object`,
            line,
            sequence,
          });
        } else {
          evidence.inputSchema = tool.inputSchema;
          const mapping = tool.inputSchema["x-authzen-mapping"];
          if (mapping !== undefined) {
            if (isJsonObject(mapping)) {
              evidence.declaredMapping = mapping;
            } else {
              evidence.mappingMalformed = true;
              diagnose({
                code: "malformed_mapping",
                message: `line ${line}: tool ${JSON.stringify(tool.name)} x-authzen-mapping is not a JSON object`,
                line,
                sequence,
              });
            }
          }
        }
      }
      chain.tools.push(evidence);
    }
    chain.pages += 1;
    chain.lastObservedSequence = sequence;
    if (typeof result.ttlMs === "number") chain.ttlMs = result.ttlMs;
    if (typeof result.cacheScope === "string") chain.cacheScope = result.cacheScope;

    const nextCursor = result.nextCursor;
    if (nextCursor === undefined) {
      const snapshot: McpToolCatalogSnapshot = {
        requestSequence: chain.requestSequence,
        completedAtSequence: sequence,
        pageCount: chain.pages,
        tools: chain.tools,
      };
      if (chain.ttlMs !== undefined) snapshot.ttlMs = chain.ttlMs;
      if (chain.cacheScope !== undefined) snapshot.cacheScope = chain.cacheScope;
      catalogs.push(snapshot);
      const i = openChains.indexOf(chain);
      if (i !== -1) openChains.splice(i, 1);
      return;
    }
    if (typeof nextCursor !== "string") {
      diagnose({
        code: "malformed_list_result",
        message: `line ${line}: tools/list nextCursor is not a string`,
        line,
        sequence,
      });
      killChain(chain);
      return;
    }
    if (chain.seenCursors.has(nextCursor)) {
      diagnose({
        code: "cursor_reuse",
        message: `line ${line}: tools/list repeated nextCursor ${JSON.stringify(nextCursor)} (possible loop)`,
        line,
        sequence,
      });
      killChain(chain);
      return;
    }
    chain.seenCursors.add(nextCursor);
    chain.nextCursor = nextCursor;
  };

  for (const entry of entries) {
    if (entry.diagnostic) continue;
    const record = entry.record;
    if (!record || record.parse.status !== "ok" || !isJsonObject(record.parse.value)) {
      continue;
    }
    const msg = record.parse.value;

    if (record.direction === "server_to_client") {
      if (msg.method === "notifications/tools/list_changed") {
        // The most recently completed catalog goes stale; keep the snapshot.
        const latest = catalogs.at(-1);
        if (latest && latest.invalidatedAtSequence === undefined) {
          latest.invalidatedAtSequence = record.sequence;
        }
        continue;
      }
      const isResponse =
        msg.method === undefined && (msg.result !== undefined || msg.error !== undefined);
      if (!isResponse || !isRequestId(msg.id)) continue;
      const key = requestIdKey(msg.id);
      const req = pending.get(key);
      if (!req) {
        // A response that advertises a tools array with no pending list
        // request is an orphaned catalog page — diagnose it.
        if (isJsonObject(msg.result) && Array.isArray(msg.result.tools)) {
          diagnose({
            code: "unmatched_list_response",
            message: `line ${entry.line}: tools/list response id ${JSON.stringify(msg.id)} has no pending request`,
            line: entry.line,
            sequence: record.sequence,
          });
        }
        continue;
      }
      pending.delete(key);
      if (msg.error !== undefined) {
        diagnose({
          code: "list_error",
          message: `line ${entry.line}: tools/list request at sequence ${req.sequence} returned a JSON-RPC error`,
          line: entry.line,
          sequence: record.sequence,
        });
        if (req.chain) killChain(req.chain);
        continue;
      }
      if (!req.chain) continue;
      if (!isJsonObject(msg.result)) {
        diagnose({
          code: "malformed_list_result",
          message: `line ${entry.line}: tools/list result is not a JSON object`,
          line: entry.line,
          sequence: record.sequence,
        });
        killChain(req.chain);
        continue;
      }
      applyPage(req.chain, msg.result, record.sequence, entry.line);
      continue;
    }

    // client_to_server
    if (msg.method !== "tools/list") continue;
    if (msg.jsonrpc !== "2.0" || !isRequestId(msg.id)) {
      diagnose({
        code: "invalid_list_request",
        message: `line ${entry.line}: tools/list is not a well-formed JSON-RPC 2.0 request`,
        line: entry.line,
        sequence: record.sequence,
      });
      continue;
    }
    const key = requestIdKey(msg.id);
    if (pending.has(key)) {
      diagnose({
        code: "duplicate_list_request_id",
        message: `line ${entry.line}: tools/list reuses outstanding JSON-RPC id ${JSON.stringify(msg.id)}`,
        line: entry.line,
        sequence: record.sequence,
      });
      continue;
    }

    let cursor: string | undefined;
    if (msg.params !== undefined) {
      if (isJsonObject(msg.params) && msg.params.cursor !== undefined) {
        if (typeof msg.params.cursor === "string") {
          cursor = msg.params.cursor;
        } else {
          diagnose({
            code: "invalid_list_request",
            message: `line ${entry.line}: tools/list cursor is not a string`,
            line: entry.line,
            sequence: record.sequence,
          });
          continue;
        }
      }
    }

    let chain: ChainState | null;
    if (cursor === undefined) {
      chain = {
        requestSequence: record.sequence,
        pages: 0,
        tools: [],
        seenCursors: new Set(),
        seenNames: new Set(),
        lastObservedSequence: record.sequence,
      };
      openChains.push(chain);
    } else {
      const target = openChains.find((c) => !c.dead && c.nextCursor === cursor);
      if (!target) {
        diagnose({
          code: "cursor_mismatch",
          message: `line ${entry.line}: tools/list continuation cursor ${JSON.stringify(cursor)} matches no open catalog`,
          line: entry.line,
          sequence: record.sequence,
        });
        chain = null;
      } else {
        chain = target;
      }
    }
    pending.set(key, { sequence: record.sequence, line: entry.line, chain });
  }

  for (const req of pending.values()) {
    diagnose({
      code: "incomplete_list_request",
      message: `tools/list request at sequence ${req.sequence} (line ${req.line}) had no matching response at end of tape`,
      line: req.line,
      sequence: req.sequence,
    });
    if (req.chain && !req.chain.dead) {
      killChain(req.chain);
    }
  }
  for (const chain of openChains) {
    if (!chain.dead) {
      diagnose({
        code: "incomplete_catalog",
        message: `tools/list catalog started at sequence ${chain.requestSequence} never reached a terminal page`,
        sequence: chain.requestSequence,
      });
      killChain(chain);
    }
  }

  return { catalogs, incomplete, diagnostics };
}
