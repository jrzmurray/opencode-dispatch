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
# with abort). Pass --synchronous to instead run a one-shot, non-server,
# blocking `opencode run` that prints output inline (for quick/small asks).
#
# Modes:
#   review    Review the local git changes (uses the `review` agent).
#   plan      Read-only analysis / planning, no edits (built-in `plan` agent).
#   ask       Question answering, no edits (built-in `plan` agent).
#   task      Agentic build task — the model may edit files and run commands.
#   bulk      Same as task (async server run is inherently background-friendly).
#   serve     Start (or confirm) a persistent local `opencode serve` on --port.
#   sessions  List sessions from a running server (id, updated, title).
#   history   Print a session's transcript. <sessionID> positional required.
#             Limit with any of: --tail N (default 100 lines), --since <range>
#             (e.g. 1d 6h 10m 30s), --turns N (last N prompts + their responses).
#   status    Liveness of sessions. With a <sessionID>: detailed view of that
#             session (activity, cost, state). Without one: one-line summary of
#             all sessions, sorted newest first. Cheap — no transcript pulled.
#   send      Message an existing session. <sessionID> then the message text.
#             --wait (default) blocks for the reply; --steer injects into the
#             running turn; --queue appends after the current turn.
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
#   --effort <name>           Provider-specific reasoning effort -> --variant.
#   --variant <name>          Same as --effort (explicit passthrough).
#   --base <ref>              (review) diff base ref, e.g. main; default = working tree
#   --pr <n>                  (review) review GitHub PR #n: fetches `gh pr diff <n>`
#                             IN-SCRIPT and uploads it to the delegate — the diff
#                             never returns to the caller's context. Needs gh+auth.
#   --dir <path>              Directory to root the SESSION in (default: current
#                             dir). Passed as ?directory= on create+prompt, so a
#                             single shared server can run each session in its own
#                             worktree — no server-per-agent needed.
#   --prompt-file <path>      (run modes + send) REQUIRED source of the message/task.
#                             Inline positional prompt text is REJECTED: argv is
#                             visible host-wide via `ps` for the whole run, and a
#                             pruned session context cannot re-read inline text.
#                             task/bulk additionally copy the prompt into the
#                             worker's worktree as ./.opencode-task-brief.md
#                             (git-excluded) and tell the worker to re-read it.
#                             Historical rationale (superseded text follows): for large prompts and to avoid
#                             shell quoting/arg-length issues. Overrides positionals.
#   --synchronous             (run modes) run one-shot & non-server, blocking,
#                             output inline (NOT --sync). Default is server+async.
#   --follow                  (run modes) after the async submit, wait (bounded)
#                             for the turn to finish and print the reply inline.
#   --await                   (run modes) block until the turn COMPLETES, print
#                             only the distilled result, then EXIT 0 — designed to
#                             be launched as a background task so the caller (e.g.
#                             Claude Code) is woken on exit ("wake-on-complete").
#                             No short deadline: waits ~24h by default; --timeout 0
#                             = truly unbounded. Exits non-zero on turn error or if
#                             the server becomes unreachable.
#   --summarize               (with --await) instead of the final message, produce
#                             a REMOTE summary (POST /session/:id/summarize, done on
#                             the delegate model) and print only that. For churny
#                             task/bulk sessions; reviews are already distilled.
#   --timeout <N>             (with --follow/--await) max seconds to wait. --follow
#                             default 300 then leaves it running; --await default
#                             ~24h then exits non-zero. 0 = unbounded (--await).
#   --stall <N>               (with --await) give up if the session makes NO
#                             progress for N seconds — its newest message
#                             timestamp stops advancing (default 900; 0 = off;
#                             env OPENCODE_DISPATCH_STALL_SECS). Catches hung
#                             turns that read as "working" forever. Exit 8.
#   --require-dir             (task/bulk with --follow/--await) hard-fail if the
#                             server's cwd differs from --dir: abort the session
#                             and exit 9 instead of just warning. Use to stop a
#                             subagent editing the wrong (shared) tree.
#   --orchestration-root <p>  Directory containing spawn-agent.mjs and the
#                             worktree lifecycle helpers (task/bulk).
#   --task <id>               Resolve a worker task record for lifecycle commands.
#   --json                    (run modes, --synchronous only) raw JSON events
#   --tail <N>                (history) keep only the last N lines (default 100)
#   --turns <N>               (history) keep only the last N prompts + their responses
#                             (alias --prompts). Un-truncated unless --tail is also given.
#   --since <range>           (history) only messages newer than now-range (1d/6h/10m/30s/2w)
#   --wait                    (send) block for the reply (default delivery)
#   --steer                   (send) inject into the in-progress turn
#   --queue                   (send) append after the current turn
#   --port <N>                Server port (default $OPENCODE_DISPATCH_PORT or 4096)
#   --host <addr>             Server host (default $OPENCODE_DISPATCH_HOST or 127.0.0.1)
#   --                        Everything after this is the literal message
#
# Server auth: if $OPENCODE_SERVER_PASSWORD is set, curl uses it as basic-auth
# password (empty username), matching an `opencode serve` started with that env.

