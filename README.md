# OpenCode delegation skill

This skill lets Claude Code delegate read-only analysis and isolated editing work
to OpenCode while keeping one persistent OpenCode server. It installs the
`/opencode:*` command set and a small dispatch wrapper; the repository's
orchestration scripts own worktree allocation, bootstrap, session registration,
and cleanup.

The safety invariant is simple: an edit-capable worker gets one uniquely allocated
Git worktree, one branch, one task record, and one directory-bound OpenCode
session. Workers never edit the primary checkout or another worker's worktree by
default.

See [DESIGN.md](DESIGN.md) for the delegation architecture and the orchestration
repository's `scripts/README.md` for the launcher and worker-script reference.

## What is installed

| Source | Installed location | Role |
| --- | --- | --- |
| `scripts/opencode-dispatch.sh` | `~/.claude/scripts/opencode-dispatch.sh` | Parses command flags, talks to the persistent server, and delegates edit tasks to `spawn-agent.mjs`. |
| `commands/opencode/*.md` | `~/.claude/commands/opencode/` | Claude Code slash-command instructions. |
| `install.sh` | not installed | Installs the two surfaces above. It deliberately does not read or write `opencode.json`. |
| Repository orchestration scripts | `<repository>/scripts/` or `OPENCODE_ORCHESTRATION_ROOT` | Allocates worktrees, bootstraps children, verifies sessions, reports status, and cleans up. |

The skill repository is not the worker repository. The dispatch script discovers
the orchestration scripts from `<--dir>/scripts` by default. If the skill is
installed globally or the current repository stores the scripts elsewhere, set
`OPENCODE_ORCHESTRATION_ROOT` or pass `--orchestration-root <path>`.

## Prerequisites

- Claude Code with support for installed slash commands.
- OpenCode on `PATH` (`brew install sst/tap/opencode` or the installation method
  appropriate to your system).
- Node.js with built-in `fetch` support (Node 18+; Node 20+ recommended).
- A clean source worktree for every edit task. Uncommitted source changes are not
  copied into a new worker worktree.
- The repository's orchestration scripts, including:
  `spawn-agent.mjs`, `bootstrap-worktree.mjs`, `worktree-utils.mjs`,
  `opencode-server.mjs`, `agent-worker-guard.mjs`, `agent-status.mjs`, and
  `agent-cleanup.mjs`.
- A configured OpenCode provider and credentials in the environment inherited by
  the server. Start the server only after exporting provider credentials.

## Installation

From this skill repository:

```bash
./install.sh
```

The installer copies the dispatch script and slash commands into the Claude
directory selected by `$CLAUDE_HOME` (default `~/.claude`). It never inspects,
backs up, merges, or overwrites an existing OpenCode configuration file. Manage
OpenCode configuration separately through the normal OpenCode tooling.

If the orchestration scripts are in the current project checkout, no additional
setting is required. Otherwise point the installed skill at them:

```bash
export OPENCODE_ORCHESTRATION_ROOT=/absolute/path/to/repository/scripts
```

The value must contain `spawn-agent.mjs` and the other lifecycle helpers. Keep it
on a trusted local filesystem; it is executable orchestration code.

## One-server execution model

Run exactly one local `opencode serve` for the server/port used by the skill. The
server is a session broker, not the ownership boundary. Each session receives an
explicit `directory=<worktree>` query, so multiple workers can share the server
without sharing a checkout.

Start or verify it with:

```text
/opencode:serve
```

The default endpoint is `http://127.0.0.1:4096`. Override it with:

```bash
export OPENCODE_DISPATCH_HOST=127.0.0.1
export OPENCODE_DISPATCH_PORT=4096
export OPENCODE_SERVER_URL=http://127.0.0.1:4096
```

If the server is already running, do not start another server for each worktree.
If no server is reachable, the dispatch wrapper may start one at the configured
endpoint; it still routes each created session to its explicit directory.

## Slash commands

