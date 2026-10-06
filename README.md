# opencode-dispatch

Let Claude Code — and, via generated skills, Codex — delegate
read-only analysis and isolated editing work to OpenCode while keeping one
persistent OpenCode server. For Claude Code it installs the `/opencode:*`
command set and a small dispatch wrapper; `scripts/sync-claude-commands-to-skills.ts`
generates Codex-format skills from those commands for the Codex install. The
repository's orchestration scripts own worktree allocation, bootstrap, session
registration, and cleanup.

The safety invariant is simple: an edit-capable worker gets one uniquely allocated
Git worktree, one branch, one task record, and one directory-bound OpenCode
session. Workers never edit the primary checkout or another worker's worktree by
default.

See [DESIGN.md](DESIGN.md) for the delegation architecture; the launcher and
worker scripts are documented under "Agent launcher scripts" below.

## What is installed

| Source | Installed location | Role |
| --- | --- | --- |
| `scripts/opencode-dispatch.sh` | `~/.claude/scripts/opencode-dispatch.sh` | Parses command flags, talks to the persistent server, and delegates edit tasks to `spawn-agent.mjs`. |
| `scripts/opencode-set-model.sh` | `~/.claude/scripts/opencode-set-model.sh` | Sets the default model/effort (overall, per agent, or for tasks) by merging `~/.config/opencode/opencode.json`; backs up before writing and never overwrites an existing config. |
| `scripts/opencode-guard.sh` | `~/.claude/scripts/opencode-guard.sh` | PreToolUse hook (Bash matcher) that throws if `opencode-dispatch.sh` output is piped through `tail`. |
| `commands/opencode/*.md` | `~/.claude/commands/opencode/` | Claude Code slash-command instructions. |
| `install.sh` | not installed | Installs the surfaces above, registers the tail-guard hook in `~/.claude/settings.json` (merged, never clobbered), and copies the config samples (`config/opencode.json`, `config/servers.json.example`) into `~/.config/…` only when no file exists there yet. It never reads or writes provider credentials. |
| `scripts/spawn-agent.mjs` and helpers (`agent-status.mjs`, `agent-cleanup.mjs`, `agent-worker-guard.mjs`, `worktree-utils.mjs`, `opencode-server.mjs`, `api-dialect.mjs`, `oc-api.mjs`, `agent-config.mjs`, `server-profiles.mjs`, `server-credentials.cjs`, `prune-named-sessions.mjs`) | `~/.claude/scripts/` (next to the dispatch script; repo scope: `<repo>/.claude/scripts/` and `<repo>/.codex/scripts/`) | Allocates worktrees, runs the target repo's bootstrap hook, verifies sessions, reports status, cleans up, prunes old named sessions, resolves profiles/credentials, and owns the v1/v2 API dialect layer. |

The skill repository is not the worker repository. `install.sh` installs the
launcher scripts next to `opencode-dispatch.sh`, and the dispatcher finds them
there. `OPENCODE_ORCHESTRATION_ROOT` or `--orchestration-root <path>` overrides
that, and `<--dir>/scripts` is the fallback when neither is set.

## Prerequisites

What each item is actually needed for:

- **OpenCode CLI on `PATH`** — every mode; the wrapper exits 4 when it is
  missing (`brew install sst/tap/opencode`, or `npm i -g opencode-ai`).
  Both server generations are supported: v1 (1.18.29+) and v2 (2.x). A
  server and the client binary launched against it must be the same
  generation; the dispatcher detects the dialect and refuses mismatches. See
  [COMPATIBILITY.md](COMPATIBILITY.md).
- **Node.js** — the wrapper needs Node 18+ (the `follow` mode uses built-in
  `fetch`). Two features need newer Node: `identify`'s database fallback uses
  `node:sqlite` (Node 22.5+) and the Codex skill generator uses native
  TypeScript stripping (Node 22.6+, install time only). Node 22.6+ covers
  everything.
- **A Claude Code or Codex install** — pick the surface(s) you install:
  `--claude` needs Claude Code with support for installed slash commands;
  `--codex` needs Codex with plugin support. The read-only Claude modes need
  only OpenCode + Node.
- **An authenticated OpenCode provider** — run `opencode auth login` once per
  provider. The dispatcher uses OpenCode's own credential store; the separate
  Go usage script can also read `OPENCODE_GO_API_KEYS` as described below.
- **The launcher scripts (`scripts/*.mjs`, in this repo)** — only the
  edit-capable `task` and `bulk` modes need them: `spawn-agent.mjs`,
  `worktree-utils.mjs`, `opencode-server.mjs`, `agent-worker-guard.mjs`,
  `agent-status.mjs`, and `agent-cleanup.mjs`. `install.sh` copies them next
  to `opencode-dispatch.sh`, which finds them in its own directory (override
  with `OPENCODE_ORCHESTRATION_ROOT` or `--orchestration-root`). A per-repo bootstrap hook is optional (see below). Read-only and control modes (`review`, `plan`, `ask`,
  `follow`, `status`, `history`, `send`, `abort`, …) run without them.
- **Dirty source worktrees are allowed for edit tasks** — workers start from the
  selected Git ref (`HEAD` by default); uncommitted source changes stay in the
  source checkout and are not copied into a worker worktree.

## OpenCode v1 and v2 support

This dispatcher speaks both the original opencode server API (**v1**, opencode
1.18.29+) and the revised **v2** API (opencode 2.x). The dialect is detected by
probing the server; each profile may pin `api` and the client binary it uses
(`bin`), and a server/client generation mismatch is refused before anything
launches. Not every mode is v2-ready yet — the per-mode matrix and the rollout
plan live in [COMPATIBILITY.md](COMPATIBILITY.md). Modes that are not ported
refuse a v2 server with a clear error instead of issuing calls that cannot
work. `/opencode:setup` prints each profile's live dialect and the resolved
profile's pairing.

## Installation

From this skill repository (running with no arguments prints help and does
nothing):

