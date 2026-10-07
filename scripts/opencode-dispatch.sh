#!/usr/bin/env bash
#
# opencode-dispatch.sh — a thin, provider-agnostic wrapper around `opencode`.
# Routes work to whatever model opencode is configured to use (default set in
# ~/.config/opencode/opencode.json), so you can offload from Claude to a cheaper
# model (DeepSeek, or anything opencode supports) to save tokens — and read back
# persistent-session output on demand.
#
# Usage:
#   opencode-dispatch.sh <mode> [flags] [message...]
#
# Run modes default to SERVER-BACKED + ASYNC: they submit to the persistent
# server and return a session id immediately (watch with status/history, kill
# with abort). Pass --direct to instead run a one-shot, non-server,
# blocking `opencode run` that prints output inline (for quick/small asks).
#
# Modes:
#   review    Review the local git changes (uses the `review` agent).
#   plan      Read-only analysis / planning, no edits (built-in `plan` agent).
#   ask       Question answering, no edits (built-in `plan` agent).
#   task      Agentic build task — the model may edit files and run commands.
#   bulk      Same as task (async server run is inherently background-friendly).
#   serve     Start (or confirm) a persistent local `opencode serve` on --port.
#             --stop stops the running server (identified by the recorded
#             launch args, or --port/--host if none are recorded). --restart
#             stops and starts it again with the SAME arguments it was last
#             invoked with, overridden by any flags passed now (e.g.
#             `serve --restart --port 5000`).
#   sessions  List sessions from a running server (id, updated, title).
#   history   Print a session's transcript. <sessionID> positional required.
#             Limit with any of: --tail N (default 100 lines), --since <range>
#             (e.g. 1d 6h 10m 30s), --turns N (last N prompts + their responses).
#   status    Liveness of sessions. With a <sessionID>: detailed view of that
#             session (activity, cost, state). Without one: one-line summary of
#             all sessions, sorted newest first. Cheap — no transcript pulled.
#   send      Message an existing session. <sessionID> then the message text.
#             Default delivery: async submit + follow the turn (300s bounded,
#             --timeout tunable) then print the reply — no more hard 300s curl
#             cap that died on long turns. --wait/--background select the same
#             24h-backstop completion loop as the run modes (stall guard,
#             parked-permission heartbeat, distilled reply, exit codes 3/7/8).
#             --steer injects into the running turn; --queue appends after the
#             current turn (both synchronous, no reply loop).
#   abort     Interrupt the in-progress turn of a session. <sessionID> required.
#   permissions  List pending permission requests on the server (request id,
#                permission, patterns, session, tool). A WORKING-but-frozen
#                session is usually parked on one of these.
#   allow      Approve a pending permission request. <requestID> required;
#              --always also remembers the pattern for the session.
#   setup     Show install / auth / model status and exit.
#
# Flags (all optional):
#   --model <provider/model>   Explicit model (e.g. deepseek/deepseek-v4-pro).
#                              Falls back to $OPENCODE_DISPATCH_MODEL, then to
#                              opencode's configured default (no -m passed).
#   --agent <name>            Override the opencode agent (build|plan|review|…).
#   --effort <low|medium|high|xhigh|max>  Codex-style reasoning effort, mapped
#                             to the provider's --variant. Use --variant for
#                             provider-specific names.
#   --variant <name>          Raw provider variant passthrough (unvalidated).
#   --base <ref>              (review) what base branch to use for the job's
#                             base, e.g. main; default = working tree.
#   --scope <auto|working-tree|branch>  (review) what to diff: auto = --base
#                             <ref>...HEAD when --base is given, else the working
#                             tree; working-tree = uncommitted changes only
#                             (git diff HEAD); branch = --base <ref>...HEAD
#                             (requires --base).
#   --pr <n>                  (review) review GitHub PR #n: fetches `gh pr diff <n>`
#                             IN-SCRIPT and uploads it to the delegate — the diff
#                             never returns to the caller's context. Needs gh+auth.
#   --repo <owner/repo>       (review with --pr) explicit repo for gh pr diff,
#                             for when the --dir has no git remote (default:
#                             inferred from --dir's origin remote).
#   --dir <path>              Directory to root the SESSION in (default: current
#                             dir). Passed as ?directory= on create+prompt, so a
#                             single shared server can run each session in its own
#                             worktree — no server-per-agent needed.
#   --prompt-file <path>      (run modes + send) preferred source of the
#                             message/task. --brief is an alias for this flag.
#                             Plain positional prompt text is ALSO
#                             accepted: it is written to a temp file immediately
#                             and the script re-executes itself with
#                             --prompt-file, so the prompt never stays in this
#                             process's argv for the run (it survives only in the
#                             invoking shell's one-line command string, which no
#                             CLI can avoid, and in the file). A pruned session
#                             context can always re-read the file. Positional
#                             arguments are space-joined into one line (no line
#                             breaks unless an argument itself contains one).
#                             task/bulk additionally copy the prompt into the
#                             worker's worktree as ./.opencode-task-brief.md
#                             (git-excluded) and tell the worker to re-read it.
#                             Historical rationale (superseded text follows): for large prompts and to avoid
#                             shell quoting/arg-length issues. Positionals and --prompt-file are mutually exclusive.
#   --direct                  (run modes) invoke the opencode CLI DIRECTLY — a
#                             one-shot, non-server, blocking `opencode run` that
#                             prints output inline (NOT --sync). No session is
#                             created on the persistent server, so the run is
#                             unobservable and not killable. For quick/small asks;
#                             read-only modes only. Default is server+async.
#                             --auto posture (opencode 1.18.9): passed ONLY for
#                             review — its edit/webfetch are explicitly denied,
#                             so --auto cannot unlock them, and bash is
#                             explicitly allowed (git reads). plan/ask run
#                             WITHOUT --auto: the plan agent's bash is already
#                             allow-by-default (opencode's `*` default), so
#                             --auto adds nothing there and would only
#                             auto-approve plan's remaining read-only guards
#                             (external_directory/doom_loop asks).
#   --follow                  (run modes + send) after the async submit, wait
#                             (bounded) for the turn to finish and print the
#                             reply inline. Run-mode default timeout 300s then
#                             leaves it running; send's DEFAULT delivery is this
#                             loop (300s, --timeout tunable).
#   --background              (run modes + send) the job runs in the BACKGROUND
#                             on the persistent opencode server (detached, no
#                             terminal; it survives this process). The wrapper
#                             then WAITS for the turn to complete, prints only
#                             the distilled result, and EXITs 0 — launch the
#                             wrapper itself as a background task and the caller
#                             (e.g. Claude Code) is woken on that exit
#                             ("wake-on-complete"): only the waiting wrapper
#                             blocks, never the session. No short deadline:
#                             ~24h default; --timeout 0 = truly unbounded.
#                             Exits non-zero on turn error or if the server
#                             becomes unreachable. DEFAULT for all run modes
#                             (unless --wait/--follow/--direct); for send it
#                             must be requested (--background or --wait).
#   --wait                    (run modes + send) FOREGROUND blocking wait: block
#                             the session until the turn completes, then print
#                             the result — call the wrapper in the FOREGROUND
#                             (not as a background task), so the caller waits
#                             inline for the answer. Same completion loop as
#                             --background (24h backstop, stall guard, distilled
#                             result, exit 0); the difference is the launch:
#                             --wait blocks the session, --background does not
#                             (wake-on-complete). Last one given wins.
#   --timeout <N>             (with --follow/--background) max seconds to wait.
#                             --follow default 300 then leaves it running;
#                             --background default ~24h then exits non-zero.
#                             0 = unbounded (--background).
#   --stall <N>               (with --background) give up if the session makes NO
#                             progress for N seconds — its newest message
#                             timestamp stops advancing (default 900; 0 = off;
#                             env OPENCODE_DISPATCH_STALL_SECS). Catches hung
#                             turns that read as "working" forever. Exit 8.
#   --require-dir             (task/bulk with --follow/--background) hard-fail if the
#                             server's cwd differs from --dir: abort the session
#                             and exit 9 instead of just warning. Use to stop a
#                             subagent editing the wrong (shared) tree.
#   --orchestration-root <p>  Directory containing spawn-agent.mjs and the
#                             worktree lifecycle helpers (task/bulk).
#   --task <id>               Resolve a worker task record for lifecycle commands.
#   --teardown                (task/bulk with --background/--wait) when the turn completes
#                             successfully, automatically run the teardown described under
#                             the `teardown` mode. Left-behind files are listed first. On a
#                             failed/timed-out/stalled turn nothing is removed. The result is
#                             only the final message — commit or copy anything you need FIRST
#                             (the worker should commit/push its own work).
#                             Requires --background/--wait (not --follow/--direct) and a
#                             clean exit 0; also needs the worker process exited and the
#                             server reachable (see `teardown`). Uncommitted files are lost.
#   --json                    (run modes, --direct only) raw JSON events
#   --tail <N>                (history) keep only the last N lines (default 100)
#   --turns <N>               (history) keep only the last N prompts + their responses
#                             (alias --prompts). Output stays bounded by the
#                             line cap (--tail or 100 lines).
#   --since <range>           (history) only messages newer than now-range (1d/6h/10m/30s/2w)
#   --wait                    (send) block for the reply — selects the completion
#                             loop (24h backstop, stall guard, exit codes 3/7/8)
#   --background              (send) same completion loop as --wait (equivalent
#                             code path; caller-side launch convention only)
#   --steer                   (send) inject into the in-progress turn
#   --queue                   (send) append after the current turn
#   --port <N>                Server port (profile field, or $OPENCODE_DISPATCH_PORT, or 4096)
#   --host <addr>             Server ADDRESSABLE host — how the dispatcher reaches the
#                             server (profile field, or $OPENCODE_DISPATCH_HOST, or the
#                             listen address). NEVER 0.0.0.0/:: (unreachable).
#   --listen <addr>           (serve) bind interface passed to `opencode serve
#                             --hostname` (profile 'listen' field; 127.0.0.1 |
#                             0.0.0.0 | an interface IP). Distinct from --host: you
#                             bind one interface but reach the server at another.
#   --server <name>           Server definition name (default: default, or
#                             $OPENCODE_DISPATCH_SERVER). Definitions live in
#                             $OPENCODE_DISPATCH_SERVERS (default
#                             ~/.config/opencode-dispatch/servers.json; sample in
#                             config/servers.json.example). Keys starting with _ are
#                             ignored. Per-field precedence:
#                             CLI flag > env (OPENCODE_DISPATCH_*) > definition.
#   --stop                    (serve) stop the running opencode server (needs
#                             lsof; uses the recorded launch args unless
#                             --port/--host are given).
#   --restart                 (serve) stop and restart the server, reusing the
#                             recorded launch args (dir/port/host/listen) overridden by
#                             any flags passed on this command line.
#   --                        Everything after this is the literal message
#
# Server auth: the resolved profile's 'password' (or $OPENCODE_SERVER_PASSWORD,
# or a .env.local in the skill dir) is used as the basic-auth password with
# username $OPENCODE_SERVER_USERNAME (default 'opencode') for every request,
# and both are exported to the launched `opencode serve` — server and clients
# always share one credential pair. Binding a non-loopback interface REQUIRES a
# password — the dispatcher refuses to start an unauthenticated server.

set -euo pipefail

# ---- .env.local credential loading ------------------------------------------
# A .env.local in the skill directory can carry OPENCODE_SERVER_USERNAME /
# OPENCODE_SERVER_PASSWORD (nothing else is read from it). Looked up in order:
# $OPENCODE_DISPATCH_ENV_FILE, then walking up from this script's directory
# (stopping at $HOME). Values apply ONLY when the variable is not already set
# in the real environment (dotenv semantics), so an exported shell var always
# wins. Only KEY=VALUE lines are parsed — never sourced, so the file cannot
# execute code.
load_env_local() {
  local f="${OPENCODE_DISPATCH_ENV_FILE:-}" d key val line
  if [ -z "$f" ]; then
    d="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    while :; do
      if [ -f "$d/.env.local" ]; then f="$d/.env.local"; break; fi
      [ "$d" = "$HOME" ] || [ "$d" = "/" ] && break
      d="$(dirname "$d")"
    done
  fi
  [ -f "$f" ] || return 0
  while IFS= read -r line; do
    case "$line" in
      ''|\#*) continue ;;
    esac
    key="${line%%=*}"
    val="${line#*=}"
    case "$val" in
      \"*\") val="${val#\"}"; val="${val%\"}" ;;
      \'*\') val="${val#\'}"; val="${val%\'}" ;;
    esac
    case "$key" in
      OPENCODE_SERVER_USERNAME|OPENCODE_SERVER_PASSWORD)
        if [ -z "${!key:-}" ]; then export "$key=$val"; fi ;;
    esac
  done < "$f"
}
load_env_local

