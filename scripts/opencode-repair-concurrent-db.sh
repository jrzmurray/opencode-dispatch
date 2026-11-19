#!/usr/bin/env bash
#
# opencode-repair-concurrent-db.sh — repair desynced per-session message
# sequence counters in an OpenCode v2 SQLite store.
#
# Background
#   Every row in `session_message` gets a per-session `seq`, guarded by the
#   unique index `(session_id, seq)`. The next number is read from
#   `event_sequence.seq` for that session. When that counter falls behind rows
#   that already exist — a stale counter after a reload, a model/agent switch,
#   a fork/import, or two server processes (e.g. the desktop service and an
#   `opencode serve`) allocating seq from independent in-memory counters — the
#   next insert lands on an occupied number:
#
#     SQLiteError: UNIQUE constraint failed:
#       session_message.session_id, session_message.seq
#
#   The failure aborts the whole step ("Failed to drain Session"), the counter
#   never advances, and every later attempt hits the same slot. Restarting does
#   not help: the stale value is re-read from disk.
#
#   Upstream: anomalyco/opencode#53146 (open), duplicates #56975, #56528.
#
# What this script does
#   Finds sessions whose `event_sequence.seq` is below the highest seq already
#   stored in `session_message`, and moves the counter to `MAX(seq) + 1`.
#   Sessions sitting exactly at `MAX(seq)` are reported separately: they are
#   healthy if the counter means "last allocated", wedged if it means
#   "next seq". `--include-at-max` repairs those too (moving the counter past
#   the top row is harmless either way; seq is a sparse projection space).
#
#   The repair is a single `BEGIN IMMEDIATE` transaction. Nothing else in the
#   database is touched, and no messages are deleted or renumbered.
#
# Usage
#   opencode-repair-concurrent-db.sh                 # report only (dry run)
#   opencode-repair-concurrent-db.sh --apply         # repair every stale session
#   opencode-repair-concurrent-db.sh --session ses_x  # restrict to one session
#   opencode-repair-concurrent-db.sh --apply --session ses_x
#
# Options
#   --apply           Write the repair. Without it the script only reports.
#   --session ID      Only consider this session (must look like ses_[A-Za-z0-9]+).
#   --include-at-max  Also repair counters that sit exactly at MAX(seq).
#   --no-dump         Do not write the pre-repair counter snapshot.
#   --dump PATH       Snapshot path (default: alongside the database, with a
#                     timestamp). The snapshot is one line per counter row — a
#                     rollback aid, not a database backup.
#   --db PATH         Database to inspect (overrides the environment).
#   -h, --help        This text.
#
# Environment
#   OPENCODE_DB       database path (default ~/.local/share/opencode/opencode.db)
#   OPENCODE_DB_PATH  fallback used by the OpenCode binary itself
#
# Exit codes
#   0  healthy, or repair applied and verified
#   1  error (missing database/schema/tools, transaction failed, verification failed)
#   2  usage error
#   3  stale counters found but not repaired (dry run) — useful for monitoring
#
# Notes
#   * A running server that already has a session loaded may keep its own
#     in-memory counter until that session is reloaded; restart the app after
#     applying.
#   * Only one OpenCode server should hold a given database. Two processes with
#     the file open is the most common way to re-create the desync.
#   * Do not run two servers on the same data dir, and do not drive one session
#     from two clients at once.

set -uo pipefail

DB="${OPENCODE_DB:-${OPENCODE_DB_PATH:-$HOME/.local/share/opencode/opencode.db}}"
APPLY=0
AT_MAX=0
SID=""
DUMP=1
DUMP_PATH=""

die() { printf 'error: %s\n' "$*" >&2; exit 1; }
usage() { awk 'NR==1{next} /^set -uo/{exit} {sub(/^# ?/,""); print}' "$0" | sed -e '/./,$!d'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --include-at-max) AT_MAX=1 ;;
    --no-dump) DUMP=0 ;;
    --session)
      shift
      [ $# -gt 0 ] || { usage >&2; exit 2; }
      SID="$1"
      ;;
    --dump)
      shift
      [ $# -gt 0 ] || { usage >&2; exit 2; }
      DUMP_PATH="$1"
      ;;
    --db)
      shift
      [ $# -gt 0 ] || { usage >&2; exit 2; }
      DB="$1"
      ;;
    -h|--help) usage; exit 0 ;;
    *) printf 'error: unknown argument %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

