---
description: Liveness of an opencode session — parked asks, running tool, working/idle
argument-hint: '[<sessionID> | --task <taskID>] [--server <name>] [--port <N>]'
allowed-tools: Bash(bash:*), Bash(opencode:*)
---

Cheap liveness check for a session (no full transcript pulled): model, message
count, cost, last-activity time + how long ago, and the turn state. Use this to
tell if a long-running delegate is still working, parked on a prompt, or stuck.
For isolated workers, `--task <taskID>` resolves the recorded session safely.
`--server <name>` checks the session on another server profile (default
`default`).

State detection (all verified on opencode 1.18.9):
- **`PERMASK` / `WORKING — PERMISSION PROMPT (per_… …)`** — the session is parked
  on a permission ask (from `GET /permission`); approve with `/opencode:allow
  <requestID> [--always]`.
- **`QUESTION` / `WORKING — QUESTION ASK (que_… …)`** — parked on a `question`
  tool ask (from `GET /question`); no reply path on a headless server — abort.
- **`WORKING — TOOL RUNNING (<tool> · Nm, no ask in queue)`** — a turn is in
  progress with a tool call stuck in `running`. The ask queues are in-memory
  and die with a server restart while the session stays stuck, so this durable
  signal names the stuck-ness even after the queue is gone.
- **`STALE` / `WORKING — STALE`** — working flag with a frozen `updated` for
  >30m; likely a dead turn — `/opencode:abort <id>`.
- `idle` — turn completed or no turn running.

The no-argument list view probes each shown session's last message (one small
request each) so it reports `PERMASK`/`QUESTION`/`WORKING`/`STALE` accurately —
opencode's session JSON has no `lastMessage` in 1.18.x, so list state cannot
come from the list itself.

**Prefer this over `/opencode:history` when you only want to know if a session is
active.** `status` costs a few lines; `history` dumps the whole transcript into
context. Run `status` first; only pull `history` when you actually want the
content.

Raw slash-command arguments:
`$ARGUMENTS`

Run:
```bash
bash "$HOME/.claude/scripts/opencode-dispatch.sh" status $ARGUMENTS
```

Return the output verbatim. If the state names a permission prompt (`PERMASK` /
`WORKING — PERMISSION PROMPT`), approve it with `/opencode:allow <requestID>`
and the turn resumes. `QUESTION` asks and `STALE`/`TOOL RUNNING` states have no
approval path — `/opencode:abort <id>`.

**Never pipe this command's output through `tail`** — the installed PreToolUse
hook blocks it; `status` is already a few lines.
