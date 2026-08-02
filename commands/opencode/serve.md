---
description: Start (or confirm) a persistent local opencode server
argument-hint: '[--port <N>] [--host <addr>]'
allowed-tools: Bash(bash:*), Bash(opencode:*)
---

Ensure the single persistent `opencode serve` is running so sessions can be
created, continued, and read back on demand. Sessions are routed to individual
worktrees by directory; do not start one server per worker.

Raw slash-command arguments:
`$ARGUMENTS`

Run:
```bash
bash "$HOME/.claude/scripts/opencode-dispatch.sh" serve $ARGUMENTS
```

Default port is 4096 (override with `--port`, or `$OPENCODE_DISPATCH_PORT`).
Report the URL/pid/log from the output. The server stays bound to 127.0.0.1;
to secure a non-local bind, start it with `OPENCODE_SERVER_PASSWORD` set.
