---
description: Approve a pending opencode permission request, resuming its parked turn
argument-hint: '<requestID> [--always]'
allowed-tools: Bash(bash:*), Bash(opencode:*)
---

Approve a pending permission request (find ids with `/opencode:permissions`).
Default is a one-shot approval (`once`); pass `--always` to also remember the
pattern for the session so covered asks auto-resolve. The blocked turn resumes
if its session is still active.

Caveat: `--always` approvals are in-memory only — they do not survive a server
restart. Make the allow durable in `~/.config/opencode/opencode.json` instead.

Raw slash-command arguments:
`$ARGUMENTS`

Run:
```bash
bash "$HOME/.claude/scripts/opencode-dispatch.sh" allow $ARGUMENTS
```

Return the output verbatim.
