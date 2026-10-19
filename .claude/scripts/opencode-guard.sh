#!/usr/bin/env bash
#
# opencode-guard.sh — PreToolUse hook (Bash matcher) for Claude Code and Codex,
# installed by install.sh. THROWS when a Bash command pipes opencode-dispatch.sh
# output through `tail`. The dispatch script already bounds its own output
# (--tail/--turns/--since on history, --background's distilled result), and piping
# through tail can clip the final distilled result the design depends on.
#
# The hook reads the PreToolUse JSON on stdin and blocks the tool call with a
# stderr explanation when it matches. It never inspects or modifies anything
# else.
#
# Exit codes: 0 = allow, 1 = block (Claude Code; stderr is fed back to the
# model), 2 = block (Codex; stderr is the blocking reason). Pass the block
# exit code as $1 — Codex hooks.json invokes `opencode-guard.sh 2`.

set -u

BLOCK_EXIT="${1:-1}"

BLOCK_EXIT="$BLOCK_EXIT" node -e '
  let d = "";
  process.stdin.on("data", c => d += c).on("end", () => {
    let j = {};
    try { j = JSON.parse(d); } catch (e) { process.exit(0); }
    const cmd = (j.tool_input && j.tool_input.command) || "";
    if (!/opencode-dispatch\.sh/.test(cmd)) process.exit(0);
    // `| tail` (or `| sudo tail`, `| /usr/bin/tail`) on the dispatch invocation.
    // A flag like --tail is never preceded by a pipe, so it does not match.
    if (/\|\s*(?:sudo\s+)?[\w./-]*tail(?:\s|$)/.test(cmd)) {
      console.error("blocked: never pipe opencode-dispatch.sh output through tail — the script already bounds its own output (--tail/--turns/--since, --background distilled result), and tail can clip the final result. Rerun without the pipe; use the script flags instead.");
      process.exit(parseInt(process.env.BLOCK_EXIT || "1", 10));
    }
    process.exit(0);
  });
'
