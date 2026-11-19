---
description: Background isolated opencode batch job (awaits completion; remote summary)
argument-hint: '[--server <name>] [--model provider/model] [--effort low|medium|high|xhigh|max] [--timeout <N>] [--wait|--background] [--follow] [--orchestration-root <path>] <task>'
allowed-tools: Bash(bash:*), Bash(opencode:*), Read
---

Dispatch an agentic batch job on a cheap model. Each invocation gets a unique
bootstrapped worktree and directory-bound session on the shared persistent server,
then starts an attached `auto` worker and awaits completion. Edit/bash are
pre-authorized.

The task may be plain positional text or `--prompt-file <path>` (preferred).
Plain text is auto-converted to a prompt file at launch, so the task text never
stays in the process argv for the run. `--background` (the default) runs the job
in the background on the server and the wrapper waits for it: it blocks until
the turn completes, then exits 0 (wake-on-complete). `--wait` is the foreground
blocking form: call it inline (not backgrounded) and the session blocks until
the turn completes. The two are mutually exclusive; the last one given wins.
`--effort` accepts `low|medium|high|xhigh|max`.

Raw slash-command arguments:
`$ARGUMENTS`

**Run this in the BACKGROUND** (Bash `run_in_background: true`). `--background`
blocks for the whole turn, and batch editing jobs routinely outlast the foreground Bash-tool
timeout (which would clip the run at a few minutes). Backgrounded, there is no
foreground timeout — the harness wakes you when the process exits (wake-on-complete),
bounded only by the script's own 24h `--background` backstop.

Run:
```bash
bash "$HOME/.claude/scripts/opencode-dispatch.sh" bulk --background $ARGUMENTS
```

- Report the remote summary + session id. For many targets, launch **one backgrounded
  job per target** (each awaits its own completion and wakes you independently); track
  them with `/opencode:sessions`.
- Edits land in the reported isolated worktree; **review that worktree's diff before
  trusting it**. The output includes task, session, branch, and path.
- The default already runs the job in the background with wake-on-complete;
  there is no fire-and-forget mode — every dispatch waits for its turn.
- **Never pipe this command's output through `tail`** — the installed PreToolUse
  hook blocks it, and tail can clip the distilled summary the script prints.
