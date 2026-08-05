---
description: Analyze code and produce a plan via opencode (waits to completion; wakes on done)
argument-hint: '[--model provider/model] [--effort <name>] [--timeout <N>] [--follow] [--synchronous] <what to plan>'
allowed-tools: Bash(bash:*), Bash(opencode:*), Read
---

Read-only planning/analysis on a cheap model. Runs server-backed and **awaits
completion**: blocks until the turn finishes, prints the result, then exits (waking
the caller on that exit if it was backgrounded). No fixed give-up deadline.

Raw slash-command arguments:
`$ARGUMENTS`

Run:
```bash
bash "$HOME/.claude/scripts/opencode-dispatch.sh" plan --await $ARGUMENTS
```

Return the output verbatim. `--await` exits non-zero only on turn error or an
unreachable server (else waits up to ~24h; `--timeout 0` = unbounded). `--follow` =
bounded 300s foreground wait; `--synchronous` = quick inline one-shot.
