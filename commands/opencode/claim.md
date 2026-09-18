---
description: Atomically claim a unit of work under this agent's identity (or release it)
argument-hint: '<unit>'
allowed-tools: Bash(bash:*), Bash(opencode:*), Read
---

Atomically claim a unit of work in the current working tree, keyed by this
agent session's identity (from `/opencode:identify`). Use **before** starting
work in a shared delegation: the claim file is created with an exclusive lock
(`O_EXCL`), so a second agent claiming the same unit fails with the owner's
session id — claims can never double-assign.

- `claim <unit>` — claim `<unit>` (letters/digits/`._-`). Prints the claim
  record and the session id. Exit 3 if already claimed.
- `release <unit>` — remove the claim. Only the owning session may release it.

Claims live in `<worktree>/.opencode-claims/<unit>.json` with the session id,
slug, agent, task id (when spawned), worktree, and claim timestamp.

```bash
bash "$HOME/.claude/scripts/opencode-dispatch.sh" claim $ARGUMENTS
```

If the claim fails, the unit is taken — pick another unit or report back to the
caller.

**Never pipe this command's output through `tail`** — the installed PreToolUse
hook blocks it.
