---
description: Interrupt the in-progress turn of an opencode session
argument-hint: '[<sessionID> | --task <taskID>] [--server <name>] [--port <N>]'
allowed-tools: Bash(bash:*), Bash(opencode:*)
---

Stop a session's current turn — the escape hatch for a runaway/stuck delegate.
Use `--task` to resolve an isolated worker record.

Raw slash-command arguments:
`$ARGUMENTS`

Run:
```bash
bash "$HOME/.claude/scripts/opencode-dispatch.sh" abort $ARGUMENTS
```

**Never pipe this command's output through `tail`** — the installed PreToolUse
hook blocks it; the output is already one line.
