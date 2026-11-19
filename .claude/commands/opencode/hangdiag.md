---
description: Diagnose why an opencode session hung — stalled tool call, duration, permission ask
argument-hint: '[<sessionID>]'
allowed-tools: Bash(bash:*)
---

Targeted hang diagnosis for an opencode session, read straight from the local
SQLite store (`~/.local/share/opencode/opencode.db`) and daemon log
(`~/.local/share/opencode/log/opencode.log`) — no transcript dump.

With no argument, lists the 5 most recently updated sessions (id, created,
updated, title) so you can pick an id. With a `<sessionID>`, prints:

1. Session metadata — id, title, agent, model, created/updated, directory.
2. Message timeline — last 6 messages with role and part count.
3. **Hang candidates** — every tool call that did not complete (status
   `running`/`pending`/`error`) with start/end times and elapsed seconds.
   A long gap between tool `start` and `end` is the hang.
4. The input of the last stalled tool call (what it was doing when it stopped).
5. Log tail filtered to permission asks and cancellations.

**Run `/opencode:status <id>` FIRST.** Status is the cheap liveness check; when
it shows a session that looks stuck (working-but-idle, or stale), use `hangdiag`
to find the root cause. Prefer it over `/opencode:history` here — history dumps
the whole transcript into context; `hangdiag` prints only the stalled call plus
log evidence.

The two signatures you will see:

- **Unanswered permission ask** — log shows `message=asking id=per_...` (often
  `permission=external_directory`, e.g. a tool touching `/tmp/**` or the home
  directory) with no matching `allowed`/`denied` resolution, followed much later
  by `cancel` + `error=Aborted`. Fix by adding an allow in
  `~/.config/opencode/opencode.json` (per-agent or top-level `permission`
  block) and restarting `opencode serve`.
- **Stuck turn, no ask** — tool call sits `running`/`pending` with no end time.
  Interrupt with `/opencode:abort <id>`.

Note: the log's `asking`/`evaluated permission` lines carry `run=<id>`, not
`session.id=` — the script resolves the run id itself.

Raw slash-command arguments:
`$ARGUMENTS`

Run:
```bash
bash "$HOME/.claude/scripts/opencode-hang-diag.sh" $ARGUMENTS
```

**Never pipe this command's output through `tail`** — the installed PreToolUse
hook blocks `| tail` on `opencode-dispatch.sh` invocations, and `hangdiag`
already prints only the stalled call plus log evidence.

Return the output verbatim.
