---
description: Remove a finished opencode task — worktree and session database rows
argument-hint: '--task <taskID> [--force]'
allowed-tools: Bash(bash:*), Bash(opencode:*)
---

Tear down a completed isolated task. First prints the files left behind in its
worktree (first 80 bytes of the first 5), asks the OpenCode server to delete the
session through its native API (removes the session's share, deletes child
sessions, interrupts any active turn), then removes the worktree. It verifies
the rows are gone and falls back to deleting them directly (`session` +
`event_sequence`; needs `sqlite3` and the database file) only when the server
delete failed and the configured server is local — a remote server means the
session is deleted through it, never through the local database.
Refuses unless the worker process has exited, no turn is active,
and the server is reachable with a matching session directory (`--force`
bypasses these).

To do this automatically, pass `--teardown` to `task`/`bulk` (with
`--background`/`--wait`); it runs only after a clean completion.

Raw slash-command arguments:
`$ARGUMENTS`

Run:
```bash
bash "$HOME/.claude/scripts/opencode-dispatch.sh" teardown $ARGUMENTS
```
