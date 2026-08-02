---
description: Print an opencode session transcript, with tail / time / turn limits
argument-hint: '[<sessionID> | --task <taskID>] [--tail <N>] [--turns <N>] [--since <1d|6h|10m|30s>] [--port <N>]'
allowed-tools: Bash(bash:*), Bash(opencode:*)
---

Print the transcript of an existing opencode session (or isolated task via
`--task`; assumes the server is up —
see `/opencode:serve`, and `/opencode:sessions` to find the id). Read-only; does
not send a new prompt.

**Check `/opencode:status <id>` FIRST.** To find out whether a session is still
active, has gone idle, or errored, run `status` — it's a cheap, few-line liveness
check. Only reach for `history` once you've decided you actually want the
transcript content. Pulling `history` just to see if a delegate is alive dumps the
whole session into Claude's context and burns the tokens this tooling exists to
save. When you do run `history`, always scope it with `--turns`, `--tail`, or
`--since` — never pull an unbounded transcript.

Raw slash-command arguments:
`$ARGUMENTS`

Run:
```bash
bash "$HOME/.claude/scripts/opencode-dispatch.sh" history $ARGUMENTS
```

Limits (combine freely):
- `--tail N` — keep only the last N lines (default 100).
- `--turns N` — keep only the last N user prompts and their responses; shown
  un-truncated unless `--tail` is also given.
- `--since <range>` — only messages newer than now minus the range (e.g. `1d`,
  `6h`, `10m`, `30s`, `2w`).

Return the output verbatim.
