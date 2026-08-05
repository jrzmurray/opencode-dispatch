#!/usr/bin/env bash
# opencode-hang-diag.sh — find where an opencode session hung.
#
# Usage:
#   opencode-hang-diag.sh                 # list 5 most recent sessions
#   opencode-hang-diag.sh <session-id>    # full hang diagnosis for one session
#
# Sources: SQLite store (~/.local/share/opencode/opencode.db) and the
# daemon log (~/.local/share/opencode/log/opencode.log). A session is
# considered hung when its last tool part is not `completed` — status
# `error` after a long gap, or `running`/`pending` with no result.

set -u
DB="${OPENCODE_DB:-$HOME/.local/share/opencode/opencode.db}"
LOG="${OPENCODE_LOG:-$HOME/.local/share/opencode/log/opencode.log}"
Q() { sqlite3 "$DB" "$1"; }

SID="${1:-}"
if [ -z "$SID" ]; then
  echo "== 5 most recently updated sessions =="
  Q "SELECT id, datetime(time_created/1000,'unixepoch','localtime') AS created,
            datetime(time_updated/1000,'unixepoch','localtime') AS updated, title
     FROM session ORDER BY time_updated DESC LIMIT 5;"
  exit 0
fi

echo "== session =="
Q "SELECT 'id:        ' || id,
          'title:     ' || title,
          'agent:     ' || agent,
          'model:     ' || model,
          'created:   ' || datetime(time_created/1000,'unixepoch','localtime'),
          'updated:   ' || datetime(time_updated/1000,'unixepoch','localtime'),
          'directory: ' || directory
   FROM session WHERE id='$SID';"

echo
echo "== message timeline (last 6) =="
Q "SELECT datetime(m.time_created/1000,'unixepoch','localtime') || '  ' ||
          json_extract(m.data,'\$.role') || '  ' ||
          (SELECT count(*) FROM part p WHERE p.message_id=m.id) || ' parts'
   FROM message m WHERE m.session_id='$SID'
   ORDER BY m.time_created DESC LIMIT 6;"

echo
echo "== tool parts with non-completed state (the hang candidates) =="
Q "SELECT datetime(p.time_created/1000,'unixepoch','localtime') AS started,
          json_extract(p.data,'\$.tool') AS tool,
          json_extract(p.data,'\$.state.status') AS status,
          json_extract(p.data,'\$.error') AS error,
          datetime(json_extract(p.data,'\$.state.time.start')/1000,'unixepoch','localtime') AS tool_start,
          datetime(json_extract(p.data,'\$.state.time.end')/1000,'unixepoch','localtime') AS tool_end,
          CAST((json_extract(p.data,'\$.state.time.end') - json_extract(p.data,'\$.state.time.start'))/1000 AS INTEGER) AS seconds
   FROM part p WHERE p.session_id='$SID'
     AND json_extract(p.data,'\$.type')='tool'
     AND json_extract(p.data,'\$.state.status') != 'completed'
   ORDER BY p.time_created;"

echo
echo "== last tool call input (context for the hang) =="
Q "SELECT json_extract(p.data,'\$.state.input') AS input
   FROM part p WHERE p.session_id='$SID'
     AND json_extract(p.data,'\$.type')='tool'
     AND json_extract(p.data,'\$.state.status') != 'completed'
   ORDER BY p.time_created DESC LIMIT 1;"

echo
echo "== log tail for this session (permission asks / cancellations) =="
# Key note: 'asking'/'evaluated permission' lines carry run=<id>, not session.id,
# so resolve the run id first and grep on that.
RUN=$(grep "session.id=$SID " "$LOG" | grep -o 'run=[0-9a-f]*' | head -1 | cut -d= -f2)
grep "run=$RUN " "$LOG" | awk -v sid="$SID" '
  /message=cleanup/ { next }
  index($0, "session.id=" sid " ") || (index($0, "session.id=") == 0) {
    if ($0 ~ /message=asking|action.action=ask|allowed|denied|cancel|error=Aborted|message=stream|message=process/) print
  }' | tail -14