print_usage() {
  cat <<'EOF'
Usage: opencode-dispatch.sh <mode> [flags] [message...]

Delegate work to a persistent opencode server (or run one-shot with --direct).

Modes:
  review      Review local git changes or a GitHub PR (read-only; agent 'review').
  plan        Read-only analysis/planning (agent 'plan').
  ask         Read-only question answering (agent 'plan').
  task        Agentic build task in a freshly allocated worktree (agent 'auto').
  bulk        Same as task, for background/batch work.
  serve       Start/confirm the persistent server; also --stop / --restart.
  sessions    List sessions from the server (id, updated, title).
  status      Liveness of a session (or a one-line summary of all sessions).
  history     Print a session transcript (bound with --tail/--turns/--since).
  send        Message an existing session (completion-loop reply, or --steer/--queue).
  abort       Interrupt a session's in-progress turn.
  teardown    Remove a finished task: print the files left in its worktree (first
              80 bytes of the first 5), delete the worktree, and delete the session's
              rows from the OpenCode database (session + event_sequence).
              Usage: teardown --task <taskID> [--force]
              Requires: a task/bulk worker record; worker process exited; no active
              turn; server reachable with a session directory matching the worktree
              (unreachable = unknown = refused); sqlite3 + the DB file for the DB step
              (else the worktree is still removed and the DB is reported not cleaned).
              --force aborts the session and kills the matching process first.
  permissions List pending permission requests on the server.
  allow       Approve a pending permission request (--always remembers it).
  follow      Watch an existing session read-only; prints new output until the
              turn completes (sends nothing; --timeout <N> to bound the wait).
  setup       Show executable, server, auth, and model diagnostics.
  identify    Print this agent session's identity (session id, slug, agent).
  claim       Atomically claim a unit of work (claim <unit>).
  release     Release a claim owned by this session (release <unit>).

Run-mode flags (review|plan|ask|task|bulk):
  --background        DEFAULT: the job runs in the background on the server;
                      the wrapper waits until the turn completes, prints the
                      distilled result, and exits 0 (wake-on-complete).
  --wait              Foreground blocking wait: the session blocks until the
                      turn completes (call the wrapper inline, not backgrounded).
  --follow            Bounded foreground wait (300s); leaves the session running.
  --direct            One-shot 'opencode run' bypassing the server (read-only
                      modes only; unobservable, not killable). --auto is passed
                      only for review (its edit/webfetch are explicitly denied);
                      plan/ask run without it (bash is already allow-by-default
                      there, and --auto would only lift plan's read-only asks).
  --timeout <N>       Max seconds to wait (--follow: 300; --background: ~24h;
                      0 = unbounded).
  --stall <N>         With --background: give up after N seconds without
                      progress (default 900; 0 = off).
  --model <provider/model>  Explicit model, e.g. deepseek/deepseek-v4-flash.
  --effort <low|medium|high|xhigh|max>  Reasoning effort (maps to --variant).
  --variant <name>    Raw provider variant passthrough.
  --agent <name>      Override the agent (plan|ask -> plan; task|bulk -> auto).
  --dir <path>        Directory to root the session in (default: current dir).
  --prompt-file <path>  Preferred prompt source (alias: --brief). Plain
                      positional prompt text
                      is also accepted (space-joined); the two are mutually
                      exclusive.
  --json              With --direct: raw JSON events.

Send flags (send):
  --background/--wait Select the completion loop (24h backstop, stall guard,
                      parked-permission heartbeat, distilled reply; exit codes
                      3 = timeout, 7 = server unreachable, 8 = stall). --wait
                      and --background are equivalent code paths (caller-side
                      launch convention only).
  --follow            Bounded completion wait (DEFAULT for send: 300s,
                      --timeout tunable); prints the reply and exits 0 on
                      timeout, leaving the turn running.
  --timeout/--stall   As in run-mode flags above.

Review-only flags:
  --base <ref>        Diff base ref (the job's base branch), e.g. main.
  --pr <n>            Review GitHub PR #n (needs gh + auth).
  --repo <owner/repo> Explicit repo for --pr when --dir has no git remote.
  --scope <auto|working-tree|branch>  What to diff; branch requires --base.

Task/bulk-only flags:
  --orchestration-root <p>  Directory with spawn-agent.mjs + worktree helpers.
  --worktree-root <p>  Override the worktree allocation root.
  --teardown          With --background/--wait: after a clean completion, list
                      leftover files (80 bytes of the first 5), remove the
                      worktree, and delete the session's DB rows. Or run it
                      yourself later: teardown --task <id> [--force].
                      Needs a clean turn exit (0), worker process exited, server
                      reachable; skipped for --follow/--direct or failed turns.
  --require-dir       With --follow/--background: abort if the server cwd
                      differs from --dir.

Serve flags:
  --stop              Stop the running server (recorded launch args, or an
                      explicit --port/--host; never guesses a port).
  --restart           Restart using the recorded launch args, overridden by
                      any flags passed now (e.g. --restart --port 5000).

Server selection (all server-backed modes):
  --server <name>     Named server definition (default: 'default').
                      Definitions file: $OPENCODE_DISPATCH_SERVERS (default
                      ~/.config/opencode-dispatch/servers.json).
  --listen <addr>     (serve) bind interface for `opencode serve --hostname`
                      (127.0.0.1 | 0.0.0.0 | an interface IP). The server is
                      still REACHED at --host — never 0.0.0.0.

Session/control flags:
  --task <id>         Resolve a worker task record for status/history/send/abort.
  --tail <N>          (history/sessions) keep only the last N lines/entries.
  --turns <N>         (history) keep only the last N prompts + their responses.
  --since <range>     (history) only messages newer than now-range (1d/6h/10m/30s).
  --steer             (send) inject into the in-progress turn.
  --queue             (send) append after the current turn.
  --always            (allow) also remember the pattern for the session.
  --port <N>          Server port (profile field, or $OPENCODE_DISPATCH_PORT, or 4096).
  --host <addr>       Server ADDRESSABLE host — how the dispatcher reaches the
                      server (never 0.0.0.0/::).
  --                  Everything after is literal message text.

Notes:
  - Run modes are server-backed; the server auto-starts if none is reachable.
  - Server definitions: per-server bind interface ('listen') vs addressable
    host ('host'); binding a non-loopback interface requires a password.
  - --await was removed (use --background); --no-await was removed (use --wait).
  - Server auth: OPENCODE_SERVER_USERNAME (default 'opencode') +
    OPENCODE_SERVER_PASSWORD (or the profile's password field) must match
    'opencode serve'. A .env.local in the skill dir can supply both.
  - Never pipe this script's output through tail (a PreToolUse hook blocks it).
EOF
}

MODE="${1:-}"
if [ -z "$MODE" ]; then
  echo "error: mode required (review|plan|ask|task|bulk|serve|sessions|status|history|send|abort|teardown|permissions|allow|follow|setup|identify|claim|release)" >&2
  echo "  Run: $(basename "$0") --help" >&2
  exit 2
fi
shift || true

# --help / --usage / -? anywhere on the command line prints the reference.
if [ "$MODE" = "--help" ] || [ "$MODE" = "--usage" ] || [ "$MODE" = "-?" ]; then
  print_usage
  exit 0
fi
for _a in "$@"; do
  case "$_a" in
    --help|--usage|-?) print_usage; exit 0 ;;
  esac
done

if ! command -v opencode >/dev/null 2>&1; then
  echo "error: opencode is not installed or not on PATH." >&2
  echo "  Install: brew install sst/tap/opencode   (or: npm i -g opencode-ai)" >&2
  exit 4
fi

MODEL="${OPENCODE_DISPATCH_MODEL:-}"
AGENT=""
VARIANT=""
EFFORT=""
BASE=""
REPO=""
PR=""
SCOPE=""
DIR="$PWD"
FORMAT=""
TAIL="100"
TAIL_SET=""
TURNS=""
SINCE=""
STEER=""
QUEUE=""
WAIT=""
DIRECT=""
FOLLOW=""
AWAIT=""
NO_AWAIT=""
ALWAYS=""
FOLLOW_TIMEOUT="300"
TIMEOUT_SET=""
# --background stall guard: give up if the session makes NO progress (its newest
# message timestamp stops advancing) for this many seconds. Catches hung turns
# that read as "working" forever — the 20h-zombie failure mode. 0 = disable.
STALL_SECS="${OPENCODE_DISPATCH_STALL_SECS:-900}"
# --require-dir: hard-fail (abort the session) if the server's cwd differs from
# --dir. Default is a loud warning only. Guards against multiple subagents all
# editing one shared server tree when they meant to target separate worktrees.
REQUIRE_DIR=""
ORCHESTRATION_ROOT="${OPENCODE_ORCHESTRATION_ROOT:-}"
WORKTREE_ROOT="${AGENT_WORKTREE_ROOT:-}"
TASK_ID=""
PROMPT_FILE=""
PORT="${OPENCODE_DISPATCH_PORT:-}"
HOST="${OPENCODE_DISPATCH_HOST:-}"
PORT_SET=""
HOST_SET=""
LISTEN=""
LISTEN_SET=""
SERVER_NAME="${OPENCODE_DISPATCH_SERVER:-}"
SERVER_SET=""
SERVERS_FILE="${OPENCODE_DISPATCH_SERVERS:-$HOME/.config/opencode-dispatch/servers.json}"
DIR_SET=""
STOP=""
RESTART=""
TEARDOWN=""
TEARDOWN_FORCE=""
MSG_PARTS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --model)             MODEL="${2:-}"; shift 2 ;;
    --agent)             AGENT="${2:-}"; shift 2 ;;
    --effort)            EFFORT="${2:-}"; shift 2 ;;
    --variant)           VARIANT="${2:-}"; shift 2 ;;
    --base)              BASE="${2:-}"; shift 2 ;;
    --pr)                PR="${2:-}"; shift 2 ;;
    --repo)              REPO="${2:-}"; shift 2 ;;
    --scope)             SCOPE="${2:-}"; shift 2 ;;
    --dir)               DIR="${2:-}"; DIR_SET=1; shift 2 ;;
    --prompt-file|--brief) PROMPT_FILE="${2:-}"; shift 2 ;;
    --json)              FORMAT="json"; shift ;;
    --tail)              TAIL="${2:-}"; TAIL_SET=1; shift 2 ;;
    --turns|--prompts)   TURNS="${2:-}"; shift 2 ;;
    --since)             SINCE="${2:-}"; shift 2 ;;
    --steer)             STEER=1; shift ;;
    --queue)             QUEUE=1; shift ;;
    --wait)              WAIT=1; AWAIT=1; NO_AWAIT=""; shift ;;
    --background)        AWAIT=1; NO_AWAIT=""; shift ;;
    --await)             echo "error: --await was removed — use --background instead (the default: job runs in the background, wrapper waits, caller woken on completion) or --wait (blocks the session until the turn completes)." >&2; exit 2 ;;
    --direct)            DIRECT=1; shift ;;
    --follow)            FOLLOW=1; shift ;;
    --always)            ALWAYS=1; shift ;;
    --summarize)         echo "error: --summarize was removed — run modes now always return the session transcript's final message (no remote summary step)" >&2; exit 2 ;;
    --timeout)           FOLLOW_TIMEOUT="${2:-}"; TIMEOUT_SET=1; shift 2 ;;
    --stall)             STALL_SECS="${2:-}"; shift 2 ;;
    --require-dir)       REQUIRE_DIR=1; shift ;;
    --orchestration-root) ORCHESTRATION_ROOT="${2:-}"; shift 2 ;;
    --worktree-root)     WORKTREE_ROOT="${2:-}"; shift 2 ;;
    --task)              TASK_ID="${2:-}"; shift 2 ;;
    --teardown)          TEARDOWN=1; shift ;;
    --force)             TEARDOWN_FORCE=1; shift ;;
    --port)              PORT="${2:-}"; PORT_SET=1; shift 2 ;;
    --host)              HOST="${2:-}"; HOST_SET=1; shift 2 ;;
    --listen)            LISTEN="${2:-}"; LISTEN_SET=1; shift 2 ;;
    --server)            SERVER_NAME="${2:-}"; SERVER_SET=1; shift 2 ;;
    --stop)              STOP=1; shift ;;
    --restart)           RESTART=1; shift ;;
    --)                  shift; MSG_PARTS+=("$@"); break ;;
    *)                   MSG_PARTS+=("$1"); shift ;;
  esac
done

# ---- server definition resolution --------------------------------------------
# Named profiles in $SERVERS_FILE (sample: config/servers.json.example). Each profile
# separates the BIND interface ('listen', passed to `opencode serve
# --hostname`) from the ADDRESSABLE host the dispatcher reaches it at
# ('host') — the address can never be 0.0.0.0/::, and binding a non-loopback
# interface requires a password. Per-field precedence:
#   CLI flag > env (OPENCODE_DISPATCH_*) > definition field > default.
# Definition keys starting with `_` are ignored (documentation examples).
# (serve) `serve <name>` is shorthand for `serve --server <name>`.
[ "$MODE" = "serve" ] && [ -n "${MSG_PARTS[0]:-}" ] && SERVER_NAME="${MSG_PARTS[0]}"
SERVER_NAME="${SERVER_NAME:-default}"
case "$SERVER_NAME" in
  ""|*[!A-Za-z0-9._-]*)
    echo "error: invalid server name: '$SERVER_NAME' (use letters, digits, . _ -)" >&2; exit 2 ;;
esac
# Fields are joined with \x1f (unit separator) — NOT tab: tab is IFS whitespace,
# so bash `read` collapses empty middle fields (e.g. an unset 'dir' would push
# the password into the wrong variable). \x1f is literal, so every field slot
# survives, including empty ones.
IFS=$'\x1f' read -r SERVER_NAME LISTEN HOST PORT SERVE_DIR SERVE_PASSWORD DEF_MODEL < <(
  SRV_NAME="$SERVER_NAME" SERVERS_FILE="$SERVERS_FILE" \
  CLI_LISTEN="$LISTEN" CLI_HOST="$HOST" CLI_PORT="$PORT" \
  ENV_LISTEN="${OPENCODE_DISPATCH_LISTEN:-}" \
  ENV_HOST="${OPENCODE_DISPATCH_HOST:-}" \
  ENV_PORT="${OPENCODE_DISPATCH_PORT:-}" \
  ENV_PASSWORD="${OPENCODE_SERVER_PASSWORD:-}" \
  node - <<'EOF'
    const fs = require("fs");
    const file = process.env.SERVERS_FILE;
    let defs = {};
    if (fs.existsSync(file)) {
      try { defs = JSON.parse(fs.readFileSync(file, "utf8")); }
      catch (e) { console.error(`error: ${file} is not valid JSON: ${e.message}`); process.exit(1); }
    }
    const name = process.env.SRV_NAME || "default";
    const d = defs[name] || {};
    if (name !== "default" && !(name in defs)) {
      console.error(`error: no server definition '${name}' in ${file}`);
      process.exit(1);
    }
    const loopback = (a) => a === "localhost" || a === "::1" || /^127\./.test(a);
    const listen = process.env.CLI_LISTEN || process.env.ENV_LISTEN || d.listen || "127.0.0.1";
    // Addressable host defaults to the listen address when that is concrete
    // (loopback or an interface IP); a wildcard bind (0.0.0.0/::) has no
    // addressable form and REQUIRES an explicit host.
    let host = process.env.CLI_HOST || process.env.ENV_HOST
      || d.host || (loopback(listen) ? listen : "");
    const port = parseInt(process.env.CLI_PORT || process.env.ENV_PORT || d.port || "4096", 10);
    const pass = process.env.ENV_PASSWORD || d.password || "";
    const dir = d.dir || "";
    const model = d.model || "";
    if (!(port >= 1 && port <= 65535)) {
      console.error(`error: invalid port ${port} for server '${name}'`); process.exit(1);
    }
    if (host === "" || host === "0.0.0.0" || host === "::") {
      console.error(`error: server '${name}' has no reachable address (host can never be 0.0.0.0/::) — set 'host' in the definition, or bind loopback and let the host default to it`);
      process.exit(1);
    }
    process.stdout.write([name, listen, host, port, dir, pass, model].join("\x1f") + "\n");
EOF
) || exit 2
# Binding a non-loopback interface without a password would expose an
# unauthenticated server on the network — refuse.
case "$LISTEN" in
  127.*|localhost|::1) ;;
  *)
    if [ -z "$SERVE_PASSWORD" ]; then
      echo "error: server '$SERVER_NAME' binds non-loopback interface '$LISTEN' — set 'password' in the definition (or OPENCODE_SERVER_PASSWORD), or it would be reachable without auth" >&2
      exit 2
    fi ;;
esac
# Profile fields feed the session defaults: directory root + dispatch model.
[ -z "$DIR_SET" ] && [ -n "$SERVE_DIR" ] && DIR="$SERVE_DIR"
[ -z "$MODEL" ] && [ -n "$DEF_MODEL" ] && MODEL="$DEF_MODEL"
# Per-name launch record so stop/restart target the named server only.
SERVE_ARGS_FILE="${TMPDIR:-/tmp}/opencode-serve/serve-${SERVER_NAME}.args"

BASE_URL="http://${HOST}:${PORT}"
# opencode serve's basic auth pairs a username (OPENCODE_SERVER_USERNAME,
# default 'opencode' — the server validates it, verified on 1.18.9) with the
# password. Both the launched server and every client use the SAME resolved
# pair, so a .env.local / env change never desyncs them.
SERVER_USERNAME="${OPENCODE_SERVER_USERNAME:-opencode}"
CURL_AUTH=()
[ -n "${SERVE_PASSWORD:-}" ] && CURL_AUTH=( --user "${SERVER_USERNAME}:${SERVE_PASSWORD}" )