set -euo pipefail

MODE="${1:-}"
if [ -z "$MODE" ]; then
  echo "error: mode required (review|plan|ask|task|bulk|serve|sessions|history|permissions|allow|setup)" >&2
  exit 2
fi
shift || true

if ! command -v opencode >/dev/null 2>&1; then
  echo "error: opencode is not installed or not on PATH." >&2
  echo "  Install: brew install sst/tap/opencode   (or: npm i -g opencode-ai)" >&2
  exit 4
fi

MODEL="${OPENCODE_DISPATCH_MODEL:-}"
AGENT=""
VARIANT=""
BASE=""
PR=""
DIR="$PWD"
FORMAT=""
TAIL="100"
TAIL_SET=""
TURNS=""
SINCE=""
STEER=""
QUEUE=""
WAIT=""
SYNC=""
FOLLOW=""
AWAIT=""
ALWAYS=""
SUMMARIZE=""
FOLLOW_TIMEOUT="300"
TIMEOUT_SET=""
# --await stall guard: give up if the session makes NO progress (its newest
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
PORT="${OPENCODE_DISPATCH_PORT:-4096}"
HOST="${OPENCODE_DISPATCH_HOST:-127.0.0.1}"
MSG_PARTS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --model)             MODEL="${2:-}"; shift 2 ;;
    --agent)             AGENT="${2:-}"; shift 2 ;;
    --effort|--variant)  VARIANT="${2:-}"; shift 2 ;;
    --base)              BASE="${2:-}"; shift 2 ;;
    --pr)                PR="${2:-}"; shift 2 ;;
    --dir)               DIR="${2:-}"; shift 2 ;;
    --prompt-file)       PROMPT_FILE="${2:-}"; shift 2 ;;
    --json)              FORMAT="json"; shift ;;
    --tail)              TAIL="${2:-}"; TAIL_SET=1; shift 2 ;;
    --turns|--prompts)   TURNS="${2:-}"; shift 2 ;;
    --since)             SINCE="${2:-}"; shift 2 ;;
    --steer)             STEER=1; shift ;;
    --queue)             QUEUE=1; shift ;;
    --wait)              WAIT=1; shift ;;
    --synchronous)       SYNC=1; shift ;;
    --follow)            FOLLOW=1; shift ;;
    --await)             AWAIT=1; shift ;;
    --always)            ALWAYS=1; shift ;;
    --summarize)         SUMMARIZE=1; shift ;;
    --timeout)           FOLLOW_TIMEOUT="${2:-}"; TIMEOUT_SET=1; shift 2 ;;
    --stall)             STALL_SECS="${2:-}"; shift 2 ;;
    --require-dir)       REQUIRE_DIR=1; shift ;;
    --orchestration-root) ORCHESTRATION_ROOT="${2:-}"; shift 2 ;;
    --worktree-root)     WORKTREE_ROOT="${2:-}"; shift 2 ;;
    --task)              TASK_ID="${2:-}"; shift 2 ;;
    --port)              PORT="${2:-}"; shift 2 ;;
    --host)              HOST="${2:-}"; shift 2 ;;
    --)                  shift; MSG_PARTS+=("$@"); break ;;
    *)                   MSG_PARTS+=("$1"); shift ;;
  esac
done

BASE_URL="http://${HOST}:${PORT}"
CURL_AUTH=()
[ -n "${OPENCODE_SERVER_PASSWORD:-}" ] && CURL_AUTH=( --user ":${OPENCODE_SERVER_PASSWORD}" )

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

# --await blocks to completion: no short deadline. Default backstop ~24h unless
# the caller set --timeout (0 = unbounded). --follow keeps its 300s default.
if [ -n "$AWAIT" ] && [ -z "$TIMEOUT_SET" ]; then FOLLOW_TIMEOUT="86400"; fi

