---
description: Watch an existing session read-only — streams new output until the turn completes
argument-hint: '[<sessionID> | --task <taskID>] [--timeout <N>] [--server <name>] [--port <N>]'
allowed-tools: Bash(bash:*), Bash(opencode:*)
---

Read-only follow of a session that is **already running**: polls the transcript
every ~2s, prints new text parts as they land, and exits 0 when the last
assistant turn completes. **Sends nothing** — it never resumes, steers, or
prompts the session, so you can watch a delegate without touching it.

- `follow <sessionID>` — watch that session (default: wait indefinitely; press
  Ctrl-C to detach).
- `follow <sessionID> --timeout <N>` — bounded wait: exits 3 with a notice if
  the turn is still running after N seconds.
- `follow --task <taskID>` — resolve the recorded worker session.
- Prints a one-time `(parked: …)` notice if the session is waiting on a
  permission or question ask instead of working.

The backlog is not re-printed (you joined mid-session) — use
`/opencode:history <id> --tail <N>` for recent context first.

Run:
```bash
bash "$HOME/.claude/scripts/opencode-dispatch.sh" follow $ARGUMENTS
```

**Never pipe this command's output through `tail`** — the installed PreToolUse
hook blocks it, and tail would clip the streamed output.
