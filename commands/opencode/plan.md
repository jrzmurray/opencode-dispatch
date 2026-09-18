---
description: Analyze code and produce a plan via opencode (waits to completion; wakes on done)
argument-hint: '[--server <name>] [--model provider/model] [--effort low|medium|high|xhigh|max] [--timeout <N>] [--wait|--background] [--follow] [--direct] <what to plan>'
allowed-tools: Bash(bash:*), Bash(opencode:*), Read
---

Read-only planning/analysis on a cheap model. Runs server-backed and **awaits
completion**: blocks until the turn finishes, prints the result, then exits (waking
the caller on that exit if it was backgrounded). No fixed give-up deadline.

The task may be plain positional text or `--prompt-file <path>` (preferred).
Plain text is auto-converted to a prompt file at launch, so the prompt never
stays in the process argv for the run. `--background` (the default) runs the job
in the background on the server and the wrapper waits for it: it blocks until
the turn completes, then exits 0 (wake-on-complete). `--wait` is the foreground
blocking form: call it inline (not backgrounded) and the session blocks until
the turn completes. The two are mutually exclusive; the last one given wins.
`--effort` accepts `low|medium|high|xhigh|max`.

Raw slash-command arguments:
`$ARGUMENTS`

Run:
```bash
bash "$HOME/.claude/scripts/opencode-dispatch.sh" plan --background $ARGUMENTS
```

Return the output verbatim. `--background` exits non-zero only on turn error or an
unreachable server (else waits up to ~24h; `--timeout 0` = unbounded). `--follow` =
bounded 300s foreground wait; `--direct` = one-shot inline plan that invokes the
opencode CLI directly (no server session, unobservable).

**Never pipe this command's output through `tail`** — the installed PreToolUse
hook blocks it, and tail can clip the final plan the script prints whole.
