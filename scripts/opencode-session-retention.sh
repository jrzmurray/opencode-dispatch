#!/usr/bin/env bash
#
# opencode-session-retention.sh — prune old opencode sessions while keeping
# unfinished work.
#
# Sessions whose last activity is older than --days (default 45) are deleted
# unless:
#   * the directory the session ran in belongs to a git worktree that is NOT
#     safe to delete (uncommitted changes, or commits not merged to main).
#     Safety comes from the repository's own scripts/audit-worktree-commits.sh
#     via a batched `--worktree` query; when that tool is unavailable the
#     check falls back to direct git state (dirty tracked files, unpushed
#     commits).
#   * the session carries a pending revert.
# Directories that no longer exist and directories that are not git worktrees
# cannot hold recoverable work and are pruned by age.
#
# Deleting a session cascades to its messages, parts, todos, inputs, shares
# and context epochs; its event-sourcing log (event_sequence -> event, the
# largest tables) is deleted too. Deletion is batched so the WAL stays bounded.
#
# Usage:
#   opencode-session-retention.sh [--days N] [--apply] [--vacuum]
#                                 [--force-vacuum] [--no-protect-work]
#                                 [--batch N] [--verbose]
#
# Options:
#   --days N          Retention window in days (default 45).
#   --apply           Delete; without it the script only reports (dry run).
#   --vacuum          After pruning, VACUUM in place to return freed pages to
#                     the OS. Skipped while the database is open (--force-vacuum
#                     overrides). Needs local free disk >= compacted size.
#   --vacuum-into PATH  VACUUM a compacted copy to PATH; the live database is
#                     untouched, so this can run while opencode is open and
#                     PATH may be on another volume. Exits with swap-in
#                     instructions (stop opencode, move file). Refuses to
#                     overwrite PATH.
#   --event-days N    Trim the event log (event table) for sessions idle longer
#                     than N days even when their session row is kept. Session
#                     content in message/part is untouched, and event_sequence
#                     rows stay so sequence numbers remain valid. Opt-in.
#   --no-protect-work Prune by age alone; ignores worktree safety.
#   --batch N         Sessions per delete transaction (default 25).
#   --verbose         Print each audit tool invocation.
#
# Environment:
#   OPENCODE_DB             database path (default ~/.local/share/opencode/opencode.db)
#   OPENCODE_AUDIT_TOOL     explicit audit-worktree-commits.sh path (must support --worktree)
#   OPENCODE_AUDIT_TIMEOUT  seconds before an audit call is abandoned (default 900)

set -uo pipefail

DAYS=45
EVENT_DAYS=0
APPLY=0
DO_VACUUM=0
VACUUM_INTO=""
FORCE_VACUUM=0
PROTECT_WORK=1
BATCH=25
VERBOSE=0
DB="${OPENCODE_DB:-$HOME/.local/share/opencode/opencode.db}"
AUDIT_TOOL_OVERRIDE="${OPENCODE_AUDIT_TOOL:-}"
AUDIT_TIMEOUT="${OPENCODE_AUDIT_TIMEOUT:-900}"

usage() {
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --days) DAYS="${2:?--days needs a value}"; shift 2 ;;
    --event-days) EVENT_DAYS="${2:?--event-days needs a value}"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    --vacuum) DO_VACUUM=1; shift ;;
    --vacuum-into) VACUUM_INTO="${2:?--vacuum-into needs a path}"; DO_VACUUM=1; shift 2 ;;
    --force-vacuum) DO_VACUUM=1; FORCE_VACUUM=1; shift ;;
    --no-protect-work) PROTECT_WORK=0; shift ;;
    --batch) BATCH="${2:?--batch needs a value}"; shift 2 ;;
    --verbose) VERBOSE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "$DAYS" in ''|*[!0-9]*) echo "--days must be a positive integer" >&2; exit 2 ;; esac
case "$EVENT_DAYS" in ''|*[!0-9]*) echo "--event-days must be a positive integer" >&2; exit 2 ;; esac
case "$BATCH" in ''|*[!0-9]*) echo "--batch must be a positive integer" >&2; exit 2 ;; esac
[ "$DAYS" -ge 1 ] || { echo "--days must be >= 1" >&2; exit 2; }
[ "$BATCH" -ge 1 ] || { echo "--batch must be >= 1" >&2; exit 2; }
case "$AUDIT_TIMEOUT" in ''|*[!0-9]*) AUDIT_TIMEOUT=900 ;; esac
command -v sqlite3 >/dev/null 2>&1 || { echo "sqlite3 not found" >&2; exit 1; }
[ -f "$DB" ] || { echo "database not found: $DB" >&2; exit 1; }