# Per-session working directory. Every /session endpoint takes ?directory=<path>,
# so ONE server can root each session in its own dir — no server-per-worktree.
# We pass --dir on create + prompt so `task --dir <worktree>` truly runs there,
# even when reusing a server started elsewhere. URL-encode it once here.
DIR_Q="directory=$(printf '%s' "$DIR" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(encodeURIComponent(d)))')"

refresh_dir_query() {
  DIR_Q="directory=$(printf '%s' "$DIR" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(encodeURIComponent(d)))')"
}

resolve_task_context() {
  [ -n "$TASK_ID" ] || return 0
  local orch="${ORCHESTRATION_ROOT:-$DIR/scripts}" status_json
  [ -f "$orch/agent-status.mjs" ] || { echo "error: task lifecycle helper not found: $orch/agent-status.mjs" >&2; exit 5; }
  status_json="$(node "$orch/agent-status.mjs" --from "$DIR" --worktree-root "${WORKTREE_ROOT:-}" --task "$TASK_ID" --json)" || exit 5
  IFS=$'\t' read -r SID DIR < <(printf '%s' "$status_json" | node -e '
    const rows=JSON.parse(require("fs").readFileSync(0,"utf8"));
    const r=rows[0]; if(!r?.sessionId||!r?.worktreePath) process.exit(1);
    process.stdout.write(`${r.sessionId}\t${r.worktreePath}\n`);') || {
      echo "error: task $TASK_ID has no active session/worktree" >&2; exit 5;
    }
  refresh_dir_query
}

# --model must be provider/model (e.g. deepseek/deepseek-v4-pro), not a bare id.
if [ -n "$MODEL" ] && [ "${MODEL#*/}" = "$MODEL" ]; then
  echo "error: --model must be provider/model, e.g. deepseek/${MODEL}" >&2
  exit 2
fi

# --effort accepts the codex-style effort levels and maps to the provider's
# variant; --variant remains the raw, unvalidated passthrough.
if [ -n "$EFFORT" ]; then
  case "$EFFORT" in
    low|medium|high|xhigh|max) VARIANT="$EFFORT" ;;
    *) echo "error: --effort must be one of low|medium|high|xhigh|max (got: $EFFORT); use --variant for provider-specific names" >&2; exit 2 ;;
  esac
fi

# --scope: auto (default) | working-tree | branch. Review-only; enforced with
# the --pr gate below.
case "$SCOPE" in
  ""|auto|working-tree|branch) ;;
  *) echo "error: --scope must be one of auto|working-tree|branch (got: $SCOPE)" >&2; exit 2 ;;
esac

# Tasks default to --background: every run mode sends the job to the background
# and blocks until the turn completes (wake-on-complete — the caller's session
# is never blocked because the wrapper is launched as a background task and its
# exit wakes the caller). --wait is the foreground blocking form (it BLOCKS the
# session until the turn completes); --follow is the bounded wait; --direct is
# the one-shot.
case "$MODE" in
  review|plan|ask|task|bulk)
    if [ -z "$DIRECT" ] && [ -z "$FOLLOW" ] && [ -z "$AWAIT" ] && [ -z "$NO_AWAIT" ]; then
      AWAIT=1
    fi
    ;;
esac

# ---- plain positional prompt support -----------------------------------------
# Inline prompt text IS accepted for run modes and send — but never kept in
# this process's argv for the run. It is written to a temp file immediately and
# the script re-executes itself with --prompt-file, so `ps` shows the prompt
# only in the invoking shell's one-line command string (unavoidable for any
# CLI that takes a positional prompt) and in the file, never in the long-lived
# process. --prompt-file remains the preferred, fully-clean path.
prompt_rebuild() {  # $1 = leading positional arg to keep ("" = none); rest = prompt words
  local lead="$1"; shift
  local tmp
  tmp="$(mktemp "${TMPDIR:-/tmp}/opencode-msg.XXXXXX")"
  # Space-join the positional arguments into one line, matching the codex
  # plugin's `positionals.join(" ")`: no line breaks appear unless an argument
  # itself contains one.
  printf '%s\n' "$*" > "$tmp"
  local args=("$MODE")
  [ -n "$lead" ] && args+=("$lead")
  [ -n "$MODEL" ] && args+=( --model "$MODEL" )
  [ -n "$AGENT" ] && args+=( --agent "$AGENT" )
  [ -n "$VARIANT" ] && args+=( --variant "$VARIANT" )
  [ -n "$BASE" ] && args+=( --base "$BASE" )
  [ -n "$REPO" ] && args+=( --repo "$REPO" )
  [ -n "$PR" ] && args+=( --pr "$PR" )
  [ -n "$SCOPE" ] && args+=( --scope "$SCOPE" )
  args+=( --dir "$DIR" )
  [ -n "$FORMAT" ] && args+=( --json )
  [ -n "$TAIL_SET" ] && args+=( --tail "$TAIL" )
  [ -n "$TURNS" ] && args+=( --turns "$TURNS" )
  [ -n "$SINCE" ] && args+=( --since "$SINCE" )
  [ -n "$STEER" ] && args+=( --steer )
  [ -n "$QUEUE" ] && args+=( --queue )
  [ -n "$DIRECT" ] && args+=( --direct )
  [ -n "$FOLLOW" ] && args+=( --follow )
  [ -n "$AWAIT" ] && args+=( --background )
  [ -n "$NO_AWAIT" ] && args+=( --wait )
  [ -n "$ALWAYS" ] && args+=( --always )
  [ -n "$TIMEOUT_SET" ] && args+=( --timeout "$FOLLOW_TIMEOUT" )
  args+=( --stall "$STALL_SECS" )
  [ -n "$REQUIRE_DIR" ] && args+=( --require-dir )
  [ -n "$ORCHESTRATION_ROOT" ] && args+=( --orchestration-root "$ORCHESTRATION_ROOT" )
  [ -n "$WORKTREE_ROOT" ] && args+=( --worktree-root "$WORKTREE_ROOT" )
  [ -n "$TASK_ID" ] && args+=( --task "$TASK_ID" )
  [ -n "$TEARDOWN" ] && args+=( --teardown )
  # Only re-pass --server when the user EXPLICITLY set it: SERVER_NAME is
  # defaulted to "default" before rebuild runs, so an unconditional re-pass
  # would clobber a $OPENCODE_DISPATCH_SERVER env selection on the re-exec.
  [ -n "$SERVER_SET" ] && args+=( --server "$SERVER_NAME" )
  args+=( --port "$PORT" )
  args+=( --host "$HOST" )
  args+=( --prompt-file "$tmp" )
  exec bash "$0" "${args[@]}"
}

case "$MODE" in
  review|plan|ask|task|bulk)
    if [ "${#MSG_PARTS[@]}" -gt 0 ]; then
      if [ -n "$PROMPT_FILE" ]; then
        echo "error: positional prompt text and --prompt-file are mutually exclusive" >&2; exit 2
      fi
      prompt_rebuild "" "${MSG_PARTS[@]}"
    fi
    ;;
  send)
    if [ "${#MSG_PARTS[@]}" -gt 0 ]; then
      if [ -n "$PROMPT_FILE" ]; then
        # Re-exec state: the message already lives in the file and the only
        # positional is the <sessionID> (the rebuild passes it as the lead
        # arg) — nothing to rebuild. A genuine conflict carries the message
        # as an EXTRA positional (or any positional at all under --task,
        # where the SID comes from the task record instead).
        if [ -n "$TASK_ID" ] || [ "${#MSG_PARTS[@]}" -gt 1 ]; then
          echo "error: positional message and --prompt-file are mutually exclusive" >&2; exit 2
        fi
      elif [ -n "$TASK_ID" ]; then
        prompt_rebuild "" "${MSG_PARTS[@]}"
      else
        prompt_rebuild "${MSG_PARTS[0]}" "${MSG_PARTS[@]:1}"
      fi
    fi
    ;;
esac

# --background blocks to completion: no short deadline. Default backstop ~24h unless
# the caller set --timeout (0 = unbounded). --follow keeps its 300s default.
if [ -n "$AWAIT" ] && [ -z "$TIMEOUT_SET" ]; then FOLLOW_TIMEOUT="86400"; fi

server_up() { curl -sf -m 3 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} "$BASE_URL/session" -o /dev/null 2>/dev/null; }

# parked_permission <sessionID> [timeout-s] — echoes a descriptor when the
# session is parked on an open ask: a permission request ("per_xxx bash ls
# /tmp") OR a question ask ("que_xxx [question] header"). Both queues are
# IN-MEMORY on the server — a restart loses them while the session stays
# stuck, and /question has been observed empty while a question ask was
# pending — so the wait loops fall back to the durable message-stream signal
# (see pending_ask); the status paths also detect parking durably (tool part
# stuck in state.status "running" with no time.end).
parked_permission() {
  local tmo="${2:-5}"
  curl -sf -m "$tmo" ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} "$BASE_URL/permission" 2>/dev/null \
    | PERMSID="$1" node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const a=JSON.parse(d);const p=(a||[]).find(x=>x.sessionID===process.env.PERMSID);if(!p)process.exit(0);process.stdout.write(p.id+" "+p.permission+" "+((p.patterns||[]).join(" ")))}catch(e){process.exit(0)}})' 2>/dev/null || true
  curl -sf -m "$tmo" ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} "$BASE_URL/question" 2>/dev/null \
    | PERMSID="$1" node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const a=JSON.parse(d);const p=(a||[]).find(x=>x.sessionID===process.env.PERMSID);if(!p)process.exit(0);const q=(p.questions||[])[0]||{};process.stdout.write(p.id+" [question] "+((q.header||q.question||"").slice(0,80)))}catch(e){process.exit(0)}})' 2>/dev/null || true
}

# pending_ask <sessionID> <stuckTool> <toolStartMs> <questionHeader> — echoes a
# descriptor when the session is parked on an ask. Sources, in order:
#   1. the server's in-memory /permission + /question queues (short timeout —
#      this is polled every loop wake while a turn is working; queue
#      descriptors carry a request id the `allow` mode can reply to);
#   2. the durable message-stream signal, passed in by the caller from the
#      transcript it already fetched: the newest assistant turn holds a tool
#      part stuck in state.status "running" with no time.end. A stuck
#      `question` tool IS a parked ask (it waits on a human); other stuck
#      tools are long-running work, not asks (the caller renders them as
#      activity, not parking). A stream-only question ask has no reply path —
#      abort is the only way out (matches `status`).
pending_ask() {
  local sid="$1" tp="$2" qh="${4:-}" desc
  desc="$(parked_permission "$sid" 3)"
  if [ -n "$desc" ]; then printf '%s' "$desc"; return 0; fi
  if [ "$tp" = "question" ]; then
    printf '%s' "que_stream [question] ${qh:-?} (queue lost — no reply path; abort if it never finishes)"
  fi
  return 0
}

require_server() {
  if ! server_up; then
    echo "error: no opencode server reachable at $BASE_URL" >&2
    echo "  Start one: $(basename "$0") serve --port $PORT" >&2
    exit 5
  fi
}

SERVE_LOG=""
start_server() {  # $1=dir (default $DIR) $2=port (default $PORT) $3=listen (default $LISTEN) $4=password
  local dir="${1:-$DIR}" port="${2:-$PORT}" listen="${3:-$LISTEN}" pass="${4:-$SERVE_PASSWORD}"
  local logdir="${TMPDIR:-/tmp}/opencode-serve"; mkdir -p "$logdir"
  SERVE_LOG="$logdir/serve-${port}.log"
  if [ -n "$pass" ]; then
    ( cd "$dir" 2>/dev/null && exec env OPENCODE_SERVER_USERNAME="${SERVER_USERNAME:-opencode}" OPENCODE_SERVER_PASSWORD="$pass" nohup opencode serve --port "$port" --hostname "$listen" </dev/null >"$SERVE_LOG" 2>&1 ) &
  else
    ( cd "$dir" 2>/dev/null && exec nohup opencode serve --port "$port" --hostname "$listen" </dev/null >"$SERVE_LOG" 2>&1 ) &
  fi
  disown 2>/dev/null || true
  local i
  for i in $(seq 1 50); do server_up && return 0; sleep 0.3; done
  return 1
}

# The last server THIS script started for the resolved server name is recorded
# (dir/port/host, one per line) in $SERVE_ARGS_FILE, so --restart can reuse the
# exact invocation and --stop can find it even when it is not on the default
# port. Each named server keeps its own record; a server started by a pre-names
# install has no per-name record, so 'default' also falls back to the legacy
# serve.args path.
write_serve_args() {  # $1=dir $2=port $3=host
  mkdir -p "$(dirname "$SERVE_ARGS_FILE")"
  printf '%s\n%s\n%s\n' "$1" "$2" "$3" > "$SERVE_ARGS_FILE"
}

read_serve_args() {  # sets RDIR/RPORT/RHOST (empty when no record exists)
  RDIR=""; RPORT=""; RHOST=""
  local f="$SERVE_ARGS_FILE"
  if [ ! -f "$f" ] && [ "$SERVER_NAME" = "default" ]; then
    f="${TMPDIR:-/tmp}/opencode-serve/serve.args"
  fi
  if [ -f "$f" ]; then
    { IFS= read -r RDIR; IFS= read -r RPORT; IFS= read -r RHOST; } < "$f" || true
  fi
}

server_pids() {  # $1=host $2=port — echo PIDs of opencode processes listening there
  # lsof @host:port does NOT match a socket bound to the wildcard (0.0.0.0/::)
  # but reached at a concrete --host (verified empirically on macOS lsof), so
  # fall back to a port-only match when the host-qualified form finds nothing.
  # The opencode command check below keeps the port-only match safe (a
  # non-opencode process on the port is filtered out).
  local pids
  pids="$(lsof -nP -tiTCP@"$1":"$2" -sTCP:LISTEN 2>/dev/null || true)"
  [ -z "$pids" ] && pids="$(lsof -nP -tiTCP:"$2" -sTCP:LISTEN 2>/dev/null || true)"
  printf '%s\n' "$pids" | while IFS= read -r pid; do
    [ -n "$pid" ] && ps -o command= -p "$pid" 2>/dev/null | grep -q opencode && echo "$pid"
  done
}

stop_server() {  # stop the recorded server (or an explicitly-named --port/--host)
  if ! command -v lsof >/dev/null 2>&1; then
    echo "error: --stop/--restart need lsof (brew install lsof)" >&2
    return 1
  fi
  read_serve_args
  # Safety: never guess a port. Use the recorded invocation; without one, only
  # stop a server the caller explicitly named with --port/--host.
  local sport="${RPORT:-}" shost="${RHOST:-}" pids
  if [ -z "$sport" ]; then
    if [ -z "$PORT_SET" ] && [ -z "$HOST_SET" ]; then
      echo "error: no recorded server to stop — pass --port <N> [--host <addr>] explicitly" >&2
      return 1
    fi
    sport="$PORT"; shost="$HOST"
  fi
  pids="$(server_pids "$shost" "$sport")"
  if [ -z "$pids" ]; then
    echo "no opencode server running on $shost:$sport"
    return 0
  fi
  for pid in $pids; do
    echo "stopping opencode server (pid $pid) on $shost:$sport"
    kill "$pid" 2>/dev/null || true
  done
  local i
  for i in $(seq 1 40); do [ -z "$(server_pids "$shost" "$sport")" ] && break; sleep 0.25; done
  if [ -n "$(server_pids "$shost" "$sport")" ]; then
    echo "graceful stop timed out; forcing SIGKILL" >&2
    for pid in $(server_pids "$shost" "$sport"); do kill -9 "$pid" 2>/dev/null || true; done
    sleep 1
  fi
  if [ -n "$(server_pids "$shost" "$sport")" ]; then
    echo "error: could not stop server on $shost:$sport" >&2
    return 1
  fi
  echo "stopped: opencode server on $shost:$sport"
  rm -f "$SERVE_ARGS_FILE"
  [ "$SERVER_NAME" = "default" ] && rm -f "${TMPDIR:-/tmp}/opencode-serve/serve.args"
  return 0
}