command -v sqlite3 >/dev/null 2>&1 || die "sqlite3 not found on PATH"
[ -f "$DB" ] || die "database not found: $DB"
[ -r "$DB" ] || die "database not readable: $DB"

if [ -n "$SID" ] && [[ ! "$SID" =~ ^ses_[A-Za-z0-9]+$ ]]; then
  die "not a session id: $SID"
fi

RO_DB="file:${DB}?mode=ro"
QRO() { sqlite3 "$RO_DB" "$@"; }

for t in event_sequence session_message; do
  have=$(QRO "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='$t';")
  [ "$have" = "1" ] || die "table '$t' not present — not an OpenCode v2 database?"
done

scope_q=""
scope_u=""
if [ -n "$SID" ]; then
  scope_q=" AND e.aggregate_id = '$SID'"
  scope_u=" AND aggregate_id = '$SID'"
fi
[ "$AT_MAX" -eq 1 ] && CMP="<=" || CMP="<"

stale_sql="
SELECT e.aggregate_id,
       e.seq,
       (SELECT MAX(m.seq) FROM session_message m WHERE m.session_id = e.aggregate_id) AS mx,
       (SELECT COUNT(*) FROM session_message m WHERE m.session_id = e.aggregate_id) AS rows,
       datetime((SELECT MAX(m.time_created) FROM session_message m
                  WHERE m.session_id = e.aggregate_id)/1000,'unixepoch','localtime') AS last
FROM event_sequence e
WHERE e.aggregate_id LIKE 'ses_%'
  AND EXISTS (SELECT 1 FROM session_message m WHERE m.session_id = e.aggregate_id)
  AND e.seq $CMP (SELECT MAX(m.seq) FROM session_message m WHERE m.session_id = e.aggregate_id)
  $scope_q
ORDER BY (mx - e.seq) DESC, e.aggregate_id;"

echo "database: $DB"
echo

holders=$(lsof -- "$DB" 2>/dev/null | awk 'NR>1 {print $2}' | sort -un | while read -r pid; do
  printf '  pid %s %s\n' "$pid" "$(ps -o command= -p "$pid" 2>/dev/null | cut -c1-90)"
done)
if [ -n "$holders" ]; then
  echo "processes with the database open:"
  printf '%s\n' "$holders"
  echo "  (restart them after applying so counters are re-read from disk)"
  echo
fi

rows=$(QRO -separator '|' "$stale_sql")
stale=$(printf '%s' "$rows" | grep -c . || true)
case "$stale" in ''|*[!0-9]*) die "could not read counters from $DB" ;; esac