log() { if [ "$VERBOSE" -eq 1 ]; then echo "$@"; fi; }

sql() { sqlite3 -cmd "PRAGMA foreign_keys=ON;" -cmd ".timeout 60000" "$DB" "$@"; }

CUTOFF_MS=$(( ($(date +%s) - DAYS * 86400) * 1000 ))
CUTOFF_HUMAN=$(date -r $((CUTOFF_MS / 1000)) '+%Y-%m-%d %H:%M')

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT
CANDIDATES_FILE="$WORK_DIR/candidates.tsv"
DIRMAP_FILE="$WORK_DIR/dirmap.tsv"
SAFES_FILE="$WORK_DIR/safe.tsv"
AUDITED_FILE="$WORK_DIR/audited-primaries.txt"
PRUNE_IDS="$WORK_DIR/prune-ids.txt"
EVENT_IDS_FILE="$WORK_DIR/event-session-ids.txt"
BATCH_FILE="$WORK_DIR/batch-ids.txt"
: > "$DIRMAP_FILE"
: > "$SAFES_FILE"
: > "$AUDITED_FILE"

sqlite3 -separator "$(printf '\t')" -cmd ".timeout 60000" "$DB" \
  "SELECT id, coalesce(directory, ''), CASE WHEN revert IS NULL THEN 0 ELSE 1 END
     FROM session WHERE time_updated < $CUTOFF_MS ORDER BY time_updated;" > "$CANDIDATES_FILE"

