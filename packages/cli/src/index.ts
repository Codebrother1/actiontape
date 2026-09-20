import { readFile, stat } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import type { Readable, Writable } from "node:stream";
import {
  ACTION_ENVELOPE_SCHEMA_VERSION,
  isJsonObject,
  type ActionEnvelope,
} from "@actiontape/core";
import {
  ContractParseError,
  evaluateContract,
  parseContract,
  type ContractViolation,
} from "@actiontape/contracts";
import {
  evaluateAccess,
  evaluateAccessMany,
  expandAccessEvaluationsRequest,
  mapMcpToolCallToAuthzen,
  renderCoazMapping,
  simulateAuthzen,
  type AuthzenAccessEvaluationRequest,
  type AuthzenAccessEvaluationsRequest,
  type AuthzenIdentity,
  type AuthzenSimulationDecision,
  type CoazRenderWarning,
} from "@actiontape/authzen";
import {
  extractMcpToolCatalogs,
  getMcpToolCallRequestParams,
  JsonlTapeWriter,
  normalizeMcpTape,
  readTapeFile,
  resolveToolMappingProvenance,
  runStdioProxy,
  type McpMappingUnknownReason,
  type McpToolMappingProvenance,
  type NormalizationDiagnostic,
  type TapeEntry,
} from "@actiontape/mcp";
import type { JsonObject } from "@actiontape/core";

export const CLI_VERSION = "0.0.0";

const HELP = `actiontape - deterministic record/replay for agent tool calls

Usage:
  actiontape record --out <path> -- <command> [args...]   Record MCP stdio traffic to a JSONL tape
  actiontape inspect <tape>                             Inspect a tape (read-only)
  actiontape inspect --json <tape>                      Emit normalized actions as JSONL
  actiontape check <tape> --contract <path>             Evaluate a contract against a tape
  actiontape check --json <tape> --contract <path>      Emit the check result as one JSON object
  actiontape authzen export <tape> --subject-id <id> [--agent-id <id>]
      Emit AuthZEN Access Evaluation requests (JSONL) for recorded tools/call actions
  actiontape authzen simulate [--json] <tape> --endpoint <url> --subject-id <id> [--agent-id <id>] [--timeout-ms <ms>]
      Simulate recorded actions against an AuthZEN-compatible PDP
  actiontape authzen plan [--json] <tape>
      Report declared/default/unknown mapping provenance per recorded tools/call
  actiontape authzen render [--json] <tape> --token-claims <claims.json>
      Construct the AuthZEN request(s) each recorded tools/call would produce
  actiontape authzen audit [--json] <tape> --token-claims <claims.json> --evaluation-endpoint <url> [--evaluations-endpoint <url>] [--timeout-ms <ms>]
      Render historical requests and ask a PDP what it would have decided
  actiontape --help                                     Show this help
  actiontape --version                                  Print version

Notes:
  - While recording, stdout carries only the child server's protocol bytes.
    ActionTape diagnostics are written to stderr.
  - Tapes record traffic verbatim and may contain sensitive data.

Experimental: stdio recording only. No replay, redaction, or policy yet.
`;

const RECORD_USAGE = `usage: actiontape record --out <path> -- <command> [args...]`;
const INSPECT_USAGE = `usage: actiontape inspect [--json] <tape>`;
const CHECK_USAGE = `usage: actiontape check [--json] <tape> --contract <path>

exit codes: 0 = contract passed, 1 = violations found, 2 = evaluation error`;
const AUTHZEN_USAGE = `usage:
  actiontape authzen export <tape> --subject-id <id> [--agent-id <id>]
  actiontape authzen simulate [--json] <tape> --endpoint <url> --subject-id <id> [--agent-id <id>] [--timeout-ms <ms>]
  actiontape authzen plan [--json] <tape>
  actiontape authzen render [--json] <tape> --token-claims <claims.json>

export/simulate use the COAZ-MCP Draft 1 default tools/call mapping.
plan inspects recorded tools/list evidence for declared x-authzen-mapping provenance.
render combines that evidence with supplied simulation token claims to build
the AuthZEN request(s) each call would produce. It never contacts a PDP and
never falls back to the default mapping when provenance is unknown.
audit additionally POSTs rendered requests to a user-specified PDP —
counterfactual historical analysis only; no tools are contacted.

exit codes: 0 = all permitted / all rendered, 1 = denied / unknown provenance / mapping error, 2 = operational error`;

const RESPONSE_KIND_LABELS: Record<string, string> = {
  success: "success",
  jsonrpc_error: "protocol error",
  tool_error: "tool error",
  input_required: "input required",
  unknown_result_type: "unknown result type",
  incomplete: "incomplete",
};

export interface CliIo {
  in?: Readable;
  out?: Writable;
  err?: Writable;
  log?: (line: string) => void;
  error?: (line: string) => void;
}

type RecordArgs = { out: string; command: string; args: string[] } | { error: string };

function parseRecordArgs(argv: string[]): RecordArgs {
  const separator = argv.indexOf("--");
  if (separator === -1) return { error: "missing -- separator before the command" };
  const flagArgs = argv.slice(0, separator);
  const commandArgs = argv.slice(separator + 1);
  if (commandArgs.length === 0) return { error: "missing command after --" };

  let out: string | undefined;
  for (let i = 0; i < flagArgs.length; i += 1) {
    const flag = flagArgs[i]!;
    if (flag === "--out") {
      const value = flagArgs[i + 1];
      if (value === undefined) return { error: "--out requires a path" };
      out = value;
      i += 1;
    } else if (flag.startsWith("--out=")) {
      out = flag.slice("--out=".length);
    } else {
      return { error: `unknown option ${flag}` };
    }
  }
  if (!out) return { error: "missing required --out <path>" };

  const [command, ...rest] = commandArgs;
  return { out, command: command!, args: rest };
}

