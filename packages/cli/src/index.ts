import { ACTION_ENVELOPE_SCHEMA_VERSION } from "@actiontape/core";

export const CLI_VERSION = "0.0.0";

const HELP = `actiontape - deterministic record/replay for agent tool calls

Usage:
  actiontape --help       Show this help
  actiontape --version    Print version

Milestone 0: repository bootstrap only. Recording, replay, contracts,
and policy simulation are not implemented yet.
`;

export function main(argv: string[], write: (line: string) => void = console.log): number {
  if (argv.includes("--version") || argv.includes("-v")) {
    write(`actiontape ${CLI_VERSION} (envelope schema ${ACTION_ENVELOPE_SCHEMA_VERSION})`);
    return 0;
  }
  write(HELP);
  const known = argv.length === 0 || argv.includes("--help") || argv.includes("-h");
  return known ? 0 : 1;
}