ensure_server() {  # auto-start in $DIR if none is reachable
  server_up && return 0
  echo "no opencode server ($SERVER_NAME) at $BASE_URL — starting one in ${DIR}…" >&2
  start_server "$DIR" || { echo "error: server did not start; see $SERVE_LOG" >&2; exit 6; }
}

# --- server API helpers (used by the default server-backed run path) ---
oc_create_session() {  # $1=agent $2=model $3=variant $4=title $5=permJson(optional) -> echoes id
  AGENT="$1" MODEL="$2" VARIANT="$3" TITLE="$4" PERM="${5:-}" node -e '
    const b={title:process.env.TITLE};
    if(process.env.AGENT) b.agent=process.env.AGENT;
    if(process.env.MODEL){const i=process.env.MODEL.indexOf("/");
      b.model={providerID:process.env.MODEL.slice(0,i), id:process.env.MODEL.slice(i+1)};
      if(process.env.VARIANT) b.model.variant=process.env.VARIANT;}
    if(process.env.PERM) b.permission=JSON.parse(process.env.PERM);
    process.stdout.write(JSON.stringify(b));' \
  | curl -sf -m 15 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} -X POST "$BASE_URL/session?$DIR_Q" -H 'content-type: application/json' --data-binary @- \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).id)}catch(e){process.exit(1)}});'
}

# The agent MUST be repeated on the prompt. The agent passed to POST /session is
# not inherited by the turn: without it here every server-backed turn runs as the
# server default (`build`), whatever the session was created as. That silently
# defeated the `review` agent's read-only denies (bash/edit/webfetch) AND its
# permission block, so review turns both had write access they should not have
# and parked forever on an external_directory prompt no one could answer.
# Verified via `select json_extract(data,'$.agent') from message` — every review
# session pre-fix reads `build`.
# Same bug, other half: the model/effort passed to POST /session is likewise
# not inherited by the turn — the turn runs on the agent's configured model
# from opencode.json unless prompt_async's own `model`/`variant` fields are
# set. Confirmed against the running server's OpenAPI doc (GET /doc) for
# POST /session/{id}/prompt_async: model is {providerID, modelID} (note:
# modelID here, NOT `id` as on session create), and variant is a top-level
# sibling field, not nested under model.
oc_submit_async() {  # $1=sessionId $2=path-to-message-text-file $3=agent(optional) $4=model(optional provider/model) $5=variant(optional)
  MSGFILE="$2" AGENT_ID="${3:-}" MODEL_ID="${4:-}" VARIANT_ID="${5:-}" node -e '
    const fs=require("fs");
    const b={parts:[{type:"text",text:fs.readFileSync(process.env.MSGFILE,"utf8")}]};
    if(process.env.AGENT_ID) b.agent=process.env.AGENT_ID;
    if(process.env.MODEL_ID){const m=process.env.MODEL_ID,i=m.indexOf("/");
      b.model={providerID:m.slice(0,i), modelID:m.slice(i+1)};}
    if(process.env.VARIANT_ID) b.variant=process.env.VARIANT_ID;
    process.stdout.write(JSON.stringify(b));' \
  | curl -sf -m 20 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} -X POST "$BASE_URL/session/$1/prompt_async?$DIR_Q" -H 'content-type: application/json' --data-binary @-
}

# ---- setup -------------------------------------------------------------------
if [ "$MODE" = "setup" ]; then
  echo "opencode:  $(command -v opencode)"
  opencode --version 2>/dev/null | sed 's/^/version:   /' || true
  echo "config:    $HOME/.config/opencode/opencode.json"
  echo "servers:   $SERVERS_FILE"
  # Every defined server, with its bind vs addressable split and live state.
  # '*' marks the one this invocation resolves (--server / OPENCODE_DISPATCH_SERVER).
  while IFS=$'\x1f' read -r n l h p d pw m; do
    [ -n "$n" ] || continue
    mark=" "; [ "$n" = "$SERVER_NAME" ] && mark="*"
    # The marked row shows the RESOLVED values (CLI/env overrides applied).
    if [ "$n" = "$SERVER_NAME" ]; then
      l="$LISTEN"; h="$HOST"; p="$PORT"; d="$SERVE_DIR"; pw="$SERVE_PASSWORD"; m="$DEF_MODEL"
    fi
    url="http://${h}:${p}"
    auth=(); [ -n "$pw" ] && auth=( --user "${SERVER_USERNAME:-opencode}:${pw}" )
    if curl -sf -m 2 ${auth[@]:+"${auth[@]}"} "$url/session" -o /dev/null 2>/dev/null; then st="UP"; else st="down"; fi
    printf '%s %-16s %-14s -> %-22s %-5s %s%s\n' "$mark" "$n" "listen:$l" "$h:$p" "$st" "${m:+model: $m }" "${d:+dir: $d}"
  done < <(
    SERVERS_FILE="$SERVERS_FILE" node - <<'EOF'
      const fs = require("fs");
      const file = process.env.SERVERS_FILE;
      let defs = {};
      if (fs.existsSync(file)) {
        try { defs = JSON.parse(fs.readFileSync(file, "utf8")); }
        catch (e) { console.error(`error: ${file} is not valid JSON: ${e.message}`); process.exit(1); }
      }
      const loopback = (a) => a === "localhost" || a === "::1" || /^127\./.test(a);
      for (const [k, v] of Object.entries(defs)) {
        if (k.startsWith("_")) continue;  // documentation keys
        const listen = v.listen || "127.0.0.1";
        const host = v.host || (loopback(listen) ? listen : "");
        // The env password is the effective one for any profile without its own.
        const pw = v.password || process.env.OPENCODE_SERVER_PASSWORD || "";
        process.stdout.write([k, listen, host, v.port || "4096", v.dir || "", pw, v.model || ""].join("\x1f") + "\n");
      }
EOF
  )
  echo "default model (dispatch): ${MODEL:-<opencode config default>}"
  echo "authenticated providers:"
  opencode auth list 2>/dev/null | sed 's/^/  /' || echo "  (none — run: opencode auth login)"
  echo "models available:"
  opencode models 2>/dev/null | sed 's/^/  - /' | head -40 || echo "  (run after auth to list)"
  exit 0
fi

# ---- follow ------------------------------------------------------------------
# READ-ONLY watch on an existing session: poll the transcript, print new text
# parts as they land, exit 0 when the last assistant turn completes. Sends
# nothing — never resumes, steers, or prompts the session.
if [ "$MODE" = "follow" ]; then
  require_server
  SID="${MSG_PARTS[0]:-}"
  [ -n "$TASK_ID" ] && { resolve_task_context; }
  if [ -z "$SID" ]; then
    echo "error: follow needs a <sessionID> (or --task <taskID>)" >&2; exit 2
  fi
  if ! curl -sf -m 5 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} "$BASE_URL/session/$SID" -o /dev/null 2>/dev/null; then
    echo "error: session not found: $SID" >&2; exit 5
  fi
  AUTH_B64=""
  [ -n "${SERVE_PASSWORD:-}" ] && AUTH_B64="$(printf '%s' "${SERVER_USERNAME}:${SERVE_PASSWORD}" | base64)"
  # Bounded only when the caller explicitly passed --timeout (FOLLOW_TIMEOUT
  # defaults to 300 for run modes; a passive follow waits indefinitely).
  [ -n "$TIMEOUT_SET" ] || FOLLOW_TIMEOUT="0"
  BASE_URL="$BASE_URL" AUTH_B64="$AUTH_B64" SID="$SID" FOLLOW_TIMEOUT="${FOLLOW_TIMEOUT:-0}" node -e '
    const base = process.env.BASE_URL, sid = process.env.SID;
    const auth = process.env.AUTH_B64;
    const hdr = auth ? { authorization: "Basic " + auth } : {};
    const timeout = parseInt(process.env.FOLLOW_TIMEOUT, 10);
    const deadline = timeout > 0 ? Date.now() + timeout * 1000 : 0;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const jget = async (u) => { const r = await fetch(base + u, { headers: hdr, signal: AbortSignal.timeout(10000) }); if (!r.ok) throw new Error("http " + r.status); return r.json(); };
    console.log("following " + sid + " (read-only; Ctrl-C to detach)");
    (async () => {
      let dir = "";
      try { const s = await jget("/session/" + sid); dir = (s.directory || ""); } catch (e) {}
      const dirQ = dir ? "?directory=" + encodeURIComponent(dir) : "";
      let lastSeen = 0, done = false, first = true;
      const noticed = new Set();
      while (!done) {
        try {
          const msgs = await jget("/session/" + sid + "/message" + dirQ);
          for (let i = lastSeen; i < msgs.length; i++) {
            const m = msgs[i] || {}, li = m.info || {};
            for (const p of (m.parts || [])) {
              if (p.type === "text" && p.text) process.stdout.write(p.text.replace(/\n+$/, "") + "\n");
              else if (p.type === "reasoning" && p.text && !first) console.log("· " + p.text.split("\n")[0].slice(0, 120));
              else if (p.type === "tool" && p.state && p.state.status === "running") console.log("(tool: " + p.tool + " running)");
            }
          }
          lastSeen = Math.max(lastSeen, msgs.length);
          const li = ((msgs[msgs.length - 1] || {}).info) || {};
          done = li.role === "assistant" && !!(li.time && li.time.completed);
          // parked-ask notice: the session is waiting on a human, not working.
          // Print once per request id, not every poll.
          if (!done) {
            try {
              for (const q of await jget("/permission")) {
                if (q.sessionID === sid && !noticed.has(q.id)) {
                  noticed.add(q.id);
                  console.log("(parked: permission ask " + q.id + " — " + q.permission + " " + (q.patterns || []).join(" ") + ")");
                }
              }
              for (const q of await jget("/question")) {
                if (q.sessionID === sid && !noticed.has(q.id)) {
                  noticed.add(q.id);
                  console.log("(parked: question ask " + q.id + " — waiting on a human)");
                }
              }
            } catch (e) {}
          }
          first = false;
        } catch (e) { /* transient poll failure — keep waiting */ }
        if (deadline && Date.now() >= deadline) {
          console.log("(timeout after " + timeout + "s — session still running; follow again or watch: " + base + ")");
          process.exit(3);
        }
        if (!done) await sleep(2000);
      }
      console.log("(done — " + sid + " completed)");
    })();
  '
  exit 0
fi

# ---- identify / claim / release ----------------------------------------------
# Agent identity for delegation. Authoritative source: $OPENCODE_SESSION_ID,
# injected into every tool shell by the opencode-identity plugin's shell.env
# hook — each agent (parent OR subagent) sees its OWN session id, with no env
# inheritance or directory guessing. The DB fallback (newest session in $PWD)
# covers interactive shells without the plugin.
identity_record() {  # echoes JSON; exits 2 when unresolved
  if [ -n "${OPENCODE_SESSION_ID:-}" ]; then
    node - <<'EOF'
      process.stdout.write(JSON.stringify({
        sessionId: process.env.OPENCODE_SESSION_ID,
        slug: process.env.OPENCODE_SESSION_SLUG || "",
        title: process.env.OPENCODE_SESSION_TITLE || "",
        agent: process.env.OPENCODE_SESSION_AGENT || "",
        model: process.env.OPENCODE_SESSION_MODEL || "",
        directory: process.env.OPENCODE_SESSION_DIRECTORY || process.cwd(),
        taskId: process.env.AGENT_TASK_ID || "",
      }) + "\n")
EOF
    return 0
  fi
  # DB fallback: newest session rooted in $PWD (opencode.db is shared by every
  # instance — TUI, run, serve — so this resolves self-started sessions too).
  local out
  out="$(DB="${OPENCODE_DB:-$HOME/.local/share/opencode/opencode.db}" PWD_DIR="$PWD" node - <<'EOF'
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(process.env.DB, { readOnly: true });
    const r = db.prepare("SELECT id,slug,directory,title,agent,model FROM session WHERE directory=? ORDER BY time_created DESC LIMIT 1").get(process.env.PWD_DIR);
    if (!r) process.exit(1);
    let m = {}; try { m = JSON.parse(r.model || "{}"); } catch (e) {}
    process.stdout.write(JSON.stringify({
      sessionId: r.id, slug: r.slug, title: r.title,
      agent: r.agent, model: (m.providerID || "") + "/" + (m.id || ""),
      directory: r.directory, taskId: process.env.AGENT_TASK_ID || "",
      dbResolved: true,
    }) + "\n");
EOF
)" || { echo "error: no identity resolvable — run inside an opencode session (plugin env) or from a directory opencode has a session in" >&2; exit 2; }
  printf '%s\n' "$out"
  return 0
}

if [ "$MODE" = "identify" ]; then
  JSON_OUT=""
  [ "$FORMAT" = "json" ] && JSON_OUT=1
  SID_EXPLICIT="${MSG_PARTS[0]:-}"
  if [ -n "$SID_EXPLICIT" ]; then
    # Explicit session id: emit a record from the DB for that id (verifies existence).
    srec="$(DB="${OPENCODE_DB:-$HOME/.local/share/opencode/opencode.db}" SID="$SID_EXPLICIT" node - <<'EOF'
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.env.DB, { readOnly: true });
      const r = db.prepare("SELECT id,slug,directory,title,agent,model FROM session WHERE id=?").get(process.env.SID);
      if (!r) process.exit(1);
      let m = {}; try { m = JSON.parse(r.model || "{}"); } catch (e) {}
      process.stdout.write(JSON.stringify({ sessionId: r.id, slug: r.slug, title: r.title, agent: r.agent, model: (m.providerID||"")+"/"+(m.id||""), directory: r.directory }) + "\n");
EOF
)" || { echo "error: session not found in DB: $SID_EXPLICIT" >&2; exit 1; }
    printf '%s\n' "$srec"
    exit 0
  fi
  rec="$(identity_record)" || exit $?
  if [ -n "$JSON_OUT" ]; then
    printf '%s\n' "$rec"
  else
    printf '%s\n' "$rec" | node -e '
      let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
        const r=JSON.parse(d);
        console.log("sessionId:   "+r.sessionId);
        console.log("slug:        "+r.slug);
        console.log("title:       "+r.title);
        console.log("agent:       "+r.agent);
        console.log("model:       "+r.model);
        console.log("directory:   "+r.directory);
        if(r.taskId) console.log("taskId:      "+r.taskId);
        if(r.dbResolved) console.log("note:        db-resolved (newest session in this directory) — set OPENCODE_SESSION_ID explicitly if ambiguous");
      });'
  fi
  exit 0
fi

