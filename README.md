# ActionTape

A deterministic record/replay, contract-testing, behavior-diffing, and
policy-simulation layer for AI agent tool calls. Initial protocol target:
[Model Context Protocol (MCP)](https://modelcontextprotocol.io).

> **Status: early / experimental.** The only working feature today is
> transparent **stdio recording** of MCP traffic. Replay, contracts, diffing,
> redaction, and policy simulation are not implemented yet.

## What problem is this trying to solve?

AI agents act on the world through tool calls. Those calls are
non-deterministic at the edges — live services, clocks, random identifiers —
which makes agent behavior hard to test, reproduce, and audit.

ActionTape intends to sit between an agent and its tool servers:

```
Agent
  |
  v
ActionTape  (record / replay / inspect / diff / contract / policy simulation)
  |
  v
MCP servers / tools
```

By capturing tool calls as immutable, serializable records, ActionTape aims to
let developers:

- record real agent sessions and replay them deterministically in CI
- write contracts over tool-call sequences
- diff agent behavior between runs, models, or prompts
- simulate policy decisions against recorded traffic

ActionTape is **not** an agent framework and has no LLM dependency in its core.

## Recording MCP stdio traffic

ActionTape can wrap an MCP server process as a transparent stdio proxy. Bytes
flow through unchanged; every newline-delimited JSON-RPC message is
additionally written to a JSONL tape.

```sh
actiontape record --out ./my-run.agentlog -- node my-mcp-server.js
actiontape record --out ./my-run.agentlog -- npx some-mcp-server --arg value
```

- Client → server traffic (the child's stdin) and server → client traffic (the
  child's stdout) are both recorded, with a single monotonically increasing
  sequence number across both directions.
- While recording, ActionTape writes **nothing** to stdout — stdout belongs to
  the protocol. Diagnostics go to stderr, and child stderr is passed through
  to the parent's stderr (never recorded as protocol traffic).
- Messages that are not valid JSON are still forwarded unchanged and recorded
  with a parse error. ActionTape is an observer first.

### Important caveats

- **Tapes may contain sensitive data.** MCP arguments and results can carry
  credentials, tokens, personal data, or file contents. ActionTape records the
  traffic verbatim — there is no redaction yet.
- **A recording ID is not an MCP session.** Each `record` run is tagged with an
  ActionTape `recordingId`; this is unrelated to any MCP protocol session.
- **stdio only.** Streamable HTTP and other transports are not supported yet.
- **No replay.** Tapes cannot currently be replayed, diffed, or checked against
  contracts.
- The wire record format is experimental and may change between milestones.

## Packages

- `@actiontape/core` — protocol-independent `ActionEnvelope` domain model and
  a small event vocabulary (`session.started`, `action.requested`,
  `action.completed`, `action.failed`, `session.ended`)
- `@actiontape/mcp` — transparent stdio proxy and JSONL wire-record writer
- `@actiontape/recorder` — minimal in-memory tape recorder
- `@actiontape/contracts` — minimal contract-evaluation skeleton
- `@actiontape/cli` — `actiontape` CLI (`record`, `--help`, `--version`)

## Development

Requirements: Node.js 22+, pnpm.

```sh
pnpm install
pnpm build
pnpm test        # builds all packages, then runs vitest
pnpm typecheck
pnpm lint
pnpm format
```

## License

MIT
