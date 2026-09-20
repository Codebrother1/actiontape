# Cerbos demo: historical authorization audit

This example audits a **synthetic recorded MCP session** against a real
[Cerbos](https://cerbos.dev) **0.55.0** PDP using the AuthZEN Access
Evaluation and Access Evaluations APIs. It was validated end-to-end on macOS
with the official standalone Cerbos binary — no Docker required.

## What the fixture is

`historical-demo.jsonl` is a synthetic ActionTape wire recording (JSONL) of a
plausible MCP session: one `tools/list` catalog followed by five `tools/call`
rounds. No tools were ever executed while producing this file, and
`authzen audit` never executes tools or replays MCP — it only asks a PDP
what it _would have decided_.

The catalog advertises four tools:

| Tool           | Mapping                                                |
| -------------- | ------------------------------------------------------ |
| `get_customer` | **declared** `x-authzen-mapping` (single `evaluation`) |
| `get_weather`  | none → **confirmed default** `tools/call` mapping      |
| `write_file`   | none → **confirmed default** `tools/call` mapping      |
| `copy_file`    | **declared** `x-authzen-mapping` (multi `evaluations`) |

`claims.json` holds **simulation token claims** (`sub`, `client_id`) supplied
to the renderer. They are inputs you choose — ActionTape never reads or
validates real credentials.

## The policies

`policies/` contains three Cerbos resource policies (all `version: default`,
all `roles: ["*"]`):

- `tool.yaml` — the COAZ **default** mapping surface: action `tools/call` on
  resource kind `tool`. Allows read-style filesystem tools and `get_weather`;
  `write_file`/`edit_file`/`move_file` have no rule and are denied.
- `customer.yaml` — allows `get_customer` **except** on `cust-sensitive`.
- `file.yaml` — allows `read`, never `write`.

## Why it's interesting

- `get_customer` is called twice with different arguments. The declared
  mapping projects `params.arguments.id` into the AuthZEN resource id, so
  `cust-public` permits while `cust-sensitive` denies — the same MCP tool,
  different authorization outcome, decided by _historical_ arguments.
- `copy_file` renders one AuthZEN `evaluations` envelope with two entries
  (`read` the source, `write` the destination). Cerbos returns
  `read → permit`, `write → deny`, so the whole historical action is a deny.
- `get_weather` permits and `write_file` denies through the **confirmed
  default** mapping — no declared mapping, no arguments sent.

Expected audit result: **5 actions, 2 permit, 3 deny, 6 decisions**,
status `deny`, exit `1`.

## Run it

From the repository root:

```sh
# 1. Build ActionTape
pnpm install && pnpm build

# 2. Download the official Cerbos 0.55.0 binary (macOS universal) into a
#    temp directory — do NOT install it globally.
mkdir -p /tmp/cerbos-demo && cd /tmp/cerbos-demo
curl -fsSLO https://github.com/cerbos/cerbos/releases/download/v0.55.0/cerbos_0.55.0_Darwin_all.tar.gz
tar xzf cerbos_0.55.0_Darwin_all.tar.gz
./cerbos --version   # must print 0.55.0

# 3. Compile the demo policies (must succeed)
./cerbos compile "$OLDPWD/examples/cerbos-demo/policies"

# 4. Create a local server config (adjust the policy path for your checkout)
cat > cerbos.yaml <<EOF
server:
  httpListenAddr: "127.0.0.1:3592"
  grpcListenAddr: "127.0.0.1:3593"
storage:
  driver: "disk"
  disk:
    directory: "$OLDPWD/examples/cerbos-demo/policies"
    watchForChanges: false
telemetry:
  disabled: true
EOF

# 5. Start the PDP in the background
./cerbos server --config=./cerbos.yaml > cerbos.log 2>&1 &
CERBOS_PID=$!
curl -fsS http://127.0.0.1:3592/.well-known/authzen-configuration
# -> advertises access_evaluation_endpoint and access_evaluations_endpoint

cd "$OLDPWD"

# 6. Inspect mapping provenance (no PDP contact)
node packages/cli/dist/cli.js authzen plan examples/cerbos-demo/historical-demo.jsonl

# 7. Render the AuthZEN requests each call would produce (no PDP contact)
node packages/cli/dist/cli.js authzen render examples/cerbos-demo/historical-demo.jsonl \
  --token-claims examples/cerbos-demo/claims.json

# 8. Audit against real Cerbos — native Access Evaluations API
node packages/cli/dist/cli.js authzen audit examples/cerbos-demo/historical-demo.jsonl \
  --token-claims examples/cerbos-demo/claims.json \
  --evaluation-endpoint http://127.0.0.1:3592/access/v1/evaluation \
  --evaluations-endpoint http://127.0.0.1:3592/access/v1/evaluations
# expect: permit 2, deny 3, decisions 6, pdp-requests 5, status deny, exit 1

# 9. Same audit WITHOUT the batch endpoint — copy_file expands into two
#    individual evaluation requests with identical decisions
node packages/cli/dist/cli.js authzen audit examples/cerbos-demo/historical-demo.jsonl \
  --token-claims examples/cerbos-demo/claims.json \
  --evaluation-endpoint http://127.0.0.1:3592/access/v1/evaluation
# expect: same decisions, pdp-requests 6

# 10. Stop Cerbos
kill "$CERBOS_PID"
```

Linux users: substitute the `Linux_x86_64`/`arm64` release archive for the
same `v0.55.0` tag. Cerbos may also be run from its published image
(`ghcr.io/cerbos/cerbos:0.55.0`) as an optional alternative if you have a
container runtime.

## Scope

This demo proves historical/contract-time interoperability only. It is not a
runtime enforcement mechanism and makes no claims about production security.