if [ "$MODE" = "claim" ] || [ "$MODE" = "release" ]; then
  UNIT="${MSG_PARTS[0]:-}"
  if [ -z "$UNIT" ]; then
    echo "error: $MODE needs a <unit> (e.g. claim gate-42)" >&2; exit 2
  fi
  case "$UNIT" in
    *[!A-Za-z0-9._-]*) echo "error: unit must be letters/digits/._- (got: $UNIT)" >&2; exit 2 ;;
  esac
  rec="$(identity_record)" || exit $?
  IDENT_DIR="$(printf '%s' "$rec" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).directory||""))')"
  IDENT_SESSION="$(printf '%s' "$rec" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).sessionId||""))')"
  [ -n "$IDENT_DIR" ] || { echo "error: identity has no directory to anchor claims in" >&2; exit 2; }
  CLAIM_DIR="${CLAIM_ROOT:-$IDENT_DIR/.opencode-claims}"
  mkdir -p "$CLAIM_DIR"
  CLAIM_FILE="$CLAIM_DIR/$UNIT.json"
  if [ "$MODE" = "claim" ]; then
    CLAIM_FILE="$CLAIM_FILE" REC="$rec" BASE_URL="$BASE_URL" UNIT="$UNIT" node - <<'EOF'
      const fs = require("fs");
      const file = process.env.CLAIM_FILE;
      const unit = process.env.UNIT;
      const r = JSON.parse(process.env.REC);
      let fd;
      try { fd = fs.openSync(file, "wx", 0o644); }
      catch (e) {
        if (e.code === "EEXIST") {
          let prev = {}; try { prev = JSON.parse(fs.readFileSync(file, "utf8")); } catch (_) {}
          console.error("ALREADY CLAIMED: " + file);
          console.error("  by session: " + (prev.sessionId || "?") + " (" + (prev.slug || "?") + ") since " + (prev.claimedAt || "?"));
          if (prev.agent) console.error("  agent: " + prev.agent + (prev.taskId ? "   taskId: " + prev.taskId : ""));
          console.error("  release: opencode-dispatch.sh release " + unit + " (owner only)");
          process.exit(3);
        }
        console.error("error: " + e.message); process.exit(1);
      }
      const claim = {
        unit,
        sessionId: r.sessionId,
        slug: r.slug,
        agent: r.agent,
        model: r.model,
        taskId: r.taskId || "",
        worktree: r.directory,
        serverUrl: process.env.BASE_URL,
        claimedAt: new Date().toISOString(),
      };
      fs.writeSync(fd, JSON.stringify(claim, null, 2) + "\n");
      fs.closeSync(fd);
      console.log("claimed " + file);
      console.log("  session: " + claim.sessionId + " (" + claim.slug + ")");
EOF
    exit 0
  else
    # release <unit> — owner-only removal
    if [ ! -f "$CLAIM_FILE" ]; then
      echo "no claim at $CLAIM_FILE" >&2; exit 3
    fi
    OWNER="$(node -e 'const fs=require("fs");try{const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(c.sessionId||"")}catch(e){}' "$CLAIM_FILE")"
    if [ -z "$OWNER" ] || [ "$OWNER" != "$IDENT_SESSION" ]; then
      echo "error: claim on $UNIT is owned by $OWNER, not $IDENT_SESSION — only the owner may release" >&2; exit 3
    fi
    rm -f "$CLAIM_FILE"
    echo "released $CLAIM_FILE"
    exit 0
  fi
fi

# ---- serve -------------------------------------------------------------------
# Temp prompt/diff files (opencode-msg.* / opencode-diff.*) are left behind by
# design (prune-recovery: a re-exec'd run re-reads its prompt file), and a
# kill -9 leaks the diff file past the EXIT trap — so they accumulate in TMPDIR.
# Every `serve` invocation prunes files older than the TTL (default 7 days;
# OPENCODE_DISPATCH_PROMPT_TTL_DAYS). Only these exact prefixes in TMPDIR are
# ever touched — never user-supplied --prompt-file paths.
prune_prompt_files() {
  local ttl="${OPENCODE_DISPATCH_PROMPT_TTL_DAYS:-7}"
  case "$ttl" in
    ''|*[!0-9]*) ttl=7 ;;
  esac
  [ -d "${TMPDIR:-/tmp}" ] || return 0
  find "${TMPDIR:-/tmp}" -maxdepth 1 \( -name 'opencode-msg.*' -o -name 'opencode-diff.*' \) -mtime "+${ttl}" -delete 2>/dev/null || true
}
if [ "$MODE" = "serve" ]; then
  prune_prompt_files
  if [ -n "$STOP" ] && [ -n "$RESTART" ]; then
    echo "error: --stop and --restart are mutually exclusive" >&2; exit 2
  fi
  if [ -n "$STOP" ]; then
    stop_server || exit 6
    exit 0
  fi
  if [ -n "$RESTART" ]; then
    # Stop the RECORDED server first (it may be on a different port than any
    # --port passed now), then reuse its args overridden by this command line.
    # Without a record, only restart when the target is explicitly named.
    read_serve_args
    if [ -n "$RPORT" ]; then
      stop_server || exit 6
    elif { [ -n "$PORT_SET" ] || [ -n "$HOST_SET" ]; } && server_up; then
      stop_server || exit 6
    elif [ -z "$PORT_SET" ] && [ -z "$HOST_SET" ]; then
      echo "error: no recorded server to restart — pass --port <N> [--host <addr>] explicitly" >&2
      exit 2
    fi
    [ -z "$DIR_SET" ]  && [ -n "$RDIR" ]  && DIR="$RDIR"
    [ -z "$PORT_SET" ] && [ -n "$RPORT" ] && PORT="$RPORT"
    [ -z "$HOST_SET" ] && [ -n "$RHOST" ] && HOST="$RHOST"
    BASE_URL="http://${HOST}:${PORT}"
    if start_server "$DIR" "$PORT" "$LISTEN" "$SERVE_PASSWORD"; then
      write_serve_args "$DIR" "$PORT" "$HOST"
      echo "opencode server restarted at $BASE_URL (dir: $DIR)"
      [ -n "$SERVE_PASSWORD" ] && echo "auth:     ${SERVER_USERNAME} (password from env/.env.local/profile)"
      echo "log: $SERVE_LOG"
      exit 0
    fi
    echo "error: server did not come up within ~9s; see $SERVE_LOG" >&2
    tail -5 "$SERVE_LOG" >&2 2>/dev/null || true
    exit 6
  fi
  if server_up; then
    echo "opencode server '$SERVER_NAME' already running at $BASE_URL"
    exit 0
  fi
  if start_server "$DIR" "$PORT" "$LISTEN" "$SERVE_PASSWORD"; then
    write_serve_args "$DIR" "$PORT" "$HOST"
    echo "opencode server started at $BASE_URL (dir: $DIR)"
    [ -n "$SERVE_PASSWORD" ] && echo "auth:     ${SERVER_USERNAME} (password from env/.env.local/profile)"
    echo "log: $SERVE_LOG"
    exit 0
  fi
  echo "error: server did not come up within ~9s; see $SERVE_LOG" >&2
  tail -5 "$SERVE_LOG" >&2 2>/dev/null || true
  exit 6
fi

# --stop/--restart are serve-only.
if { [ -n "$STOP" ] || [ -n "$RESTART" ]; } && [ "$MODE" != "serve" ]; then
  echo "error: --stop and --restart are only valid for 'serve'" >&2; exit 2
fi

# ---- sessions ----------------------------------------------------------------
if [ "$MODE" = "sessions" ]; then
  require_server
  curl -sf -m 10 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} "$BASE_URL/session" \
    | LIMIT="$TAIL" node -e '
      let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
        let a; try{a=JSON.parse(d)}catch(e){console.error("bad JSON from server");process.exit(1)}
        const norm=t=>t&&t<1e12?t*1000:t;
        a.sort((x,y)=>(norm(y?.time?.updated)||0)-(norm(x?.time?.updated)||0));
        const lim=parseInt(process.env.LIMIT,10)||50;
        const shown=a.slice(0,lim);
        for(const s of shown){
          const u=norm(s?.time?.updated); const iso=u?new Date(u).toISOString().replace("T"," ").slice(0,19):"?";
          console.log(`${s.id}  ${iso}  ${s.title||""}`);
        }
        if(a.length>shown.length) console.log(`… ${a.length-shown.length} older session(s) not shown (raise --tail).`);
      });'
  exit 0
fi

# ---- history -----------------------------------------------------------------
if [ "$MODE" = "history" ]; then
  require_server
  SID="${MSG_PARTS[0]:-}"
  [ -n "$TASK_ID" ] && { resolve_task_context; }
  if [ -z "$SID" ]; then
    echo "error: history needs a <sessionID> (see: $(basename "$0") sessions)" >&2
    exit 2
  fi
  # Directory-scoped fetch first; a session rooted elsewhere (or a server that
  # ignores the param) falls back to a bare fetch — the session id is unique
  # server-wide, the directory is only a scoping hint.
  HIST_RAW="$(curl -sf -m 30 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} "$BASE_URL/session/$SID/message?$DIR_Q" 2>/dev/null)" \
    || HIST_RAW="$(curl -sf -m 30 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} "$BASE_URL/session/$SID/message" 2>/dev/null)" \
    || { echo "error: session $SID not found (server unreachable or no such session)" >&2; exit 5; }
  printf '%s' "$HIST_RAW" \
    | TAIL="$TAIL" TAIL_SET="$TAIL_SET" TURNS="$TURNS" SINCE="$SINCE" node -e '
      let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
        let msgs; try{msgs=JSON.parse(d)}catch(e){console.error("bad JSON from server");process.exit(1)}
        if(!Array.isArray(msgs)){console.error("unexpected response");process.exit(1)}
        const norm=t=>t&&t<1e12?t*1000:t;
        // --since -> cutoff (ms). supports s/m/h/d/w.
        let cutoff=0; const since=(process.env.SINCE||"").trim();
        if(since){
          const m=since.match(/^([0-9]+)\s*([smhdw])$/i);
          if(!m){console.error(`bad --since "${since}" (use e.g. 30s 10m 6h 1d 2w)`);process.exit(2);}
          const n=parseInt(m[1],10); const unit={s:1e3,m:6e4,h:36e5,d:864e5,w:6048e5}[m[2].toLowerCase()];
          cutoff=Date.now()-n*unit;
        }
        // 1) time filter
        let kept=msgs.filter(msg=>{
          const c=norm(msg?.info?.time?.created)||0;
          return !(cutoff && c && c<cutoff);
        });
        // 2) --turns: keep only the last N user prompts and everything after each.
        const turns=parseInt(process.env.TURNS,10);
        if(turns>0){
          const userIdx=kept.map((m,i)=>({r:m?.info?.role,i})).filter(x=>x.r==="user").map(x=>x.i);
          if(userIdx.length>turns){ kept=kept.slice(userIdx[userIdx.length-turns]); }
        }
        // 3) render
        const lines=[];
        for(const msg of kept){
          const info=msg?.info||{}; const created=norm(info?.time?.created)||0;
          const role=info.role||"?";
          const iso=created?new Date(created).toISOString().replace("T"," ").slice(0,19):"";
          const text=(msg?.parts||[]).filter(p=>p&&p.type==="text"&&p.text).map(p=>p.text).join("\n").trim();
          if(!text) continue;
          lines.push(`── ${role}${iso?" @ "+iso:""} ──`);
          for(const l of text.split("\n")) lines.push(l);
          lines.push("");
        }
        // 4) line cap: --tail always applies; otherwise the default 100 UNLESS
        //    --turns was given — then the window is shown UNBOUNDED (a fixed
        //    cap silently ate whole turns, and any per-turn allowance (100,
        //    turns*200) was still too small for tool-heavy turns). The caller
        //    bounds volume explicitly with --tail when they want less.
        const tailSet=!!process.env.TAIL_SET;
        const cap = tailSet ? (parseInt(process.env.TAIL,10)||100)
                            : (turns>0 ? Infinity : 100);
        const out = lines.length>cap ? lines.slice(-cap) : lines;
        if(lines.length>cap) console.log(`… showing last ${cap} of ${lines.length} lines (raise --tail) …`);
        process.stdout.write(out.join("\n")+"\n");
      });'
  exit 0
fi

