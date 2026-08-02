# claude-skill-opencode

Delegate work from **Claude Code** to **opencode** running a cheaper model
(default **DeepSeek**) to cut token cost — one-shot reviews/tasks, fire-and-forget
batches, and readable persistent sessions — all from `/opencode:*` slash commands.

See **[DESIGN.md](DESIGN.md)** for the architecture, token economics, and the
inter-agent roadmap for a future MCP server.

## Layout

```
scripts/opencode-dispatch.sh   # the wrapper around `opencode` (the "companion")
commands/opencode/*.md         # Claude Code slash commands (/opencode:*)
config/opencode.json           # opencode provider + read-only `review` agent
install.sh                     # deploys the above into ~/.claude and ~/.config/opencode
```

This repo is the **source of truth**; `install.sh` copies into place.

## Install

Prereqs: `opencode` (`brew install sst/tap/opencode`) and a provider key.

```bash
./install.sh
```

Then authenticate a provider and confirm:

```bash
export DEEPSEEK_API_KEY=…            # add to your shell profile
```

```bash
/opencode:setup
```

> Export the key **before** starting the server — a server only inherits env at
> launch (see DESIGN.md §4).

## Commands

| Command | Purpose |
|---|---|
| `/opencode:review [--base <ref>]` | Read-only review of local git changes |
| `/opencode:task <desc>` | Agentic build task (may edit files) |
| `/opencode:plan <what>` | Read-only planning |
| `/opencode:ask <question>` | One-shot Q&A / drafting |
| `/opencode:bulk <desc>` | Fire-and-forget background batch |
| `/opencode:serve [--port N]` | Start/confirm a persistent server |
| `/opencode:sessions [--tail N]` | List sessions (newest first) |
| `/opencode:history <id> [--tail N\|--turns N\|--since 1d]` | Print a session transcript |
| `/opencode:status <id>` | Liveness: last activity, idle, working/idle (cheap) |
| `/opencode:send <id> <msg> [--wait\|--steer\|--queue]` | Message a session; steer/queue a running one |
| `/opencode:abort <id>` | Interrupt a stuck/runaway turn |
| `/opencode:setup` | Check install / auth / models |

### Execution model

Run modes (`review`/`plan`/`task`/`ask`/`bulk`) are **server-backed and async by
default**: they submit to the persistent server and hand back a session id you can
watch (`status`/`history`) and kill (`abort`). Nothing runs as an unobservable
one-shot, and nothing can hang indefinitely.

- `--follow [--timeout N]` — wait (bounded, default 300s) and print the reply
  inline, then leave the session available. The `review`/`plan`/`ask` commands use
  this so you still get results back; on timeout they return the id, still running.
- `--synchronous` — opt out of the server entirely: a one-shot, non-server,
  blocking `opencode run` (for quick/small asks). *Not* `--sync`.

Edit-capable `task` and `bulk` runs allocate and bootstrap a unique worktree, then
bind an attached `auto` worker session to that directory on the one persistent
server. Output includes the task ID, session ID, branch, and worktree path. Read-only
modes may use the current directory; editing modes never silently target the main
checkout. Use `--task <id>` with lifecycle commands when you have a task record.

Shared flags on run modes: `--model provider/model`, `--effort <name>` (→
opencode `--variant`), `--agent <name>`, `--dir <path>` (`--synchronous` only).

## Typical flow

```
/opencode:serve
/opencode:task "…"          # or drive the web UI at http://127.0.0.1:4096
/opencode:sessions          # find the id
/opencode:history <id> --turns 3
```

## Web UI

The local server serves a self-contained web UI at `http://127.0.0.1:4096/` that
renders in Claude Code's browser pane — handy for watching a delegate work.
