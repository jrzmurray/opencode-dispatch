---
description: Liveness of an opencode session — last activity, idle duration, working/idle
argument-hint: '[<sessionID> | --task <taskID>] [--port <N>]'
allowed-tools: Bash(bash:*), Bash(opencode:*)
---

Cheap liveness check for a session (no transcript pulled): model, message count,
cost, last-activity time + how long ago, and whether a turn is currently in
progress. Use this to tell if a long-running delegate is still working or stuck.
For isolated workers, `--task <taskID>` resolves the recorded session safely.

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

Return the output verbatim. If `state: WORKING` but `updated` was a long time ago,
the turn may be stuck — consider `/opencode:abort <id>`.