# ---- status ------------------------------------------------------------------
if [ "$MODE" = "status" ]; then
  require_server
  SID="${MSG_PARTS[0]:-}"
  [ -n "$TASK_ID" ] && { resolve_task_context; }
  if [ -z "$SID" ]; then
    # No session ID: one-line summary for every session. opencode's session JSON
    # has NO lastMessage in 1.18.x, so "working" cannot come from the list —
    # probe each shown session's last message (limit=1) concurrently, plus the
    # two ask queues (/permission, /question) for parked state.
    AUTH_B64=""
    [ -n "${SERVE_PASSWORD:-}" ] && AUTH_B64="$(printf '%s' "${SERVER_USERNAME}:${SERVE_PASSWORD}" | base64)"
    curl -sf -m 10 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} "$BASE_URL/session" \
      | BASE_URL="$BASE_URL" AUTH_B64="$AUTH_B64" BN="$(basename "$0")" LIMIT="$TAIL" node -e '
        let d=""; process.stdin.on("data",c=>d+=c).on("end",async()=>{
          let a; try{a=JSON.parse(d)}catch(e){console.error("bad JSON from server");process.exit(1)}
          const base=process.env.BASE_URL, auth=process.env.AUTH_B64;
          const hdr=auth?{authorization:"Basic "+auth}:{};
          const jget=async(u)=>{const r=await fetch(base+u,{headers:hdr,signal:AbortSignal.timeout(5000)});if(!r.ok)throw new Error("http "+r.status);return r.json();};
          let perms=new Map(), questions=new Map();
          try{ for(const p of await jget("/permission")) if(p?.sessionID) perms.set(p.sessionID,"PERMASK ("+p.id+" "+p.permission+")"); }catch(e){}
          try{ for(const q of await jget("/question")){ if(q?.sessionID){ const h=(q.questions||[])[0]; questions.set(q.sessionID,"QUESTION ("+q.id+" "+((h?.header||h?.question||"").slice(0,40))+")"); } } }catch(e){}
          const norm=t=>t&&t<1e12?t*1000:t;
          const now=Date.now();
          const fmt=ms=>{let x=Math.floor(ms/1000);const h=Math.floor(x/3600);x%=3600;const mi=Math.floor(x/60);const se=x%60;return (h?h+"h ":"")+(h||mi?mi+"m ":"")+se+"s";};
          a.sort((x,y)=>(norm(y?.time?.updated)||0)-(norm(x?.time?.updated)||0));
          const lim=parseInt(process.env.LIMIT,10)||50;
          const shown=a.slice(0,lim);
          // working = last assistant message without time.completed; parked queues win.
          // Also capture a stuck tool part (durable signal) so a WORKING row names
          // the tool, and flag turns frozen >30m as STALE.
          const states=await Promise.all(shown.map(async s=>{
            if(perms.has(s.id)) return "PERMASK";
            if(questions.has(s.id)) return "QUESTION";
            try{
              const dir=encodeURIComponent(s.directory||"");
              const msgs=await jget("/session/"+s.id+"/message?directory="+dir+"&limit=1");
              const m=(msgs||[])[(msgs||[]).length-1];
              const li=m?.info||{};
              const working=li.role==="assistant" && !(li.time&&li.time.completed);
              if(!working) return "idle";
              const parts=(m?.parts)||[];
              let runPart=null;
              for(let i=parts.length-1;i>=0;i--){const p=parts[i];if(p.type==="tool"&&p.state?.status==="running"&&!p.state?.time?.end){runPart=p;break;}}
              const dur=runPart?.state?.time?.start?fmt(Math.max(0,now-runPart.state.time.start)):"";
              const idle=now-(norm(s?.time?.updated)||0);
              const tool=(runPart?("("+runPart.tool+(dur?"·"+dur:"")+")"):"");
              return (idle>30*60*1000?"STALE":"WORKING")+tool;
            }catch(e){ return "idle"; }
          }));
          let nparked=0, nwork=0;
          shown.forEach((s,i)=>{
            const u=norm(s?.time?.updated)||0;
            const idle=now-u;
            const state=states[i];
            if(state==="PERMASK"||state==="QUESTION") nparked++;
            if(state.startsWith("WORKING")) nwork++;
            const age=u?fmt(idle)+" ago":"?";
            console.log(`${s.id}  ${state.padEnd(14)}  ${age.padStart(12)}  ${s.title||""}`);
          });
          if(nparked) console.log(`… ${nparked} session(s) parked on an ask (see: ${process.env.BN} permissions / allow)`);
          if(nwork) console.log(`… ${nwork} session(s) working`);
          if(a.length>shown.length) console.log(`… ${a.length-shown.length} older session(s) not shown (raise --tail).`);
        });'
    exit 0
  fi
  # Directory-scoped fetch first, bare fetch as fallback (see history mode).
  sess="$(curl -sf -m 10 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} "$BASE_URL/session/$SID?$DIR_Q" 2>/dev/null)" \
    || sess="$(curl -sf -m 10 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} "$BASE_URL/session/$SID" 2>/dev/null)" \
    || { echo "error: session not found" >&2; exit 5; }
  msgs="$(curl -sf -m 10 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} "$BASE_URL/session/$SID/message?$DIR_Q" 2>/dev/null)" \
    || msgs="$(curl -sf -m 10 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} "$BASE_URL/session/$SID/message" 2>/dev/null)" \
    || msgs="[]"
  parked="$(parked_permission "$SID")"
  printf '{"session":%s,"messages":%s}' "$sess" "$msgs" | PARKED="$parked" BN="$(basename "$0")" node -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
      const {session:s,messages:m}=JSON.parse(d);
      const parked=process.env.PARKED||"";
      const norm=t=>t&&t<1e12?t*1000:t;
      const upd=norm(s?.time?.updated)||0; const now=Date.now();
      const idle=Math.max(0,now-upd);
      const fmt=ms=>{let x=Math.floor(ms/1000);const h=Math.floor(x/3600);x%=3600;const mi=Math.floor(x/60);const se=x%60;return (h?h+"h ":"")+(h||mi?mi+"m ":"")+se+"s";};
      const last=Array.isArray(m)&&m.length?m[m.length-1]:null;
      const li=last?.info||{};
      const working = li.role==="assistant" && !(li.time&&li.time.completed);
      // Durable stuck-tool signal: the newest assistant turn holds a tool part
      // stuck in state.status "running" with no time.end. The ask queues are
      // in-memory and die with a server restart while the session stays stuck,
      // so this is what still names the stuck-ness after the queue is gone.
      const parts=(last?.parts)||[];
      let runPart=null;
      for(let i=parts.length-1;i>=0;i--){const p=parts[i];if(p.type==="tool"&&p.state?.status==="running"&&!p.state?.time?.end){runPart=p;break;}}
      const lastErr = (Array.isArray(m)?m:[]).map(x=>x?.info?.error).filter(Boolean).pop();
      console.log("session:  "+s.id);
      console.log("title:    "+(s.title||""));
      console.log("model:    "+(s?.model?.providerID||"?")+"/"+(s?.model?.id||"?"));
      console.log("messages: "+(Array.isArray(m)?m.length:0)+"   cost: $"+(s.cost??0));
      console.log("updated:  "+(upd?new Date(upd).toISOString().replace("T"," ").slice(0,19):"?")+"  ("+fmt(idle)+" ago)");
      const stale = working && idle > 30*60*1000;
      let state;
      if (parked) {
        const head=parked.startsWith("per_")?"PERMISSION PROMPT":"QUESTION ASK";
        const act=parked.startsWith("per_")
          ? "approve: "+process.env.BN+" allow <requestID> [--always]"
          : "no reply path on a headless server (the agent is waiting on a human)";
        state = "WORKING — "+head+" ("+parked+") — "+act+"   |   abort: "+process.env.BN+" abort "+s.id;
      } else if (working && runPart) {
        const d=runPart.state?.time?.start?fmt(Math.max(0,now-runPart.state.time.start)):"?";
        state = "WORKING — TOOL RUNNING ("+(runPart.tool||"?")+" · "+d+", no ask in queue — likely parked on a lost prompt or a dead turn; abort if it never finishes)";
      } else if (stale) state = "WORKING — STALE ("+fmt(idle)+" without activity; likely a dead turn — try "+process.env.BN+" abort "+s.id+")";
      else state = working ? "WORKING (turn in progress)" : "idle";
      console.log("state:    "+state);
      if(lastErr) console.log("lastError: "+(lastErr.name||"?")+" "+(lastErr.data?.statusCode||"")+" "+(lastErr.data?.message||""));
    });'
  exit 0
fi

# ---- completion loops (shared by run modes and send) --------------------------
# Two wait loops over a session's message stream. Run modes use them for
# --follow / --background; send uses the SAME loops for its delivery modes
# (--wait/--background select await_turn, the default is follow_turn) instead of
# a hard-capped synchronous POST. ONE copy of each loop. $2 is the message count
# that proves the turn finished: a fresh run-mode session reaches 2 (user prompt
# + assistant reply); an EXISTING send session must count past its pre-submit
# total (precount + 2), or the loop could break on the session's OLD idle state
# the instant after submit and print a stale reply.
# emit_heartbeat <state> <msgs> <idle-secs> [detail] — the recurring ~30s status
# line. The one-time banner already names $MODE and $SID, so this line omits
# them: a tailed background log stays short, and the fields that change (state,
# message count, idle seconds, running tool or parked ask) keep a stable order.
emit_heartbeat() {
  local state="$1" n="$2" idle="$3" detail="${4:-}"
  local msg="$state · ${n} msgs · ${idle}s idle"
  [ -n "$detail" ] && msg="$msg · $detail"
  printf '%s\n' "$msg" >&2
}
# nudge_hint — the recover-a-stuck-turn command appended to PARKED/STALLED
# diagnostics. `send --steer` injects into the running turn, and the server
# accepts it for ANY session id — including subagent sessions, which are
# otherwise not meant to be messaged. It recovers the turn in place instead of
# aborting and redoing it. Reads $SID from the calling loop (bash dynamic scope).
nudge_hint() {
  printf '%s' "nudge: $(basename "$0") send $SID \"<message>\" --steer"
}
follow_turn() {  # $1=SID $2=min-msgs-for-done (default 2); always exits (0)
  local SID="$1" minmsgs="${2:-2}"
  local deadline last_beat now n st fails line tp ts qh ask prev_ask=""
  local mx prev_mx last_change askid askrest
  echo "[$MODE] session $SID started; following (timeout ${FOLLOW_TIMEOUT}s)…" >&2
  deadline=$(( $(date +%s) + FOLLOW_TIMEOUT ))
  last_beat=0; fails=0; prev_mx=""; last_change=$(date +%s)
  while :; do
    line="$(curl -sf -m 10 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} "$BASE_URL/session/$SID/message" \
      | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const a=JSON.parse(d);const l=a[a.length-1]?.info;const w=l&&l.role==="assistant"&&!(l.time&&l.time.completed);let mx=0;for(const m of a){const t=m.info&&m.info.time;if(t)for(const k in t){const v=t[k];if(typeof v==="number"&&v>mx)mx=v;}}let tp="-",ts=0,qh="-";if(w){const parts=(a[a.length-1]?.parts)||[];for(let i=parts.length-1;i>=0;i--){const p=parts[i];if(p.type==="tool"&&p.state?.status==="running"&&!p.state?.time?.end){tp=p.tool||"-";ts=p.state?.time?.start||0;const q=(p.state?.input||{}).questions;if(q&&q[0])qh=(q[0].header||q[0].question||"").replace(/ /g,"_").slice(0,40)||"-";break;}}}process.stdout.write(a.length+" "+(w?"working":"idle")+" "+mx+" "+tp+" "+ts+" "+qh+"\n")});' 2>/dev/null)" || line=""
    if [ -z "$line" ]; then
      # dead server: fail fast like await_turn (exit 7) instead of spinning
      # silently to the deadline looking hung.
      fails=$((fails+1))
      if [ "$fails" -ge 20 ]; then
        echo "[$MODE] server unreachable for ~40s; giving up on $SID (may still be running server-side)." >&2
        exit 7
      fi
      sleep 2; continue
    fi
    fails=0
    read -r n st mx tp ts qh <<<"$line" || true
    tp="${tp:--}"; qh="${qh:--}"
    [ "${n:-0}" -ge "$minmsgs" ] && [ "$st" = "idle" ] && break
    now=$(date +%s)
    # reset the stall/idle clock whenever the newest timestamp moves
    if [ "${mx:-0}" != "${prev_mx:-}" ]; then prev_mx="${mx:-0}"; last_change=$now; fi
    # Per-iteration ask polling while the turn works: announce a parked
    # permission/question the MOMENT it appears (transition detection), not at
    # the next 30s heartbeat. pending_ask falls back to the durable
    # message-stream signal when the in-memory queues are empty/lost.
    ask=""
    if [ "$st" = "working" ]; then ask="$(pending_ask "$SID" "$tp" "$ts" "$qh")"; fi
    if [ -n "$ask" ] && [ "$ask" != "$prev_ask" ]; then
      echo "[$MODE] $SID PARKED on an ask (request $ask)" >&2
      echo "        approve: $(basename "$0") allow <requestID> [--always]   |   abort: $(basename "$0") abort $SID   |   $(nudge_hint)" >&2
      prev_ask="$ask"; last_beat=$now
    elif [ -z "$ask" ] && [ -n "$prev_ask" ]; then
      echo "[$MODE] $SID ask resolved — resuming." >&2
      prev_ask=""; last_beat=$now
    fi
    # Heartbeat every ~30s REGARDLESS of state — an idle-but-not-done wait
    # (submit still landing, or a slow server) used to be silent and read as
    # hung. emit_heartbeat drops the mode/SID the banner already printed; while
    # parked it repeats the ask, while working it names the tool that has been
    # running longest. Follow has no stall guard.
    if [ $(( now - last_beat )) -ge 30 ]; then
      if [ -n "$ask" ]; then
        askid="${ask%% *}"; askrest="${ask#* }"; [ "$askrest" = "$askid" ] && askrest=""
        emit_heartbeat "parked on ask [$askid]" "${n:-0}" "$(( now - last_change ))" "$askrest"
      elif [ "$st" = "working" ]; then
        if [ "$tp" != "-" ]; then
          emit_heartbeat working "${n:-0}" "$(( now - last_change ))" "tool $tp $(( now - ${ts:-0}/1000 ))s"
        else
          emit_heartbeat working "${n:-0}" "$(( now - last_change ))"
        fi
      else
        emit_heartbeat waiting "${n:-0}" "$(( now - last_change ))"
      fi
      last_beat=$now
    fi
    if [ "$now" -ge "$deadline" ]; then
      if [ -n "$ask" ]; then
        echo "[$MODE] session $SID still running after ${FOLLOW_TIMEOUT}s (parked on an ask: $ask)." >&2
        echo "approve: $(basename "$0") allow <requestID> [--always]   |   abort: $(basename "$0") abort $SID   |   $(nudge_hint)" >&2
      else
        echo "[$MODE] session $SID still running after ${FOLLOW_TIMEOUT}s." >&2
        echo "watch: $(basename "$0") status $SID | $(basename "$0") history $SID --turns 1 | $(basename "$0") abort $SID" >&2
      fi
      exit 0
    fi
    sleep 1.5
  done
  curl -sf -m 15 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} "$BASE_URL/session/$SID/message" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{let a;try{a=JSON.parse(d)}catch(ex){console.error("error: invalid response from server ("+ex.message+")");process.exit(1);}const asst=a.filter(m=>m.info?.role==="assistant");const last=asst[asst.length-1];const e=last?.info?.error;if(e){console.error("ERROR "+(e.data?.statusCode||"")+" "+(e.data?.message||e.name||""));process.exit(1);}const t=(last?.parts||[]).filter(p=>p.type==="text"&&p.text).map(p=>p.text).join("\n").trim();console.log(t);});'
  echo "(session: $SID)" >&2
  exit 0
}

