---
description: Remove a finished opencode task — worktree and session database rows
argument-hint: '--task <taskID> [--force]'
allowed-tools: Bash(bash:*), Bash(opencode:*)
---

Tear down a completed isolated task. First prints the files left behind in its
worktree (first 80 bytes of the first 5), then deletes the worktree and the
session's rows in the OpenCode database (`session` + `event_sequence`).
Refuses unless the worker process has exited, no turn is active, and the server
is reachable with a matching session directory (`--force` bypasses these).
The DB step needs `sqlite3` and the database file; if missing, the worktree is
still removed and the DB is reported as not cleaned.

To do this automatically, pass `--teardown` to `task`/`bulk` (with
`--background`/`--wait`); it runs only after a clean completion.

Raw slash-command arguments:
`$ARGUMENTS`

Run:
```bash
bash "$HOME/.claude/scripts/opencode-dispatch.sh" teardown $ARGUMENTS
```
