# Compatibility: OpenCode v1 and v2

opencode-dispatch drives two OpenCode server generations:

| Dialect | Server API | OpenCode releases | Status |
| --- | --- | --- | --- |
| **v1** | `/session`, `/permission`, `/question` | 1.18.29 – 1.18.x (floor: **1.18.29**) | Supported; the reference implementation |
| **v2** | `/api/session`, `/api/permission/request`, `/api/form`, `/api/event` | 2.x (current: 2.0.32) | Rolling out mode by mode (matrix below) |

v1 and v2 are **not installed side by side by default** (the v2 installer
replaces the v1 binary), and the two generations are not wire-compatible: a
v2 client binary cannot drive a v1 server and vice versa. The dispatcher
therefore detects the server's dialect, pairs it with the right client
binary, and refuses mismatches with an actionable error.

## How a dialect is chosen

1. `--api <auto|v1|v2>` (CLI), else
2. `$OPENCODE_DISPATCH_API`, else
3. the profile's `"api"` field in `servers.json`, else
4. `auto`.

`auto` probes the server:

- `GET /api/info` → `200` JSON ⇒ **v2**,
- `GET /session` → `200` JSON array ⇒ **v1** (on v2 that URL serves the web
  UI as HTML; HTML is therefore a v2 signal),
- both routes rejected with `401`/`403` ⇒ authentication required and the
  dialect is unknown; a `401` on `/api/info` alone is **not** a v2 signal
  (v1 also guards unknown routes with basic auth),
- neither ⇒ the mode reports the server as unreachable.

Detection is honest — a pinned `api` never overrides what the server actually
is. The pin is only a fallback for client operations when the server cannot be
classified (typically because it is down and about to be launched). A
credential rejection is always reported as an auth error, never masked by the
pin.

## Client pairing (`bin`)

Which client binary a profile uses is **per-profile** (`"bin"` in the profile,
else `opencode` on `PATH`). The pairing rule:

- v1 profile ⇒ client binary must be **1.18.29+** (v1 line),
- v2 profile ⇒ client binary must be **2.x**,
- unknown versions produce a warning, mismatches a hard error before launch.