server_up() { curl -sf -m 3 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} "$BASE_URL/session" -o /dev/null 2>/dev/null; }

# parked_permission <sessionID> — echoes "requestID permission patterns" if the
# server holds a pending permission ask for that session, else nothing. Lets
# every "working"-ish readout (status, follow, await heartbeats) tell a parked
# permission prompt apart from real progress.
parked_permission() {
  curl -sf -m 5 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} "$BASE_URL/permission" 2>/dev/null \
    | PERMSID="$1" node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const a=JSON.parse(d);const p=(a||[]).find(x=>x.sessionID===process.env.PERMSID);if(!p)process.exit(0);process.stdout.write(p.id+" "+p.permission+" "+((p.patterns||[]).join(" ")))}catch(e){process.exit(0)}})' 2>/dev/null || true
}

require_server() {
  if ! server_up; then
    echo "error: no opencode server reachable at $BASE_URL" >&2
    echo "  Start one: $(basename "$0") serve --port $PORT" >&2
    exit 5
  fi
}

SERVE_LOG=""
start_server() {  # $1 = directory to root the server in
  local dir="${1:-$PWD}"
  local logdir="${TMPDIR:-/tmp}/opencode-serve"; mkdir -p "$logdir"
  SERVE_LOG="$logdir/serve-${PORT}.log"
  ( cd "$dir" 2>/dev/null && exec nohup opencode serve --port "$PORT" --hostname "$HOST" >"$SERVE_LOG" 2>&1 ) &
  disown 2>/dev/null || true
  local i
  for i in $(seq 1 30); do server_up && return 0; sleep 0.3; done
  return 1
}

