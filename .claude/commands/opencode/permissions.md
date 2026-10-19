---
description: List pending permission requests on the opencode server (parked asks)
argument-hint: ''
allowed-tools: Bash(bash:*), Bash(opencode:*)
---

List permission requests the server is waiting on. A session that reads WORKING
but frozen (see `/opencode:status`) is usually parked on one of these — an
`external_directory`/`bash` ask on a headless server that no TUI ever answered.
Each entry shows the request id, permission, patterns, session, and tool.

Approve with `/opencode:allow <requestID> [--always]`.

Raw slash-command arguments:
`$ARGUMENTS`

Run:
```bash
bash "$HOME/.claude/scripts/opencode-dispatch.sh" permissions $ARGUMENTS
```

**Never pipe this command's output through `tail`** — the installed PreToolUse
hook blocks it; pending asks are few, print them all.

Return the output verbatim.
