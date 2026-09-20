# ActionTape

A deterministic record/replay, contract-testing, behavior-diffing, and
policy-simulation layer for AI agent tool calls. Initial protocol target:
[Model Context Protocol (MCP)](https://modelcontextprotocol.io).

> **Status: early / experimental.** This repository currently contains only the
> milestone-0 foundation: a strict TypeScript monorepo skeleton plus the core
> domain model. Recording, replay, diffing, and MCP translation are not
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

## Milestone 0 contents

- `@actiontape/core` — protocol-independent `ActionEnvelope` domain model and
  a small event vocabulary (`session.started`, `action.requested`,
  `action.completed`, `action.failed`, `session.ended`)
- `@actiontape/recorder` — minimal in-memory tape recorder
- `@actiontape/contracts` — minimal contract-evaluation skeleton
- `@actiontape/cli` — `actiontape` CLI placeholder (`--help`, `--version`)

MCP-specific translation layers are planned for a later milestone.

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
