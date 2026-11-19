---
description: Liveness of an opencode session — parked asks, running tool, working/idle
argument-hint: '[<sessionID> | --task <taskID>] [--server <name>] [--port <N>]'
allowed-tools: Bash(bash:*), Bash(opencode:*)
---

Cheap liveness check for a session (no full transcript pulled): model, message
count, cost, last-activity time + how long ago, and the turn state. Use this to
tell if a long-running delegate is still working, parked on a prompt, or stuck.
For isolated workers, `--task <taskID>` resolves the recorded session safely.
`--server <name>` checks the session on another server profile (default
`default`).

State detection (verified on opencode 1.18.9 and 2.0.32):
- **`PERMASK` / `WORKING — PERMISSION PROMPT (per_… …)`** — the session is parked
  on a permission ask (from `GET /permission`); approve with `/opencode:allow
  <requestID> [--always]`.
- **`QUESTION` / `WORKING — QUESTION ASK (que_… …)`** — parked on a `question`
  tool ask (from `GET /question`); no reply path on a headless server — abort.
- **`WORKING — TOOL RUNNING (<tool> · Nm)`** — a turn is in progress with a tool
  call currently running. Long tool calls are normal; if `updated` also freezes
  for >30m the state becomes `STALE` instead.
- **`STALE` / `WORKING — STALE`** — working flag with a frozen `updated` for
  >30m; likely a dead turn — `/opencode:abort <id>`.
- **`initializing (Ns)`** — the session exists but has no transcript yet. A
  freshly spawned worker has not submitted its first prompt. **This is not
  done:** keep waiting; do not cancel and re-run it as a fresh agent.
- **`pending`** — a prompt was submitted (trailing user message) but the
  assistant reply has not started yet. **This is not done.**
- **`failed`** — the last turn ended with a provider/turn error (also shown as
  `lastError`); inspect before re-running.
- **`interrupted`** — the last turn was explicitly interrupted.
- **`unknown`** — the session's transcript could not be read. The state is not
  known; do not treat it as done.
- `idle` — the last turn completed cleanly and no turn is running. Only this
  state means a successful finish.

An incomplete last assistant step is reported as `WORKING` (or `STALE` after
30m), even if the server's active list is empty: the turn may be driven by
another server process over the shared database, and only a completed step with
no active turn is a finished turn.

The no-argument list view probes each shown session's last message (one small
request each) so it reports `PERMASK`/`QUESTION`/`WORKING`/`STALE` accurately —
opencode's session JSON has no `lastMessage` in 1.18.x, so list state cannot
come from the list itself. It uses the same `initializing`/`pending`/`failed`/
`interrupted` labels and ends with a summary warning when sessions are still
initializing, so it does not label a not-yet-initialized worker as done.

**Prefer this over `/opencode:history` when you only want to know if a session is
active.** `status` costs a few lines; `history` dumps the whole transcript into
context. Run `status` first; only pull `history` when you actually want the
content.

Raw slash-command arguments:
`$ARGUMENTS`

Run:
```bash
bash "$HOME/.claude/scripts/opencode-dispatch.sh" status $ARGUMENTS
```

Return the output verbatim. If the state names a permission prompt (`PERMASK` /
`WORKING — PERMISSION PROMPT`), approve it with `/opencode:allow <requestID>`
and the turn resumes. `QUESTION` asks and `STALE` states have no approval path —
for `STALE`, use `/opencode:abort <id>`. A normal `WORKING — TOOL RUNNING` is
just progress: do not abort it.

**Never pipe this command's output through `tail`** — the installed PreToolUse
hook blocks it; `status` is already a few lines.