# Same three paths get the same answer: resolve each unique directory once to
# its worktree root and repository primary, then ask each repository once
# about all of its candidate worktrees (one batched --worktree call).
if [ "$PROTECT_WORK" -eq 1 ]; then
  cut -f2 "$CANDIDATES_FILE" | sort -u | while IFS= read -r dir; do
    [ -n "$dir" ] && [ -d "$dir" ] || continue
    wt=$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null) || continue
    primary=$(git -C "$dir" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print substr($0,10); exit}')
    [ -n "$primary" ] || continue
    printf '%s\t%s\t%s\n' "$dir" "$wt" "$primary" >> "$DIRMAP_FILE"
  done

  # run_with_timeout SECONDS cmd... — the audit can be slow on repositories
  # with hundreds of worktrees; abandon it and fall back rather than hang.
  run_with_timeout() {
    local secs="$1"; shift
    "$@" &
    local pid=$! waited=0
    while kill -0 "$pid" 2>/dev/null; do
      if [ "$waited" -ge "$secs" ]; then
        kill "$pid" 2>/dev/null
        wait "$pid" 2>/dev/null
        return 124
      fi
      sleep 2
      waited=$((waited + 2))
    done
    wait "$pid"
  }

  # Globals consumed by run_audit_tool (kept out of the function signature so
  # run_with_timeout can invoke it as a plain command).
  AUDIT_PRIMARY=""
  AUDIT_TOOL=""
  AUDIT_ARGS=()
  run_audit_tool() ( cd "$AUDIT_PRIMARY" && exec "$AUDIT_TOOL" -n -s "${AUDIT_ARGS[@]+"${AUDIT_ARGS[@]}"}" )

  cut -f3 "$DIRMAP_FILE" | sort -u | while IFS= read -r primary; do
    tool="$AUDIT_TOOL_OVERRIDE"
    [ -n "$tool" ] || tool="$primary/scripts/audit-worktree-commits.sh"
    if [ ! -x "$tool" ] || ! "$tool" --help 2>&1 | grep -q -- '--worktree'; then
      log "no --worktree-capable audit tool for $primary; falling back to git checks"
      continue
    fi
    AUDIT_PRIMARY="$primary"
    AUDIT_TOOL="$tool"
    AUDIT_ARGS=()
    while IFS= read -r wt; do
      AUDIT_ARGS+=(-W "$wt")
    done < <(awk -F'\t' -v p="$primary" '$3==p {print $2}' "$DIRMAP_FILE" | sort -u)
    [ "${#AUDIT_ARGS[@]}" -gt 0 ] || continue
    out="$WORK_DIR/audit-out-$RANDOM.txt"
    log "auditing $(( ${#AUDIT_ARGS[@]} / 2 )) worktree(s) in $primary with $tool"
    if run_with_timeout "$AUDIT_TIMEOUT" run_audit_tool > "$out" 2>/dev/null; then
      # Tool prints display paths: ".", "relative", "~/...", or absolute.
      while IFS= read -r line; do
        [ -n "$line" ] || continue
        case "$line" in
          ".") printf '%s\t%s\n' "$primary" "$primary" >> "$SAFES_FILE" ;;
          "~") printf '%s\t%s\n' "$primary" "$HOME" >> "$SAFES_FILE" ;;
          "~/"*) printf '%s\t%s\n' "$primary" "$HOME/${line#"~/"}" >> "$SAFES_FILE" ;;
          /*) printf '%s\t%s\n' "$primary" "$line" >> "$SAFES_FILE" ;;
          *) printf '%s\t%s\n' "$primary" "$primary/$line" >> "$SAFES_FILE" ;;
        esac
      done < "$out"
      printf '%s\n' "$primary" >> "$AUDITED_FILE"
    else
      log "audit tool failed or timed out for $primary; falling back to git checks"
    fi
  done
fi

# Fallback safety check for repositories the audit tool could not cover:
# tracked uncommitted changes or commits not on any remote.
fallback_at_risk() {
  local dir="$1"
  [ -n "$(git -C "$dir" status --porcelain -uno 2>/dev/null | head -n 1)" ] && return 0
  [ -n "$(git -C "$dir" log --branches --not --remotes --oneline -n 1 2>/dev/null)" ] && return 0
  return 1
}

is_safe() { # primary wt
  [ -n "$1" ] && [ -n "$2" ] || return 1
  grep -qxF "$1" "$AUDITED_FILE" 2>/dev/null || return 1
  awk -F'\t' -v p="$1" -v w="$2" 'BEGIN{f=0} $1==p && $2==w {f=1} END{exit(f?0:1)}' "$SAFES_FILE" 2>/dev/null
}

: > "$PRUNE_IDS"
candidates=0
kept_work=0
kept_revert=0
while IFS="$(printf '\t')" read -r id dir has_revert; do
  [ -n "$id" ] || continue
  candidates=$((candidates + 1))
  if [ "$PROTECT_WORK" -eq 1 ]; then
    if [ "$has_revert" = 1 ]; then
      kept_revert=$((kept_revert + 1))
      continue
    fi
    wt=$(awk -F'\t' -v d="$dir" '$1==d {print $2; exit}' "$DIRMAP_FILE" 2>/dev/null)
    primary=$(awk -F'\t' -v d="$dir" '$1==d {print $3; exit}' "$DIRMAP_FILE" 2>/dev/null)
    if [ -n "$wt" ]; then
      if grep -qxF "$primary" "$AUDITED_FILE" 2>/dev/null; then
        is_safe "$primary" "$wt" || { kept_work=$((kept_work + 1)); continue; }
      else
        fallback_at_risk "$dir" && { kept_work=$((kept_work + 1)); continue; }
      fi
    fi
  fi
  printf '%s\n' "$id" >> "$PRUNE_IDS"
done < "$CANDIDATES_FILE"

TO_PRUNE=$(wc -l < "$PRUNE_IDS" | tr -d ' ')
TO_PRUNE_EVENTS=0
if [ "$TO_PRUNE" -gt 0 ]; then
  TO_PRUNE_EVENTS=$(sqlite3 -cmd ".timeout 60000" "$DB" <<SQL
CREATE TEMP TABLE prune_ids(id TEXT PRIMARY KEY);
.import $PRUNE_IDS prune_ids
SELECT count(*) FROM event WHERE aggregate_id IN (SELECT id FROM prune_ids);
SQL
)
fi

# Event-log trimming is independent of session pruning: events of sessions
# that are kept (protected worktrees, or inside the session window but past
# the event window) still age out here. Only event rows are removed;
# event_sequence stays so sequence numbers remain valid.
EVENT_CUTOFF_MS=0
EVENT_SESSIONS=0
EVENT_ROWS=0
if [ "$EVENT_DAYS" -gt 0 ]; then
  EVENT_CUTOFF_MS=$(( ($(date +%s) - EVENT_DAYS * 86400) * 1000 ))
  sqlite3 -cmd ".timeout 60000" "$DB" <<SQL > "$EVENT_IDS_FILE"
CREATE TEMP TABLE prune_ids(id TEXT PRIMARY KEY);
.import $PRUNE_IDS prune_ids
SELECT id FROM session WHERE time_updated < $EVENT_CUTOFF_MS AND id NOT IN (SELECT id FROM prune_ids);
SQL
  if [ -s "$EVENT_IDS_FILE" ]; then
    EVENT_SESSIONS=$(wc -l < "$EVENT_IDS_FILE" | tr -d ' ')
    EVENT_ROWS=$(sqlite3 -cmd ".timeout 60000" "$DB" <<SQL
CREATE TEMP TABLE ev_ids(id TEXT PRIMARY KEY);
.import $EVENT_IDS_FILE ev_ids
SELECT count(*) FROM event WHERE aggregate_id IN (SELECT id FROM ev_ids);
SQL
)
  fi
fi

echo "database : $DB"
echo "cutoff   : idle since $CUTOFF_HUMAN (--days $DAYS)"
if [ "$PROTECT_WORK" -eq 1 ]; then
  echo "protected: $kept_work session(s) on worktrees not safe to delete, $kept_revert with a pending revert"
fi
echo "to prune : $TO_PRUNE of $candidates session(s), $TO_PRUNE_EVENTS event row(s)"
if [ "$EVENT_DAYS" -gt 0 ]; then
  echo "event log: $EVENT_ROWS row(s) for $EVENT_SESSIONS retained session(s) idle since $(date -r $((EVENT_CUTOFF_MS / 1000)) '+%Y-%m-%d %H:%M') (--event-days $EVENT_DAYS)"
fi

if [ "$APPLY" -ne 1 ]; then
  echo "dry run  : no sessions deleted (pass --apply to delete)"
  [ "$DO_VACUUM" -eq 1 ] || exit 0
fi

if [ "$TO_PRUNE" -gt 0 ]; then
  pruned=0
  flush_batch() {
    [ -s "$BATCH_FILE" ] || return 0
    local ids count
    ids=$(sed "s/.*/'&'/" "$BATCH_FILE" | paste -sd, -)
    count=$(wc -l < "$BATCH_FILE" | tr -d ' ')
    sql "BEGIN IMMEDIATE;
         DELETE FROM session WHERE id IN ($ids);
         DELETE FROM event_sequence WHERE aggregate_id NOT IN (SELECT id FROM session);
         COMMIT;"
    sql "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1
    pruned=$((pruned + count))
    echo "  pruned $pruned/$TO_PRUNE session(s)"
    : > "$BATCH_FILE"
  }

  while IFS= read -r id; do
    printf '%s\n' "$id" >> "$BATCH_FILE"
    if [ "$(wc -l < "$BATCH_FILE" | tr -d ' ')" -ge "$BATCH" ]; then
      flush_batch
    fi
  done < "$PRUNE_IDS"
  flush_batch
  sql "PRAGMA incremental_vacuum;" >/dev/null 2>&1
  echo "pruned $pruned session(s)"
