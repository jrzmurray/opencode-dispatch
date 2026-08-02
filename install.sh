#!/usr/bin/env bash
#
# install.sh — deploy claude-skill-opencode into ~/.claude.
# This installer deliberately never reads or writes opencode.json.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE="${CLAUDE_HOME:-$HOME/.claude}"
echo "repo:   $REPO"
echo "claude: $CLAUDE"

# 1) dispatch script
mkdir -p "$CLAUDE/scripts"
install -m 0755 "$REPO/scripts/opencode-dispatch.sh" "$CLAUDE/scripts/opencode-dispatch.sh"
echo "installed: $CLAUDE/scripts/opencode-dispatch.sh"

# 2) slash commands
mkdir -p "$CLAUDE/commands/opencode"
cp "$REPO"/commands/opencode/*.md "$CLAUDE/commands/opencode/"
echo "installed: $CLAUDE/commands/opencode/*.md ($(ls "$REPO"/commands/opencode/*.md | wc -l | tr -d ' ') files)"

echo
echo "Done. Next:"
echo "  1) export DEEPSEEK_API_KEY=…   (in your shell profile, BEFORE starting the server)"
echo "  2) /opencode:setup             (verify install/auth/models)"