| Command | Behavior |
| --- | --- |
| `/opencode:review [--base <ref>]` | Read-only review of a local diff or GitHub PR diff. |
| `/opencode:plan <question>` | Read-only planning through the `plan` agent. |
| `/opencode:ask <question>` | Read-only question answering/drafting. |
| `/opencode:task <task>` | Allocates, bootstraps, and launches one isolated edit worker using agent `auto`. |
| `/opencode:bulk <task>` | Same isolated lifecycle, intended for background/batch work. |
| `/opencode:serve` | Start or confirm the one persistent server. |
| `/opencode:sessions` | List server sessions. |
| `/opencode:status <session> \| --task <task>` | Show liveness and server state. |
| `/opencode:history <session> \| --task <task>` | Read a bounded transcript. |
| `/opencode:send <session> \| --task <task> <message>` | Send, steer, or queue a prompt. |
| `/opencode:abort <session> \| --task <task>` | Stop an active turn. |
| `/opencode:setup` | Show executable, server, auth, and model diagnostics. |

Use `--task <task-id>` after an isolated launch when you have the task record but
not the session ID. The lifecycle helper resolves the recorded session and exact
worktree path; it does not search arbitrary directories.

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
bash ~/.claude/scripts/opencode-dispatch.sh task \
  --orchestration-root "$PWD/scripts" \
  --await --summarize \
  "Implement the parser validation and tests"
```

For a worker that should return immediately after allocation/launch, omit
`--await`. `--follow` waits for a bounded period; `--await` waits for completion
and returns the final result (or a server-side summary with `--summarize`).

`--synchronous` is reserved for read-only modes. Edit-capable `task` and `bulk`
reject it because a one-shot process would bypass task registration and worktree
ownership.

## Worktree and task lifecycle

The orchestration scripts keep an ownership record for every worker. The record
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

## Safety rules

- Never pass the primary checkout as a worker worktree path.
- Never manually start an unattached `opencode` worker for an edit task.
- Never start a second OpenCode server merely to obtain a different worktree.
- Never reuse another task's branch, worktree path, task ID, or session ID.
- Keep source clean before allocation; the child starts from the selected Git ref,
  not uncommitted source changes.
- Treat `--no-bootstrap` as a test/provisioning escape hatch, not a normal task
  option.
- Verify the reported branch and worktree before reviewing or merging changes.
- Stop/abort the worker before cleanup; use `--force` only as an explicit recovery
  action.
- Keep provider credentials in the environment or approved OpenCode tooling; do
  not put them in prompts, task records, logs, or documentation.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `OPENCODE_ORCHESTRATION_ROOT` | Directory containing the orchestration scripts. |
| `OPENCODE_SERVER_URL` | Existing persistent server URL for direct launcher use. |
| `OPENCODE_DISPATCH_HOST` / `OPENCODE_DISPATCH_PORT` | Dispatch server endpoint parts. |
| `OPENCODE_SERVER_PASSWORD` | Optional server password consumed by HTTP requests. |
| `OPENCODE_DISPATCH_MODEL` | Default `provider/model` for dispatch. |
| `AGENT_WORKTREE_ROOT` | Generic allocation root. |
| `AGENT_BRANCH_PREFIX` | Generic worker branch prefix. |
| `AGENT_LOCK_TIMEOUT_MS` | Allocation lock wait timeout. |
| `OPENCODE_DISPATCH_STALL_SECS` | Default `--await` inactivity threshold; `0` disables it. |

The child launcher also passes task metadata to the worker through
`AGENT_TASK_ID`, `AGENT_WORKTREE_PATH`, `AGENT_WORKTREE_BRANCH`,
`AGENT_METADATA_PATH`, `OPENCODE_SESSION_ID`, and `OPENCODE_SERVER_URL`.

## Troubleshooting

### `isolated worker launcher not found`

Set `OPENCODE_ORCHESTRATION_ROOT` to the directory containing `spawn-agent.mjs`,
or pass `--orchestration-root /absolute/path/to/scripts`. Confirm that the path is
the same trusted checkout whose scripts you reviewed.

### `source worktree is dirty`

Commit or stash the source changes before launching an edit task. The launcher
does not copy uncommitted changes into a child. If the source is intentionally
dirty, create a controlled worktree yourself and use the normal bootstrap path;
do not bypass task ownership casually.

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

Export credentials before starting the persistent server. Restarting the client
does not change the environment inherited by an already-running server.

## Validation

Skill shell checks:

```bash
bash -n scripts/opencode-dispatch.sh install.sh
```

Orchestration checks, from the application checkout containing the scripts:

```bash
node --check scripts/spawn-agent.mjs
node --test scripts/agent-worktree.test.mjs
```

The tests use temporary Git repositories and mocked server requests. They must not
require, inspect, or modify secret-bearing OpenCode configuration.