ensure_server() {  # auto-start in $DIR if none is reachable
  server_up && return 0
  echo "no opencode server at $BASE_URL — starting one in ${DIR}…" >&2
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
oc_submit_async() {  # $1=sessionId $2=path-to-message-text-file $3=agent(optional)
  MSGFILE="$2" AGENT_ID="${3:-}" node -e '
    const fs=require("fs");
    const b={parts:[{type:"text",text:fs.readFileSync(process.env.MSGFILE,"utf8")}]};
    if(process.env.AGENT_ID) b.agent=process.env.AGENT_ID;
    process.stdout.write(JSON.stringify(b));' \
  | curl -sf -m 20 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} -X POST "$BASE_URL/session/$1/prompt_async?$DIR_Q" -H 'content-type: application/json' --data-binary @-
}

# ---- setup -------------------------------------------------------------------
if [ "$MODE" = "setup" ]; then
  echo "opencode:  $(command -v opencode)"
  opencode --version 2>/dev/null | sed 's/^/version:   /' || true
  echo "config:    $HOME/.config/opencode/opencode.json"
  echo "server:    $BASE_URL  ($(server_up && echo UP || echo down))"
  echo "default model (dispatch): ${MODEL:-<opencode config default>}"
  echo "authenticated providers:"
  opencode auth list 2>/dev/null | sed 's/^/  /' || echo "  (none — run: opencode auth login)"
  echo "models available:"
  opencode models 2>/dev/null | sed 's/^/  - /' | head -40 || echo "  (run after auth to list)"
  exit 0
fi

# ---- serve -------------------------------------------------------------------
if [ "$MODE" = "serve" ]; then
  if server_up; then
    echo "opencode server already running at $BASE_URL"
    exit 0
  fi
  if start_server "$DIR"; then
    echo "opencode server started at $BASE_URL (dir: $DIR)"
    echo "log: $SERVE_LOG"
    exit 0
  fi
  echo "error: server did not come up within ~9s; see $SERVE_LOG" >&2
  tail -5 "$SERVE_LOG" >&2 2>/dev/null || true
  exit 6
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
  curl -sf -m 30 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} "$BASE_URL/session/$SID/message?$DIR_Q" \
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
        // 4) line cap: explicit --tail always applies; otherwise default 100 UNLESS
        //    --turns was given (then show whole turns un-truncated).
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
    # No session ID: show one-line summary for every session, sorted newest first.
    # Fetch the pending-permission session ids once so a parked ask can mark its
    # session instead of a misleading plain "WORKING".
    permsids="$(curl -sf -m 5 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} "$BASE_URL/permission" 2>/dev/null \
      | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{for(const p of JSON.parse(d)){if(p.sessionID)console.log(p.sessionID)}}catch(e){}})' 2>/dev/null || true)"
    curl -sf -m 10 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} "$BASE_URL/session" \
      | BN="$(basename "$0")" PERMSIDS="$permsids" LIMIT="$TAIL" node -e '
        let d=""; process.stdin.on("data",c=>d+=c).on("end",()=>{
          let a; try{a=JSON.parse(d)}catch(e){console.error("bad JSON from server");process.exit(1)}
          const norm=t=>t&&t<1e12?t*1000:t;
          a.sort((x,y)=>(norm(y?.time?.updated)||0)-(norm(x?.time?.updated)||0));
          const lim=parseInt(process.env.LIMIT,10)||50;
          const shown=a.slice(0,lim);
          const now=Date.now();
          const permset=new Set((process.env.PERMSIDS||"").split("\n").filter(Boolean));
          const fmt=ms=>{let x=Math.floor(ms/1000);const h=Math.floor(x/3600);x%=3600;const mi=Math.floor(x/60);const se=x%60;return (h?h+"h ":"")+(h||mi?mi+"m ":"")+se+"s";};
          let nperm=0;
          for(const s of shown){
            const u=norm(s?.time?.updated)||0;
            const idle=now-u;
            const li=s?.lastMessage?.info||{};
            const working=li.role==="assistant"&&!(li.time&&li.time.completed);
            const parked=permset.has(s.id);
            if(parked) nperm++;
            const state=working?(parked?"PERMASK":"WORKING"):"idle";
            const age=u?fmt(idle)+" ago":"?";
            console.log(`${s.id}  ${state.padEnd(7)}  ${age.padStart(12)}  ${s.title||""}`);
          }
          if(nperm) console.log(`… ${nperm} session(s) parked on a permission prompt (see: ${process.env.BN} permissions / allow)`);
          if(a.length>shown.length) console.log(`… ${a.length-shown.length} older session(s) not shown (raise --tail).`);
        });'
    exit 0
  fi
  sess="$(curl -sf -m 10 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} "$BASE_URL/session/$SID?$DIR_Q")" || { echo "error: session not found" >&2; exit 5; }
  msgs="$(curl -sf -m 10 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} "$BASE_URL/session/$SID/message?$DIR_Q" || echo '[]')"
  parked="$(parked_permission "$SID")"
  printf '{"session":%s,"messages":%s}' "$sess" "$msgs" | PARKED="$parked" node -e '
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
      const lastErr = (Array.isArray(m)?m:[]).map(x=>x?.info?.error).filter(Boolean).pop();
      console.log("session:  "+s.id);
      console.log("title:    "+(s.title||""));
      console.log("model:    "+(s?.model?.providerID||"?")+"/"+(s?.model?.id||"?"));
      console.log("messages: "+(Array.isArray(m)?m.length:0)+"   cost: $"+(s.cost??0));
      console.log("updated:  "+(upd?new Date(upd).toISOString().replace("T"," ").slice(0,19):"?")+"  ("+fmt(idle)+" ago)");
      // A WORKING flag with a long-frozen `updated` is a parked turn (typically
      // an unanswerable permission ask on a headless server), not live work.
      const stale = working && idle > 30*60*1000;
      let state;
      if (parked) state = "WORKING — PERMISSION PROMPT ("+parked+") — approve: opencode-dispatch.sh allow <requestID> [--always]";
      else if (stale) state = "WORKING — STALE ("+fmt(idle)+" without activity; likely a dead turn — try 'abort')";
      else state = working ? "WORKING (turn in progress)" : "idle";
      console.log("state:    "+state);
      if(lastErr) console.log("lastError: "+(lastErr.name||"?")+" "+(lastErr.data?.statusCode||"")+" "+(lastErr.data?.message||""));
    });'
  exit 0
fi

