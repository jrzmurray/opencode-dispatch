---
description: Print this agent session's identity (session id, slug, agent, worktree)
argument-hint: '[<sessionID>] [--json]'
allowed-tools: Bash(bash:*), Bash(opencode:*), Read
---

Print the identity of the agent session you are running in: session id, slug,
agent, model, and working directory. The identity comes from
`OPENCODE_SESSION_ID` + friends, injected into every tool shell by the
opencode-identity plugin (each agent — parent OR subagent — sees its OWN
session id; no inheritance, no guessing). Without the env (interactive shells),
it falls back to the newest opencode session rooted in the current directory,
or accepts an explicit `<sessionID>`.

Use this before claiming work: the claim record (`/opencode:claim`) keys on
this identity, so a delegation system can trace every unit back to the exact
session that did it.

Run:
```bash
bash "$HOME/.claude/scripts/opencode-dispatch.sh" identify $ARGUMENTS
```

`--json` emits the machine-readable record (sessionId, slug, agent, model,
directory, taskId) for scripts.

**Never pipe this command's output through `tail`** — the installed PreToolUse
hook blocks it; the identity is a few lines.