fi

if [ "$APPLY" -eq 1 ] && [ "$EVENT_DAYS" -gt 0 ] && [ "$EVENT_ROWS" -gt 0 ]; then
  trimmed=0
  : > "$BATCH_FILE"
  flush_event_batch() {
    [ -s "$BATCH_FILE" ] || return 0
    local ids
    ids=$(sed "s/.*/'&'/" "$BATCH_FILE" | paste -sd, -)
    sql "DELETE FROM event WHERE aggregate_id IN ($ids);"
    sql "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null 2>&1
    trimmed=$((trimmed + $(wc -l < "$BATCH_FILE" | tr -d ' ')))
    echo "  trimmed events for $trimmed/$EVENT_SESSIONS session(s)"
    : > "$BATCH_FILE"
  }

  while IFS= read -r id; do
    printf '%s\n' "$id" >> "$BATCH_FILE"
    if [ "$(wc -l < "$BATCH_FILE" | tr -d ' ')" -ge "$BATCH" ]; then
      flush_event_batch
    fi
  done < "$EVENT_IDS_FILE"
  flush_event_batch
  sql "PRAGMA incremental_vacuum;" >/dev/null 2>&1
  echo "trimmed event log for $trimmed session(s)"
fi

db_in_use() {
  if command -v lsof >/dev/null 2>&1; then
    [ -n "$(lsof -t "$DB" 2>/dev/null)" ] && return 0
    return 1
  fi
  pgrep -x opencode >/dev/null 2>&1
}