async function runRecord(
  argv: string[],
  io: CliIo,
  error: (line: string) => void,
): Promise<number> {
  const parsed = parseRecordArgs(argv);
  if ("error" in parsed) {
    error(`actiontape record: ${parsed.error}`);
    error(RECORD_USAGE);
    return 2;
  }

  const writer = await JsonlTapeWriter.open(parsed.out);
  try {
    const result = await runStdioProxy({
      command: parsed.command,
      args: parsed.args,
      input: io.in ?? process.stdin,
      output: io.out ?? process.stdout,
      stderr: io.err ?? process.stderr,
      onRecord: (record) => writer.writeRecord(record),
    });
    if (result.exitCode !== null) return result.exitCode;
    if (result.signal) {
      const signals = osConstants.signals as Record<string, number | undefined>;
      return 128 + (signals[result.signal] ?? 1);
    }
    return 1;
  } catch (err) {
    error(`actiontape record: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  } finally {
    await writer.close();
  }
}

function formatDiagnostic(d: {
  code: string;
  message: string;
  line?: number;
  sequence?: number;
}): string {
  const where = [
    d.line !== undefined ? `line ${d.line}` : undefined,
    d.sequence !== undefined ? `seq ${d.sequence}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  return `diagnostic[${d.code}]${where ? ` ${where}` : ""}: ${d.message}`;
}

function formatAction(action: ActionEnvelope, index: number): string {
  const mcp = isJsonObject(action.metadata?.mcp) ? action.metadata.mcp : undefined;
  const kind = typeof mcp?.responseKind === "string" ? mcp.responseKind : "unknown";
  const label = RESPONSE_KIND_LABELS[kind] ?? kind;
  const requestSeq = typeof mcp?.requestSequence === "number" ? mcp.requestSequence : "?";
  const responseSeq = typeof mcp?.responseSequence === "number" ? mcp.responseSequence : "-";
  const requestId = mcp?.requestId !== undefined ? JSON.stringify(mcp.requestId) : "?";

  const lines = [
    `#${index} ${action.operation} ${action.target} — ${label}`,
    `   request seq: ${requestSeq}   response seq: ${responseSeq}   jsonrpc id: ${requestId}`,
    `   arguments: ${JSON.stringify(action.arguments)}`,
  ];
  if (action.error) {
    lines.push(`   error: ${action.error.code}: ${action.error.message}`);
  }
  return lines.join("\n");
}

async function runInspect(
  argv: string[],
  io: CliIo,
  log: (line: string) => void,
  error: (line: string) => void,
): Promise<number> {
  let json = false;
  let path: string | undefined;
  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      log(INSPECT_USAGE);
      return 0;
    } else if (arg.startsWith("-")) {
      error(`actiontape inspect: unknown option ${arg}`);
      error(INSPECT_USAGE);
      return 2;
    } else if (path === undefined) {
      path = arg;
    } else {
      error(`actiontape inspect: unexpected argument ${arg}`);
      error(INSPECT_USAGE);
      return 2;
    }
  }
  if (path === undefined) {
    error("actiontape inspect: missing tape path");
    error(INSPECT_USAGE);
    return 2;
  }

  const entries: TapeEntry[] = [];
  try {
    for await (const entry of readTapeFile(path)) {
      entries.push(entry);
    }
  } catch (err) {
    error(`actiontape inspect: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const { actions, diagnostics } = normalizeMcpTape(entries);

  if (json) {
    const out = io.out ?? process.stdout;
    for (const action of actions) {
      out.write(JSON.stringify(action) + "\n");
    }
    for (const d of diagnostics) {
      error(formatDiagnostic(d));
    }
    return 0;
  }

  log(`tape: ${path}`);
  log(`actions: ${actions.length}   diagnostics: ${diagnostics.length}`);
  for (const [i, action] of actions.entries()) {
    log(formatAction(action, i + 1));
  }
  for (const d of diagnostics) {
    error(formatDiagnostic(d));
  }
  return 0;
}

interface CheckResult {
  schemaVersion: "1.0";
  status: "pass" | "fail" | "error";
  actionCount: number;
  ruleCount: number;
  violationCount: number;
  violations: ContractViolation[];
  diagnostics: NormalizationDiagnostic[];
  error: string | null;
}

async function runCheck(
  argv: string[],
  io: CliIo,
  log: (line: string) => void,
  error: (line: string) => void,
): Promise<number> {
  let json = false;
  let path: string | undefined;
  let contractPath: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--contract") {
      const value = argv[i + 1];
      if (value === undefined) {
        error("actiontape check: --contract requires a path");
        error(CHECK_USAGE);
        return 2;
      }
      contractPath = value;
      i += 1;
    } else if (arg.startsWith("--contract=")) {
      contractPath = arg.slice("--contract=".length);
    } else if (arg === "--help" || arg === "-h") {
      log(CHECK_USAGE);
      return 0;
    } else if (arg.startsWith("-")) {
      error(`actiontape check: unknown option ${arg}`);
      error(CHECK_USAGE);
      return 2;
    } else if (path === undefined) {
      path = arg;
    } else {
      error(`actiontape check: unexpected argument ${arg}`);
      error(CHECK_USAGE);
      return 2;
    }
  }
  if (path === undefined) {
    error("actiontape check: missing tape path");
    error(CHECK_USAGE);
    return 2;
  }
  if (contractPath === undefined) {
    error("actiontape check: missing required --contract <path>");
    error(CHECK_USAGE);
    return 2;
  }

  const result: CheckResult = {
    schemaVersion: "1.0",
    status: "error",
    actionCount: 0,
    ruleCount: 0,
    violationCount: 0,
    violations: [],
    diagnostics: [],
    error: null,
  };
  const finish = (exitCode: number): number => {
    if (json) {
      const out = io.out ?? process.stdout;
      out.write(JSON.stringify(result) + "\n");
    }
    return exitCode;
  };
  const fail = (message: string): number => {
    result.error = message;
    error(`actiontape check: ${message}`);
    return finish(2);
  };

  const entries: TapeEntry[] = [];
  try {
    for await (const entry of readTapeFile(path)) {
      entries.push(entry);
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  const { actions, diagnostics } = normalizeMcpTape(entries);
  result.actionCount = actions.length;
  result.diagnostics = diagnostics;

  let contractText: string;
  try {
    contractText = await readFile(contractPath, "utf8");
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
  let contract;
  try {
    contract = parseContract(contractText);
  } catch (err) {
    return fail(
      err instanceof ContractParseError ? err.message : `invalid contract: ${String(err)}`,
    );
  }
  result.ruleCount = contract.rules.length;

  // Fail closed: any normalization diagnostic means the tape cannot be trusted.
  if (diagnostics.length > 0) {
    for (const d of diagnostics) {
      error(formatDiagnostic(d));
    }
    return fail(`tape produced ${diagnostics.length} normalization diagnostic(s)`);
  }

  const evaluation = evaluateContract(contract, actions);
  result.violations = evaluation.violations;
  result.violationCount = evaluation.violations.length;
  result.status = evaluation.ok ? "pass" : "fail";

  if (json) return finish(evaluation.ok ? 0 : 1);

  log(`${evaluation.ok ? "PASS" : "FAIL"} ${contractPath}`);
  log(`actions: ${actions.length}`);
  log(`rules: ${contract.rules.length}`);
  log(`violations: ${evaluation.violations.length}`);
  for (const v of evaluation.violations) {
    log(`[${v.ruleId}] ${v.message}`);
  }
  return evaluation.ok ? 0 : 1;
}

interface AuthzenFlags {
  json: boolean;
  help: boolean;
  path?: string;
  subjectId?: string;
  agentId?: string;
  endpoint?: string;
  timeoutMs?: number;
}

const AUTHZEN_VALUE_FLAGS = new Set(["--subject-id", "--agent-id", "--endpoint", "--timeout-ms"]);

function parseAuthzenArgs(argv: string[]): AuthzenFlags | { error: string } {
  const flags: AuthzenFlags = { json: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    if (flag === "--json") {
      flags.json = true;
    } else if (flag === "--help" || flag === "-h") {
      flags.help = true;
    } else if (AUTHZEN_VALUE_FLAGS.has(flag)) {
      const value = inline ?? argv[++i];
      if (value === undefined) return { error: `${flag} requires a value` };
      if (flag === "--subject-id") flags.subjectId = value;
      else if (flag === "--agent-id") flags.agentId = value;
      else if (flag === "--endpoint") flags.endpoint = value;
      else {
        const ms = Number(value);
        if (!Number.isInteger(ms) || ms <= 0) {
          return { error: "--timeout-ms must be a positive integer" };
        }
        flags.timeoutMs = ms;
      }
    } else if (arg.startsWith("-")) {
      return { error: `unknown option ${arg}` };
    } else if (flags.path === undefined) {
      flags.path = arg;
    } else {
      return { error: `unexpected argument ${arg}` };
    }
  }
  return flags;
}

async function loadTapeEntries(
  path: string,
): Promise<{ entries: TapeEntry[] } | { error: string }> {
  const entries: TapeEntry[] = [];
  try {
    for await (const entry of readTapeFile(path)) {
      entries.push(entry);
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
  return { entries };
}

async function loadTapeActions(
  path: string,
): Promise<
  { actions: ActionEnvelope[]; diagnostics: NormalizationDiagnostic[] } | { error: string }
> {
  const loaded = await loadTapeEntries(path);
  if ("error" in loaded) return loaded;
  return normalizeMcpTape(loaded.entries);
}

function checkAuthzenFlags(
  flags: AuthzenFlags,
  needEndpoint: boolean,
  error: (line: string) => void,
): number | null {
  const missing = !flags.path
    ? "missing tape path"
    : flags.subjectId === undefined || flags.subjectId === ""
      ? "missing required --subject-id <id>"
      : needEndpoint && !flags.endpoint
        ? "missing required --endpoint <url>"
        : null;
  if (missing) {
    error(`actiontape authzen: ${missing}`);
    error(AUTHZEN_USAGE);
    return 2;
  }
  return null;
}

function reportDiagnostics(
  diagnostics: { code: string; message: string; line?: number; sequence?: number }[],
  error: (line: string) => void,
): void {
  for (const d of diagnostics) {
    error(formatDiagnostic(d));
  }
}

async function runAuthzenExport(
  argv: string[],
  io: CliIo,
  log: (line: string) => void,
  error: (line: string) => void,
): Promise<number> {
  const parsed = parseAuthzenArgs(argv);
  if ("error" in parsed) {
    error(`actiontape authzen export: ${parsed.error}`);
    error(AUTHZEN_USAGE);
    return 2;
  }
  if (parsed.help) {
    log(AUTHZEN_USAGE);
    return 0;
  }
  const flagError = checkAuthzenFlags(parsed, false, error);
  if (flagError !== null) return flagError;

  const loaded = await loadTapeActions(parsed.path!);
  if ("error" in loaded) {
    error(`actiontape authzen export: ${loaded.error}`);
    return 2;
  }
  if (loaded.diagnostics.length > 0) {
    reportDiagnostics(loaded.diagnostics, error);
    error(
      `actiontape authzen export: tape produced ${loaded.diagnostics.length} normalization diagnostic(s)`,
    );
    return 2;
  }

  const identity: AuthzenIdentity = { subjectId: parsed.subjectId! };
  if (parsed.agentId !== undefined) identity.agentId = parsed.agentId;

  // Map every action before writing anything — fail closed, no partial output.
  const requests = [];
  try {
    for (const action of loaded.actions) {
      requests.push(mapMcpToolCallToAuthzen(action, identity));
    }
  } catch (err) {
    error(`actiontape authzen export: ${err instanceof Error ? err.message : String(err)}`);
    return 2;
  }
  const out = io.out ?? process.stdout;
  for (const request of requests) {
    out.write(JSON.stringify(request) + "\n");
  }
  return 0;
}

interface SimulateResult {
  schemaVersion: "1.0";
  status: "pass" | "deny" | "error";
  actionCount: number;
  permitCount: number;
  denyCount: number;
  decisions: AuthzenSimulationDecision[];
  diagnostics: NormalizationDiagnostic[];
  error: string | null;
}

async function runAuthzenSimulate(
  argv: string[],
  io: CliIo,
  log: (line: string) => void,
  error: (line: string) => void,
): Promise<number> {
  const parsed = parseAuthzenArgs(argv);
  if ("error" in parsed) {
    error(`actiontape authzen simulate: ${parsed.error}`);
    error(AUTHZEN_USAGE);
    return 2;
  }
  if (parsed.help) {
    log(AUTHZEN_USAGE);
    return 0;
  }
  const flagError = checkAuthzenFlags(parsed, true, error);
  if (flagError !== null) return flagError;

  const result: SimulateResult = {
    schemaVersion: "1.0",
    status: "error",
    actionCount: 0,
    permitCount: 0,
    denyCount: 0,
    decisions: [],
    diagnostics: [],
    error: null,
  };
  const finish = (exitCode: number): number => {
    if (parsed.json) {
      const out = io.out ?? process.stdout;
      out.write(JSON.stringify(result) + "\n");
    }
    return exitCode;
  };
  const fail = (message: string): number => {
    result.error = message;
    error(`actiontape authzen simulate: ${message}`);
    return finish(2);
  };

  const loaded = await loadTapeActions(parsed.path!);
  if ("error" in loaded) return fail(loaded.error);
  result.actionCount = loaded.actions.length;
  result.diagnostics = loaded.diagnostics;
  // Fail closed before contacting the PDP.
  if (loaded.diagnostics.length > 0) {
    reportDiagnostics(loaded.diagnostics, error);
    return fail(`tape produced ${loaded.diagnostics.length} normalization diagnostic(s)`);
  }

  const identity: AuthzenIdentity = { subjectId: parsed.subjectId! };
  if (parsed.agentId !== undefined) identity.agentId = parsed.agentId;

  // Validate that every action is mappable before the first PDP request.
  try {
    for (const action of loaded.actions) {
      mapMcpToolCallToAuthzen(action, identity);
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  const endpoint = parsed.endpoint!;
  const evaluator = async (request: AuthzenAccessEvaluationRequest, action: ActionEnvelope) => {
    const decision = await evaluateAccess(endpoint, request, { timeoutMs: parsed.timeoutMs });
    result.decisions.push({
      actionId: action.id,
      target: action.target,
      decision: decision.decision,
      context: decision.context ?? null,
    });
    return decision;
  };

  try {
    await simulateAuthzen(loaded.actions, identity, evaluator);
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  result.permitCount = result.decisions.filter((d) => d.decision).length;
  result.denyCount = result.decisions.length - result.permitCount;
  result.status = result.denyCount === 0 ? "pass" : "deny";
  const exitCode = result.status === "pass" ? 0 : 1;
  if (parsed.json) return finish(exitCode);

  log(`AUTHZEN ${result.status === "pass" ? "PASS" : "DENY"}`);
  log(`actions: ${result.actionCount}`);
  log(`permitted: ${result.permitCount}`);
  log(`denied: ${result.denyCount}`);
  log("");
  for (const d of result.decisions) {
    log(`${d.decision ? "PERMIT" : "DENY"} ${d.target} (${d.actionId})`);
  }
  return exitCode;
}

const UNKNOWN_REASON_LABELS: Record<McpMappingUnknownReason, string> = {
  no_catalog: "no completed catalog before call",
  catalog_stale: "catalog invalidated by tools/list_changed",
  partial_catalog: "catalog pagination incomplete",
  tool_not_in_catalog: "tool absent from observed catalog",
  malformed_mapping: "malformed x-authzen-mapping",
};

interface PlanResult {
  schemaVersion: "1.0";
  status: "complete" | "incomplete" | "error";
  actionCount: number;
  declaredCount: number;
  defaultConfirmedCount: number;
  unknownCount: number;
  actions: {
    actionId: string;
    target: string;
    mappingSource: "declared" | "default_confirmed" | "unknown";
    reason: string | null;
    catalogSequence: number | null;
    declaredMapping: unknown;
  }[];
  catalogs: {
    completedAtSequence: number;
    pageCount: number;
    toolCount: number;
    invalidatedAtSequence: number | null;
  }[];
  diagnostics: { code: string; message: string; line?: number; sequence?: number }[];
  error: string | null;
}

async function runAuthzenPlan(
  argv: string[],
  io: CliIo,
  log: (line: string) => void,
  error: (line: string) => void,
): Promise<number> {
  let json = false;
  let path: string | undefined;
  for (const arg of argv) {
    if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      log(AUTHZEN_USAGE);
      return 0;
    } else if (arg.startsWith("-")) {
      error(`actiontape authzen plan: unknown option ${arg}`);
      error(AUTHZEN_USAGE);
      return 2;
    } else if (path === undefined) {
      path = arg;
    } else {
      error(`actiontape authzen plan: unexpected argument ${arg}`);
      error(AUTHZEN_USAGE);
      return 2;
    }
  }
  if (path === undefined) {
    error("actiontape authzen plan: missing tape path");
    error(AUTHZEN_USAGE);
    return 2;
  }

  const result: PlanResult = {
    schemaVersion: "1.0",
    status: "error",
    actionCount: 0,
    declaredCount: 0,
    defaultConfirmedCount: 0,
    unknownCount: 0,
    actions: [],
    catalogs: [],
    diagnostics: [],
    error: null,
  };
  const finish = (exitCode: number): number => {
    if (json) {
      const out = io.out ?? process.stdout;
      out.write(JSON.stringify(result) + "\n");
    }
    return exitCode;
  };
  const fail = (message: string): number => {
    result.error = message;
    error(`actiontape authzen plan: ${message}`);
    return finish(2);
  };

  const loaded = await loadTapeEntries(path);
  if ("error" in loaded) return fail(loaded.error);

  const { actions, diagnostics } = normalizeMcpTape(loaded.entries);
  const timeline = extractMcpToolCatalogs(loaded.entries);
  result.actionCount = actions.length;
  result.catalogs = timeline.catalogs.map((c) => ({
    completedAtSequence: c.completedAtSequence,
    pageCount: c.pageCount,
    toolCount: c.tools.length,
    invalidatedAtSequence: c.invalidatedAtSequence ?? null,
  }));
  result.diagnostics = [...diagnostics, ...timeline.diagnostics];
  reportDiagnostics(timeline.diagnostics, error);

  if (diagnostics.length > 0) {
    reportDiagnostics(diagnostics, error);
    return fail(`tape produced ${diagnostics.length} normalization diagnostic(s)`);
  }

  try {
    for (const action of actions) {
      const p = resolveToolMappingProvenance(action, timeline);
      result.actions.push({
        actionId: p.actionId,
        target: p.toolName,
        mappingSource: p.mappingSource,
        reason: p.reason,
        catalogSequence: p.catalogSequence,
        declaredMapping: p.declaredMapping,
      });
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  result.declaredCount = result.actions.filter((a) => a.mappingSource === "declared").length;
  result.defaultConfirmedCount = result.actions.filter(
    (a) => a.mappingSource === "default_confirmed",
  ).length;
  result.unknownCount = result.actions.filter((a) => a.mappingSource === "unknown").length;
  result.status = result.unknownCount === 0 ? "complete" : "incomplete";
  const exitCode = result.status === "complete" ? 0 : 1;
  if (json) return finish(exitCode);

  log("AUTHZEN PLAN");
  log(`actions: ${result.actionCount}`);
  log(`declared: ${result.declaredCount}`);
  log(`default-confirmed: ${result.defaultConfirmedCount}`);
  log(`unknown: ${result.unknownCount}`);
  log("");
  for (const a of result.actions) {
    const detail =
      a.mappingSource === "unknown"
        ? UNKNOWN_REASON_LABELS[a.reason as McpMappingUnknownReason]
        : `catalog seq ${a.catalogSequence}`;
    const label =
      a.mappingSource === "declared"
        ? "DECLARED"
        : a.mappingSource === "default_confirmed"
          ? "DEFAULT "
          : "UNKNOWN ";
    log(`${label} ${a.target} (${a.actionId}) — ${detail}`);
  }
  return exitCode;
}

const TOKEN_CLAIMS_MAX_BYTES = 2 * 1024 * 1024;

// Loads simulation token claims from a JSON file: bounded size, JSON only,
// top-level object required. Claims are caller-supplied simulation data —
// never decoded, validated as credentials, or treated as historical identity.
async function loadTokenClaims(path: string): Promise<{ token: JsonObject } | { error: string }> {
  try {
    const info = await stat(path);
    if (info.size > TOKEN_CLAIMS_MAX_BYTES) {
      return { error: `token claims file exceeds ${TOKEN_CLAIMS_MAX_BYTES} bytes` };
    }
    const text = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (!isJsonObject(parsed)) {
      return { error: "token claims file must contain a JSON object" };
    }
    return { token: parsed };
  } catch (err) {
    if (err instanceof SyntaxError) {
      return { error: "token claims file is not valid JSON" };
    }
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

interface RenderActionResult {
  actionId: string;
  target: string;
  status: "rendered_declared" | "rendered_default" | "unknown" | "mapping_error";
  mappingSource: "declared" | "default_confirmed" | "unknown";
  catalogSequence: number | null;
  reason: string | null;
  envelope: "evaluation" | "evaluations" | null;
  decisionCount: number;
  request: AuthzenAccessEvaluationRequest | AuthzenAccessEvaluationsRequest | null;
  warnings: CoazRenderWarning[];
}

interface RenderResult {
  schemaVersion: "1.0";
  status: "complete" | "incomplete" | "error";
  actionCount: number;
  renderedDeclaredCount: number;
  renderedDefaultCount: number;
  unknownCount: number;
  mappingErrorCount: number;
  requestCount: number;
  actions: RenderActionResult[];
  diagnostics: { code: string; message: string; line?: number; sequence?: number }[];
  error: string | null;
}

// Renders one historical tools/call against the simulation token. UNKNOWN
// provenance never falls back to the default mapping; a known-provenance
// mapping that fails for this specific call is a per-action MAPPING_ERROR,
// not a fatal command error.
function renderActionResult(
  action: ActionEnvelope,
  provenance: McpToolMappingProvenance,
  token: JsonObject,
): RenderActionResult {
  const base = {
    actionId: action.id,
    target: action.target,
    mappingSource: provenance.mappingSource,
    catalogSequence: provenance.catalogSequence,
  };
  if (provenance.mappingSource === "unknown") {
    return {
      ...base,
      status: "unknown",
      reason: provenance.reason,
      envelope: null,
      decisionCount: 0,
      request: null,
      warnings: [],
    };
  }
  const mappingError = (err: unknown): RenderActionResult => ({
    ...base,
    status: "mapping_error",
    reason: err instanceof Error ? err.message : String(err),
    envelope: null,
    decisionCount: 0,
    request: null,
    warnings: [],
  });
  if (provenance.mappingSource === "declared") {
    try {
      if (provenance.declaredMapping === null) {
        throw new Error("declared provenance is missing its mapping evidence");
      }
      const params = getMcpToolCallRequestParams(action);
      const rendered = renderCoazMapping(provenance.declaredMapping, { params, token });
      return {
        ...base,
        status: "rendered_declared",
        reason: null,
        envelope: rendered.kind,
        decisionCount: rendered.kind === "evaluation" ? 1 : rendered.request.evaluations.length,
        request: rendered.request,
        warnings: rendered.warnings,
      };
    } catch (err) {
      return mappingError(err);
    }
  }
  try {
    const sub = token.sub;
    if (typeof sub !== "string" || sub.length === 0) {
      throw new Error("token.sub must be a non-empty string");
    }
    const request: AuthzenAccessEvaluationRequest = {
      subject: { type: "identity", id: sub },
      action: { name: "tools/call" },
      resource: { type: "tool", id: action.target },
    };
    const clientId = token.client_id;
    if (clientId !== undefined) {
      if (typeof clientId !== "string") {
        throw new Error("token.client_id must be a string when present");
      }
      request.context = { agent: clientId };
    }
    return {
      ...base,
      status: "rendered_default",
      reason: null,
      envelope: "evaluation",
      decisionCount: 1,
      request,
      warnings: [],
    };
  } catch (err) {
    return mappingError(err);
  }
}

async function runAuthzenRender(
  argv: string[],
  io: CliIo,
  log: (line: string) => void,
  error: (line: string) => void,
): Promise<number> {
  let json = false;
  let path: string | undefined;
  let tokenPath: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      log(AUTHZEN_USAGE);
      return 0;
    } else if (arg === "--token-claims") {
      const value = argv[++i];
      if (value === undefined) {
        error("actiontape authzen render: --token-claims requires a path");
        error(AUTHZEN_USAGE);
        return 2;
      }
      tokenPath = value;
    } else if (arg.startsWith("--token-claims=")) {
      tokenPath = arg.slice("--token-claims=".length);
    } else if (arg.startsWith("-")) {
      error(`actiontape authzen render: unknown option ${arg}`);
      error(AUTHZEN_USAGE);
      return 2;
    } else if (path === undefined) {
      path = arg;
    } else {
      error(`actiontape authzen render: unexpected argument ${arg}`);
      error(AUTHZEN_USAGE);
      return 2;
    }
  }
  if (path === undefined) {
    error("actiontape authzen render: missing tape path");
    error(AUTHZEN_USAGE);
    return 2;
  }
  if (tokenPath === undefined) {
    error("actiontape authzen render: missing required --token-claims <path>");
    error(AUTHZEN_USAGE);
    return 2;
  }

  const result: RenderResult = {
    schemaVersion: "1.0",
    status: "error",
    actionCount: 0,
    renderedDeclaredCount: 0,
    renderedDefaultCount: 0,
    unknownCount: 0,
    mappingErrorCount: 0,
    requestCount: 0,
    actions: [],
    diagnostics: [],
    error: null,
  };
  const finish = (exitCode: number): number => {
    if (json) {
      const out = io.out ?? process.stdout;
      out.write(JSON.stringify(result) + "\n");
    }
    return exitCode;
  };
  const fail = (message: string): number => {
    result.error = message;
    error(`actiontape authzen render: ${message}`);
    return finish(2);
  };

  const loaded = await loadTapeEntries(path);
  if ("error" in loaded) return fail(loaded.error);
  const { actions, diagnostics } = normalizeMcpTape(loaded.entries);
  const timeline = extractMcpToolCatalogs(loaded.entries);
  result.actionCount = actions.length;
  result.diagnostics = [...diagnostics, ...timeline.diagnostics];

  // Simulation token claims: a small JSON object supplied by the caller. Not
  // decoded, not validated as a credential, never treated as evidence about
  // the original run.
  const claims = await loadTokenClaims(tokenPath);
  if ("error" in claims) return fail(claims.error);
  const token = claims.token;

  reportDiagnostics(timeline.diagnostics, error);
  if (diagnostics.length > 0) {
    reportDiagnostics(diagnostics, error);
    return fail(`tape produced ${diagnostics.length} normalization diagnostic(s)`);
  }

  try {
    for (const action of actions) {
      const provenance = resolveToolMappingProvenance(action, timeline);
      result.actions.push(renderActionResult(action, provenance, token));
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  result.renderedDeclaredCount = result.actions.filter(
    (a) => a.status === "rendered_declared",
  ).length;
  result.renderedDefaultCount = result.actions.filter(
    (a) => a.status === "rendered_default",
  ).length;
  result.unknownCount = result.actions.filter((a) => a.status === "unknown").length;
  result.mappingErrorCount = result.actions.filter((a) => a.status === "mapping_error").length;
  // One AuthZEN HTTP request per rendered envelope — decisions inside an
  // `evaluations` envelope do not multiply request count.
  result.requestCount = result.renderedDeclaredCount + result.renderedDefaultCount;
  result.status =
    result.unknownCount === 0 && result.mappingErrorCount === 0 ? "complete" : "incomplete";
  const exitCode = result.status === "complete" ? 0 : 1;
  if (json) return finish(exitCode);

  log("AUTHZEN RENDER");
  log(`actions: ${result.actionCount}`);
  log(`declared: ${result.renderedDeclaredCount}`);
  log(`default: ${result.renderedDefaultCount}`);
  log(`unknown: ${result.unknownCount}`);
  log(`mapping-errors: ${result.mappingErrorCount}`);
  log(`requests: ${result.requestCount}`);
  log("");
  for (const a of result.actions) {
    let label: string;
    let detail: string;
    if (a.status === "rendered_declared") {
      label = "DECLARED";
      detail =
        a.envelope === "evaluations" ? `evaluations (${a.decisionCount} decisions)` : "evaluation";
    } else if (a.status === "rendered_default") {
      label = "DEFAULT ";
      detail = "evaluation";
    } else if (a.status === "unknown") {
      label = "UNKNOWN ";
      detail = UNKNOWN_REASON_LABELS[a.reason as McpMappingUnknownReason] ?? String(a.reason);
    } else {
      label = "ERROR   ";
      detail = String(a.reason);
    }
    if (a.warnings.length > 0) {
      detail += `; ${a.warnings.length} warning(s)`;
    }
    log(`${label} ${a.target} (${a.actionId}) — ${detail}`);
  }
  return exitCode;
}

interface AuditDecision {
  decision: boolean;
  context: JsonObject | null;
}

interface AuditActionResult {
  actionId: string;
  target: string;
  mappingSource: "declared" | "default_confirmed" | "unknown";
  envelope: "evaluation" | "evaluations" | null;
  status: "permit" | "deny" | "unknown" | "mapping_error" | "not_evaluated";
  reason: string | null;
  decisionCount: number;
  pdpRequestCount: number;
  decisions: AuditDecision[];
  warnings: CoazRenderWarning[];
}

interface AuditResult {
  schemaVersion: "1.0";
  status: "pass" | "deny" | "incomplete" | "error";
  actionCount: number;
  permitCount: number;
  denyCount: number;
  unknownCount: number;
  mappingErrorCount: number;
  notEvaluatedCount: number;
  decisionCount: number;
  pdpRequestCount: number;
  actions: AuditActionResult[];
  diagnostics: { code: string; message: string; line?: number; sequence?: number }[];
  error: string | null;
}

function validatePdpEndpoint(endpoint: string, flag: string): string | null {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return `${flag}: invalid URL ${endpoint}`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `${flag}: unsupported scheme "${url.protocol}"`;
  }
  return null;
}

async function runAuthzenAudit(
  argv: string[],
  io: CliIo,
  log: (line: string) => void,
  error: (line: string) => void,
): Promise<number> {
  let json = false;
  let path: string | undefined;
  let tokenPath: string | undefined;
  let evaluationEndpoint: string | undefined;
  let evaluationsEndpoint: string | undefined;
  let timeoutMs: number | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    if (flag === "--json") {
      json = true;
    } else if (flag === "--help" || flag === "-h") {
      log(AUTHZEN_USAGE);
      return 0;
    } else if (
      flag === "--token-claims" ||
      flag === "--evaluation-endpoint" ||
      flag === "--evaluations-endpoint" ||
      flag === "--timeout-ms"
    ) {
      const value = inline ?? argv[++i];
      if (value === undefined) {
        error(`actiontape authzen audit: ${flag} requires a value`);
        error(AUTHZEN_USAGE);
        return 2;
      }
      if (flag === "--token-claims") tokenPath = value;
      else if (flag === "--evaluation-endpoint") evaluationEndpoint = value;
      else if (flag === "--evaluations-endpoint") evaluationsEndpoint = value;
      else {
        const ms = Number(value);
        if (!Number.isInteger(ms) || ms <= 0) {
          error("actiontape authzen audit: --timeout-ms must be a positive integer");
          error(AUTHZEN_USAGE);
          return 2;
        }
        timeoutMs = ms;
      }
    } else if (arg.startsWith("-")) {
      error(`actiontape authzen audit: unknown option ${arg}`);
      error(AUTHZEN_USAGE);
      return 2;
    } else if (path === undefined) {
      path = arg;
    } else {
      error(`actiontape authzen audit: unexpected argument ${arg}`);
      error(AUTHZEN_USAGE);
      return 2;
    }
  }
  if (path === undefined) {
    error("actiontape authzen audit: missing tape path");
    error(AUTHZEN_USAGE);
    return 2;
  }
  if (tokenPath === undefined) {
    error("actiontape authzen audit: missing required --token-claims <path>");
    error(AUTHZEN_USAGE);
    return 2;
  }
  if (evaluationEndpoint === undefined) {
    error("actiontape authzen audit: missing required --evaluation-endpoint <url>");
    error(AUTHZEN_USAGE);
    return 2;
  }

  const result: AuditResult = {
    schemaVersion: "1.0",
    status: "error",
    actionCount: 0,
    permitCount: 0,
    denyCount: 0,
    unknownCount: 0,
    mappingErrorCount: 0,
    notEvaluatedCount: 0,
    decisionCount: 0,
    pdpRequestCount: 0,
    actions: [],
    diagnostics: [],
    error: null,
  };
  const finish = (exitCode: number): number => {
    if (json) {
      const out = io.out ?? process.stdout;
      out.write(JSON.stringify(result) + "\n");
    }
    return exitCode;
  };
  const fail = (message: string): number => {
    result.error = message;
    error(`actiontape authzen audit: ${message}`);
    return finish(2);
  };

  // Endpoints are explicit caller inputs — never derived from tape, token, or
  // mapping data — and are validated before any network activity.
  const evalEndpointError = validatePdpEndpoint(evaluationEndpoint, "--evaluation-endpoint");
  if (evalEndpointError !== null) return fail(evalEndpointError);
  if (evaluationsEndpoint !== undefined) {
    const batchEndpointError = validatePdpEndpoint(evaluationsEndpoint, "--evaluations-endpoint");
    if (batchEndpointError !== null) return fail(batchEndpointError);
  }

  const loaded = await loadTapeEntries(path);
  if ("error" in loaded) return fail(loaded.error);
  const { actions, diagnostics } = normalizeMcpTape(loaded.entries);
  const timeline = extractMcpToolCatalogs(loaded.entries);
  result.actionCount = actions.length;
  result.diagnostics = [...diagnostics, ...timeline.diagnostics];

  const claims = await loadTokenClaims(tokenPath);
  if ("error" in claims) return fail(claims.error);
  const token = claims.token;

  reportDiagnostics(timeline.diagnostics, error);
  if (diagnostics.length > 0) {
    reportDiagnostics(diagnostics, error);
    return fail(`tape produced ${diagnostics.length} normalization diagnostic(s)`);
  }

  // Render the entire historical tape BEFORE the first PDP request.
  const rendered: RenderActionResult[] = [];
  try {
    for (const action of actions) {
      const provenance = resolveToolMappingProvenance(action, timeline);
      rendered.push(renderActionResult(action, provenance, token));
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }

  const opts = timeoutMs === undefined ? {} : { timeoutMs };
  let pdpFailed = false;
  for (let i = 0; i < rendered.length; i += 1) {
    const r = rendered[i]!;
    const base = {
      actionId: r.actionId,
      target: r.target,
      mappingSource: r.mappingSource,
      envelope: r.envelope,
      warnings: r.warnings,
    };
    if (r.status === "unknown") {
      result.actions.push({
        ...base,
        status: "unknown",
        reason: r.reason,
        decisionCount: 0,
        pdpRequestCount: 0,
        decisions: [],
      });
      continue;
    }
    if (r.status === "mapping_error") {
      result.actions.push({
        ...base,
        status: "mapping_error",
        reason: r.reason,
        decisionCount: 0,
        pdpRequestCount: 0,
        decisions: [],
      });
      continue;
    }
    if (pdpFailed || r.request === null) {
      result.actions.push({
        ...base,
        status: "not_evaluated",
        reason: r.reason,
        decisionCount: 0,
        pdpRequestCount: 0,
        decisions: [],
      });
      continue;
    }
    const decisions: AuditDecision[] = [];
    let requests = 0;
    try {
      if (r.envelope === "evaluations") {
        const batch = r.request as AuthzenAccessEvaluationsRequest;
        if (evaluationsEndpoint !== undefined) {
          // Native Access Evaluations API: one HTTP request for all entries.
          requests += 1;
          for (const d of await evaluateAccessMany(evaluationsEndpoint, batch, opts)) {
            decisions.push({ decision: d.decision, context: d.context ?? null });
          }
        } else {
          // COAZ-permitted fallback: expand into individual Access Evaluation
          // requests against the single-decision endpoint. All entries are
          // evaluated even after a denial — this is historical evidence.
          for (const single of expandAccessEvaluationsRequest(batch)) {
            requests += 1;
            const d = await evaluateAccess(evaluationEndpoint, single, opts);
            decisions.push({ decision: d.decision, context: d.context ?? null });
          }
        }
      } else {
        requests += 1;
        const d = await evaluateAccess(
          evaluationEndpoint,
          r.request as AuthzenAccessEvaluationRequest,
          opts,
        );
        decisions.push({ decision: d.decision, context: d.context ?? null });
      }
      const permitted = decisions.every((d) => d.decision);
      result.actions.push({
        ...base,
        status: permitted ? "permit" : "deny",
        reason: null,
        decisionCount: decisions.length,
        pdpRequestCount: requests,
        decisions,
      });
    } catch (err) {
      // PDP/transport failures are fatal: stop issuing requests and mark the
      // remaining renderable actions not_evaluated rather than implying a
      // decision was reached. Requests already sent still count.
      pdpFailed = true;
      result.actions.push({
        ...base,
        status: "not_evaluated",
        reason: null,
        decisionCount: decisions.length,
        pdpRequestCount: requests,
        decisions,
      });
      result.error = err instanceof Error ? err.message : String(err);
    }
  }

  result.permitCount = result.actions.filter((a) => a.status === "permit").length;
  result.denyCount = result.actions.filter((a) => a.status === "deny").length;
  result.unknownCount = result.actions.filter((a) => a.status === "unknown").length;
  result.mappingErrorCount = result.actions.filter((a) => a.status === "mapping_error").length;
  result.notEvaluatedCount = result.actions.filter((a) => a.status === "not_evaluated").length;
  result.decisionCount = result.actions.reduce((n, a) => n + a.decisionCount, 0);
  result.pdpRequestCount = result.actions.reduce((n, a) => n + a.pdpRequestCount, 0);

  if (result.error !== null) {
    result.status = "error";
  } else if (result.unknownCount > 0 || result.mappingErrorCount > 0) {
    result.status = "incomplete";
  } else if (result.denyCount > 0) {
    result.status = "deny";
  } else {
    result.status = "pass";
  }
  const exitCode = result.status === "pass" ? 0 : result.status === "error" ? 2 : 1;
  if (json) return finish(exitCode);

  log("AUTHZEN AUDIT");
  log(`status: ${result.status}`);
  log(`actions: ${result.actionCount}`);
  log(`permit: ${result.permitCount}`);
  log(`deny: ${result.denyCount}`);
  log(`unknown: ${result.unknownCount}`);
  log(`mapping-errors: ${result.mappingErrorCount}`);
  log(`decisions: ${result.decisionCount}`);
  log(`pdp-requests: ${result.pdpRequestCount}`);
  log("");
  for (const a of result.actions) {
    let label: string;
    let detail: string | null = null;
    if (a.status === "permit") {
      label = "PERMIT  ";
      if (a.decisionCount > 1) detail = `${a.decisionCount}/${a.decisionCount} decisions permitted`;
    } else if (a.status === "deny") {
      label = "DENY    ";
      detail =
        a.decisionCount > 1
          ? `${a.decisions.filter((d) => d.decision).length}/${a.decisionCount} decisions permitted`
          : null;
    } else if (a.status === "unknown") {
      label = "UNKNOWN ";
      detail = UNKNOWN_REASON_LABELS[a.reason as McpMappingUnknownReason] ?? String(a.reason);
    } else if (a.status === "mapping_error") {
      label = "ERROR   ";
      detail = String(a.reason);
    } else {
      label = "SKIPPED ";
      detail = "not evaluated";
    }
    const suffix = detail === null ? "" : ` — ${detail}`;
    log(`${label} ${a.target} (${a.actionId})${suffix}`);
  }
  if (result.error !== null) error(`actiontape authzen audit: ${result.error}`);
  return exitCode;
}

async function runAuthzen(
  argv: string[],
  io: CliIo,
  log: (line: string) => void,
  error: (line: string) => void,
): Promise<number> {
  if (argv[0] === "export") return runAuthzenExport(argv.slice(1), io, log, error);
  if (argv[0] === "simulate") return runAuthzenSimulate(argv.slice(1), io, log, error);
  if (argv[0] === "plan") return runAuthzenPlan(argv.slice(1), io, log, error);
  if (argv[0] === "render") return runAuthzenRender(argv.slice(1), io, log, error);
  if (argv[0] === "audit") return runAuthzenAudit(argv.slice(1), io, log, error);
  error(`actiontape authzen: expected "export", "simulate", "plan", "render", or "audit"`);
  error(AUTHZEN_USAGE);
  return 2;
}

export async function main(argv: string[], io: CliIo = {}): Promise<number> {
  const log = io.log ?? console.log;
  const error = io.error ?? console.error;

  if (argv[0] === "record") {
    return runRecord(argv.slice(1), io, error);
  }
  if (argv[0] === "inspect") {
    return runInspect(argv.slice(1), io, log, error);
  }
  if (argv[0] === "check") {
    return runCheck(argv.slice(1), io, log, error);
  }
  if (argv[0] === "authzen") {
    return runAuthzen(argv.slice(1), io, log, error);
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    log(`actiontape ${CLI_VERSION} (envelope schema ${ACTION_ENVELOPE_SCHEMA_VERSION})`);
    return 0;
  }
  log(HELP);
  const known = argv.length === 0 || argv.includes("--help") || argv.includes("-h");
  return known ? 0 : 1;
}
