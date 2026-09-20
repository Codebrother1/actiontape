import { readFile } from "node:fs/promises";
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
  JsonlTapeWriter,
  normalizeMcpTape,
  readTapeFile,
  runStdioProxy,
  type NormalizationDiagnostic,
  type TapeEntry,
} from "@actiontape/mcp";

export const CLI_VERSION = "0.0.0";

const HELP = `actiontape - deterministic record/replay for agent tool calls

Usage:
  actiontape record --out <path> -- <command> [args...]   Record MCP stdio traffic to a JSONL tape
  actiontape inspect <tape>                             Inspect a tape (read-only)
  actiontape inspect --json <tape>                      Emit normalized actions as JSONL
  actiontape check <tape> --contract <path>             Evaluate a contract against a tape
  actiontape check --json <tape> --contract <path>      Emit the check result as one JSON object
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

function formatDiagnostic(d: NormalizationDiagnostic): string {
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
  if (argv.includes("--version") || argv.includes("-v")) {
    log(`actiontape ${CLI_VERSION} (envelope schema ${ACTION_ENVELOPE_SCHEMA_VERSION})`);
    return 0;
  }
  log(HELP);
  const known = argv.length === 0 || argv.includes("--help") || argv.includes("-h");
  return known ? 0 : 1;
}