if [ "$DO_VACUUM" -eq 1 ]; then
  # Both VACUUM forms write a compacted copy; skip rather than churn I/O when
  # free space cannot hold it. Live size is page_count minus freelist_count
  # times page_size.
  IFS='|' read -r PAGE_SIZE PAGE_COUNT FREELIST <<< "$(sql "SELECT page_size, page_count, freelist_count FROM pragma_page_size(), pragma_page_count(), pragma_freelist_count();")"
  case "${PAGE_SIZE:-}${PAGE_COUNT:-}${FREELIST:-}" in
    ''|*[!0-9]*) LIVE_BYTES=0 ;;
    *) LIVE_BYTES=$(( (PAGE_COUNT - FREELIST) * PAGE_SIZE )) ;;
  esac

  if [ -n "$VACUUM_INTO" ]; then
    DEST_DIR=$(dirname "$VACUUM_INTO")
    [ -d "$DEST_DIR" ] || { echo "vacuum target directory does not exist: $DEST_DIR" >&2; exit 1; }
    [ -e "$VACUUM_INTO" ] && { echo "vacuum target already exists: $VACUUM_INTO" >&2; exit 1; }
    FREE_BYTES=$(( $(df -k "$DEST_DIR" | awk 'NR==2 {print $4}') * 1024 ))
    if [ "$LIVE_BYTES" -gt 0 ] && [ "$FREE_BYTES" -lt $(( LIVE_BYTES + LIVE_BYTES / 10 )) ]; then
      echo "skipping VACUUM: target needs about $(( LIVE_BYTES / 1073741824 )) GiB free, $(( FREE_BYTES / 1073741824 )) GiB available at $DEST_DIR"
      exit 0
    fi
    echo "vacuuming into $VACUUM_INTO (takes a while)..."
    ESCAPED=${VACUUM_INTO//\'/\'\'}
    if sql "PRAGMA auto_vacuum=INCREMENTAL; VACUUM INTO '$ESCAPED';" >/dev/null; then
      echo "vacuum done: $(du -h "$VACUUM_INTO" | cut -f1), incremental auto-vacuum enabled"
      echo "swap it in with opencode stopped:"
      echo "  mv \"$DB\" \"$DB.pre-vacuum\" && mv \"$VACUUM_INTO\" \"$DB\" && rm -f \"$DB-wal\" \"$DB-shm\""
    else
      rm -f "$VACUUM_INTO"
      echo "vacuum into failed: destination removed (check free disk at $DEST_DIR)"
    fi
    exit 0
  fi

  if db_in_use && [ "$FORCE_VACUUM" -ne 1 ]; then
    echo "database is in use: skipping VACUUM (quit opencode, or use --force-vacuum)"
    exit 0
  fi
  FREE_BYTES=$(( $(df -k "$(dirname "$DB")" | awk 'NR==2 {print $4}') * 1024 ))
  if [ "$LIVE_BYTES" -gt 0 ] && [ "$FREE_BYTES" -lt $(( LIVE_BYTES + LIVE_BYTES / 10 )) ]; then
    echo "skipping VACUUM: needs about $(( LIVE_BYTES / 1073741824 )) GiB free, $(( FREE_BYTES / 1073741824 )) GiB available (delete more sessions, or use --vacuum-into)"
    exit 0
  fi
  BEFORE=$(du -h "$DB" | cut -f1)
  echo "vacuuming (takes a while)..."
  if sql "PRAGMA auto_vacuum=INCREMENTAL; VACUUM;" >/dev/null; then
    sql "PRAGMA incremental_vacuum;" >/dev/null
    AFTER=$(du -h "$DB" | cut -f1)
    echo "vacuum done: $BEFORE -> $AFTER"
  else
    echo "vacuum failed: database unchanged (check free disk)"
  fi
fi
