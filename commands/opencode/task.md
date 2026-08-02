---
description: Delegate an isolated agentic build task via opencode (awaits completion; remote summary)
argument-hint: '[--model provider/model] [--effort <name>] [--timeout <N>] [--orchestration-root <path>] <task>'
allowed-tools: Bash(bash:*), Bash(opencode:*), Bash(git:*), Read
---

Delegate an editing task to a cheap model. The launcher allocates and bootstraps a
unique worktree, creates a directory-bound session on the existing persistent server,
and starts an attached `auto` worker. It then awaits completion and prints a remote
summary. Edit/bash are pre-authorized.

Raw slash-command arguments:
`$ARGUMENTS`

**Run this in the BACKGROUND** (Bash `run_in_background: true`). `--await` blocks
for the whole turn, and editing turns routinely outlast the foreground Bash-tool
timeout (which would clip the run at a few minutes). Backgrounded, there is no
foreground timeout — the harness wakes you when the process exits (wake-on-complete),
bounded only by the script's own 24h `--await` backstop.

Run:
```bash
bash "$HOME/.claude/scripts/opencode-dispatch.sh" task --await --summarize $ARGUMENTS
```

- Report the remote summary and the session id. **Review the diff before trusting
  it** (`/opencode:history <id>` for detail, `/opencode:abort <id>` for a runaway).
- **Directory:** edits land only in the newly allocated worktree. The output includes
  task ID, session ID, branch, and path. The persistent server is shared safely.
- For fire-and-forget (return the allocation immediately), call the script directly
  with `task` and no `--await`.
