import { constants as osConstants } from "node:os";
import type { Readable, Writable } from "node:stream";
import { ACTION_ENVELOPE_SCHEMA_VERSION } from "@actiontape/core";
import { JsonlTapeWriter, runStdioProxy } from "@actiontape/mcp";

export const CLI_VERSION = "0.0.0";

const HELP = `actiontape - deterministic record/replay for agent tool calls

Usage:
  actiontape record --out <path> -- <command> [args...]   Record MCP stdio traffic to a JSONL tape
  actiontape --help                                     Show this help
  actiontape --version                                  Print version

Notes:
  - While recording, stdout carries only the child server's protocol bytes.
    ActionTape diagnostics are written to stderr.
  - Tapes record traffic verbatim and may contain sensitive data.

Experimental: stdio recording only. No replay, redaction, or policy yet.
`;

const RECORD_USAGE = `usage: actiontape record --out <path> -- <command> [args...]`;

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

export async function main(argv: string[], io: CliIo = {}): Promise<number> {
  const log = io.log ?? console.log;
  const error = io.error ?? console.error;

  if (argv[0] === "record") {
    return runRecord(argv.slice(1), io, error);
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    log(`actiontape ${CLI_VERSION} (envelope schema ${ACTION_ENVELOPE_SCHEMA_VERSION})`);
    return 0;
  }
  log(HELP);
  const known = argv.length === 0 || argv.includes("--help") || argv.includes("-h");
  return known ? 0 : 1;
}
