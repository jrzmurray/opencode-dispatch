---
description: Delegate an isolated agentic build task via opencode (awaits completion; remote summary)
argument-hint: '[--server <name>] [--dir <path>] [--model provider/model] [--effort low|medium|high|xhigh|max] [--timeout <N>] [--wait|--background] [--follow] [--orchestration-root <path>] [--bootstrap-cmd <cmd>] <task>'
allowed-tools: Bash(bash:*), Bash(opencode:*), Bash(git:*), Read
---

Delegate an editing task to a cheap model. The launcher allocates and bootstraps a
unique worktree, creates a directory-bound session on the resolved server
(`--server <name>`, default `default` — see `/opencode:setup` for profiles),
and starts an attached `auto` worker. It then awaits completion and prints a remote
summary. Edit/bash are pre-authorized.

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
blocks for the whole turn, and editing turns routinely outlast the foreground Bash-tool
timeout (which would clip the run at a few minutes). Backgrounded, there is no
foreground timeout — the harness wakes you when the process exits (wake-on-complete),
bounded only by the script's own 24h `--background` backstop.

Run:
```bash
bash "$HOME/.claude/scripts/opencode-dispatch.sh" task --background $ARGUMENTS
```

- Report the remote summary and the session id. **Review the diff before trusting
  it** (`/opencode:history <id>` for detail, `/opencode:abort <id>` for a runaway).
- **Directory:** edits land only in the newly allocated worktree. The output includes
  task ID, session ID, branch, and path. The persistent server is shared safely.
- The default already runs the job in the background with wake-on-complete;
  there is no fire-and-forget mode — every dispatch waits for its turn.
- **Target repo:** `--dir <path>` selects the repo to edit; use it when the
  session's cwd is not the project. The repo's
  `<repo>/.opencode-dispatch.json` `{"bootstrap":"..."}` runs in the new
  worktree before the session starts. It sees tracked files only (the worktree
  is created from the base commit), so commit any script it references or pass
  `--bootstrap-cmd` with an absolute path. The started output prints the
  resolved command, or `(none)` when no hook was found.
- **Never pipe this command's output through `tail`** — the installed PreToolUse
  hook blocks it, and tail can clip the distilled summary the script prints.
