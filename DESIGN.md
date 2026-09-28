# opencode-dispatch — Design & Inter-Agent Roadmap

Delegate work from inside the Claude Code harness to **opencode** driving a
cheaper model (default **DeepSeek**), so heavy reading/drafting/reviewing runs on
cheap tokens and only distilled results cross back into Claude's context.

Status: the CLI/skill layer (dispatch script + `/opencode:*` commands + persistent
server + session read-back) is built. The inter-agent features below are the
roadmap for the future MCP server.

---

## 1. The core idea (token seam)

Claude Code subagents ("Fable delegating to subagents") run in their **own**
context and return only a final report to the parent — the parent never pays for
the subagent's intermediate reasoning. An opencode delegate is the **same shape,
on a different model**:

| | Model | Context | Parent pays for |
|---|---|---|---|
| Native Claude subagent | Anthropic (Opus/Sonnet/Haiku) | its own | final report |
| **opencode delegate** | **DeepSeek (or any)** | its own opencode session | **only what the tool returns** |

You **cannot** repoint a native Claude `Agent` subagent at DeepSeek — Claude
subagents run Anthropic models. So an MCP tool (or the current bash/`run`
dispatch) is the *only* seam to inject a non-Anthropic worker into the harness.
The MCP is the more subagent-like of the two: it can hold session state and
return structured results, not just stdout.

**The invariant that keeps the token math positive:** *only distilled output
crosses the seam into Claude.* A tool that returns a raw transcript or a 20-page
dump spends the savings. Design every tool to return summaries, diffs, verdicts,
or typed JSON.

### Token economics (measured)
A one-line DeepSeek reply cost **~17.6k input tokens ($0.0077)** on
`deepseek-v4-pro` — opencode sends its full agent/system prompt every turn. Cheap,
but **not per-call-free**. Implication: batch related asks into one session; don't
spray many cold one-turn sessions.

---

## 2. Inter-agent feature catalog

Grouped by purpose. ⚙️ = native opencode endpoint exists; 🔧 = wrapper/MCP convenience.

### Unlocks "seamless like Fable"
- **Completion signal** ⚙️ — opencode has an SSE event stream (`/global/event`,
  `/api/session/:id/event`). A watcher on it **wakes Claude when a delegate
  finishes** instead of polling. Pairs with a Claude Code hook. This is the piece
  that turns "call tool, block/poll" into "fire, get notified."

### Result contracts (keep token math positive)
- **Structured/typed returns** ⚙️ — the message API supports
  `format: json_schema`. The delegate returns *validated JSON*, not prose. Single
  biggest lever for cheap, reliable agent-to-agent handoff.
- **Cheap outcome inspection (no transcript)** ⚙️ — `GET /session/:id/diff`
  (files changed), `/session/:id/todo` (task list/progress).
- **Cost/token readout** ⚙️ (already in the session object) → a budget guard so a
  delegate can't silently run up cost.

### Control
- **steer / queue** ⚙️ — `POST /api/session/:id/prompt` with `delivery:"steer"`
  (inject into the running turn) or `"queue"` (after current). Returns an
  admission record, not the reply — then poll `status`/`history`.
- **abort / interrupt** ⚙️ — `POST /session/:id/abort`, `/api/session/:id/interrupt`.
- **wait** ⚙️ — `/api/session/:id/wait` blocks until the current turn completes.

### Safety
- **Revert / unrevert** ⚙️ — undo a delegate's file edits (`/session/:id/revert`).
  Essential when `task`/`build` can edit.
- **Permission surfacing** ⚙️ — `/session/:id/permissions/:pid`; if a delegate
  hits an approval gate, bubble it up rather than hang.

### Coordination
- **Context handoff** 🔧 — seed a delegate with files (`-f`) or a briefing message.
- **Fork** ⚙️ — branch a session (`/session/:id/fork`) to explore a variant
  without polluting the original.
- **Delegate registry** 🔧 — a local `role → session-id` map so Claude addresses
  delegates stably ("the reviewer", "the migrator") and runs several concurrently.
- **liveness / status** 🔧 — `GET /session/:id` → `time.updated`; compute
  "idle for Nm" without pulling the transcript. Distinguish working-vs-idle via
  the last assistant message lacking `time.completed`.

---

## 3. Recommended build order (for the MCP)

The three that most change day-to-day, in order:

