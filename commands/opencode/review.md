---
description: Review local git changes or a GitHub PR via opencode (waits to completion; wakes on done)
argument-hint: '[--pr <n>] [--base <ref>] [--model provider/model] [--effort <name>] [--timeout <N>] [--follow] [--synchronous]'
allowed-tools: Bash(bash:*), Bash(opencode:*), Bash(git:*), Bash(gh:*), Read
---

Read-only review of local git changes — or a GitHub PR with `--pr <n>` — on a cheap
model. Runs **server-backed** (observable via `/opencode:status`, killable via
`/opencode:abort`) and **awaits completion** — it blocks exactly until the turn
finishes, prints the findings, then exits. If it runs long enough to be
backgrounded, the caller is woken on that exit (wake-on-complete); no fixed
give-up deadline.

**The diff never reaches Claude.** Whether local or `--pr`, the diff is fetched
*inside the script* and uploaded straight to the delegate — only the distilled
findings come back. So `--pr` costs Claude nothing to read the PR.

Raw slash-command arguments:
`$ARGUMENTS`

**Run this in the BACKGROUND** (Bash `run_in_background: true`). `--await` blocks
for the whole turn, and a large-diff review can outlast the foreground Bash-tool
timeout (which would clip the run at a few minutes). Backgrounded, there is no
foreground timeout — the harness wakes you when the process exits (wake-on-complete),
bounded only by the script's own 24h `--await` backstop.

Run:
```bash
bash "$HOME/.claude/scripts/opencode-dispatch.sh" review --await $ARGUMENTS
```

- Return the findings verbatim. **Review-only — do not fix issues or apply patches.**
- `--pr <n>` reviews GitHub PR #n (via `gh pr diff <n>`, needs gh + `gh auth login`),
  independent of the current branch/worktree. Mutually exclusive with `--base`.
- `--base <ref>` scopes to `<ref>...HEAD`; default is the working tree.
- `--await` exits non-zero only on a turn error or if the server goes unreachable;
  otherwise it waits (up to ~24h backstop; `--timeout 0` = unbounded). If it does
  exit early, report the session id and `/opencode:status <id>`.
- `--follow` = bounded foreground wait (300s) that leaves the session running on
  timeout; `--synchronous` = quick inline one-shot on a tiny diff (non-server).