# ---- send --------------------------------------------------------------------
if [ "$MODE" = "send" ]; then
  require_server
  SID="${MSG_PARTS[0]:-}"
  [ -n "$TASK_ID" ] && { resolve_task_context; }
  [ -z "$SID" ] && { echo "error: send needs a <sessionID> and --prompt-file <path>" >&2; exit 2; }
  # PROMPT FILES EXCLUSIVELY: inline message words would sit in this process's
  # argv for the whole (possibly minutes-long) run, visible to every user via
  # `ps` — and inline text can't be re-read by the worker after context
  # pruning. Write the message to a file and pass --prompt-file.
  if [ "${#MSG_PARTS[@]}" -gt 1 ]; then
    echo "error: inline send messages are no longer accepted (argv leaks to the OS process list)." >&2
    echo "  Write the message to a file and run: $(basename "$0") send $SID --prompt-file <path>" >&2
    exit 2
  fi
  [ -n "$PROMPT_FILE" ] || { echo "error: send needs --prompt-file <path> after the sessionID" >&2; exit 2; }
  [ -r "$PROMPT_FILE" ] || { echo "error: --prompt-file not readable: $PROMPT_FILE" >&2; exit 2; }
  MSG="$(cat "$PROMPT_FILE")"
  [ -n "$MSG" ] && MSG="$MSG

(This message is also saved at $PROMPT_FILE — re-read that file if your context gets pruned.)"
  [ -z "$MSG" ] && { echo "error: prompt file is empty: $PROMPT_FILE" >&2; exit 2; }
  if [ -n "$STEER" ] || [ -n "$QUEUE" ]; then
    delivery="steer"; [ -n "$QUEUE" ] && delivery="queue"
    MSG="$MSG" DELIVERY="$delivery" node -e '
      process.stdout.write(JSON.stringify({prompt:{text:process.env.MSG},delivery:process.env.DELIVERY}));' \
          | curl -sf -m 20 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} -X POST "$BASE_URL/api/session/$SID/prompt?$DIR_Q" \
          -H 'content-type: application/json' --data-binary @- \
      | DELIVERY="$delivery" node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);console.log(`${process.env.DELIVERY} admitted: seq=${j.data?.admittedSeq} id=${j.data?.id}`);}catch(e){console.log(d);}});'
    echo "(poll with: $(basename "$0") status $SID   /   history $SID --turns 1)"
  else
    # default: blocking send, return the reply text
    MSG="$MSG" node -e 'process.stdout.write(JSON.stringify({parts:[{type:"text",text:process.env.MSG}]}));' \
      | curl -sf -m 300 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} -X POST "$BASE_URL/session/$SID/message?$DIR_Q" \
          -H 'content-type: application/json' --data-binary @- \
      | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{let j;try{j=JSON.parse(d)}catch(ex){console.error("error: invalid response from server ("+ex.message+")");process.exit(1);}const e=j.info?.error;if(e){console.error("ERROR: "+(e.name||"?")+" "+(e.data?.statusCode||"")+" "+(e.data?.message||""));process.exit(1);}const t=(j.parts||[]).filter(p=>p.type==="text"&&p.text).map(p=>p.text).join("\n").trim();console.log(t);});'
  fi
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
  REPLY="$REPLY" node -e 'process.stdout.write(JSON.stringify({reply:process.env.REPLY}));' \
    | curl -sf -m 10 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} -X POST "$BASE_URL/permission/$RID/reply?$DIR_Q" \
        -H 'content-type: application/json' --data-binary @- -o /dev/null \
    || { echo "error: reply failed (request not found, already resolved, or server unreachable)" >&2; exit 5; }
  echo "allowed $RID ($REPLY)"
  exit 0
fi

# ---- run modes (review|plan|ask|task|bulk) -----------------------------------
# DEFAULT: server-backed + async (observable via status/history, killable via
# abort). Opt into a one-shot, non-server, blocking run with --synchronous.
# PROMPT FILES EXCLUSIVELY (run modes): inline prompt words would sit in this
# process's argv for the whole run (visible via `ps` to every user of the host)
# and can't be re-read by the worker after opencode's context pruning truncates
# old tool output. All run-mode messages come from --prompt-file; positional
# prompt text is rejected with guidance.
if [ "${#MSG_PARTS[@]}" -gt 0 ]; then
  echo "error: inline prompt text is no longer accepted for run modes (argv leaks to the OS process list; pruned contexts can't re-read it)." >&2
  echo "  Write the prompt to a file and run: $(basename "$0") $MODE [flags] --prompt-file <path>" >&2
  exit 2
fi
MSG=""
if [ -n "$PROMPT_FILE" ]; then
  [ -r "$PROMPT_FILE" ] || { echo "error: --prompt-file not readable: $PROMPT_FILE" >&2; exit 2; }
  MSG="$(cat "$PROMPT_FILE")"