```bash
./install.sh --claude                       # install into Claude Code (~/.claude)
./install.sh --codex                        # install into Codex as a local plugin
./install.sh --claude --codex               # both
./install.sh --claude -s repo -r ~/my/proj  # Claude skills scoped to a repository
./install.sh --codex --no-marketplace       # Codex direct drop, no marketplace
```

Install arguments:

```text
./install.sh [--claude] [--codex] [options]

  --claude                Install the Claude Code surface: dispatch,
                          set-model, tail-guard hook, /opencode:* commands.
  --codex                 Install the Codex surface: plugin + generated
                          skills (or a direct drop with --no-marketplace).
  -s, --scope <profile|repo>
                          profile (default): the user dirs ~/.claude, ~/.codex.
                          repo: <repo>/.claude and <repo>/.codex, so the
                          skills travel with the project instead of the user.
  -r, --repo <path>       Repository for repo scope (implies --scope repo).
                          Without it the installer installs in place: when
                          the CWD is a git repo that is not this skill repo,
                          the skills land there (resolved from its git
                          top-level, so a subdirectory CWD works too). An
                          explicit -s profile always stays profile.
  --no-marketplace        Codex only: skip the plugin + marketplace and drop
                          skills straight into ~/.codex/skills with a merged
                          ~/.codex/hooks.json.
```

