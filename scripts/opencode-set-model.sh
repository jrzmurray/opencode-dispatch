#!/usr/bin/env bash
#
# opencode-set-model.sh — set the default model (and reasoning effort) opencode
# uses, overall, per agent, or for task dispatches. Writes by MERGE into
# ~/.config/opencode/opencode.json: every existing setting ($schema, mcp,
# permission, agents, …) is preserved, and an existing config is never
# overwritten. A timestamped backup is taken before each write.
#
# Verified against https://opencode.ai/config.json:
#   - overall model   -> top-level "model" + "small_model"
#   - per-agent model -> agent.<name>.model
#   - per-agent effort -> agent.<name>.variant  (opencode has no top-level
#     effort setting; "variant" is per-agent and applies only when the agent
#     uses its configured model)
#   - per-task        -> task/bulk workers run agent `auto`, so --task is the
#     shorthand for --agent auto; per-invocation overrides stay available via
#     opencode-dispatch.sh --model/--effort.
#
# Usage:
#   opencode-set-model.sh overall <provider/model> [--effort <name>]
#       Default for everything. --effort writes the variant on every agent
#       currently defined in the config.
#   opencode-set-model.sh --agent <name> <provider/model> [--effort <name>]
#       Model/effort for one agent (build, review, plan, general, …).
#   opencode-set-model.sh --task <provider/model> [--effort <name>]
#       Same as --agent auto — the agent used by task/bulk workers.
#   opencode-set-model.sh show
#       Print the current overall and per-agent model/effort settings.
#
# Requires Node (the same prerequisite as opencode-dispatch.sh).

set -euo pipefail

CONFIG="$HOME/.config/opencode/opencode.json"

MODE="set"
SCOPE=""
AGENT_NAME=""
MODEL=""
EFFORT=""

while [ $# -gt 0 ]; do
  case "$1" in
    show)            MODE="show"; shift ;;
    overall)         SCOPE="overall"; shift ;;
    --task)          SCOPE="agent"; AGENT_NAME="auto"; shift ;;
    --agent)         SCOPE="agent"; AGENT_NAME="${2:-}"; shift 2 ;;
    --effort)        EFFORT="${2:-}"; shift 2 ;;
    -*)              echo "error: unknown option: $1" >&2; exit 2 ;;
    *)               if [ -z "$MODEL" ]; then MODEL="$1"; shift;
                     else echo "error: unexpected argument: $1" >&2; exit 2; fi ;;
  esac
done

# --model must be provider/model (e.g. deepseek/deepseek-v4-pro), not a bare id.
if [ -n "$MODEL" ] && [ "${MODEL#*/}" = "$MODEL" ]; then
  echo "error: model must be provider/model, e.g. deepseek/${MODEL}" >&2
  exit 2
fi

if [ "$MODE" = "show" ]; then
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(p, "utf8")); }
    catch (e) { console.log("no config yet: " + p); process.exit(0); }
    console.log("config:  " + p);
    console.log("overall: " + (cfg.model || "<opencode default>")
      + (cfg.small_model ? "   (small: " + cfg.small_model + ")" : ""));
    const agents = Object.keys(cfg.agent || {});
    if (agents.length === 0) console.log("agents:  (none configured)");
    for (const a of agents) {
      const m = cfg.agent[a].model || "<default>";
      const v = cfg.agent[a].variant ? "   variant: " + cfg.agent[a].variant : "";
      console.log("agent " + a + ": " + m + v);
    }
  ' "$CONFIG"
  exit 0
fi

[ -n "$SCOPE" ] || { echo "error: scope required — overall | --agent <name> | --task" >&2; exit 2; }
[ -n "$MODEL" ] || { echo "error: model required (provider/model)" >&2; exit 2; }
if [ "$SCOPE" = "agent" ] && [ -z "$AGENT_NAME" ]; then
  echo "error: --agent needs a name" >&2; exit 2
fi

# Merge (never overwrite): back up the existing config, then apply the change
# to a copy of it. An invalid existing config is left untouched (exit 1).
mkdir -p "$(dirname "$CONFIG")"
if [ -f "$CONFIG" ]; then
  cp "$CONFIG" "$CONFIG.bak-$(date +%Y%m%d-%H%M%S)"
fi
SCOPE="$SCOPE" AGENT_NAME="$AGENT_NAME" MODEL="$MODEL" EFFORT="$EFFORT" node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const { SCOPE, AGENT_NAME, MODEL, EFFORT } = process.env;
  let cfg = {};
  if (fs.existsSync(p)) {
    try { cfg = JSON.parse(fs.readFileSync(p, "utf8")); }
    catch (e) { console.error("error: " + p + " is not valid JSON — refusing to touch it (fix it or move it aside, then retry)."); process.exit(1); }
  }
  if (!cfg.$schema) cfg.$schema = "https://opencode.ai/config.json";
  if (SCOPE === "overall") {
    cfg.model = MODEL;
    cfg.small_model = MODEL;
    if (EFFORT) for (const k of Object.keys(cfg.agent || {})) cfg.agent[k].variant = EFFORT;
  } else {
    cfg.agent = cfg.agent || {};
    cfg.agent[AGENT_NAME] = cfg.agent[AGENT_NAME] || {};
    cfg.agent[AGENT_NAME].model = MODEL;
    if (EFFORT) cfg.agent[AGENT_NAME].variant = EFFORT;
  }
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n");
' "$CONFIG"

echo "updated: $CONFIG"
if [ "$SCOPE" = "overall" ]; then
  echo "  overall model: $MODEL (small_model: $MODEL)"
  [ -n "$EFFORT" ] && echo "  effort $EFFORT applied to every configured agent (opencode has no top-level effort setting)"
else
  echo "  agent $AGENT_NAME: model $MODEL${EFFORT:+  variant $EFFORT}"
fi
echo "  note: opencode loads config at startup — restart 'opencode serve' (or the session) for the change to take effect."