# ---- --background/--wait: block to COMPLETION, print distilled result, then EXIT ----
# Unlike follow_turn (bounded, then leaves it running), await_turn lives exactly
# as long as the turn: it exits 0 the moment the turn completes. Launch it as a
# background task and the caller is re-invoked on that exit — wake-on-complete.
# Exit codes: 3 = backstop timeout (still running server-side), 7 = server
# unreachable, 8 = stall (hung turn / parked ask).
await_turn() {  # $1=SID $2=min-msgs-for-done (default 2); always exits
  local SID="$1" minmsgs="${2:-2}"
  local unbounded deadline fails prev_mx last_change last_beat now line n st he mx
  local tp ts qh ask prev_ask=""
  local askid askrest
  local sinfo qdir sbody got=""
  echo "[$MODE] session $SID started in the background; waiting for completion (stall guard ${STALL_SECS}s)…" >&2
  unbounded=0; [ "$FOLLOW_TIMEOUT" = "0" ] && unbounded=1
  deadline=$(( $(date +%s) + FOLLOW_TIMEOUT ))
  fails=0
  # Progress/stall tracking: `mx` is the newest message timestamp the server
  # reports; while it advances the turn is doing work. If it freezes for
  # STALL_SECS we bail (hung turn). A throttled heartbeat to stderr every ~30s
  # makes a backgrounded run tailable instead of silent.
  prev_mx=""; last_change=$(date +%s); last_beat=0
  while :; do
    line="$(curl -sf -m 10 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} "$BASE_URL/session/$SID/message" \
      | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const a=JSON.parse(d);const l=a[a.length-1]&&a[a.length-1].info;const w=l&&l.role==="assistant"&&!(l.time&&l.time.completed);const e=(l&&l.role==="assistant"&&l.error)?1:0;let mx=0;for(const m of a){const t=m.info&&m.info.time;if(t)for(const k in t){const v=t[k];if(typeof v==="number"&&v>mx)mx=v;}}let tp="-",ts=0,qh="-";if(w){const parts=(a[a.length-1]?.parts)||[];for(let i=parts.length-1;i>=0;i--){const p=parts[i];if(p.type==="tool"&&p.state?.status==="running"&&!p.state?.time?.end){tp=p.tool||"-";ts=p.state?.time?.start||0;const q=(p.state?.input||{}).questions;if(q&&q[0])qh=(q[0].header||q[0].question||"").replace(/ /g,"_").slice(0,40)||"-";break;}}}process.stdout.write(a.length+" "+(w?"working":"idle")+" "+e+" "+mx+" "+tp+" "+ts+" "+qh+"\n")}catch(x){process.exit(1)}})' 2>/dev/null)" || line=""
    if [ -z "$line" ]; then
      fails=$((fails+1))
      if [ "$fails" -ge 20 ]; then
        echo "[$MODE] server unreachable for ~40s; giving up on $SID (may still be running server-side)." >&2
        exit 7
      fi
      sleep 2; continue
    fi
    fails=0
    read -r n st he mx tp ts qh <<<"$line" || true
    tp="${tp:--}"; qh="${qh:--}"
    [ "${he:-0}" = "1" ] && break
    { [ "${n:-0}" -ge "$minmsgs" ] && [ "$st" = "idle" ]; } && break
    now=$(date +%s)
    # reset the stall clock whenever the newest timestamp moves
    if [ "${mx:-0}" != "${prev_mx:-}" ]; then prev_mx="${mx:-0}"; last_change=$now; fi
    # Per-iteration ask polling while the turn works: announce a parked
    # permission/question the MOMENT it appears (transition detection), not at
    # the next 30s heartbeat. pending_ask falls back to the durable
    # message-stream signal when the in-memory queues are empty/lost.
    ask=""
    if [ "$st" = "working" ]; then ask="$(pending_ask "$SID" "$tp" "$ts" "$qh")"; fi
    if [ -n "$ask" ] && [ "$ask" != "$prev_ask" ]; then
      echo "[$MODE] $SID PARKED on an ask (request $ask)" >&2
      echo "        approve: $(basename "$0") allow <requestID> [--always]   |   abort: $(basename "$0") abort $SID   |   $(nudge_hint)" >&2
      prev_ask="$ask"; last_beat=$now
    elif [ -z "$ask" ] && [ -n "$prev_ask" ]; then
      echo "[$MODE] $SID ask resolved — resuming." >&2
      prev_ask=""; last_beat=$now
    fi
    # Heartbeat every ~30s REGARDLESS of state — an idle-but-not-done wait
    # (submit still landing, or a slow server) used to be silent and read as
    # hung. emit_heartbeat drops the mode/SID the banner already printed; while
    # parked it repeats the ask, while working it names the tool that has been
    # running longest. The stall guard still governs hung turns.
    if [ $(( now - last_beat )) -ge 30 ]; then
      if [ -n "$ask" ]; then
        askid="${ask%% *}"; askrest="${ask#* }"; [ "$askrest" = "$askid" ] && askrest=""
        emit_heartbeat "parked on ask [$askid]" "${n:-0}" "$(( now - last_change ))" "$askrest"
      elif [ "$st" = "working" ]; then
        if [ "$tp" != "-" ]; then
          emit_heartbeat working "${n:-0}" "$(( now - last_change ))" "tool $tp $(( now - ${ts:-0}/1000 ))s"
        else
          emit_heartbeat working "${n:-0}" "$(( now - last_change ))"
        fi
      else
        emit_heartbeat waiting "${n:-0}" "$(( now - last_change ))"
      fi
      last_beat=$now
    fi
    # stall bail: newest timestamp frozen for STALL_SECS → hung turn. Name the
    # parked-ask case explicitly — it is NOT hung, just waiting on a human.
    if [ "${STALL_SECS:-0}" -gt 0 ] && [ $(( now - last_change )) -ge "$STALL_SECS" ]; then
      if [ -n "$ask" ]; then
        echo "[$MODE] session $SID STALLED: parked on an ask for ${STALL_SECS}s (request $ask)." >&2
        echo "approve: $(basename "$0") allow <requestID> [--always]   |   abort: $(basename "$0") abort $SID   |   $(nudge_hint)" >&2
      else
        echo "[$MODE] session $SID STALLED: no activity for ${STALL_SECS}s (likely a hung turn); giving up." >&2
        echo "watch: $(basename "$0") status $SID   |   abort: $(basename "$0") abort $SID   |   $(nudge_hint)" >&2
      fi
      exit 8
    fi
    if [ "$unbounded" -eq 0 ] && [ "$now" -ge "$deadline" ]; then
      if [ -n "$ask" ]; then
        echo "[$MODE] session $SID still running after ${FOLLOW_TIMEOUT}s (parked on an ask: $ask)." >&2
        echo "approve: $(basename "$0") allow <requestID> [--always]   |   abort: $(basename "$0") abort $SID   |   $(nudge_hint)" >&2
      else
        echo "[$MODE] session $SID still running after ${FOLLOW_TIMEOUT}s; exiting non-zero (still running server-side)." >&2
        echo "watch: $(basename "$0") status $SID" >&2
      fi
      exit 3
    fi
    sleep 2
  done

  # default distilled output: the final assistant message (reviews/plans are already tight)
  curl -sf -m 15 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} "$BASE_URL/session/$SID/message" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{let a;try{a=JSON.parse(d)}catch(ex){console.error("error: invalid response from server ("+ex.message+")");process.exit(1);}const asst=a.filter(m=>m.info?.role==="assistant");const last=asst[asst.length-1];const e=last?.info?.error;if(e){console.error("ERROR "+(e.data?.statusCode||"")+" "+(e.data?.message||e.name||""));process.exit(1);}const t=(last?.parts||[]).filter(p=>p.type==="text"&&p.text).map(p=>p.text).join("\n").trim();console.log(t);});'
  echo "(session: $SID)" >&2
  exit 0
}

# ---- send --------------------------------------------------------------------
if [ "$MODE" = "send" ]; then
  require_server
  SID="${MSG_PARTS[0]:-}"
  [ -n "$TASK_ID" ] && { resolve_task_context; }
  [ -z "$SID" ] && { echo "error: send needs a <sessionID> and a message (positional or --prompt-file <path>)" >&2; exit 2; }
  # The positional message (if any) was already converted to --prompt-file by
  # the re-exec at the top of this script, so the message text never stays in
  # this process's argv for the run.
  [ -n "$PROMPT_FILE" ] || { echo "error: send needs a message after the sessionID (or --prompt-file <path>)" >&2; exit 2; }
  [ -r "$PROMPT_FILE" ] || { echo "error: --prompt-file not readable: $PROMPT_FILE" >&2; exit 2; }
  MSG="$(cat "$PROMPT_FILE")"
  [ -n "$MSG" ] && MSG="$MSG

(This message is also saved at $PROMPT_FILE — re-read that file if your context gets pruned.)"
  [ -z "$MSG" ] && { echo "error: prompt file is empty: $PROMPT_FILE" >&2; exit 2; }
  if [ -n "$STEER" ] || [ -n "$QUEUE" ]; then
    delivery="steer"; [ -n "$QUEUE" ] && delivery="queue"
    # /api/session/{id}/prompt (steer/queue delivery) has no model/variant/agent
    # field in its schema (confirmed via GET /doc) — unlike prompt_async, there
    # is no way to apply --model/--effort/--agent on this path. Warn rather than
    # silently drop them.
    if [ -n "$MODEL" ] || [ -n "$VARIANT" ] || [ -n "$AGENT" ]; then
      echo "warning: --model/--effort/--agent have no effect with --steer/--queue (the $delivery API has no model field); the turn runs on the session's configured model" >&2
    fi
    MSG="$MSG" DELIVERY="$delivery" node -e '
      process.stdout.write(JSON.stringify({prompt:{text:process.env.MSG},delivery:process.env.DELIVERY}));' \
          | curl -sf -m 20 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} -X POST "$BASE_URL/api/session/$SID/prompt?$DIR_Q" \
          -H 'content-type: application/json' --data-binary @- \
      | DELIVERY="$delivery" node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);console.log(`${process.env.DELIVERY} admitted: seq=${j.data?.admittedSeq} id=${j.data?.id}`);}catch(e){console.log(d);}});'
    echo "(poll with: $(basename "$0") status $SID   /   history $SID --turns 1)"
  else
    # Default delivery (and --wait/--background/--follow): async submit via
    # prompt_async (same as the run modes), then the shared completion loop —
    # no more hard 300s curl cap that died on long turns. --wait/--background
    # select await_turn (24h backstop, stall guard, parked-permission heartbeat,
    # exit codes 3/7/8); the default is follow_turn (300s bounded, exits 0 on
    # timeout and leaves the turn running, matching --follow).
    msgfile="$(mktemp "${TMPDIR:-/tmp}/opencode-msg.XXXXXX")"
    trap 'rm -f "$msgfile"' EXIT
    printf '%s' "$MSG" > "$msgfile"
    # Pre-submit message count: the loops break on idle + N messages, and an
    # existing session is already idle with history — without counting past the
    # pre-submit total the loop could break on the OLD idle state and print a
    # stale reply before the new turn even starts.
    precount="$(curl -sf -m 10 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} "$BASE_URL/session/$SID/message?$DIR_Q" 2>/dev/null \
      | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(String(JSON.parse(d).length))}catch(e){process.stdout.write("0")}});')"
    precount="${precount:-0}"
    oc_submit_async "$SID" "$msgfile" "$AGENT" "$MODEL" "$VARIANT" || { echo "error: could not submit message to $SID" >&2; exit 5; }
    if [ -n "$AWAIT" ]; then
      await_turn "$SID" "$((precount + 2))"
    else
      follow_turn "$SID" "$((precount + 2))"
    fi
    exit 0
  fi
  exit 0
fi

# ---- teardown ----------------------------------------------------------------
# Delegates to agent-cleanup.mjs --teardown: lists leftover files (with a short
# preview), removes the worktree, and deletes the session's database rows.
run_teardown() {  # $1=taskID [extra agent-cleanup args...]
  local task="$1"; shift
  local orch="${ORCHESTRATION_ROOT:-$DIR/scripts}"
  [ -f "$orch/agent-cleanup.mjs" ] || { echo "error: cleanup helper not found: $orch/agent-cleanup.mjs" >&2; return 5; }
  local cargs=( --task "$task" --from "$DIR" --teardown )
  [ -n "$WORKTREE_ROOT" ] && cargs+=( --worktree-root "$WORKTREE_ROOT" )
  node "$orch/agent-cleanup.mjs" "${cargs[@]}" "$@"
}

if [ "$MODE" = "teardown" ]; then
  TASK_ID="${TASK_ID:-${MSG_PARTS[0]:-}}"
  [ -n "$TASK_ID" ] || { echo "error: teardown needs --task <taskID>" >&2; exit 2; }
  extra=()
  [ -n "$TEARDOWN_FORCE" ] && extra+=( --force )
  run_teardown "$TASK_ID" "${extra[@]}" || exit $?
  exit 0
fi

# ---- abort -------------------------------------------------------------------
if [ "$MODE" = "abort" ]; then
  require_server
  SID="${MSG_PARTS[0]:-}"
  [ -n "$TASK_ID" ] && { resolve_task_context; }
  [ -z "$SID" ] && { echo "error: abort needs a <sessionID>" >&2; exit 2; }
  if curl -sf -m 10 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} -X POST "$BASE_URL/session/$SID/abort?$DIR_Q" -o /dev/null; then
    echo "aborted in-progress turn for $SID"
  else
    echo "error: abort failed (session not found or nothing running)" >&2; exit 5
  fi
  exit 0
fi

# ---- permissions --------------------------------------------------------------
# List pending permission requests held by the server. A turn that reads WORKING
# but frozen (see `status`) is usually parked on one of these — an
# `external_directory`/`bash` ask on a headless server no TUI ever answered.
if [ "$MODE" = "permissions" ]; then
  require_server
  curl -sf -m 10 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} "$BASE_URL/permission" \
    | node -e '
      let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
        let a;try{a=JSON.parse(d)}catch(e){console.error("bad JSON from server");process.exit(1)}
        if(!Array.isArray(a)){console.error("unexpected response");process.exit(1)}
        if(a.length===0){console.log("no pending permission requests");process.exit(0)}
        for(const p of a){
          console.log(p.id);
          console.log("  permission: "+(p.permission||"?"));
          console.log("  patterns:   "+((p.patterns||[]).join(" ")||"(none)"));
          console.log("  session:    "+(p.sessionID||"?"));
          if(p.tool) console.log("  tool:       "+p.tool);
          if(p.metadata&&p.metadata.title) console.log("  title:      "+p.metadata.title);
          console.log("");
        }
        console.log("approve with: opencode-dispatch.sh allow <requestID> [--always]");
      });'
  exit 0
fi

# ---- allow --------------------------------------------------------------------
# Approve a pending permission request (ids come from `permissions`). Default
# replies "once" (this request only); --always also remembers the pattern for
# the session, so covered asks auto-resolve without a prompt. Approvals are
# in-memory only — they do not survive a server restart (config is the durable
# fix). The blocked turn resumes if its session is still active.
if [ "$MODE" = "allow" ]; then
  require_server
  RID="${MSG_PARTS[0]:-}"
  [ -z "$RID" ] && { echo "error: allow needs a <requestID> (see: $(basename "$0") permissions)" >&2; exit 2; }
  REPLY="once"; [ -n "$ALWAYS" ] && REPLY="always"
  # NO ?directory= here: the reply endpoint VALIDATES it against the session's
  # own directory and 404s (PermissionNotFoundError) on any mismatch — verified
  # on 1.18.9 — so passing the wrapper's cwd made `allow` flaky whenever the
  # parked session lived in another directory (e.g. --task resolution, or a
  # server started elsewhere). The bare POST is the working contract.
  REPLY="$REPLY" node -e 'process.stdout.write(JSON.stringify({reply:process.env.REPLY}));' \
    | curl -sf -m 10 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} -X POST "$BASE_URL/permission/$RID/reply" \
        -H 'content-type: application/json' --data-binary @- -o /dev/null \
    || { echo "error: reply failed (request not found, already resolved, or server unreachable)" >&2; exit 5; }
  echo "allowed $RID ($REPLY)"
  exit 0
fi

# ---- run modes (review|plan|ask|task|bulk) -----------------------------------
# DEFAULT: server-backed + async (observable via status/history, killable via
# abort). Opt into a one-shot, non-server, blocking run with --direct.
# The message comes from --prompt-file, or from positional prompt text that the
# re-exec at the top of this script already converted to a prompt file — so the
# prompt never sits in this process's argv for the run, and a pruned session
# context can always re-read the file.
MSG=""
if [ -n "$PROMPT_FILE" ]; then
  [ -r "$PROMPT_FILE" ] || { echo "error: --prompt-file not readable: $PROMPT_FILE" >&2; exit 2; }
  MSG="$(cat "$PROMPT_FILE")"
fi
# review may run with no message (default intro); every other run mode needs one.
if [ "$MODE" != "review" ] && [ -z "$MSG" ]; then
  echo "error: $MODE needs a prompt (positional text or --prompt-file <path>)" >&2; exit 2
fi

case "$MODE" in
  review)    AGENT_DEF="review" ;;
  plan|ask)  AGENT_DEF="plan" ;;
  task|bulk) AGENT_DEF="auto" ;;
  *) echo "unknown mode: $MODE" >&2; exit 2 ;;
esac
AGENT_USE="${AGENT:-$AGENT_DEF}"

# review pulls the diff into a file; other modes take the message text.
# NOTE: the diff is fetched HERE, inside the script, and uploaded straight to the
# opencode server — it never crosses back into the caller's (Claude's) context.
# Only the distilled review findings return. Keep it that way: never echo $diff.
if [ -n "$PR" ] && [ "$MODE" != "review" ]; then
  echo "error: --pr is only valid for 'review'" >&2; exit 2
