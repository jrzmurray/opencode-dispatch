---
description: One-shot question via opencode (waits to completion; wakes on done)
argument-hint: '[--model provider/model] [--effort <name>] [--timeout <N>] [--follow] [--synchronous] <question>'
allowed-tools: Bash(bash:*), Bash(opencode:*), Read
---

Ask a repo-aware, read-only question on a cheap model. Runs server-backed and
**awaits completion**: blocks until the answer is ready, prints it, then exits
(waking the caller on that exit if it was backgrounded). No fixed give-up deadline.

Raw slash-command arguments:
`$ARGUMENTS`

Run:
```bash
bash "$HOME/.claude/scripts/opencode-dispatch.sh" ask --await $ARGUMENTS
```

Return the answer verbatim. `--await` exits non-zero only on turn error or an
unreachable server (else waits up to ~24h; `--timeout 0` = unbounded). `--follow` =
bounded 300s foreground wait; `--synchronous` = quick inline one-shot.