In repo scope the machine-level config samples (`opencode.json`,
`servers.json.example` → `~/.config/…`) are skipped, and Codex installs are
always the direct drop (the marketplace is a user-profile concept). Repo scope
is otherwise unchanged apart from now also carrying the launcher scripts; see
[Known issues](#known-issues--follow-ups).

For Claude Code, the installer copies the dispatch script, the set-model
script, the tail-guard hook, and the slash commands into the Claude directory
selected by `$CLAUDE_HOME` (default `~/.claude`; repo scope:
`<repo>/.claude`). It registers the guard as a PreToolUse hook in
`<root>/settings.json` by *merging* — your existing settings are preserved. It
also copies `config/opencode.json` to `~/.config/opencode/opencode.json`
**only when no config exists there yet**; an existing config is never
overwritten.

For Codex, the installer materializes a local plugin at
`~/.codex/plugins/opencode-dispatch/` (manifest, skills generated from
`commands/opencode` via `scripts/sync-claude-commands-to-skills.ts --codex`,
and the tail-guard hook bundled with Codex's block-exit convention), merges an
entry into the personal marketplace (`~/.agents/plugins/marketplace.json`),
runs `codex plugin marketplace add`, and enables the plugin in
`~/.codex/config.toml`. Codex requires reviewing and trusting the bundled hook
once via `/hooks` before it runs.

To skip the plugin + marketplace entirely, add `--no-marketplace`: the skills
and guard hook are then dropped directly into Codex's auto-discovered paths
(`~/.codex/skills/<opencode-*>/SKILL.md` and `~/.codex/hooks.json`, merged) —
no marketplace registration needed, same one-time `/hooks` trust step.

Profile Codex installs are **self-contained**: the dispatch wrapper, agent
launcher, and guard are installed into the plugin's `scripts/`
(`~/.codex/plugins/opencode-dispatch/scripts/`) or, with `--no-marketplace`,
`~/.codex/scripts/`, and the generated skills call them there. `--codex` alone
never touches `~/.claude`, and a Codex-only developer needs no Claude install.

### Install stamp, drift, and updates

Every profile install writes `.opencode-dispatch-install.json` next to its
scripts (source SHA, checkout path, installed file list). Re-installing removes
scripts a previous install put there that are no longer part of the set.
`./install.sh --check` (optionally with `--claude`/`--codex`) compares each
stamp and every installed script against this checkout and exits 1 on drift;
`/opencode:setup` runs the same check and warns. To update an install, `git pull`
this checkout and re-run `./install.sh`.

Agent config, server profiles, credentials, and the orchestration-script root
are covered in [Configuration](#configuration).

## Configuration

### Server profiles (`servers.json`)

Named server profiles live in `~/.config/opencode-dispatch/servers.json`. This
repository ships `config/servers.json.example`; keep your real definitions in
either place:

```bash
cp config/servers.json.example config/servers.json   # local copy, gitignored
$EDITOR config/servers.json                          # hosts, ports, passwords
./install.sh --claude                                # copies it to ~/.config/…
```

`install.sh` copies `config/servers.json` when it exists, otherwise
`config/servers.json.example`, and only when the installed file does not exist
yet — re-installs never overwrite it. Keys starting with `_` are documentation
and ignored. Each profile separates:

```text
listen      bind interface passed to `opencode serve --hostname`
            (127.0.0.1 | 0.0.0.0 | an interface IP)
host        addressable host the dispatcher reaches the server at
            (never 0.0.0.0/::; binding a non-loopback interface requires
            a password)
port        server port (default 4096)
dir         server working directory
            (absolute server-side path for remote profiles)
username    optional basic-auth username for this profile (default `opencode`)
password    optional basic-auth password for this profile
model       default provider/model for dispatch through this profile
```

Credentials are per address. A profile's `username`/`password` apply to that
profile; profiles without one use the top-level `credentials` map, keyed by
`host`, `host:port`, or a full URL.

The single `OPENCODE_SERVER_PASSWORD` / `OPENCODE_PASSWORD` value is only the
last-resort fallback for a profile with no keyed credential — it never
overrides an address-specific one.

Where each layer lives:

| Layer | Location | Scope |
| --- | --- | --- |
| profiles + top-level `credentials` map | `~/.config/opencode-dispatch/servers.json` (or `$OPENCODE_DISPATCH_SERVERS`) | persistent; `install.sh` seeds it from `config/servers.json.example` and never overwrites it |
| `OPENCODE_SERVER_CREDENTIALS` map, `OPENCODE_SERVER_USERNAME`, single password | `.env.local` next to the installed dispatch scripts (e.g. `~/.claude/scripts/.env.local`), or `$OPENCODE_DISPATCH_ENV_FILE` | persistent per install; exported variables win over the file |
| same variables exported in a shell | the invoking shell / process tree | that invocation only, unless placed in a shell profile |

The `credentials` map is a sibling of the profiles in `servers.json`, not a
field inside a profile:

```json
{
  "work": { "listen": "0.0.0.0", "host": "127.0.0.1", "port": 4096 },
  "credentials": { "127.0.0.1:4096": "local-pw" }
}
```

A profile's own `username`/`password` is also valid and takes precedence over
the map. The single `OPENCODE_SERVER_PASSWORD` only applies to profiles whose
address has no keyed or profile credential.

The bind address (`listen`) and the connection address (`host`) are separate
on purpose. Credentials are keyed by the **connection** address: a profile that
binds `0.0.0.0` but sets `host: "127.0.0.1"` uses the `127.0.0.1` credential;
the same bind with `host: "192.0.2.50"` uses that address's credential.
`0.0.0.0`/`::` are never valid connection addresses, so a wildcard bind without
an explicit `host` is refused rather than guessed. `localhost` and `127.0.0.1`
are treated as the same loopback credential key.

`--server <name>` (or `$OPENCODE_DISPATCH_SERVER`, or `serve <name>`) selects a
profile; per-field precedence is CLI flag > env (`OPENCODE_DISPATCH_*`) >
definition. If `--host` (or `OPENCODE_DISPATCH_HOST`) exactly matches a profile's
host and port and no profile name was selected, that profile supplies its
directory, credentials, API pin, and model. Default profile: `default`
(127.0.0.1:4096) — the single-server behavior when no definitions file exists.

Two optional fields tune the server generation (see
[COMPATIBILITY.md](COMPATIBILITY.md)):

```text
api         API dialect pin: auto (default; probe the server) | v1 | v2
bin         opencode client binary paired with THIS profile's generation
            (per-profile; default: `opencode` on PATH)
```

`setup` shows each profile's live dialect and the resolved profile's binary
pairing status.

### Agent model resolution

A per-agent `model` in `opencode.json` is honored on both generations. Run
modes resolve the selected agent's effective model through the client binary's
normalized `opencode debug config` output and send it explicitly when the
session is created/submitted (v2 otherwise leaves the session model empty and
falls back to the server default). Precedence:

1. `--model` / `OPENCODE_DISPATCH_MODEL` (explicit)
2. the selected agent's `model` from `opencode.json`
3. the profile's `model` default

`--effort` / `--variant` override the agent's configured variant. If the binary
does not support `debug config` (older v1) or the config cannot be read, the
dispatcher leaves the model unset and relies on the server's own resolution.

### Credentials (`.env.local`)

```bash
cp .env.local.example .env.local    # gitignored; install.sh copies it next
$EDITOR .env.local                  # to the installed scripts
```

`.env.local` accepts `OPENCODE_SERVER_USERNAME`, the password names
`OPENCODE_SERVER_PASSWORD` / `OPENCODE_PASSWORD` (one slot), and
`OPENCODE_SERVER_CREDENTIALS` — an object keyed by `host`, `host:port`, or a
full URL. An exported shell variable always wins over the file, and the v1/v2
password names share one slot (neither file value overrides an exported
variable under the other name).

`OPENCODE_SERVER_CREDENTIALS` accepts JSON and the JavaScript-style form used
by older instructions (unquoted keys and values):

```bash
OPENCODE_SERVER_CREDENTIALS='{127.0.0.1:4096:{password:"secret"}}'
OPENCODE_SERVER_CREDENTIALS='{127.0.0.1:4096:{username:me,password:secret}}'
OPENCODE_SERVER_CREDENTIALS='{127.0.0.1:4096:secret}'
```

Both forms are parsed by one shared parser, so the dispatcher, profile
resolver, prune script, and tests accept the same syntax. Quote a password that
contains a comma, closing brace, or trailing whitespace.

Resolution for each request is by the address actually used:

1. `OPENCODE_SERVER_CREDENTIALS` (environment or `.env.local`),
2. the selected profile's `username`/`password`,
3. the `credentials` map in `servers.json`,
4. the single `OPENCODE_SERVER_PASSWORD` / `OPENCODE_PASSWORD` fallback.

The winning pair authenticates the server, and only that pair is exported to
each launched client/helper (under the names its dialect reads), so server and
clients always share one credential. A private `opencode serve` started by the
dispatcher receives the same resolved pair (both dialect names), so it cannot
start with a credential different from the clients it serves. Binding a
non-loopback interface requires a credential for that address.

### Agent config (`opencode.json`)

Agent configs go in `~/.config/opencode/opencode.json` under the `agent` key
(opencode also reads project-level `./opencode.json`, which overrides the
global one). This repo ships a working sample in `config/opencode.json` — the
`build`, `review`, and `auto` agents it defines are what the `/opencode:*`
commands rely on. The installer copies it to `~/.config/opencode/opencode.json`
only when no config exists there yet; it never modifies it beyond that
copy-if-absent step. Manage it by hand or with `/opencode:model`; restart the
server for changes to take effect.

### OpenCode Go usage

Run `node scripts/opencode-go-usage.mjs` to print the rolling, weekly, and
monthly Go usage percentages. It gathers `OPENCODE_GO_API_KEYS` and
`OPENCODE_API_KEY` from the shell, `.env.local`, or `.env` (shell values win;
`.env.local` wins over `.env`), Go provider keys from
`~/.config/opencode/opencode.json` or `opencode.jsonc`, and Go credentials from
OpenCode's legacy auth file or SQLite credential store. Duplicate keys are
checked once, and the script never prints key values.

The module can also be imported without running the CLI. It exports
`getOpenCodeGoUsage(apiKey)`, `getOpenCodeGoUsages(apiKeys)`, and
`getConfiguredOpenCodeGoUsages()`. Each returns numeric `rolling`, `weekly`,
and `monthly` percentages; the configured variant also includes credential
source labels but never returns key values.

### Orchestration scripts

Only `task` and `bulk` need the launcher scripts. `install.sh` installs them
next to `opencode-dispatch.sh`, and the wrapper looks in its own directory by
default, so no setup is needed. Run `./install.sh --check` (profile scope) to
see whether the installed copy has drifted from this checkout (it compares the
install stamp `.opencode-dispatch-install.json` and every script byte for
byte); re-run `./install.sh` to update. `OPENCODE_ORCHESTRATION_ROOT` remains
as an override for a trusted alternative location.

### Agent launcher scripts

Standalone commands (run from the source worktree of the target repo, or
pass `--from <path>`):

| Command | Purpose |
| --- | --- |
| `node <scripts>/spawn-agent.mjs [--remote] [--project <id\|name\|path>] [--label n] [--base ref] [--bootstrap-cmd cmd] [--no-bootstrap] [--prepare-only\|--dry-run] -- <prompt>` | Allocate a task. Local mode uses a locked local worktree and attached worker; `--remote` resolves a server project, creates its v2 worktree, runs bootstrap, then submits directly to the remote session. Remote worktrees default to a uniquely named sibling directory beside the project; use `--worktree-root` to choose a server-side root. |
| `node <scripts>/agent-status.mjs [--task <id>] [--json]` | Read-only report of local or remote task and server-session state. |
| `node <scripts>/agent-cleanup.mjs --task <id> [--dry-run] [--delete-branch] [--force]` | Fail-closed stop/remove/archive of one local or remote task. Remote cleanup uses the server API; remote branch deletion is not available. |
| `node <scripts>/agent-worker-guard.mjs --metadata <task.json>` | Preflight assertion of repository, path, branch, and record. |

Run `spawn-agent.mjs --help` for every flag.

#### Per-repo bootstrap hook

After the child worktree is created, `spawn-agent.mjs` runs one shell command in
it (cwd = the child worktree) before creating the task session. The command is
chosen by, in order:

1. `--bootstrap-cmd "<cmd>"`
2. the `bootstrap` string in `<source repo>/.opencode-dispatch.json`:

   ```json
   { "bootstrap": "node scripts/agent/bootstrap-worktree.mjs" }
   ```
3. otherwise no bootstrap runs.

`--no-bootstrap` disables this dispatcher hook. The command receives task id,
worktree path, and branch in `AGENT_*`, plus `WORKTREE_TASK_ID`,
`WORKTREE_SOURCE_PATH`, `WORKTREE_ORIGIN=spawned-agent`,
`WORKTREE_BOOTSTRAP_CHILD=0`, and `WORKTREE_SESSION_START=0`. A non-zero exit
rolls the task back. For local workers, the config file is read from the source
checkout (falling back to the primary repository root for a linked worktree).
For remote workers, the launcher reads it through the server filesystem API and
runs it through the server shell API, so the dispatcher does not need SSH
access. The remote worktree API also runs OpenCode's project `commands.start`
hook during creation; `.opencode-dispatch.json` runs afterward and before the
session is created. A remote bootstrap failure triggers worktree cleanup and
prevents session creation. A remote hook receives an empty `AGENT_METADATA_PATH`
because its task record is local; `OPENCODE_SESSION_ID` is empty in both modes
because the hook runs before the session exists. `--no-bootstrap` does not skip
the OpenCode `commands.start` hook that the remote worktree API runs during
creation. Treat the config as repo-controlled shell.

The hook runs **in the child worktree**, which contains tracked files only. A
command that references an untracked script (for example
`node scripts/agent/bootstrap-worktree.mjs`) fails there even if the script
exists in your source checkout: commit it, or pass `--bootstrap-cmd` with an
absolute path. `/opencode:task` forwards `--bootstrap-cmd` and prints the
resolved hook (or `(none)`) in its started block, and `spawn-agent` reports
`bootstrap: <cmd>` / `bootstrap: ok` / a failure with the command's stderr on
stderr.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `OPENCODE_ORCHESTRATION_ROOT` | Directory containing the orchestration scripts. |
| `OPENCODE_SERVER_URL` | Existing persistent server URL for direct launcher use. |
| `OPENCODE_DISPATCH_HOST` / `OPENCODE_DISPATCH_PORT` | Dispatch server endpoint parts (override the resolved profile). |
| `OPENCODE_DISPATCH_LISTEN` | Bind interface override for launches (same as `--listen`). |
| `OPENCODE_DISPATCH_SERVER` | Server profile name (default `default`; same as `--server`). |
| `OPENCODE_DISPATCH_API` | Server API dialect override (`auto` default; `v1` or `v2`; same as `--api`). |
| `OPENCODE_DISPATCH_SERVERS` | Server definitions file (default `~/.config/opencode-dispatch/servers.json`). |
| `OPENCODE_SERVER_PASSWORD` | Fallback password for profiles with no address-keyed credential; the v1 name (still read by v2 clients); exported to launched clients. |
| `OPENCODE_PASSWORD` | v2 name for the same fallback password slot (preferred by v2 clients). |
| `OPENCODE_SERVER_CREDENTIALS` | Credential object keyed by `host`, `host:port`, or URL; accepts JSON and the JavaScript-style `{host:port:{password:pw}}` form. Overrides `servers.json` and profile fields. |
| `OPENCODE_SERVER_USERNAME` | Fallback v1 basic-auth username (default `opencode`); v2 fixes the username to `opencode`. |
| `OPENCODE_DISPATCH_ENV_FILE` | Explicit path to a `.env.local`-style credential file. |
| `OPENCODE_GO_API_KEYS` | Optional comma/space-separated list (or JSON array) of Go API keys for `scripts/opencode-go-usage.mjs`; exact duplicates are checked once. |
| `OPENCODE_API_KEY` | Optional single Go API key for `scripts/opencode-go-usage.mjs`; `.env.local` overrides `.env`, while an exported shell value wins over both. |
| `OPENCODE_SESSION_ID` / `_SLUG` / `_TITLE` / `_AGENT` / `_MODEL` / `_DIRECTORY` | The **executing** session's own identity, injected into every tool shell by the `opencode-identity` plugin (`plugins/opencode-identity.js`, installed to `~/.config/opencode/plugins/`). Parents and subagents each see their own id — the basis for `identify` / `claim`. |
| `OPENCODE_STALENESS_FETCH_TTL` / `OPENCODE_STALENESS_NUDGE_AT` / `OPENCODE_STALENESS_HOT_PATHS` | Tuning for the `opencode-branch-staleness` plugin: seconds between real `git fetch`es (default 300), commits-behind threshold for escalated wording (default 25), and optional comma-separated paths whose changes are called out explicitly. |
| `OPENCODE_DISPATCH_MODEL` | Default `provider/model` for dispatch. |
| `AGENT_WORKTREE_ROOT` | Generic allocation root. |
| `OPENCODE_DISPATCH_REMOTE_WORKTREE_ROOT` | Optional absolute worktree root on the remote server; local `AGENT_WORKTREE_ROOT` is not reused remotely. |
| `AGENT_REGISTRY_ROOT` | Override the worker registry directory (used by the launcher and the session pruner). |
| `AGENT_BRANCH_PREFIX` | Generic worker branch prefix. |
| `AGENT_LOCK_TIMEOUT_MS` | Allocation lock wait timeout. |
| `OPENCODE_DISPATCH_STALL_SECS` | Default `--background` inactivity threshold; `0` disables it. |

The local child launcher also passes task metadata to the worker through
`AGENT_TASK_ID`, `AGENT_WORKTREE_PATH`, `AGENT_WORKTREE_BRANCH`,
`AGENT_METADATA_PATH`, `OPENCODE_SESSION_ID`, and `OPENCODE_SERVER_URL`.

## One-server execution model

Run one `opencode serve` on each host that will run OpenCode work. Session
control modes (`ask`, `send`, `status`, `history`, `follow`, and related
commands) use the server API and pass `--dir` as an absolute path on that
server. The dispatcher does not resolve relative paths against a projects root.
A profile's `dir` is the default remote project path; otherwise pass `--dir`
explicitly. It must name a project the server knows.

Local `task`/`bulk` workers use a local Git worktree and an attached client.
With a remote profile, they instead ask an OpenCode v2 server to create a native
remote worktree, then submit the task to a session rooted there. The worker's
tools therefore read and edit the remote files. Remote `review` also runs its
Git or GitHub diff command on the server. `--direct` is local-only. Remote
`task`/`bulk` require the server's v2 worktree API; v1 servers continue to
support remote session-control and read-only run modes. Remote endpoints do not
support `serve` process start/stop/restart, `--direct`, or dispatcher-side
`identify <sessionID>`. `claim`/`release` use local claim files and need a shared
`CLAIM_ROOT` to coordinate with remote work. Remote `task`/`bulk` also depend on
the server's worktree capability, and remote `review --pr` needs `gh` plus GitHub
authentication on the server. See [COMPATIBILITY.md](COMPATIBILITY.md#remote-endpoint-limits)
for the complete list.

Profiles are named definitions in `~/.config/opencode-dispatch/servers.json`
(see [Configuration](#configuration)). Each profile separates the **bind
interface** (`listen`, passed to `opencode serve --hostname`) from the
**addressable host** the dispatcher reaches it at (`host`); `--server <name>`
(or `$OPENCODE_DISPATCH_SERVER`, or `serve <name>`) selects one. Default:
`default` (127.0.0.1:4096).

Start or verify a profile with:

```text
/opencode:serve [pro]
```

Stop it with `/opencode:serve pro --stop`, or restart it with
`/opencode:serve pro --restart` — restart reuses the exact arguments that
profile's server was last started with (recorded per profile at launch),
overridden by any flags passed now (e.g. `/opencode:serve --restart --port
5000`). Restarting is how config changes in
`~/.config/opencode/opencode.json` take effect. Stop/restart are local
operations (they use `lsof`); a remote profile is managed on the machine it
runs on. `/opencode:setup` lists every profile with live UP/down state.

If a server is already running for the profile, do not start another server for
each worktree. The wrapper can start a server when the endpoint is local; for a
remote endpoint, start or reconnect the server on that host. `serve --stop` and
`serve --restart` manage only servers on the current machine.

## Claude slash commands

| Command | Behavior |
| --- | --- |
| `/opencode:review [--base <ref>] [--pr <n>] [--repo <owner/repo>]` | Read-only review of a local diff or GitHub PR diff. |
| `/opencode:plan <question>` | Read-only planning through the `plan` agent. |
| `/opencode:ask <question>` | Read-only question answering/drafting. |
| `/opencode:task <task>` | Allocates, bootstraps, and launches one isolated edit worker using agent `auto`. |
| `/opencode:bulk <task>` | Same isolated lifecycle, intended for background/batch work. |
| `/opencode:serve [--stop \| --restart [args]]` | Start, confirm, stop, or restart (same args, overridable) the one persistent server. |
| `/opencode:sessions` | List server sessions. |
| `/opencode:status <session> \| --task <task>` | Show liveness and server state. |
| `/opencode:follow <session> \| --task <task>` | Read-only watch on a running session: streams new output until the turn completes (sends nothing; `--timeout <N>` bounds the wait). |
| `/opencode:history <session> \| --task <task>` | Read a bounded transcript. |
| `/opencode:hangdiag [<session>]` | Diagnose why a session hung — stalled tool call, duration, permission ask (no arg: list recent sessions). |
| `/opencode:permissions` | List pending permission requests (parked asks). |
| `/opencode:allow <requestID> [--always]` | Approve a pending permission request, resuming its turn. |
| `/opencode:send <session> \| --task <task> <message>` | Send, steer, or queue a prompt. |
| `/opencode:abort <session> \| --task <task>` | Stop an active turn. |
| `/opencode:teardown --task <task> [--force]` | Remove a finished task: list leftover files (80 bytes of the first 5), delete the worktree, and delete the session's `session`/`event_sequence` DB rows. `task`/`bulk --teardown` does this automatically after a clean completion. |
| `/opencode:model overall \| --agent <name> \| --task <model> [--effort <name>] \| show` | Set the default model/effort overall, per agent, or for tasks by merging `~/.config/opencode/opencode.json` (never overwrites; takes effect after an opencode restart). |
| `/opencode:setup` | Show executable, server, auth, and model diagnostics. |
| `/opencode:identify` | Print this agent session's identity (session id, slug, agent, model, worktree) — from the `OPENCODE_SESSION_*` env injected by the opencode-identity plugin, with a DB fallback. |
| `/opencode:claim <unit>` | Atomically claim a unit of work keyed by this session's identity (exclusive create; exit 3 if taken). `release <unit>` removes an owner's claim. |

Use `--task <task-id>` after an isolated launch when you have the task record but
not the session ID. The lifecycle helper resolves the recorded session and exact
worktree path; it does not search arbitrary directories.

## Codex skills

`./install.sh --codex` generates one Codex skill per Claude command with
`scripts/sync-claude-commands-to-skills.ts --name-prefix=opencode` (needs Node
22.6+). Codex selects skills by description, so the same workflows are available
without slash syntax:

| Skill | Behavior |
| --- | --- |
| `opencode-review` | Read-only review of a local diff or GitHub PR diff. |
| `opencode-plan` | Read-only planning through the `plan` agent. |
| `opencode-ask` | Read-only question answering/drafting. |
| `opencode-task` | Allocates, bootstraps, and launches one isolated edit worker using agent `auto`. |
| `opencode-bulk` | Same isolated lifecycle, intended for background/batch work. |
| `opencode-serve` | Start, confirm, stop, or restart the one persistent server. |
| `opencode-sessions` | List server sessions. |
| `opencode-status` | Show liveness and server state. |
| `opencode-follow` | Read-only watch on a running session (sends nothing; `--timeout <N>` bounds the wait). |
| `opencode-history` | Read a bounded transcript. |
| `opencode-hangdiag` | Diagnose why a session hung — stalled tool call, duration, permission ask. |
| `opencode-permissions` | List pending permission requests (parked asks). |
| `opencode-allow` | Approve a pending permission request, resuming its turn. |
| `opencode-send` | Send, steer, or queue a prompt. |
| `opencode-abort` | Stop an active turn. |
| `opencode-model` | Set the default model/effort overall, per agent, or for tasks. |
| `opencode-setup` | Show executable, server, auth, and model diagnostics. |
| `opencode-identify` | Print this agent session's identity (session id, slug, agent, model, worktree). |
| `opencode-claim` | Atomically claim a unit of work keyed by this session's identity (`release <unit>` removes a claim). |

Codex-skill argument aliases:

```text
--background   background the job and wake on completion (the default)
--wait         foreground blocking wait (mutually exclusive; last one wins)
--effort       low|medium|high|xhigh|max maps to the provider's variant
--scope        auto|working-tree|branch selects what a review diffs
               (branch requires --base)
```

## Typical workflows

### Read-only review or plan

```text
/opencode:serve
/opencode:review --base main
/opencode:plan "Identify the safest migration sequence"
```

These modes may use the selected `--dir` for reading and session routing, but they
do not allocate an edit worktree.

### Isolated editing task

```text
/opencode:task "Implement the parser validation and tests"
```

The dispatch sequence is:

1. Confirm the source worktree and persistent server.
2. Reserve a unique task ID under the configured worktree root.
3. Create and lock one linked worktree and branch.
4. Run `bootstrap-worktree.mjs` in that child with `WORKTREE_ORIGIN=spawned-agent`.
5. Create or fork a server session with the exact child directory.
6. Reject a server response whose directory does not exactly match the child.
7. Run the worker guard from the child.
8. Launch `opencode run --attach ... --auto --dir <child> --session <id>`.

The command output includes the task ID, session ID, branch, worktree path, and
detached log path when applicable. Review the reported worktree's diff before
merging or copying changes elsewhere.

### Background batch

```text
/opencode:bulk "Update each affected package and add regression tests"
```

Launch one background command per independent task. Each task gets separate Git
state and a separate server session. Do not manually reuse a worktree path or
branch between invocations.

### Direct script invocation

The slash commands are wrappers. The same behavior is available directly:

```bash
printf '%s' "Implement the parser validation and tests" > /tmp/opencode-brief.txt
bash ~/.claude/scripts/opencode-dispatch.sh task \
  --orchestration-root "$PWD/scripts" \
  --prompt-file /tmp/opencode-brief.txt \
  --background
```

Dispatch arguments:

```text
opencode-dispatch.sh <mode> [arguments]

Run modes:
  review | plan | ask        read-only (no worktree allocation)
  task | bulk                edit-capable (isolated worker + worktree)

Run-mode flags:
  --server <name>            server profile (default: default)
  --model provider/model     model override
  --effort low|medium|high|xhigh|max
  --timeout <N>              wait bound in seconds (0 = unbounded)
  --wait                     foreground blocking wait
  --background               background job; wrapper waits (default)
  --follow                   bounded follow (300s default)
  --direct                   one-shot `opencode run` (read-only modes only)
  --dir <path>               session routing directory
  --prompt-file <path>       prompt source (alias: --brief)
  --orchestration-root <p>   spawn-agent.mjs + helpers (task/bulk)

Server selection:
  --port <N>                 server port (profile/env/default 4096)
  --host <addr>              addressable host (never 0.0.0.0/::)
  --listen <addr>            (serve) bind interface for `opencode serve`
  --stop | --restart         (serve) stop or restart the profile's server

Control modes:
  sessions | status | follow | history | send | abort | permissions | allow
  setup | identify | claim | release
  send: --steer injects into the running turn; --queue appends after it
```

For a remote host, `--dir` must be an absolute path interpreted on that host. If
`--host` and `--port` match a configured profile, its `dir` and credentials are
inherited; otherwise provide `--dir` and configure credentials for that address.
Add `--remote` when reaching a remote server through `localhost`, such as an SSH
tunnel.

For remote `task` and `bulk`, pass `--project <id|name|path>` to resolve a
project from the remote server's OpenCode project list. The launcher sends the
resolved canonical path to the worktree API, so you do not need to know the
server's filesystem layout. Select a different project on each invocation:

```sh
opencode-dispatch.sh task --server ideapad5 --project my-service "Add a health endpoint"
```

`--project` is task/bulk-only and cannot be combined with `--dir`; a profile's
`dir` remains the default when neither is given.

**`--background` is the default for every run mode** (`review`, `plan`, `ask`,
`task`, `bulk`). The job runs in the background on the persistent opencode
server (detached, no terminal); the wrapper then waits for the turn to complete,
prints the distilled result, and exits 0 (wake-on-complete). Launch the wrapper
as a background task and the harness wakes you on that exit — only the waiting
wrapper blocks, never the session. Pass `--wait` for a foreground blocking wait:
call the wrapper inline (not backgrounded) and the session itself blocks until
the turn completes, then the result prints. `--follow` waits for a bounded
period; `--background` returns the final result.

Plain positional prompt text is accepted too — it is written to a temp file at
launch and the script re-executes itself with `--prompt-file`, so the prompt
never stays in the process argv for the run (`--prompt-file` remains the
preferred, fully-clean path; the two are mutually exclusive). Positional
arguments are space-joined into one line — line breaks appear only when an
argument itself contains one.

`--direct` is the one-shot escape hatch: it invokes the opencode CLI directly
(a non-server `opencode run`, blocking, output inline) instead of creating a
session on the persistent server — so the run is unobservable and not killable.
It is reserved for read-only modes. Edit-capable `task` and `bulk` reject it
because a one-shot process would bypass task registration and worktree
ownership.

## Worktree and task lifecycle

The launcher scripts keep an ownership record for every worker. The record
contains the task ID, repository identity, branch, worktree path, server URL,
session ID, process ID, state, and log path. Credentials are not written to task
records.

The generic defaults are:

```text
worktree root:   ~/.local/share/agent-worktrees/<repository>/worktrees/<task-id>
branch prefix:   ai/agent/<task-id>
record registry: ~/.local/share/agent-worktrees/<repository>/registry/
```

Override the root and branch naming without changing scripts:

```bash
export AGENT_WORKTREE_ROOT=/absolute/path/to/agent-worktrees
export AGENT_BRANCH_PREFIX=ai/agent
```

Inspect a worker:

```bash
node scripts/agent-status.mjs --task <task-id> --json
```

Normal cleanup is fail-closed. It refuses active processes, active turns, dirty
worktrees, and uncertain server state:

```bash
node scripts/agent-cleanup.mjs --task <task-id> --dry-run
node scripts/agent-cleanup.mjs --task <task-id> --delete-branch
```

Use `--force` only after reviewing the worker's diff and confirming that no useful
changes remain. Forced cleanup aborts the session, terminates the process, removes
the worktree, optionally deletes the branch, and archives the ownership record.

### Teardown (worktree + database)

For a finished task whose leftovers you don't need, `--teardown` prints the files
left behind (status plus the first 80 bytes of the first 5), removes the worktree
even if dirty, and deletes the session from the OpenCode database (`session` and
`event_sequence`; `event`, `message` and `part` cascade). It still refuses while the
worker process or turn is active. Override the DB path with `--db` or `OPENCODE_DB`.

```bash
node scripts/agent-cleanup.mjs --task <task-id> --teardown      # direct
opencode-dispatch.sh teardown --task <task-id>                  # via the dispatcher
opencode-dispatch.sh task --teardown "…"                        # automatic, after a clean completion
```

**Conditions for teardown to proceed** (checked in order; any failure aborts with nothing removed):

1. The task is an isolated `task`/`bulk` worker with a registry record (`--task <id>`), in the
   same repository, whose worktree is a direct child of the managed worktree root and whose
   branch matches the record.
2. The worker process is not alive. If the recorded PID is still running (e.g. the client
   hasn't exited yet) teardown refuses; retry, or use `--force`, which aborts the session
   and kills the process, but only if the PID matches this session and worktree.
3. No turn is active, the OpenCode server is reachable (the record's server URL, or `--server`),
   and the server's session directory matches the worktree. An unreachable server counts as
   "state unknown" and refuses. `--force` bypasses these checks.
4. A dirty worktree is fine: that is exactly what the preview reports and then discards.
5. Session cleanup goes through the OpenCode server first: the native session delete
   removes the session's share, deletes its child (subagent) sessions, interrupts any
   active turn, and emits `session.deleted`. The direct SQL delete (needs the `sqlite3`
   CLI and an existing database file) is only a fallback when the server delete fails,
   and afterwards it verifies the rows are gone. Both the fallback and the verification
   run only while the configured server is local (a loopback address or one of this
   host's interface addresses) — with a remote server the session is deleted through it
   and local SQL cleanup is disabled. A cleanup failure never blocks removing the
   worktree; the result reports `database: NOT cleaned (<reason>)`.

Automatic teardown (`--teardown` on `task`/`bulk`) further requires `--background` or `--wait`
(the default) and a clean exit 0 from the turn. It is skipped with `--follow` or `--direct`,
and after a timeout (3), unreachable server (7), stall (8) or any other failure; the command
to run manually is printed instead.

Branch commits are kept unless `--delete-branch` is given to `agent-cleanup.mjs`.
Uncommitted work is **not** recoverable after teardown; have the worker commit first.

### Pruning old named sessions

OpenCode auto-names sessions with a suffix such as `agent — brave-canyon` or
`review PR #42 — calm-wizard`. To remove those older than 24 hours:

```bash
node scripts/prune-named-sessions.mjs                    # report only
node scripts/prune-named-sessions.mjs --apply            # delete
node scripts/prune-named-sessions.mjs --hours 48 --apply
```

Every match with an opencode-dispatch worker record is removed with
`teardown --task <id>` (worktree and session) and its JSON result is checked for
`database.deleted`; a teardown that reports the rows were not cleaned counts as
a failure. Sessions without a worker record (reviews, TUI sessions, subagents)
are removed with `teardown --session <id>`, which uses the native server delete
and its child-session cascade. The script is a dry run unless `--apply` is
passed; `--force` forwards teardown's force checks, and `--managed-only` leaves
unmanaged sessions alone.

Because the native delete cascades to child sessions, the script skips a
matching parent when any descendant is outside the selection (fresh, a
different title, the current session, or unmanaged under `--managed-only`).
`--cascade` explicitly allows that broader deletion. Custom registry layouts are
found through `AGENT_REGISTRY_ROOT` or `--registry-root`; if a worker's source
checkout is gone, the session is deleted without worktree cleanup and the result
is marked as a fallback. The suffix must match the session's `slug` when the
server supplies one, avoiding false positives such as `Fix bug — Windows-11`.

Server credentials come from the same environment as the dispatcher:
`OPENCODE_SERVER_USERNAME`, `OPENCODE_SERVER_PASSWORD` / `OPENCODE_PASSWORD`, and
`OPENCODE_SERVER_CREDENTIALS`. The script also loads those four keys from
`$OPENCODE_DISPATCH_ENV_FILE`, a `.env.local` next to the dispatcher or script,
or `~/.claude/scripts/.env.local`; exported variables always win.

## Safety rules

- Never pass the primary checkout as a worker worktree path.
- Never manually start an unattached `opencode` worker for an edit task.
- Never start a second OpenCode server merely to obtain a different worktree.
- Never reuse another task's branch, worktree path, task ID, or session ID.
- Workers start from the selected Git ref, not uncommitted source changes. Commit
  changes or choose a base ref when a worker needs those changes.
- Treat `--no-bootstrap` as a test/provisioning escape hatch, not a normal task
  option.
- Verify the reported branch and worktree before reviewing or merging changes.
- Stop/abort the worker before cleanup; use `--force` only as an explicit recovery
  action.
- Never pipe `opencode-dispatch.sh` output through `tail` (or any other
  truncation) — the scripts bound their own output, and tail can clip the
  distilled result. The installed PreToolUse hook blocks `| tail` and throws.
- Authenticate providers with `opencode auth login`; opencode stores credentials
  itself. Never put API keys in environment variables, prompts, task records,
  logs, or config files (`~/.config/opencode/opencode.json` included).

## Troubleshooting

### `isolated worker launcher not found`

The launcher is missing next to `opencode-dispatch.sh`: re-run `./install.sh`
(older installs did not copy it). `./install.sh --check` lists what is missing.
Or set `OPENCODE_ORCHESTRATION_ROOT` / pass `--orchestration-root <path>` to a
trusted directory containing `spawn-agent.mjs`.

### A worker does not include uncommitted source changes

This is expected: the worker starts from `--base` (default `HEAD`). Commit the
changes first or set `--base` to a commit that contains them if the worker needs
that code. The primary checkout's edits are left untouched.

### `directory mismatch`

Stop. The server returned a session rooted somewhere other than the allocated
worktree. The launcher should abort and roll back the new task. Inspect the server
health, task record, and worktree registry before retrying.

### A worker is still running

```text
/opencode:status --task <task-id>
/opencode:history --task <task-id> --turns 1
/opencode:abort --task <task-id>
```

Do not remove the worktree while the process or server turn is active.

### Provider authentication errors

Authenticate with `opencode auth login` (credentials are stored by opencode
itself — not in environment variables or config files). Auth state is read when
the server starts, so (re)authenticating while a server is already running does
not change that server's credentials: restart the persistent server after
logging in. Verify with `/opencode:setup` or `opencode auth list`.

### `| tail` on the dispatch script is blocked

The installed PreToolUse hook throws on any Bash command that pipes
`opencode-dispatch.sh` output through `tail`. This is intentional: the script
already bounds its own output (`--tail`/`--turns`/`--since` on history, the
distilled `--background` result), and piping through tail can clip the final result.
Rerun without the pipe and use the script's own flags instead. If you need the
hook gone, remove the `opencode-guard.sh` entry from the `PreToolUse` array in
`~/.claude/settings.json`.

## Known issues / follow-ups

Repo scope (`--scope repo`) is deliberately left at its original behaviour.
Known problems, to fix separately:

- **Credential copy into the repo:** `.env.local` (server credentials) is copied
  into `<repo>/.claude/scripts/`, where it can be committed.
- **Absolute hook paths:** the PreToolUse hook command written to
  `<repo>/.claude/settings.json` and `<repo>/.codex/hooks.json` is an absolute
  path on the installing machine, so a committed file is not portable.
- **Profile script paths in skills:** the slash commands and the generated
  Codex skills still call `$HOME/.claude/scripts/…`, so they do not use the
  repo-local copy. Repo scope has no stamp, drift check, or stale-file cleanup.

## Validation

Skill shell checks:

```bash
bash -n scripts/opencode-dispatch.sh scripts/opencode-set-model.sh scripts/opencode-guard.sh install.sh
```

Launcher checks (from this repository's root):

```bash
npm run check   # node --check on the launcher scripts
npm test        # node --test scripts/tests/*.test.mjs
```

The tests use temporary Git repositories and mocked server requests (covering
both v1 and v2 response shapes). They must not require, inspect, or modify
secret-bearing OpenCode configuration.