1. **Structured returns** (`format: json_schema`) — makes delegation cheap and
   reliable; everything downstream benefits.
2. **Completion-notify (SSE → Claude Code hook)** — removes polling; delivers the
   hands-off, Fable-like feel.

Everything else in §2 is refinement layered on top.

Suggested minimal MCP tool surface:
`start_session`, `send` (with `steer|queue|wait`), `status`,
`get_diff`, `delegate_task` (returns a tight typed report), `list_sessions`.
Each contract-designed to return distilled output.

---

## 4. Operational notes (hard-won)

- **Everything runs in the server context by default.** Run modes are server-backed
  and async: submit → get a session id → observe (`status`/`history`) → kill
  (`abort`). This replaced the original one-shot `opencode run` default, which was
  an unobservable blocking subprocess with no timeout — the cause of an 8-hour
  "review" that no one could see into. One-shot is now opt-in via `--direct`
  (a one-shot `opencode run` that bypasses the server);
  `--follow [--timeout N]` waits (bounded) and prints the reply inline.
- **Wake-on-complete = `--background`, not the delegate calling back.** Don't have
  opencode invoke `claude --resume` — that forks a *new* Opus process (costs the
  tokens we're saving, can't target the live session). Instead the wrapper
  blocks (the job itself runs in the background on the server):
  `--background` submits async then lives exactly as long as the turn, prints the
  distilled result, and **exits 0** the moment it completes. Launched as a
  background task, that exit is what re-invokes Claude Code. No fixed deadline
  (default ~24h backstop, `--timeout 0` = unbounded); exits non-zero on turn error
  or if the server goes unreachable (~40s). `--follow` is the older bounded (300s)
  foreground wait that *leaves the session running* on timeout.   **`--background`
  is the default for every run mode** in the dispatch script itself (`--wait`
  is the foreground blocking form); the slash commands pass it explicitly (task/bulk).
- **529 "Overloaded" is an Anthropic code; DeepSeek uses 503/429.** A consistent
  529 means the work was NOT going to DeepSeek — an unconfigured/fallback Anthropic
  model, or the Claude subagents' own calls during a capacity event. Pin the model
  (`--model deepseek/...`) and check `status`'s `lastError` / the error's
  `metadata.url` to see which backend actually failed.
- **Edit workers are isolated:** task/bulk call the repository's
  `spawn-agent.mjs`, which allocates and bootstraps one locked worktree, creates a
  directory-bound session on the single persistent server, verifies the returned
  directory, and launches `opencode run --attach ... --auto`. Edit/bash are
  pre-authorized (`permission:[{edit/bash,**,allow}]`).
- **A server reads opencode's auth store at launch.** Credentials come from
  `opencode auth login` (opencode's own storage — never environment variables or
  config files). If `opencode serve` starts before auth is set up (or you add a
  provider afterwards), every turn 401s ("Authentication Fails (governor)") even
  though the key is valid. Authenticate first, then start/restart the server.
  Verify with `opencode auth list` or `/opencode:setup`.
- **Agent configs live in `~/.config/opencode/opencode.json`** under the `agent`
  key (project-level `./opencode.json` overrides it). This repo ships the sample
  in `config/opencode.json` (build/review/auto agents + permissions); `install.sh`
  copies it only when no config exists and `/opencode:model` edits it by merge —
  an existing config is never overwritten.
- **Permission surfacing lives in TWO volatile queues + one durable signal.**
  `GET /permission` (`{id, sessionID, permission, patterns, tool}`) and
  `GET /question` (`{id, sessionID, questions[], tool}`) are in-memory — a
  server restart loses them while the session stays stuck. The durable signal is
  the message stream: the last assistant message lacks `time.completed` and the
  newest tool part sits in `state.status:"running"` with no `time.end`. `status`
  checks all three: the queues give the precise `PERMASK`/`QUESTION` verdict
  with the request id; the message stream names the stuck tool (`WORKING — TOOL
  RUNNING (bash · 4m)`) when the queue is gone, and a >30m frozen `updated`
  flags `STALE`. Note the session JSON in 1.18.x has **no `lastMessage`**, so
  list views must probe each session's `message?limit=1` (returns the last
  message) rather than trust a field that never exists.
- **Never pipe `opencode-dispatch.sh` through `tail`.** install.sh registers a
  PreToolUse hook (`opencode-guard.sh`) that throws on `| tail`; the scripts
  bound their own output, and tail can clip the distilled result that keeps the
  token math positive.