fi
# review may run with no message (default intro); every other run mode needs one.
if [ "$MODE" != "review" ] && [ -z "$MSG" ]; then
  echo "error: $MODE needs --prompt-file <path> (inline prompts are not accepted)" >&2; exit 2
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
    if ! ( cd "$DIR" 2>/dev/null && gh pr diff "$PR" ) > "$diff" 2>/dev/null; then
      echo "error: could not fetch diff for PR #$PR (gh pr diff failed — check the number, repo, and 'gh auth status')." >&2
      exit 5
    fi
  elif [ -n "$BASE" ]; then
    git -C "$DIR" diff "$BASE"...HEAD > "$diff" 2>/dev/null || git -C "$DIR" diff "$BASE" > "$diff"
  else
    git -C "$DIR" diff HEAD > "$diff" 2>/dev/null || git -C "$DIR" diff > "$diff"
  fi
  if [ ! -s "$diff" ]; then echo "Nothing to review (empty diff for the selected scope)."; exit 0; fi
else
  [ -z "$MSG" ] && { echo "error: a message/task is required" >&2; exit 2; }
fi

if [ -n "$SYNC" ]; then
  # ---- OPT-IN: one-shot, non-server, blocking (returns output inline) ----
  COMMON=( run --dir "$DIR" )
  [ -n "$MODEL" ]   && COMMON+=( -m "$MODEL" )
  [ -n "$VARIANT" ] && COMMON+=( --variant "$VARIANT" )
  [ -n "$FORMAT" ]  && COMMON+=( --format "$FORMAT" )
  case "$MODE" in
      review)
        prompt="${MSG:-Review the attached ${PR:+GitHub PR #$PR }diff.} Report concrete issues only; cite file:line."
        # -f is a greedy array flag: prompt BEFORE it, -f terminal with one value.
        exec opencode "${COMMON[@]}" --agent "$AGENT_USE" --auto "$prompt" -f "$diff"
        ;;
      plan|ask)
        exec opencode "${COMMON[@]}" --agent "$AGENT_USE" --auto "$MSG"
        ;;
    task|bulk)
      echo "error: --synchronous is not supported for edit-capable task/bulk workers; use the isolated server-backed path" >&2
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
  IFS=$'\t' read -r SID DIR < <(printf '%s' "$worker_json" | node -e '
    const r=JSON.parse(require("fs").readFileSync(0,"utf8"));
    process.stdout.write(`${r.sessionId || ""}\t${r.worktreePath || ""}\n`);') || {
      echo "error: isolated worker returned invalid metadata" >&2; exit 5;
    }
  [ -n "$SID" ] && [ -n "$DIR" ] || { echo "error: isolated worker did not return session/worktree" >&2; exit 5; }
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
fi

# task/bulk may edit files → pre-authorize edit/bash so the turn doesn't stall on a prompt.
if [ "$ISOLATED" -eq 0 ]; then
perm=""
{ [ "$MODE" = "task" ] || [ "$MODE" = "bulk" ]; } && perm='[{"permission":"edit","pattern":"**","action":"allow"},{"permission":"bash","pattern":"**","action":"allow"}]'

SID="$(oc_create_session "$AGENT_USE" "$MODEL" "$VARIANT" "$title" "$perm")" || { echo "error: could not create session" >&2; exit 5; }
oc_submit_async "$SID" "$msgfile" "$AGENT_USE" || { echo "error: could not submit prompt to $SID" >&2; exit 5; }

# Early worktree-mismatch guard. Server-backed sessions run in the SERVER's cwd,
# not --dir; --follow/--await exit before the final banner's NOTE, so warn up
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
  echo "[$MODE] session $SID started; following (timeout ${FOLLOW_TIMEOUT}s)…" >&2
  deadline=$(( $(date +%s) + FOLLOW_TIMEOUT ))
  last_beat=0
  while :; do
    read -r n st < <(curl -sf -m 10 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} "$BASE_URL/session/$SID/message" \
      | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const a=JSON.parse(d);const l=a[a.length-1]?.info;const w=l&&l.role==="assistant"&&!(l.time&&l.time.completed);process.stdout.write(a.length+" "+(w?"working":"idle")+"\n")});' 2>/dev/null) || true
    [ "${n:-0}" -ge 2 ] && [ "$st" = "idle" ] && break
    now=$(date +%s)
    # follow has no stall guard, so a parked permission ask would otherwise sit
    # silent until timeout: heartbeat the parked state at ~30s while working.
    if [ "$st" = "working" ] && [ $(( now - last_beat )) -ge 30 ]; then
      parked="$(parked_permission "$SID")"
      if [ -n "$parked" ]; then
        echo "[$MODE] $SID Permissions prompt (request $parked) — approve: $(basename "$0") allow <requestID> [--always]" >&2
      else
        echo "[$MODE] $SID working… ${n:-0} msgs" >&2
      fi
      last_beat=$now
    fi
    if [ "$now" -ge "$deadline" ]; then
      if [ -n "${parked:-}" ]; then
        echo "[$MODE] session $SID still running after ${FOLLOW_TIMEOUT}s (parked on a permission prompt: $parked)." >&2
        echo "approve: $(basename "$0") allow <requestID> [--always]   |   abort: $(basename "$0") abort $SID" >&2
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
fi

