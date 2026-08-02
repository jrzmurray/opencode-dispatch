---
description: Message an existing opencode session (blocking reply, or steer/queue)
argument-hint: '[<sessionID> | --task <taskID>] <message> [--wait|--steer|--queue] [--port <N>]'
allowed-tools: Bash(bash:*), Bash(opencode:*)
---

Send a message to an existing session and keep its context. Use `--task` to
resolve an isolated worker record instead of supplying its session ID.

Raw slash-command arguments:
`$ARGUMENTS`

Run:
```bash
bash "$HOME/.claude/scripts/opencode-dispatch.sh" send $ARGUMENTS
```

Delivery:
- `--wait` (default) — block for the reply and return it. This returns real
  content into Claude's context, so keep the ask tight.
- `--steer` — inject into the turn already in progress.
- `--queue` — append to run after the current turn.

`--steer`/`--queue` return an admission record, not the reply — then read the
result with `/opencode:status <id>` and `/opencode:history <id> --turns 1`.