- **BSD/macOS `mktemp` only expands `X`s at the END of the template.** A template
  like `foo-XXXXXX.diff` (suffix after the X's) is used *literally* on macOS — so
  every run (and any concurrent run) collides with `mkstemp failed: File exists`.
  Use `foo.XXXXXX` (X's terminal). GNU mktemp tolerates the suffix; BSD does not.
- **`--model` must be `provider/model`** (e.g. `deepseek/deepseek-v4-pro`); a bare
  `deepseek-v4-pro` is rejected (it would mis-split into a bogus providerID).
- **`-f` is a greedy array flag** in `opencode run`. Keep the prompt BEFORE `-f`
  and `-f` terminal with a single value, else yargs eats the prompt as a filename.
- **`/session/:id` is an API route** and shadows the web SPA — it returns JSON,
  not the UI. The web UI routes by *project* (slugs like `kind-cabin`), not by the
  API session path.
- **The local server serves a full web UI** at `/` (self-contained, CSP `'self'`)
  and renders in Claude Code's browser pane — good for watching a delegate live.
  Sessions created via the raw API in an unregistered directory may not surface in
  the UI's project list; driving opencode through the UI (add project → create
  session) is the reliable path to see them.

---

## 5. Useful opencode endpoints (v1.18.x)

| Endpoint | Use |
|---|---|
| `POST /session` | create session (`{title?, agent?, model?:{id,providerID,variant?}}`) |
| `GET /session` | list sessions |
| `GET /session/:id` | one session (has `time.updated`, `cost`, `tokens`) |
| `DELETE /session/:id` | delete session |
| `POST /session/:id/message` | send prompt, **blocking**, returns full reply `{info, parts}` |
| `POST /session/:id/prompt_async` | send prompt, non-blocking |
| `POST /api/session/:id/prompt` | send with `delivery:steer\|queue`, `resume` |
| `GET /session/:id/message` | full transcript (messages → `parts[]` text) |
| `GET /session/:id/diff` | files changed by the session |
| `GET /session/:id/todo` | session todo list |
| `POST /session/:id/fork` | branch the session |
| `POST /session/:id/abort` / `/api/session/:id/interrupt` | stop a turn |
| `POST /session/:id/revert` / `/unrevert` | undo/redo file changes |
| `GET /global/event`, `/api/session/:id/event` | SSE event stream |
| `GET /doc` | OpenAPI 3.1 spec (auto-generated SDK source) |

Models on this DeepSeek account: `deepseek-v4-pro` (default), `deepseek-v4-flash`.

---

## 6. Multiple server definitions (named profiles)

One persistent server is the right default — but "one server" is a *per-profile*
fact, not a global one. The dispatcher resolves a **named profile** for every
server-backed mode; the default profile preserves the historical single-server
behavior exactly.

### The listen/address split (the one rule that matters)

A profile carries two distinct addresses, and conflating them is the failure
mode this design removes:

| Field | Meaning | Allowed values |
|---|---|---|
| `listen` | Bind interface passed to `opencode serve --hostname` | `127.0.0.1`, `0.0.0.0`, `::`, or a specific interface IP |
| `host` | Addressable host the dispatcher curls (and what stop/restart probe) | loopback, `localhost`, or a concrete interface IP/hostname — **never `0.0.0.0`/`::`** (nothing is reachable there) |

Resolution rules (enforced at resolve time, exit 2):
- `host` defaults to `listen` when the listen address is concrete (loopback or
  an interface IP). A wildcard bind (`0.0.0.0`) has **no** addressable form and
  requires an explicit `host` — the dispatcher refuses to guess.
- Binding a non-loopback interface requires a `password` (profile field or
  `OPENCODE_SERVER_PASSWORD`). Without it the dispatcher refuses to start: an
  unauthenticated server on a network interface is a security hole, not a
  convenience.
- opencode's basic auth is user **`opencode`** + the password (verified against
  1.18.9; `:<password>` and bare `password` both 401). The historical
  `--user ":<password>"` worked only against unauthenticated servers.
  Since 1.18.9 the server also honors **`OPENCODE_SERVER_USERNAME`** at launch
  (verified: with it set, `customuser:pw` → 200 and even `opencode:pw` → 401),
  so the username is configurable on both sides of the wire.

