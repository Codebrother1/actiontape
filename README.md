# ActionTape

A deterministic record/replay, contract-testing, behavior-diffing, and
policy-simulation layer for AI agent tool calls. Initial protocol target:
[Model Context Protocol (MCP)](https://modelcontextprotocol.io).

> **Status: early / experimental.** Working features today: transparent
> **stdio recording** of MCP traffic, **read-only tape inspection**
> (`inspect` / `inspect --json`), and **deterministic contract checks**
> (`check`). Replay, diffing, redaction, and policy simulation are not
> implemented yet.

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
- **No replay.** Tapes cannot currently be replayed or diffed.
- The wire record format is experimental and may change between milestones.

## Inspecting a tape

`inspect` reads a tape and normalizes `tools/call` JSON-RPC traffic into
deterministic, correlated `ActionEnvelope` actions. It is strictly read-only:
it never spawns the recorded command or replays any recorded message.

```sh
actiontape inspect ./my-run.agentlog
actiontape inspect --json ./my-run.agentlog   # one ActionEnvelope per line
```

Normalization correlates each `tools/call` request with its JSON-RPC response
(exact id match, distinguishing `1` from `"1"`), and classifies outcomes as
success, protocol error, tool-execution error (`result.isError`),
`input_required`, unknown `resultType`, or incomplete (no response observed).
Non-`tools/call` request/response traffic (e.g. legacy `initialize`,
`tools/list`, `server/discover`) is
tracked for correlation but not turned into actions or reported as unmatched;
genuinely orphaned responses are still diagnosed. Unreadable tapes fail; tapes
with malformed lines still inspect, with diagnostics reported on stderr.

MCP 2026-07-28 multi-round-trip calls (`resultType: "input_required"` followed
by a retry under a new JSON-RPC id) are currently normalized as one
ActionEnvelope per wire round — logical MRTR grouping is deferred because safe
correlation across rounds cannot always be inferred.

## Checking a tape against a contract

`check` evaluates a small YAML contract (JSON works too, since JSON is valid
YAML) against the normalized `ActionEnvelope` actions in a tape:

```sh
actiontape check ./my-run.agentlog --contract ./contract.yaml
actiontape check --json ./my-run.agentlog --contract ./contract.yaml
```

```yaml
contractVersion: "1.0"
rules:
  - id: no-delete
    type: deny
    match:
      protocol: mcp
      operation: tools/call
      target: "delete_*"
  - id: pull-request-base
    type: require_argument
    match:
      target: create_pull_request
    path: /base
    operator: equals
    value: main
```

Three rule types are supported: `deny` (one violation per matching action),
`max_calls` (one violation when the number of matching actions exceeds `max`),
and `require_argument` (a JSON Pointer `path` into `arguments` that must
`exists` or `equals` a structural `value`). `match` filters on `protocol`,
`direction`, `operation`, and `target` — `target` supports `*` as the only
wildcard; an omitted `match` applies the rule to every action.

Exit codes: `0` contract passed, `1` violations found, `2` ActionTape could not
safely evaluate (malformed contract or tape, unreadable file, or any
normalization diagnostic — checks fail closed).

Contracts operate on **recorded, normalized** actions. Each MRTR wire round
counts as an independent action; logical grouping is deferred. ActionTape
evaluates observed behavior only — it does not yet enforce authorization policy
at execution time (no Cedar/AuthZEN/policy simulation yet).

## Packages

- `@actiontape/core` — protocol-independent `ActionEnvelope` domain model and
  a small event vocabulary (`recording.started`, `action.requested`,
  `action.completed`, `action.failed`, `recording.ended`)
- `@actiontape/mcp` — transparent stdio proxy, JSONL wire-record writer, tape
  reader, and MCP `tools/call` normalizer
- `@actiontape/recorder` — minimal in-memory tape recorder
- `@actiontape/contracts` — strict contract parser (YAML/JSON) and
  deterministic rule evaluator over `ActionEnvelope[]`
- `@actiontape/cli` — `actiontape` CLI (`record`, `inspect`, `check`)

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
