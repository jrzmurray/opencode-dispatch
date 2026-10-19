---
description: List opencode sessions from the running server (assumes server up)
argument-hint: '[--tail <N>] [--server <name>] [--port <N>] [--host <addr>]'
allowed-tools: Bash(bash:*), Bash(opencode:*)
---

List sessions from a running opencode server, newest first (id, last-updated,
title). Assumes the server is up — if not, start it with `/opencode:serve`.
`--server <name>` lists sessions on another server profile (default `default`).

Raw slash-command arguments:
`$ARGUMENTS`

Run:
```bash
bash "$HOME/.claude/scripts/opencode-dispatch.sh" sessions $ARGUMENTS
```

Return the output verbatim. `--tail N` caps how many recent sessions are shown
(default 50). Use a session id from here with `/opencode:history <id>`.

**Never pipe this command's output through `tail`** — the installed PreToolUse
hook blocks it; use the script's own `--tail` flag instead.