counters=$(QRO "SELECT count(*) FROM event_sequence WHERE aggregate_id LIKE 'ses_%';")
sessions=$(QRO "SELECT count(DISTINCT session_id) FROM session_message;")
derived=$(QRO "SELECT count(DISTINCT m.session_id) FROM session_message m
               WHERE NOT EXISTS (SELECT 1 FROM event_sequence e WHERE e.aggregate_id = m.session_id);")
at_max=$(QRO "SELECT count(*) FROM event_sequence e
              WHERE e.aggregate_id LIKE 'ses_%'
                AND EXISTS (SELECT 1 FROM session_message m WHERE m.session_id = e.aggregate_id)
                AND e.seq = (SELECT MAX(m.seq) FROM session_message m WHERE m.session_id = e.aggregate_id)
                $scope_q;")
case "$at_max" in ''|*[!0-9]*) at_max=0 ;; esac

echo "counter rows (ses_*):      $counters"
echo "sessions with messages:    $sessions"
echo "sessions without a counter row: $derived (seq is derived from rows; not a risk)"
echo "counters at MAX(seq):      $at_max$( [ "$AT_MAX" -eq 0 ] && echo '  (ambiguous; --include-at-max repairs them)' )"
echo

if [ "$stale" -eq 0 ]; then
  echo "OK: no definitely-stale counters (counter < MAX(seq))."
  [ "$at_max" -gt 0 ] && echo "    $at_max counter(s) sit exactly at MAX(seq); see --include-at-max." >&2
  exit 0
fi

printf 'stale counters: %s\n\n' "$stale"
printf '%-34s %8s %8s %6s  %s\n' SESSION COUNTER MAX_SEQ ROWS LAST_ACTIVITY
printf '%s\n' "$rows" | awk -F'|' '{printf "%-34s %8s %8s %6s  %s\n", $1, $2, $3, $4, $5}'
echo

if [ "$APPLY" -eq 0 ]; then
  cat <<SQL
Repair runs, per stale session:

  UPDATE event_sequence
     SET seq = (SELECT MAX(seq) + 1 FROM session_message m
                 WHERE m.session_id = event_sequence.aggregate_id)
   WHERE aggregate_id LIKE 'ses_%'
     AND EXISTS (SELECT 1 FROM session_message m WHERE m.session_id = event_sequence.aggregate_id)
     AND seq $CMP (SELECT MAX(seq) FROM session_message m WHERE m.session_id = event_sequence.aggregate_id);
SQL
  echo
  echo "Dry run: re-run with --apply to write the repair."
  exit 3
fi

if [ "$DUMP" -eq 1 ]; then
  if [ -z "$DUMP_PATH" ]; then
    DUMP_PATH="${DB}.event_sequence.$(date +%Y%m%d-%H%M%S).tsv"
  fi
  if sqlite3 -separator $'\t' "$RO_DB" \
       "SELECT aggregate_id, seq, coalesce(owner_id,'') FROM event_sequence ORDER BY aggregate_id;" \
       > "$DUMP_PATH"; then
    printf 'counter snapshot: %s (%s rows)\n\n' "$DUMP_PATH" "$(wc -l < "$DUMP_PATH" | tr -d ' ')"
  else
    printf 'warning: could not write counter snapshot to %s\n\n' "$DUMP_PATH" >&2
  fi
fi

result=$(sqlite3 -cmd ".timeout 15000" "$DB" <<SQL
BEGIN IMMEDIATE;
UPDATE event_sequence
   SET seq = (SELECT MAX(m.seq) + 1 FROM session_message m
               WHERE m.session_id = event_sequence.aggregate_id)
 WHERE aggregate_id LIKE 'ses_%'
   AND EXISTS (SELECT 1 FROM session_message m WHERE m.session_id = event_sequence.aggregate_id)
   AND seq $CMP (SELECT MAX(m.seq) FROM session_message m WHERE m.session_id = event_sequence.aggregate_id)
   $scope_u;
SELECT changes();
COMMIT;
SQL
) || die "repair transaction failed"

changed=$(printf '%s' "$result" | tail -1)
case "$changed" in ''|*[!0-9]*) die "could not read the transaction result" ;; esac
printf 'repaired %s counter row(s)\n\n' "$changed"

remaining=$(QRO "SELECT count(*) FROM event_sequence e
                 WHERE e.aggregate_id LIKE 'ses_%'
                   AND EXISTS (SELECT 1 FROM session_message m WHERE m.session_id = e.aggregate_id)
                   AND e.seq $CMP (SELECT MAX(m.seq) FROM session_message m WHERE m.session_id = e.aggregate_id)
                   $scope_q;")
case "$remaining" in ''|*[!0-9]*) die "could not verify the repair" ;; esac
integrity=$(QRO "PRAGMA quick_check;" | head -1)

echo "stale counters remaining: $remaining"
echo "quick_check: $integrity"

if [ "$remaining" != "0" ]; then
  echo
  echo "warning: counters still stale — a server is probably writing concurrently." >&2
  echo "         stop all OpenCode processes and re-run with --apply." >&2
  exit 1
fi
[ "$integrity" = "ok" ] || die "quick_check reported: $integrity"

cat <<'NEXT'

Done. To make the repair stick:
  1. Restart the OpenCode app (and any `opencode serve`) so sessions reload the
     repaired counters.
  2. Run one server per database. `lsof <db>` must list a single process.
  3. Keep desktop and CLI versions matched, and do not drive the same session
     from two clients at once.
NEXT

exit 0