fi
if [ -n "$SCOPE" ] && [ "$MODE" != "review" ]; then
  echo "error: --scope is only valid for 'review' (edit workers always operate on their allocated worktree)" >&2; exit 2
fi
diff=""
if [ "$MODE" = "review" ]; then
  diff="$(mktemp "${TMPDIR:-/tmp}/opencode-diff.XXXXXX")"
  trap 'rm -f "$diff"' EXIT
  if [ -n "$PR" ]; then
    # Fetch the GitHub PR diff via gh, in-script. Requires gh + auth.
    if ! command -v gh >/dev/null 2>&1; then
      echo "error: --pr needs the GitHub CLI (gh). Install: brew install gh; then: gh auth login" >&2
      exit 4
    fi
    # gh resolves a bare PR number from the CURRENT repo's git remote. The
    # dispatch can run from a directory with no remotes (e.g. a skill repo),
    # where gh dies with "no git remotes found" — take an explicit --repo
    # owner/repo, or infer it from $DIR's origin remote.
    if [ -z "$REPO" ]; then
      REPO="$(git -C "$DIR" config --get remote.origin.url 2>/dev/null \
        | sed -E 's#^(https?://[^/]+/|ssh://[^/]+/|git@[^:]+:)##; s#\.git$##' || true)"
    fi
    if [ -z "$REPO" ]; then
      echo "error: could not determine the GitHub repo for PR #$PR (no git remote in $DIR)." >&2
      echo "  Pass --repo owner/repo explicitly." >&2
      exit 5
    fi
    if ! ( cd "$DIR" 2>/dev/null && gh pr diff "$PR" --repo "$REPO" ) > "$diff" 2>/dev/null; then
      echo "error: could not fetch diff for PR #$PR from $REPO (gh pr diff failed — check --repo, the PR number, and 'gh auth status')." >&2
      exit 5
    fi
  elif [ "$SCOPE" = "working-tree" ]; then
    # --scope working-tree: uncommitted changes only, whatever --base says.
    [ -n "$BASE" ] && { echo "error: --scope working-tree conflicts with --base" >&2; exit 2; }
    git -C "$DIR" diff HEAD > "$diff" 2>/dev/null || git -C "$DIR" diff > "$diff"
  elif [ "$SCOPE" = "branch" ]; then
    # --scope branch: the branch range --base<ref>...HEAD — the job's base branch.
    [ -n "$BASE" ] || { echo "error: --scope branch needs --base <ref> (the base branch for the job)" >&2; exit 2; }
    git -C "$DIR" diff "$BASE"...HEAD > "$diff" 2>/dev/null || git -C "$DIR" diff "$BASE" > "$diff"
  elif [ -n "$BASE" ]; then
    git -C "$DIR" diff "$BASE"...HEAD > "$diff" 2>/dev/null || git -C "$DIR" diff "$BASE" > "$diff"
  else
    git -C "$DIR" diff HEAD > "$diff" 2>/dev/null || git -C "$DIR" diff > "$diff"
  fi
  if [ ! -s "$diff" ]; then echo "Nothing to review (empty diff for the selected scope)."; exit 0; fi
else
  [ -z "$MSG" ] && { echo "error: a message/task is required" >&2; exit 2; }
fi

if [ -n "$DIRECT" ]; then
  # ---- OPT-IN: one-shot, non-server, blocking (returns output inline) ----
  COMMON=( run --dir "$DIR" )
  [ -n "$MODEL" ]   && COMMON+=( -m "$MODEL" )
  [ -n "$VARIANT" ] && COMMON+=( --variant "$VARIANT" )
  [ -n "$FORMAT" ]  && COMMON+=( --format "$FORMAT" )
  case "$MODE" in
      review)
        prompt="${MSG:-Review the attached ${PR:+GitHub PR #$PR }diff.} Report concrete issues only; cite file:line."
        # -f is a greedy array flag: prompt BEFORE it, -f terminal with one value.
        # --auto kept for review: its config EXPLICITLY denies edit/webfetch, so
        # --auto cannot unlock them (auto only approves what is not denied);
        # bash is explicitly allowed (git reads). Verified on opencode 1.18.9.
        exec opencode "${COMMON[@]}" --agent "$AGENT_USE" --auto "$prompt" -f "$diff"
        ;;
      plan|ask)
        # NO --auto for plan/ask: the plan agent's bash is already allowed by
        # opencode's default (`*` allow; no bash rule in the plan agent), so
        # --auto adds nothing — it would only auto-approve the external_directory
        # and doom_loop asks that are plan's remaining read-only guards. Verified
        # on opencode 1.18.9 (agent list + live bash probe). --auto IS kept for
        # review below, whose edit/webfetch are explicitly denied.
        exec opencode "${COMMON[@]}" --agent "$AGENT_USE" "$MSG"
        ;;
    task|bulk)
      echo "error: --direct is not supported for edit-capable task/bulk workers; use the isolated server-backed path" >&2
      exit 2
      ;;
  esac
fi

# ---- DEFAULT: server-backed, async ----
ensure_server

# assemble the prompt text into a file (safe for huge review diffs over HTTP)
msgfile="$(mktemp "${TMPDIR:-/tmp}/opencode-msg.XXXXXX")"
trap 'rm -f "$diff" "$msgfile"' EXIT
if [ "$MODE" = "review" ]; then
  if [ -n "$PR" ]; then
    default_intro="Review the following diff for GitHub PR #$PR."; title="review PR #$PR: ${DIR##*/}"
  else
    default_intro="Review the following git diff."; title="review: ${DIR##*/}"
  fi
  { printf '%s\n\n```diff\n' "${MSG:-$default_intro} Report concrete issues only; cite file:line."; cat "$diff"; printf '\n```\n'; } > "$msgfile"
elif [ "$MODE" = "task" ] || [ "$MODE" = "bulk" ]; then
  # Durable, re-readable brief: the full prompt is copied into the worker's
  # worktree (after spawn, below) as ./.opencode-task-brief.md, and the
  # submitted message leads with that pointer. opencode prunes older tool
  # output to ~2k chars once a session grows, so a long brief WILL vanish from
  # the model's context mid-session — the on-disk copy is the recovery path.
  {
    printf '%s\n' "YOUR COMPLETE TASK BRIEF IS SAVED AT ./.opencode-task-brief.md (root of your working directory)."
    printf '%s\n' "Long sessions prune older tool output from your context. RE-READ that file (in chunks if large) before each major implementation step, and any time you are unsure of the spec."
    printf '%s\n\n---\n\n' "Keep all scratch files INSIDE your working directory (writing outside it, e.g. /tmp, can stall the session on a permission prompt no one can answer)."
    printf '%s' "$MSG"
  } > "$msgfile"
  title="$MODE: ${MSG:0:60}"
else
  printf '%s' "$MSG" > "$msgfile"
  title="$MODE: ${MSG:0:60}"
fi

# Edit-capable modes always go through the isolated worker launcher. The
# launcher owns allocation, bootstrap, directory verification, session
# creation, and attached-client startup; this wrapper must not duplicate any
# of those safety-sensitive steps.
ISOLATED=0
if [ "$MODE" = "task" ] || [ "$MODE" = "bulk" ]; then
  ISOLATED=1
  orch="${ORCHESTRATION_ROOT:-$DIR/scripts}"
  spawn="$orch/spawn-agent.mjs"
  if [ ! -f "$spawn" ]; then
    echo "error: isolated worker launcher not found: $spawn" >&2
    echo "  Set OPENCODE_ORCHESTRATION_ROOT or pass --orchestration-root <path>." >&2
    exit 5
  fi
  spawn_args=("$spawn" --from "$DIR" --server "$BASE_URL" --agent "${AGENT_USE:-auto}" --prompt-file "$msgfile" --allow-edit --allow-bash)
  [ -n "$MODEL" ] && spawn_args+=(--model "$MODEL")
  [ -n "$VARIANT" ] && spawn_args+=(--variant "$VARIANT")
  [ -n "$WORKTREE_ROOT" ] && spawn_args+=(--worktree-root "$WORKTREE_ROOT")
  worker_json="$(node "${spawn_args[@]}")" || { echo "error: isolated worker launch failed" >&2; exit 5; }
  IFS=$'\t' read -r SID DIR TASK_ID WORKER_BRANCH < <(printf '%s' "$worker_json" | node -e '
    const r=JSON.parse(require("fs").readFileSync(0,"utf8"));
    process.stdout.write(`${r.sessionId || ""}\t${r.worktreePath || ""}\t${r.taskId || ""}\t${r.branch || ""}\n`);') || {
      echo "error: isolated worker returned invalid metadata" >&2; exit 5;
    }
  [ -n "$SID" ] && [ -n "$DIR" ] || { echo "error: isolated worker did not return session/worktree" >&2; exit 5; }
  WORKER_WORKTREE="$DIR"
  # Land the durable brief copy the submitted message points at. Local-only:
  # excluded from git so it can never ride into a commit. (The submit is
  # async; this cp completes long before the model's first read.)
  if cp "$msgfile" "$DIR/.opencode-task-brief.md" 2>/dev/null; then
    excl="$(git -C "$DIR" rev-parse --git-path info/exclude 2>/dev/null || true)"
    if [ -n "$excl" ]; then
      grep -qxF ".opencode-task-brief.md" "$excl" 2>/dev/null || echo ".opencode-task-brief.md" >> "$excl"
    fi
  else
    echo "warning: could not write $DIR/.opencode-task-brief.md (worker must rely on in-context brief)" >&2
  fi
  refresh_dir_query
  printf '%s\n' "$worker_json" | MODE="$MODE" node -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
      const r=JSON.parse(d);
      console.log(`started [${process.env.MODE}]`);
      console.log(`  task:    ${r.taskId}`);
      console.log(`  session: ${r.sessionId||"pending"}`);
      console.log(`  branch:  ${r.branch}`);
      console.log(`  dir:     ${r.worktreePath}`);
      if(r.logPath) console.log(`  log:     ${r.logPath}`);
    });'
  if [ -z "$FOLLOW" ] && [ -z "$AWAIT" ]; then exit 0; fi
  # From here the wrapper waits on the worker: however it ends (success, turn
  # error, timeout, stall, unreachable server, teardown or not), say where the
  # branch and worktree are. stderr, so the distilled reply on stdout stays clean.
  print_worker_footer() {
    local state="kept"
    [ -d "$WORKER_WORKTREE" ] || state="removed (torn down)"
    {
      echo "[$MODE] task:     ${TASK_ID:-?}"
      echo "[$MODE] branch:   ${WORKER_BRANCH:-?}"
      echo "[$MODE] worktree: $WORKER_WORKTREE ($state)"
    } >&2
  }
  trap 'rm -f "$diff" "$msgfile"; print_worker_footer' EXIT
fi

# task/bulk may edit files → pre-authorize edit/bash so the turn doesn't stall on a prompt.
if [ "$ISOLATED" -eq 0 ]; then
perm=""
{ [ "$MODE" = "task" ] || [ "$MODE" = "bulk" ]; } && perm='[{"permission":"edit","pattern":"**","action":"allow"},{"permission":"bash","pattern":"**","action":"allow"}]'

SID="$(oc_create_session "$AGENT_USE" "$MODEL" "$VARIANT" "$title" "$perm")" || { echo "error: could not create session" >&2; exit 5; }
oc_submit_async "$SID" "$msgfile" "$AGENT_USE" "$MODEL" "$VARIANT" || { echo "error: could not submit prompt to $SID" >&2; exit 5; }

# Early worktree-mismatch guard. Server-backed sessions run in the SERVER's cwd,
# not --dir; --follow/--background exit before the final banner's NOTE, so warn up
# front for those. Only task/bulk edit the tree (review uploads a diff captured
# from --dir), so scope it to them. Catches the "N subagents, one shared tree"
# mistake — they all edit the SAME server cwd; they do NOT get separate worktrees.
if { [ -n "$FOLLOW" ] || [ -n "$AWAIT" ]; } && { [ "$MODE" = "task" ] || [ "$MODE" = "bulk" ]; }; then
  sdir="$(curl -sf -m 10 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} "$BASE_URL/session/$SID" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).directory||"")}catch(e){}});' 2>/dev/null)"
  if [ -n "$sdir" ] && [ "$sdir" != "$DIR" ]; then
    echo "[$MODE] WARNING: server cwd ($sdir) != --dir ($DIR)." >&2
    echo "        This session EDITS $sdir, not $DIR. Every session on this server" >&2
    echo "        shares $sdir — subagents do NOT get separate worktrees here." >&2
    echo "        For isolation, run one server per worktree on its own --port." >&2
    if [ -n "$REQUIRE_DIR" ]; then
      curl -sf -m 10 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} -X POST "$BASE_URL/session/$SID/abort" -o /dev/null 2>/dev/null || true
      echo "[$MODE] --require-dir set: aborted $SID (refusing to edit the wrong tree)." >&2
      exit 9
    fi
  fi
fi
fi

if [ -n "$FOLLOW" ]; then
  follow_turn "$SID"   # always exits (reply print, or timeout -> exit 0)
  exit 0
fi

# ---- --background/--wait: block to COMPLETION, print distilled result, then EXIT ----
# Unlike --follow (bounded, then leaves it running), --background/--wait live
# exactly as long as the turn: they exit 0 the moment the turn completes. Launch
# the wrapper as a background task and the caller (Claude Code) is re-invoked on
# that exit — wake-on-complete.
if [ -n "$AWAIT" ]; then
  if [ -n "$TEARDOWN" ] && [ "$ISOLATED" -eq 1 ] && [ -n "$TASK_ID" ]; then
    # await_turn always exits, so run it in a subshell to regain control and tear
    # the worker down only after a clean completion (exit 0).
    # (set -e: capture the status without letting a non-zero subshell kill us.)
    ( await_turn "$SID" ) && rc=0 || rc=$?
    if [ "$rc" -eq 0 ]; then
      run_teardown "$TASK_ID" || echo "warning: teardown of $TASK_ID failed; clean up manually: $(basename "$0") teardown --task $TASK_ID" >&2
    else
      echo "[$MODE] turn did not complete cleanly (exit $rc); NOT tearing down. Inspect, then: $(basename "$0") teardown --task $TASK_ID" >&2
    fi
    exit "$rc"
  fi
  await_turn "$SID"   # always exits: 0 done, 3 timeout, 7 unreachable, 8 stall
  exit 0
fi

sdir="$(curl -sf -m 10 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} "$BASE_URL/session/$SID" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).directory||"")}catch(e){}});' 2>/dev/null)"
echo "started [$MODE] on server $BASE_URL"
echo "  session: $SID"
echo "  agent:   $AGENT_USE    model: ${MODEL:-<opencode default>}"
echo "  dir:     ${sdir:-?}"
if { [ "$MODE" = "task" ] || [ "$MODE" = "bulk" ]; } && [ -n "$sdir" ] && [ "$sdir" != "$DIR" ]; then
  echo "  NOTE: session runs in the SERVER's dir, which differs from --dir ($DIR)."
  echo "        Edits land in the session dir. Start the server there, or use --direct."
fi
echo "  watch:   $(basename "$0") status $SID   |   $(basename "$0") history $SID --turns 1   |   $(basename "$0") abort $SID"
