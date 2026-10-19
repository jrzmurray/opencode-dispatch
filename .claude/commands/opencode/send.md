---
description: Message an existing opencode session (blocking reply, or steer/queue)
argument-hint: '[<sessionID> | --task <taskID>] <message> [--wait|--follow|--steer|--queue] [--server <name>] [--port <N>]'
allowed-tools: Bash(bash:*), Bash(opencode:*)
---

Send a message to an existing session and keep its context. Use `--task` to
resolve an isolated worker record instead of supplying its session ID. The
message may be plain positional text or `--prompt-file <path>` (preferred) —
plain text is auto-converted to a prompt file at launch, so it never stays in
the process argv for the run.

Raw slash-command arguments:
`$ARGUMENTS`

Run:
```bash
bash "$HOME/.claude/scripts/opencode-dispatch.sh" send $ARGUMENTS
```

Delivery:
- Default — follow the turn (300s bounded; `--timeout <N>` tunes it) and return
  the reply. This returns real content into Claude's context, so keep the ask
  tight.
- `--follow` — explicit form of the default bounded follow.
- `--wait` — same completion loop with the ~24h backstop (blocks to done).
- `--steer` — inject into the turn already in progress.
- `--queue` — append to run after the current turn.

`--steer`/`--queue` return an admission record, not the reply — then read the
result with `/opencode:status <id>` and `/opencode:history <id> --turns 1`.

**Never pipe this command's output through `tail`** — the installed PreToolUse
hook blocks it; the reply is already the distilled result.
