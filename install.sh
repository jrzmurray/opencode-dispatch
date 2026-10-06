#!/usr/bin/env bash
#
# install.sh — deploy opencode-dispatch into Claude Code and/or Codex, as
# user-profile skills (default) or repository-scoped skills.
# - claude: the dispatch/hang-diag/set-model/guard scripts, the /opencode:*
#   commands, a PreToolUse hook merged into settings.json that THROWS if
#   opencode-dispatch.sh is piped through `tail`, and a sample opencode config
#   copied only when none exists.
# - codex: installs a local plugin (~/.codex/plugins/opencode-dispatch/) with
#   generated skills and the tail-guard hook, registers it in the personal
#   marketplace (~/.agents/plugins/marketplace.json), adds the marketplace via
#   `codex plugin marketplace add`, and enables the plugin in
#   ~/.codex/config.toml. With --no-marketplace, bypasses all of that and drops
#   the skills + guard hook directly into Codex's auto-discovered paths
#   (~/.codex/skills/, ~/.codex/hooks.json).
# - scope: `profile` installs into the user profile dirs (~/.claude, ~/.codex);
#   `repo` installs into a repository's own dirs (<repo>/.claude,
#   <repo>/.codex) so the skills travel with the project instead of the user.
# - never reads or writes provider credentials; authenticate with `opencode auth login`
set -euo pipefail

