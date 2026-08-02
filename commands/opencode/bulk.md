---
description: Background isolated opencode batch job (awaits completion; remote summary)
argument-hint: '[--model provider/model] [--effort <name>] [--timeout <N>] [--orchestration-root <path>] <task>'
allowed-tools: Bash(bash:*), Bash(opencode:*), Read
---

Dispatch an agentic batch job on a cheap model. Each invocation gets a unique
bootstrapped worktree and directory-bound session on the shared persistent server,
then starts an attached `auto` worker and awaits completion. Edit/bash are
pre-authorized.

Raw slash-command arguments:
`$ARGUMENTS`

**Run this in the BACKGROUND** (Bash `run_in_background: true`). `--await` blocks
for the whole turn, and batch editing jobs routinely outlast the foreground Bash-tool
timeout (which would clip the run at a few minutes). Backgrounded, there is no
foreground timeout — the harness wakes you when the process exits (wake-on-complete),
bounded only by the script's own 24h `--await` backstop.

Run:
```bash
bash "$HOME/.claude/scripts/opencode-dispatch.sh" bulk --await --summarize $ARGUMENTS
```

- Report the remote summary + session id. For many targets, launch **one backgrounded
  job per target** (each awaits its own completion and wakes you independently); track
  them with `/opencode:sessions`.
- Edits land in the reported isolated worktree; **review that worktree's diff before
  trusting it**. The output includes task, session, branch, and path.
- For true fire-and-forget (return the allocation immediately), call the script
  directly with `bulk` and no `--await`.
