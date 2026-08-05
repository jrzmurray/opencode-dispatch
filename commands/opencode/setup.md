---
description: Check opencode install, authenticated providers, and available models
allowed-tools: Bash(bash:*), Bash(opencode:*)
---

Report whether opencode is installed, which providers are authenticated, the
default dispatch model, and which models are available.

Run:
```bash
bash "$HOME/.claude/scripts/opencode-dispatch.sh" setup
```

Present the output. If no providers are authenticated, tell the user to run
`opencode auth login` and pick a provider (e.g. DeepSeek), or to set the relevant
API-key env var (e.g. `DEEPSEEK_API_KEY`) in their shell profile. Do not ask the
user to paste any key into this chat.