print_help() {
  cat <<'EOF'
Usage: ./install.sh [--claude] [--codex] [-s profile|repo] [-r <path>] [--no-marketplace]

Deploy opencode-dispatch into Claude Code, Codex, or both. Running with no
arguments prints this help and does nothing.

Options:
  --claude                Install into Claude Code (~/.claude by default).
  --codex                 Install into Codex (local plugin + personal
                          marketplace by default).
  -s, --scope <profile|repo>
                          Where the skills go:
                            profile — user profile dirs (default):
                                       ~/.claude, ~/.codex
                            repo    — a repository: <repo>/.claude,
                                       <repo>/.codex (skills travel with the
                                       project; --repo is required)
  -r, --repo <path>       Repository to install into when --scope repo
                          (implies --scope repo).
                          Without --repo: if the current working directory is a
                          git repo that is not this skill repo, the skills are
                          installed IN PLACE into that repo (repo scope). An
                          explicit `-s profile` always stays profile.
  --no-marketplace        Codex, profile scope: bypass the plugin + marketplace
                          registration and drop the skills and guard hook
                          directly into Codex's auto-discovered paths
                          (~/.codex/skills/, ~/.codex/hooks.json).
  --check                 Report whether the PROFILE-scope install
                          ($CLAUDE/scripts) matches this checkout (source SHA
                          in .opencode-dispatch-install.json plus a byte
                          compare of every installed script); exit 1 on drift.
                          Re-run ./install.sh to update.
  --help, --usage, -?              Show this help and exit.

Environment:
  CLAUDE_HOME           Claude Code directory to install into
                        (default: ~/.claude).

Claude install (--claude):
  scripts/opencode-dispatch.sh      -> $CLAUDE/scripts/        (profile scope)
                                       <repo>/.claude/scripts/ (repo scope)
  scripts/opencode-hang-diag.sh     -> same dirs
  scripts/opencode-set-model.sh     -> same dirs
  scripts/opencode-guard.sh         -> same dirs
  scripts/spawn-agent.mjs           -> same dirs: the agent launcher
  scripts/agent-status.mjs             (spawn-agent, agent-status, agent-cleanup,
  scripts/agent-cleanup.mjs             agent-worker-guard, worktree-utils,
  scripts/agent-worker-guard.mjs        opencode-server). opencode-dispatch.sh
  scripts/worktree-utils.mjs            finds them next to itself, so an install
  scripts/opencode-server.mjs           never refers back to this checkout.
  commands/opencode/*.md            -> $CLAUDE/commands/opencode/ (profile)
                                       <repo>/.claude/commands/opencode/ (repo;
                                       script paths rewritten to the repo's own
                                       .claude/scripts via git rev-parse)
  PreToolUse/Bash hook              -> merged into $CLAUDE/settings.json
                                       (profile) or <repo>/.claude/settings.json
                                       (repo); existing settings preserved;
                                       blocks '| tail' on opencode-dispatch.sh
  config/opencode.json              -> ~/.config/opencode/opencode.json
                                       (profile scope ONLY; machine-level)
  config/servers.json.example       -> ~/.config/opencode-dispatch/servers.json
                                       (profile scope ONLY; machine-level; a
                                       local config/servers.json, gitignored,
                                       is used instead when present)
  .env.local (if present)           -> $CLAUDE/scripts/.env.local
                                       (profile scope ONLY: server credentials;
                                       gitignored in the repo; re-installs
                                       refresh the copy. Never copied into a
                                       project repo; use
                                       OPENCODE_DISPATCH_ENV_FILE there.)
  plugins/*.js                    -> ~/.config/opencode/plugins/
                                       (opencode-identity.js: injects
                                       OPENCODE_SESSION_* into every tool shell
                                       + appends the slug to session titles;
                                       opencode-branch-staleness.js: reports
                                       branch drift from origin/main every turn;
                                       load at opencode startup)
                                       repo scope: <repo>/.opencode/plugins/

Codex install (--codex):
  Profile scope (default): ~/.codex/plugins/opencode-dispatch/
    .codex-plugin/plugin.json       manifest (name/version/skills/hooks)
    skills/                         generated from commands/opencode by
                                    scripts/sync-claude-commands-to-skills.ts
                                    --codex (needs Node >= 22.6)
    scripts/opencode-guard.sh       tail-guard (PreToolUse, block exit 2)
    hooks/hooks.json                hook registration
  ~/.agents/plugins/marketplace.json  personal marketplace entry (merged)
  ~/.codex/config.toml                plugin enabled = true (appended)
  Runs: codex plugin marketplace add ~/.agents/plugins (if it fails, run it
  manually). Codex requires reviewing and trusting the bundled hook once via
  /hooks before it runs.

  With --no-marketplace (profile scope), instead of the plugin + marketplace,
  the skills and guard hook are dropped directly into Codex's auto-discovered
  paths: ~/.codex/skills/<opencode-*>/SKILL.md and ~/.codex/hooks.json
  (merged). Same /hooks trust step applies.

  Repo scope (--scope repo): the skills + guard hook are dropped directly into
  <repo>/.codex/skills/ and <repo>/.codex/hooks.json, and the dispatch scripts
  plus the agent launcher into <repo>/.codex/scripts/ (the skills call them
  there, resolved from the repo root). No marketplace or plugin registration
  (those are user-profile concepts).

The installer never reads or writes provider credentials.

Next:
  1) opencode auth login   (credentials are stored by opencode itself)
  2) /opencode:setup       (claude) or /hooks + /plugins (codex)
EOF
}

CLAUDE=""
CODEX=""
CHECK=""
SCOPE="profile"
SCOPE_SET=""
TARGET_REPO=""
NO_MARKETPLACE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --help|--usage|-\?) print_help; exit 0 ;;  # NOTE: \-? escaped — bare ? would glob-match -s/-r
    --claude) CLAUDE=1; shift ;;
    --codex) CODEX=1; shift ;;
    -s|--scope) SCOPE="${2:-}"; SCOPE_SET=1; shift 2 ;;
    -r|--repo) TARGET_REPO="${2:-}"; shift 2 ;;
    --no-marketplace) NO_MARKETPLACE=1; shift ;;
    --check) CHECK=1; shift ;;
    *) echo "error: unknown argument: $1 (see: ./install.sh --help)" >&2; exit 2 ;;
  esac
done

# --check: drift detection for the profile-scope script install, then exit.
if [ -n "$CHECK" ]; then
  check_root="${CLAUDE_HOME:-$HOME/.claude}/scripts"
  check_repo="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  stamp="$check_root/.opencode-dispatch-install.json"
  drift=0
  if [ ! -f "$stamp" ]; then echo "no install stamp at $stamp (not installed, or installed by an older install.sh)"; drift=1
  else
    inst_sha="$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).sourceSha||"")' "$stamp")"
    cur_sha="$(git -C "$check_repo" rev-parse HEAD 2>/dev/null || echo unknown)"
    echo "installed from: $inst_sha"; echo "checkout HEAD:  $cur_sha"
    [ "$inst_sha" = "$cur_sha" ] || { echo "drift: installed SHA differs from this checkout"; drift=1; }
  fi
  for f in opencode-dispatch.sh opencode-hang-diag.sh opencode-set-model.sh opencode-guard.sh spawn-agent.mjs agent-status.mjs agent-cleanup.mjs agent-worker-guard.mjs worktree-utils.mjs opencode-server.mjs; do
    if [ ! -f "$check_root/$f" ]; then echo "missing: $check_root/$f"; drift=1
    elif ! cmp -s "$check_repo/scripts/$f" "$check_root/$f"; then echo "differs: $check_root/$f"; drift=1; fi
  done
  [ "$drift" = 0 ] && echo "up to date: $check_root"
  exit "$drift"
fi

# No target = same as --help: print, do nothing.
if [ -z "$CLAUDE" ] && [ -z "$CODEX" ]; then
  print_help
  exit 0
fi
case "$SCOPE" in
  profile|repo) ;;
  *) echo "error: --scope must be profile or repo (got: $SCOPE)" >&2; exit 2 ;;
esac

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --- target resolution --------------------------------------------------------
# No --repo given: install in place when the CWD is a git repo that is NOT this
# skill repo. `-s repo` requires it; with no -s at all, a foreign-repo CWD
# auto-selects repo scope (explicit `-s profile` stays profile).
if [ -n "$TARGET_REPO" ]; then
  SCOPE="repo"
elif [ "$SCOPE" = "repo" ] || [ -z "$SCOPE_SET" ]; then
  local_top=""
  if git -C "$PWD" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    local_top="$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null || true)"
  fi
  if [ -n "$local_top" ] && [ "$local_top" != "$REPO" ]; then
    SCOPE="repo"
    TARGET_REPO="$local_top"
    echo "repo scope: CWD is a git repo — installing in place at $TARGET_REPO"
  elif [ "$SCOPE" = "repo" ]; then
    echo "error: --scope repo needs --repo <path>, or run from inside a git repo (not this skill repo) to install in place" >&2
    exit 2
  fi
fi
if [ "$SCOPE" = "repo" ]; then
  if [ -z "$TARGET_REPO" ]; then
    echo "error: --scope repo needs --repo <path>, or run from inside a git repo (not this skill repo) to install in place" >&2
    exit 2
  fi
  if [ ! -d "$TARGET_REPO" ]; then
    echo "error: --repo is not a directory: $TARGET_REPO" >&2
    exit 2
  fi
fi

CLAUDE="${CLAUDE_HOME:-$HOME/.claude}"
CONFIG="$HOME/.config/opencode/opencode.json"
echo "repo:   $REPO"
echo "claude: $CLAUDE"

# Scripts every install carries. The agent launcher (task/bulk edit workers) is
# installed beside opencode-dispatch.sh, which locates it relative to itself.
DISPATCH_SCRIPTS="opencode-dispatch.sh opencode-hang-diag.sh opencode-set-model.sh opencode-guard.sh"
LAUNCHER_SCRIPTS="spawn-agent.mjs agent-status.mjs agent-cleanup.mjs agent-worker-guard.mjs worktree-utils.mjs opencode-server.mjs"

install_script_set() {  # $1 = scripts dir
  local dest="$1" f
  mkdir -p "$dest"
  for f in $DISPATCH_SCRIPTS $LAUNCHER_SCRIPTS; do
    install -m 0755 "$REPO/scripts/$f" "$dest/$f"
    echo "installed: $dest/$f"
  done
}

# Copy commands/opencode to $1 with the profile-scope script path
# ("$HOME/.claude/scripts/") rewritten to the target repo's own scripts dir
# ($2 = .claude or .codex), resolved at run time from the repo root so it also
# works inside git worktrees of that repo.
stage_repo_commands() {  # $1 = out dir, $2 = .claude|.codex
  mkdir -p "$1"
  node - "$REPO/commands/opencode" "$1" "$2" <<'EOF'
    const fs = require("fs"), path = require("path");
    const [src, out, dot] = process.argv.slice(2);
    const from = '"$HOME/.claude/scripts/';
    const to = '"$(git rev-parse --show-toplevel)/' + dot + '/scripts/';
    for (const f of fs.readdirSync(src).filter(n => n.endsWith(".md"))) {
      fs.writeFileSync(path.join(out, f), fs.readFileSync(path.join(src, f), "utf8").split(from).join(to));
    }
EOF
}

# ---------------------------------------------------------------- claude ----
install_claude() {  # $1 = install root (profile: $CLAUDE, repo: $REPO/.claude)
  local ROOT="$1"

  # 1) scripts (dispatch + agent launcher, side by side)
  install_script_set "$ROOT/scripts"
  # Install stamp (profile scope; read by --check): which source SHA is installed.
  if [ "$SCOPE" != "repo" ]; then
    printf '{"sourceSha":"%s","installedAt":"%s"}\n' "$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)" "$(date -u +%FT%TZ)" > "$ROOT/scripts/.opencode-dispatch-install.json"
  fi

  # 2) slash commands. Repo scope: point the commands at the repo's own
  # .claude/scripts instead of the user profile.
  mkdir -p "$ROOT/commands/opencode"
  if [ "$SCOPE" = "repo" ]; then
    stage_repo_commands "$ROOT/commands/opencode" ".claude"
  else
    cp "$REPO"/commands/opencode/*.md "$ROOT/commands/opencode/"
  fi
  echo "installed: $ROOT/commands/opencode/*.md ($(ls "$REPO"/commands/opencode/*.md | wc -l | tr -d ' ') files)"

  # 3) PreToolUse hook: throw if opencode-dispatch.sh output is piped through tail.
  # Merge into ~/.claude/settings.json — never clobber existing settings. If the
  # existing file is not valid JSON, skip registration rather than destroy it.
  SETTINGS="$ROOT/settings.json"
  GUARD_CMD="$ROOT/scripts/opencode-guard.sh"
  # Repo scope: a committed settings.json must not embed this machine's path.
  [ "$SCOPE" = "repo" ] && GUARD_CMD='$CLAUDE_PROJECT_DIR/.claude/scripts/opencode-guard.sh'
  if node - "$SETTINGS" "$GUARD_CMD" <<'EOF'
    const fs = require("fs");
    const [settingsPath, guardCmd] = process.argv.slice(2);
    let s = {};
    if (fs.existsSync(settingsPath)) {
      try { s = JSON.parse(fs.readFileSync(settingsPath, "utf8")); }
      catch (e) { console.error("error: " + settingsPath + " is not valid JSON; hook NOT registered (fix or remove the file, then re-run install.sh)"); process.exit(1); }
    }
    s.hooks = s.hooks || {};
    const arr = (s.hooks.PreToolUse = s.hooks.PreToolUse || []);
    let bashEntry = arr.find(e => String(e.matcher || "").toLowerCase() === "bash");
    if (!bashEntry) { bashEntry = { matcher: "Bash", hooks: [] }; arr.push(bashEntry); }
    bashEntry.hooks = bashEntry.hooks || [];
    if (!bashEntry.hooks.some(h => h.type === "command" && h.command === guardCmd)) {
      bashEntry.hooks.push({ type: "command", command: guardCmd });
    }
    fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + "\n");
EOF
  then
    echo "hook registered: $SETTINGS (PreToolUse/Bash: blocks '| tail' on opencode-dispatch.sh)"
  else
    exit 1
  fi

  # 4) sample opencode config — profile scope ONLY (machine-level). Copy only
  # when NO config exists yet; an existing config (opencode.json OR
  # opencode.jsonc) is left untouched, never overwritten. Agent definitions
  # live here under the `agent` key; see config/opencode.json.
  if [ "$SCOPE" = "repo" ]; then
    echo "repo scope: machine-level config samples skipped (opencode.json, servers.json stay profile-scoped)"
  else
    mkdir -p "$(dirname "$CONFIG")"
    if [ -f "$CONFIG" ] || [ -f "$HOME/.config/opencode/opencode.jsonc" ]; then
      echo "existing opencode config left untouched: $CONFIG (agent configs live here under the 'agent' key)"
    elif [ -f "$REPO/config/opencode.json" ]; then
      cp "$REPO/config/opencode.json" "$CONFIG"
      echo "created:  $CONFIG (from config/opencode.json sample; re-installs never overwrite it)"
    else
      echo "no sample config found; skipped creating $CONFIG"
    fi

    # 5) sample server definitions — copy only when none exists. Named profiles
    # (listen interface vs addressable host) live here; see
    # config/servers.json.example. A local config/servers.json (gitignored,
    # possibly carrying real hosts/credentials) wins over the shipped sample.
    SRVDIR="$HOME/.config/opencode-dispatch"
    SRVFILE="$SRVDIR/servers.json"
    SRCSRV="$REPO/config/servers.json"
    [ -f "$SRCSRV" ] || SRCSRV="$REPO/config/servers.json.example"
    mkdir -p "$SRVDIR"
    if [ -f "$SRVFILE" ]; then
      echo "existing server definitions left untouched: $SRVFILE (profiles live here; see config/servers.json.example)"
    elif [ -f "$SRCSRV" ]; then
      cp "$SRCSRV" "$SRVFILE"
      echo "created:  $SRVFILE (from ${SRCSRV#$REPO/}; re-installs never overwrite it)"
    else
      echo "no sample server definitions found; skipped creating $SRVFILE"
    fi
  fi

  # 6) local credentials — copy the skill dir's .env.local (if any) next to the
  # installed scripts, so /opencode:* uses the same server credentials. It is
  # gitignored; absent = defaults (username 'opencode', profile/env password).
  if [ "$SCOPE" = "repo" ]; then
    echo "repo scope: .env.local NOT copied into the project (it would be committed); set OPENCODE_DISPATCH_ENV_FILE or OPENCODE_SERVER_PASSWORD instead"
  elif [ -f "$REPO/.env.local" ]; then
    cp "$REPO/.env.local" "$ROOT/scripts/.env.local"
    echo "created:  $ROOT/scripts/.env.local (credentials from the skill dir; re-installs refresh it)"
  else
    echo "no .env.local in the skill dir; server auth falls back to defaults (see .env.local.example)"
  fi

  # 7) plugins — opencode-identity.js injects the EXECUTING session's own
  # id/slug into every tool shell (OPENCODE_SESSION_*) and appends the slug to
  # session titles; opencode-branch-staleness.js reports how far the working
  # branch is behind origin/main every turn. Profile scope: the global plugin
  # dir (loads in every opencode instance — TUI, run, serve). Repo scope: the
  # project's .opencode/plugins/ dir.
  if [ "$SCOPE" = "repo" ]; then
    PLUGIN_DIR="$TARGET_REPO/.opencode/plugins"
  else
    PLUGIN_DIR="$HOME/.config/opencode/plugins"
  fi
  mkdir -p "$PLUGIN_DIR"
  for pf in "$REPO"/plugins/*.js; do
    cp "$pf" "$PLUGIN_DIR/$(basename "$pf")"
    echo "installed: $PLUGIN_DIR/$(basename "$pf") (opencode plugin; loads at opencode startup — restart the server to activate)"
  done
}

# ----------------------------------------------------------------- codex ----
# Two install styles:
#   install_codex        (default) — a local plugin + personal marketplace
#                        registration (UI-managed; `codex plugin marketplace add`).
#   install_codex_direct — bypass: drop the skills and guard hook directly into
#                        Codex's auto-discovered paths (~/.codex/skills/,
#                        ~/.codex/hooks.json); no marketplace, no plugin.
install_codex() {
  PLUGIN_DIR="$HOME/.codex/plugins/opencode-dispatch"
  MARKETPLACE_DIR="$HOME/.agents/plugins"
  MARKETPLACE_FILE="$MARKETPLACE_DIR/marketplace.json"
  CODEX_CONFIG="$HOME/.codex/config.toml"

  # 1) plugin folder: manifest
  mkdir -p "$PLUGIN_DIR/.codex-plugin" "$PLUGIN_DIR/skills" "$PLUGIN_DIR/scripts" "$PLUGIN_DIR/hooks"
  cat > "$PLUGIN_DIR/.codex-plugin/plugin.json" <<'JSON'
{
  "name": "opencode-dispatch",
  "version": "0.1.0",
  "description": "Delegate read-only analysis and isolated editing work to opencode from Codex.",
  "skills": "./skills/",
  "hooks": "./hooks/hooks.json"
}
JSON
  echo "wrote:   $PLUGIN_DIR/.codex-plugin/plugin.json"

  # 2) skills: generate from commands/opencode via the sync script
  if node "$REPO/scripts/sync-claude-commands-to-skills.ts" \
      --codex --out="$PLUGIN_DIR/skills" --name-prefix=opencode >/dev/null 2>&1; then
    echo "skills:  $PLUGIN_DIR/skills/ ($(ls "$PLUGIN_DIR/skills" | wc -l | tr -d ' ') opencode-* skills)"
  else
    echo "warning: skill generation failed (needs Node >= 22.6); the plugin will install without skills" >&2
  fi

  # 3) tail-guard hook, bundled with the Codex block convention (exit 2)
  install -m 0755 "$REPO/scripts/opencode-guard.sh" "$PLUGIN_DIR/scripts/opencode-guard.sh"
  cat > "$PLUGIN_DIR/hooks/hooks.json" <<'JSON'
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "bash ${PLUGIN_ROOT}/scripts/opencode-guard.sh 2",
            "statusMessage": "Checking opencode-dispatch pipe"
          }
        ]
      }
    ]
  }
}
JSON
  echo "wrote:   $PLUGIN_DIR/hooks/hooks.json (tail-guard, block exit 2)"

  # 4) personal marketplace entry (merged; never clobber other entries)
  mkdir -p "$MARKETPLACE_DIR"
  if node - "$MARKETPLACE_FILE" "$PLUGIN_DIR" <<'EOF'
    const fs = require("fs");
    const [marketplacePath, pluginDir] = process.argv.slice(2);
    const pluginName = "opencode-dispatch";
    let m = {};
    if (fs.existsSync(marketplacePath)) {
      try { m = JSON.parse(fs.readFileSync(marketplacePath, "utf8")); }
      catch (e) { console.error("error: " + marketplacePath + " is not valid JSON; marketplace entry NOT written (fix or remove the file, then re-run install.sh)"); process.exit(1); }
    }
    m.name = m.name || "personal";
    m.plugins = m.plugins || [];
    const existing = m.plugins.findIndex(p => p.name === pluginName);
    const home = process.env.HOME + "/";
    const rel = pluginDir.startsWith(home)
      ? "./" + pluginDir.slice(home.length)
      : pluginDir;
    const entry = {
      name: pluginName,
      source: { source: "local", path: rel },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Developer Tools"
    };
    if (existing >= 0) m.plugins[existing] = entry; else m.plugins.push(entry);
    fs.writeFileSync(marketplacePath, JSON.stringify(m, null, 2) + "\n");
EOF
  then
    echo "wrote:   $MARKETPLACE_FILE (opencode-dispatch entry)"
  else
    exit 1
  fi

  # 5) register the marketplace with the codex CLI (informational on failure)
  if command -v codex >/dev/null 2>&1; then
    if codex plugin marketplace add "$MARKETPLACE_DIR" >/dev/null 2>&1; then
      echo "added:   codex plugin marketplace add $MARKETPLACE_DIR"
    else
      echo "note:    'codex plugin marketplace add $MARKETPLACE_DIR' failed — run it manually (or use the Plugins Directory in the ChatGPT desktop app)" >&2
    fi
  else
    echo "note:    codex CLI not found; install codex and run 'codex plugin marketplace add $MARKETPLACE_DIR' manually" >&2
  fi

  # 6) enable the plugin in config.toml (append once; never duplicate)
  mkdir -p "$(dirname "$CODEX_CONFIG")"
  if [ -f "$CODEX_CONFIG" ] && grep -q '^\[plugins\."opencode-dispatch"\]' "$CODEX_CONFIG"; then
    echo "enabled: $CODEX_CONFIG (already present)"
  else
    printf '\n[plugins."opencode-dispatch"]\nenabled = true\n' >> "$CODEX_CONFIG"
    echo "enabled: $CODEX_CONFIG"
  fi

  echo
  echo "Codex next steps:"
  echo "  1) /hooks      — review and trust the bundled opencode-guard hook"
  echo "  2) /plugins    — verify opencode-dispatch is listed and enabled"
}

install_codex_direct() {  # $1 = install root (profile: $HOME/.codex, repo: $REPO/.codex)
  local ROOT="$1"
  SKILLS_DIR="$ROOT/skills"
  SCRIPTS_DIR="$ROOT/scripts"
  HOOKS_FILE="$ROOT/hooks.json"

  # 1) skills — flat under ~/.codex/skills/<opencode-*>/SKILL.md (auto-discovered).
  # Repo scope: generate from commands rewritten to call the repo's own
  # .codex/scripts, and install those scripts (dispatch + launcher) there.
  SOURCE_ARG=""
  STAGE=""
  if [ "$SCOPE" = "repo" ]; then
    STAGE="$(mktemp -d)"
    stage_repo_commands "$STAGE" ".codex"
    SOURCE_ARG="--source=$STAGE"
    install_script_set "$SCRIPTS_DIR"
  fi
  if node "$REPO/scripts/sync-claude-commands-to-skills.ts" \
      --codex --out="$SKILLS_DIR" --name-prefix=opencode ${SOURCE_ARG:+"$SOURCE_ARG"} >/dev/null 2>&1; then
    echo "skills:  $SKILLS_DIR/ ($(ls "$SKILLS_DIR" | wc -l | tr -d ' ') opencode-* skills, auto-discovered)"
  else
    echo "warning: skill generation failed (needs Node >= 22.6); installing the guard hook only" >&2
  fi

  [ -n "$STAGE" ] && rm -rf "$STAGE"

  # 2) guard script
  mkdir -p "$SCRIPTS_DIR"
  install -m 0755 "$REPO/scripts/opencode-guard.sh" "$SCRIPTS_DIR/opencode-guard.sh"
  echo "installed: $SCRIPTS_DIR/opencode-guard.sh"

  # 3) hooks.json — merge the PreToolUse entry (never clobber existing hooks).
  # If the existing file is not valid JSON, skip registration rather than
  # destroy it.
  GUARD_CMD="$SCRIPTS_DIR/opencode-guard.sh"
  # Repo scope: resolve from the repo root so the committed file is portable.
  [ "$SCOPE" = "repo" ] && GUARD_CMD='"$(git rev-parse --show-toplevel)/.codex/scripts/opencode-guard.sh"'
  if node - "$HOOKS_FILE" "$GUARD_CMD" <<'EOF'
    const fs = require("fs");
    const [hooksPath, guardCmd] = process.argv.slice(2);
    let h = {};
    if (fs.existsSync(hooksPath)) {
      try { h = JSON.parse(fs.readFileSync(hooksPath, "utf8")); }
      catch (e) { console.error("error: " + hooksPath + " is not valid JSON; hook NOT registered (fix or remove the file, then re-run install.sh)"); process.exit(1); }
    }
    h.hooks = h.hooks || {};
    const arr = (h.hooks.PreToolUse = h.hooks.PreToolUse || []);
    let bashEntry = arr.find(e => String(e.matcher || "").toLowerCase() === "bash");
    if (!bashEntry) { bashEntry = { matcher: "Bash", hooks: [] }; arr.push(bashEntry); }
    bashEntry.hooks = bashEntry.hooks || [];
    const cmd = "bash " + guardCmd + " 2";
    if (!bashEntry.hooks.some(x => x.type === "command" && x.command === cmd)) {
      bashEntry.hooks.push({ type: "command", command: cmd, statusMessage: "Checking opencode-dispatch pipe" });
    }
    fs.writeFileSync(hooksPath, JSON.stringify(h, null, 2) + "\n");
EOF
  then
    echo "hook registered: $HOOKS_FILE (PreToolUse/Bash: blocks '| tail' on opencode-dispatch.sh)"
  else
    exit 1
  fi

  echo
  echo "Codex next steps:"
  echo "  1) /hooks   — review and trust the bundled opencode-guard hook (required once)"
  echo "  2) /skills  — verify the opencode-* skills are listed"
}

# ------------------------------------------------------------------ main ----
if [ -n "$CLAUDE" ]; then
  if [ "$SCOPE" = "repo" ]; then
    install_claude "$TARGET_REPO/.claude"
  else
    install_claude "$CLAUDE"
  fi
fi
if [ -n "$CODEX" ]; then
  if [ "$SCOPE" = "repo" ]; then
    install_codex_direct "$TARGET_REPO/.codex"
  elif [ -n "$NO_MARKETPLACE" ]; then
    install_codex_direct "$HOME/.codex"
  else
    install_codex
  fi
fi

echo
echo "Done."
if [ -n "$CLAUDE" ]; then
  echo "  1) opencode auth login       (authenticate a provider — credentials are stored by opencode itself, never in env vars or config files)"
  echo "  2) /opencode:setup           (verify install/auth/models)"
fi
if [ -n "$CODEX" ]; then
  echo "  3) /hooks + /skills in Codex (trust the hook, verify the skills)"
fi
