---
description: Check opencode install, every defined server, providers, and models
argument-hint: '[--server <name>]'
allowed-tools: Bash(bash:*), Bash(opencode:*)
---

Report whether opencode is installed, **every defined server profile** (from
`~/.config/opencode-dispatch/servers.json`) with its bind-interface vs
addressable-host split and live UP/down state (`*` marks the resolved profile),
which providers are authenticated, the default dispatch model, and which models
are available.

Run:
```bash
bash "$HOME/.claude/scripts/opencode-dispatch.sh" setup
```

Present the output. If no providers are authenticated, tell the user to run
`opencode auth login` and pick a provider (e.g. DeepSeek). Do not ask the user
to paste any key into this chat, and do not suggest environment variables or
config files for credentials — opencode stores them itself.

**Never pipe this command's output through `tail`** — the installed PreToolUse
hook blocks it; the diagnostics are already short.