# ---- --await: block to COMPLETION, print distilled result, then EXIT ----------
# Unlike --follow (bounded, then leaves it running), --await lives exactly as long
# as the turn: it exits 0 the moment the turn completes. Launch it as a background
# task and the caller (Claude Code) is re-invoked on that exit — wake-on-complete.
if [ -n "$AWAIT" ]; then
  echo "[$MODE] session $SID started; awaiting completion (stall guard ${STALL_SECS}s)…" >&2
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
      | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const a=JSON.parse(d);const l=a[a.length-1]&&a[a.length-1].info;const w=l&&l.role==="assistant"&&!(l.time&&l.time.completed);const e=(l&&l.role==="assistant"&&l.error)?1:0;let mx=0;for(const m of a){const t=m.info&&m.info.time;if(t)for(const k in t){const v=t[k];if(typeof v==="number"&&v>mx)mx=v;}}process.stdout.write(a.length+" "+(w?"working":"idle")+" "+e+" "+mx+"\n")}catch(x){process.exit(1)}})' 2>/dev/null)" || line=""
    if [ -z "$line" ]; then
      fails=$((fails+1))
      if [ "$fails" -ge 20 ]; then
        echo "[$MODE] server unreachable for ~40s; giving up on $SID (may still be running server-side)." >&2
        exit 7
      fi
      sleep 2; continue
    fi
    fails=0
    read -r n st he mx <<<"$line" || true
    [ "${he:-0}" = "1" ] && break
    { [ "${n:-0}" -ge 2 ] && [ "$st" = "idle" ]; } && break
    now=$(date +%s)
    # reset the stall clock whenever the newest timestamp moves
    if [ "${mx:-0}" != "${prev_mx:-}" ]; then prev_mx="${mx:-0}"; last_change=$now; fi
    # tailable heartbeat, throttled to every ~30s. While working, ALSO poll the
    # server's pending-permission list for THIS session: a turn parked on an
    # unanswered ask (headless server, no TUI) reads as "working" forever, so
    # say "Permissions prompt" instead of "working" and point at `allow`.
    if [ "$st" = "working" ] && [ $(( now - last_beat )) -ge 30 ]; then
      parked="$(parked_permission "$SID")"
      if [ -n "$parked" ]; then
        echo "[$MODE] $SID Permissions prompt (request $parked) — approve: $(basename "$0") allow <requestID> [--always]" >&2
      else
        echo "[$MODE] $SID working… ${n:-0} msgs, $(( now - last_change ))s since last activity" >&2
      fi
      last_beat=$now
    fi
    # stall bail: newest timestamp frozen for STALL_SECS → hung turn. Name the
    # parked-permission case explicitly — it is NOT hung, just waiting on a human.
    if [ "${STALL_SECS:-0}" -gt 0 ] && [ $(( now - last_change )) -ge "$STALL_SECS" ]; then
      parked="$(parked_permission "$SID")"
      if [ -n "$parked" ]; then
        echo "[$MODE] session $SID STALLED: parked on a permission prompt for ${STALL_SECS}s (request $parked)." >&2
        echo "approve: $(basename "$0") allow <requestID> [--always]   |   abort: $(basename "$0") abort $SID" >&2
      else
        echo "[$MODE] session $SID STALLED: no activity for ${STALL_SECS}s (likely a hung turn); giving up." >&2
        echo "watch: $(basename "$0") status $SID   |   abort: $(basename "$0") abort $SID" >&2
      fi
      exit 8
    fi
    if [ "$unbounded" -eq 0 ] && [ "$now" -ge "$deadline" ]; then
      parked="$(parked_permission "$SID")"
      if [ -n "$parked" ]; then
        echo "[$MODE] session $SID still running after ${FOLLOW_TIMEOUT}s (parked on a permission prompt: $parked)." >&2
        echo "approve: $(basename "$0") allow <requestID> [--always]   |   abort: $(basename "$0") abort $SID" >&2
      else
        echo "[$MODE] session $SID still running after ${FOLLOW_TIMEOUT}s; exiting non-zero (still running server-side)." >&2
        echo "watch: $(basename "$0") status $SID" >&2
      fi
      exit 3
    fi
    sleep 2
  done

  # --summarize: produce a REMOTE summary on the delegate model; print only that.
  # /summarize requires ?directory=<sessiondir> and a body {providerID,modelID};
  # it appends an ASSISTANT message with summary:true whose text is the digest.
  # (A user message's `summary` is a diff-stats object — must NOT match it.)
  if [ -n "$SUMMARIZE" ]; then
    sinfo="$(curl -sf -m 10 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} "$BASE_URL/session/$SID" 2>/dev/null || echo '{}')"
    qdir=""; sbody=""
    { IFS= read -r qdir; IFS= read -r sbody; } < <(printf '%s' "$sinfo" | SMODEL="$MODEL" node -e '
      let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
        let o={};try{o=JSON.parse(d)}catch(e){}
        let prov=(o.model&&o.model.providerID)||"", mod=(o.model&&o.model.id)||"";
        const sm=process.env.SMODEL||""; const i=sm.indexOf("/");
        if(i>0){prov=sm.slice(0,i);mod=sm.slice(i+1);}
        process.stdout.write(encodeURIComponent(o.directory||"")+"\n"+JSON.stringify({providerID:prov,modelID:mod})+"\n");
      });') || true
    if [ -n "$qdir" ] && [ -n "$sbody" ]; then
      curl -sf -m 30 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} -X POST "$BASE_URL/session/$SID/summarize?directory=$qdir" \
        -H 'content-type: application/json' --data-binary "$sbody" -o /dev/null 2>/dev/null || true
      got=""
      for _ in $(seq 1 30); do
        got="$(curl -sf -m 15 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} "$BASE_URL/session/$SID/message" \
          | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const a=JSON.parse(d);const s=a.filter(m=>m.info&&m.info.role==="assistant"&&m.info.summary===true);const pick=s.length?s[s.length-1]:null;if(!pick)process.exit(2);const t=(pick.parts||[]).filter(p=>p.type==="text"&&p.text).map(p=>p.text).join("\n").trim();if(!t)process.exit(2);process.stdout.write(t)})' 2>/dev/null)" && [ -n "$got" ] && break
        sleep 1.5
      done
      if [ -n "$got" ]; then
        printf '%s\n' "$got"
        echo "(remote summary of session: $SID)" >&2
        exit 0
      fi
    fi
    echo "(summarize unavailable; printing final message instead)" >&2
  fi

  # default distilled output: the final assistant message (reviews/plans are already tight)
  curl -sf -m 15 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} "$BASE_URL/session/$SID/message" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{let a;try{a=JSON.parse(d)}catch(ex){console.error("error: invalid response from server ("+ex.message+")");process.exit(1);}const asst=a.filter(m=>m.info?.role==="assistant");const last=asst[asst.length-1];const e=last?.info?.error;if(e){console.error("ERROR "+(e.data?.statusCode||"")+" "+(e.data?.message||e.name||""));process.exit(1);}const t=(last?.parts||[]).filter(p=>p.type==="text"&&p.text).map(p=>p.text).join("\n").trim();console.log(t);});'
  echo "(session: $SID)" >&2
  exit 0
fi

sdir="$(curl -sf -m 10 ${CURL_AUTH[@]:+"${CURL_AUTH[@]}"} "$BASE_URL/session/$SID" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).directory||"")}catch(e){}});' 2>/dev/null)"
echo "started [$MODE] on server $BASE_URL"
echo "  session: $SID"
echo "  agent:   $AGENT_USE    model: ${MODEL:-<opencode default>}"
echo "  dir:     ${sdir:-?}"
if { [ "$MODE" = "task" ] || [ "$MODE" = "bulk" ]; } && [ -n "$sdir" ] && [ "$sdir" != "$DIR" ]; then
  echo "  NOTE: session runs in the SERVER's dir, which differs from --dir ($DIR)."
  echo "        Edits land in the session dir. Start the server there, or use --synchronous."
fi
echo "  watch:   $(basename "$0") status $SID   |   $(basename "$0") history $SID --turns 1   |   $(basename "$0") abort $SID"