### Local credentials: `.env.local`

A `.env.local` in the skill directory (gitignored; `.env.local.example` ships
the template) can carry `OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD`.
Every dispatch mode loads it (only those two keys; only when the variable is
not already set in the real environment — dotenv semantics, an exported shell
var wins). Resolution is `$OPENCODE_DISPATCH_ENV_FILE`, else a walk up from the
script's own directory (repo copy: the repo root; installed copy:
`~/.claude/scripts/.env.local`, refreshed by install.sh). The loaded pair is
fed into the SAME resolved credential slot as the profile password, so the
launched server and every client always use one pair, and removing the file
reverts to the defaults. The loader parses `KEY=VALUE` lines only — it never
sources the file, so it cannot execute code.

### Definition file and precedence

`~/.config/opencode-dispatch/servers.json` (sample:
`config/servers.json.example`, copied by install.sh only when none exists; keys
starting with `_` are ignored as documentation). Per-field precedence:

```
CLI flag (--port/--host/--listen) > env (OPENCODE_DISPATCH_*) > definition > default
```

- `--server <name>` / `$OPENCODE_DISPATCH_SERVER` / `serve <name>` select the
  profile (default `default`).
- `OPENCODE_DISPATCH_PORT`/`HOST`/`LISTEN`/`SERVER_PASSWORD` remain valid
  overrides — the whole env-var contract from the single-server era still works,
  now layered over the profile file. No definitions file = the historical
  defaults (127.0.0.1:4096), zero-config backward compat.
- Profile `model` slots between `OPENCODE_DISPATCH_MODEL` and the opencode
  config default (a "pro" profile can pin `deepseek-v4-pro`); profile `dir`
  feeds the default session directory when `--dir` is absent (the launch cwd for
  a remote profile, and the project-root `opencode.json` it should read).

### Lifecycle

- Launch records are **per profile** (`serve-<name>.args` in the temp dir), so
  `--stop`/`--restart` on one profile can never touch another. `default` falls
  back to the legacy `serve.args` so a server started by a pre-names install is
  still stoppable.
- Stop/restart use `lsof` on the local machine — local operations only. A
  remote profile's lifecycle is managed on the machine it runs on; the
  dispatcher's `--stop` correctly finds nothing local.
- `setup` lists every profile with its bind→address split and live UP/down
  state, marking the resolved one.

### Why profiles are the right unit (vs servers-per-worktree)

The original design note still holds: sessions are directory-bound, so one
server serves every worktree. Profiles add *isolation of identity*, not
worktree multiplicity — a cheap flash server for churn, a pro server for deep
tasks, a remote box for heavy jobs — while keeping the "one server per profile,
sessions routed by directory" invariant inside each.


## 7. Agent identity & claims (delegation)

Every agent session — spawned by a launcher OR started from opencode itself —
gets a persistent, authoritative identity via the **opencode-identity plugin**
(`plugins/opencode-identity.js`, loaded from `~/.config/opencode/plugins/` or
`<project>/.opencode/plugins/` in every instance: TUI, `opencode run`, serve).

Two hooks, two problems solved:

- **`shell.env`** — injects the *executing* session's own
  `OPENCODE_SESSION_ID` / `_SLUG` / `_TITLE` / `_AGENT` / `_MODEL` /
  `_DIRECTORY` into every tool shell (verified on 1.18.9: a `general` subagent
  spawned via the task tool sees ITS OWN id, not the parent's). No env
  inheritance, no directory matching, no collisions. The id comes from the
  server's own hook context, so it is authoritative.
- **`event: session.created`** — idempotently appends ` — <slug>` to the
  session title (`PATCH /session/{id}`, verified), so every session carries a
  stable human-readable label in all listings and claim records.

`identify` (env → DB fallback via the shared `opencode.db`: newest session
rooted in `$PWD`) prints the identity; `claim <unit>` writes
`<worktree>/.opencode-claims/<unit>.json` with an exclusive create
(`O_EXCL`), so claims can never double-assign; `release <unit>` is owner-only.
The claim file records sessionId, slug, agent, taskId (delegation env), worktree,
server URL, and timestamp — every unit traces back to the exact session that
did it.

Known limitation: the env-injected `OPENCODE_SESSION_TITLE` may lag the
patched title by one hook (the cache captures the pre-suffix title at
creation); the title is informational, the id/slug are authoritative.
