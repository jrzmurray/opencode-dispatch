---
description: Set the default opencode model and effort — overall, per agent, or for tasks (merges ~/.config/opencode/opencode.json; never overwrites)
argument-hint: 'overall <provider/model> [--effort low|medium|high|xhigh|max] | --agent <name> <provider/model> [--effort low|medium|high|xhigh|max] | --task <provider/model> [--effort low|medium|high|xhigh|max] | show'
allowed-tools: Bash(bash:*), Bash(opencode:*), Read
---

Set which model (and reasoning effort) opencode uses for delegated work. The
change is written by **merge** into `~/.config/opencode/opencode.json` — every
other setting (`$schema`, `mcp`, `permission`, other agents, …) is preserved,
an existing config is never overwritten, and a timestamped backup is taken
before each write.

Forms (the input determines the scope):

- `overall <provider/model> [--effort <name>]` — default model for everything
  (writes top-level `model` + `small_model`). `--effort` writes the variant on
  every agent currently defined in the config (opencode has no top-level effort
  setting; effort maps to per-agent `variant`).
- `--agent <name> <provider/model> [--effort <name>]` — one agent only
  (`build`, `review`, `plan`, `general`, …; writes `agent.<name>.model` +
  `agent.<name>.variant`).
- `--task <provider/model> [--effort <name>]` — the default model/effort for
  task and bulk dispatches (shorthand for `--agent auto`, the agent the
  `/opencode:task` and `/opencode:bulk` workers run). Per-invocation overrides
  stay available via the dispatch script's `--model` / `--effort` flags.
- `show` — print the current overall and per-agent settings.

Effort names follow the codex-style levels `low|medium|high|xhigh|max` (and are
provider-specific — e.g. `--effort high` maps to the provider's variant). Note: a
per-agent `variant` applies only when that agent uses its configured model.

The model must be `provider/model` (e.g. `deepseek/deepseek-v4-flash`), never a
bare id. After the change, restart the opencode server (`/opencode:serve` picks
up an existing server; config is loaded at startup — restart the server process
if one is running) for it to take effect.

**Never pipe this command's output through `tail`** — the installed PreToolUse
hook blocks it; the script prints only the small confirmation you need.

Raw slash-command arguments:
`$ARGUMENTS`

Run:
```bash
bash "$HOME/.claude/scripts/opencode-set-model.sh" $ARGUMENTS
```

Return the output verbatim. If `~/.config/opencode/opencode.json` does not
exist yet, the script creates it with the minimal `$schema` plus your setting.