Read-only HTTP modes (`setup`, `sessions`, `status`, `history`, `follow`,
`identify`, `claim`, `teardown`) do not require a paired binary, so a missing
or mismatched `bin` does not block them — but the pairing is still shown in
`setup` and checked wherever a client is launched (including by `spawn-agent`,
which takes the profile's binary as `--opencode`). `setup` additionally queries
the binary for its version/auth/models when one is available.

`setup` prints each profile's live dialect, and the resolved profile's binary
pairing.

## Authentication

Basic auth with username **`opencode`** in both generations (v2 has no
username override). Credentials are keyed by the address actually used, in
this order: `OPENCODE_SERVER_CREDENTIALS` (a credential map keyed by
host/host:port; JSON or the JavaScript-style `{host:port:{password:pw}}` form),
the profile's `username`/`password`, the `servers.json` `credentials` map, then
the single `$OPENCODE_SERVER_PASSWORD` / `$OPENCODE_PASSWORD` fallback
(v1 name; still read by v2 clients). `.env.local` supplies the same variables.
Launched clients receive the names their dialect reads — one pair per process,
so one server's credential never leaks into another's client. A profile's bind
address (`listen`) is not a credential key: credentials are keyed by the
connection address (`host`), and a wildcard bind (`0.0.0.0`/`::`) without an
explicit `host` is refused. `localhost` and `127.0.0.1` share their key.

## Mode support matrix

| Mode / area | v1 | v2 | Notes |
| --- | --- | --- | --- |
| `setup` | ✓ | ✓ | Shows each profile's live dialect and the resolved profile's `bin` pairing |
| `sessions` | ✓ | ✓ | Normalized via `oc-api` |
| `status` (and `--follow`) | ✓ | ✓ | v2 turn state comes from `/api/session/active`; fresh sessions report `initializing (Ns)` and a submitted-but-not-started prompt reports `pending` instead of `idle`; a prompt admission marker keeps status/watch pending until the new user message is visible; `--follow` rides the event stream (`watch`), falling back to polling if the stream drops |
| `history` | ✓ | ✓ | v2 pages the message API backwards; `--since` pages back to the cutoff |
| `follow` | ✓ | ✓ | v2 is event-driven (same output and exit codes); v1 keeps the polling loop. A completed assistant message is only one STEP, so v2 confirms turn completion against `/api/session/active` before exiting. A failed v2 turn is reported from its `idle` record instead of waiting for an assistant reply that will never arrive |
| `identify` / `claim` / `release` | ✓ | partial | Identity env comes from the `opencode-identity` plugin, which is still v1-shaped (see below) |
| `teardown` | ✓ | ✓ | Server delete works on v1 and v2; the direct-SQL fallback is v1-only (v2 sessions live in `session_v2`) |
| `permissions` / `allow` | ✓ | ✓ | v2 lists `/api/permission/request` across session directories and replies through the owning session (`{decision: once\|always}`) |
| `send` (incl. `--steer`/`--queue`) | ✓ | ✓ | Default send uses a baseline message id on v2 instead of the v1 pre-count; `--steer`/`--queue` use v2's `delivery` field and are refused on v1 (no equivalent) |
| `abort` | ✓ | ✓ | Routed through the adapter (`/session/{id}/abort` on v1, `/api/session/{id}/interrupt` on v2) |
| `serve` / `--stop` / `--restart` | ✓ | ✓ | Manages a private `opencode serve` on either dialect (same `--port`/`--hostname`/credential env); a v2 start requires a configured password (see below); v2's shared background service is still managed by `opencode service` |
| Run modes (`review`, `plan`, `ask`, `task`, `bulk`) server-backed | ✓ | ✓ | Create/submit go through `oc-api`; v2 `--follow` uses the event stream and `--background`/`--wait` use the v2 `wait` loop (same heartbeats, stalls, and exit codes) |
| `--direct` one-shot | ✓ | — | The run flags differ between generations; refuses a v2 client binary |

The remaining generation-specific mode is `--direct` (one-shot, v1 client
binary); it refuses a v2 server/client with a clear message instead of issuing
calls that cannot work.

`send` and the run-mode submit path write a short-lived admission marker under
`~/.local/state/opencode-dispatch/pending/` (override the root with
`OPENCODE_DISPATCH_STATE_DIR`). It closes the window where the prompt POST has
returned an admission id but the user message is not yet in `GET /message`, so
`status`/`watch`/`follow`/`wait` cannot mistake the previous `idle` turn for the
new one. Markers are keyed by server URL + session id and expire after ten
minutes.

### Agent models

v2 does not copy an agent's configured `model` from `opencode.json` onto a new
session; the session starts without a model and the turn falls back to the
server default. Run modes resolve the selected agent's effective model through
the client binary's normalized `opencode debug config` output and send it with
create/submit, so per-agent models are honored on both dialects. Explicit
`--model`/`OPENCODE_DISPATCH_MODEL` wins; the profile `model` is the fallback
when the agent has no configured model. `spawn-agent` performs the same
resolution for direct worker launches.

### v2 `serve` requires a password

`opencode serve` v2 ALWAYS enables basic auth and, when no password is supplied,
generates a random one and prints it to the server log. That password is not
shared with the dispatcher's HTTP clients, so starting without one would leave
every later call with a 401. `serve` and auto-start therefore refuse a v2 launch
with no resolved password (profile `password`, `OPENCODE_SERVER_CREDENTIALS`, or
`OPENCODE_SERVER_PASSWORD`) before spawning anything, and the post-start check
requires `authOk` rather than merely a classified dialect. The same check makes
`serve` report an authentication rejection instead of "already running" when a
reachable v2 server's credential does not match.

## Plugins

`opencode-identity` and `opencode-branch-staleness` are still written against
the **v1 plugin API**. V1 plugin implementations do not run in v2. The port to
the v2 plugin API (dual-entrypoint, so one file pair serves both generations)
is in progress; until it lands, v2 users do not get identity env injection or
the branch-staleness nudge.

## Configuration files

The shipped `config/opencode.json` sample and `opencode-set-model.sh` still
write **v1-shaped** configuration (`agent`, `permission`, `variant` as a
separate key). v2 normalizes supported v1 configuration, so both generations
run the same file — with one behavioural difference: v2 allows
`external_directory` access by default where v1 asks. See the migration guide
at <https://opencode.ai/v2/docs/migrate-v1> for the native shapes.

## For maintainers: how the dual support is built

- `scripts/api-dialect.mjs` — version parsing, server probing, pairing rules,
  client auth env names.
- `scripts/opencode-server.mjs` — the dialect adapter: one client API
  (`createSession`, `interruptSession`, `messages`, `asks`, `waitTurn`,
  `eventStream`, …) with v1 and v2 implementations and normalizers for
  sessions, messages, and asks.
- `scripts/oc-api.mjs` — a CLI front of the adapter used by the shell
  orchestrator, so `opencode-dispatch.sh` keeps control flow (flags, loops,
  exit codes) and Node owns wire shapes.
- `scripts/opencode-dispatch.sh` — profile resolution adds `api`/`bin`;
  `resolve_api`/`check_pairing` gate the modes.

### Testing against both generations

```bash
npm test          # unit + CLI tests cover both dialects (mocked servers)

# real v1 server (isolated DB; the package pins the supported floor)
npm i --prefix /tmp/oc-v1 opencode-ai@1.18.29
OPENCODE_DB=/tmp/oc-v1.db OPENCODE_SERVER_PASSWORD=pw \
  /tmp/oc-v1/node_modules/.bin/opencode serve --port 4123 --hostname 127.0.0.1

# real v2 server (private; the shared service works too)
OPENCODE_PASSWORD=pw opencode serve --port 4124 --hostname 127.0.0.1
```

Point a `servers.json` profile at each (with the matching `bin`) and run
`setup`, `sessions`, `status`, `history`, `follow`.

### Rollout status

Landed: detection/pairing, the adapter, the `oc-api` shim, the read-only modes
including the v2 event fast path for `follow`/`status --follow`, the
server-backed run modes, `send` (including `--steer`/`--queue` delivery on v2),
`abort`, `permissions`/`allow` on v2, and the private `serve` lifecycle on both
dialects.

Next: plugins (dual-entrypoint), the v2 shared service (`opencode service`),
dialect-aware teardown fallbacks, native config shapes, events beyond the
read-only modes.
