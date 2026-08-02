# claude-skill-opencode — Design & Inter-Agent Roadmap

Delegate work from inside the Claude Code harness to **opencode** driving a
cheaper model (default **DeepSeek**), so heavy reading/drafting/reviewing runs on
cheap tokens and only distilled results cross back into Claude's context.

Status: the CLI/skill layer (dispatch script + `/opencode:*` commands + persistent
server + session read-back) is built. The inter-agent features below are the
roadmap for the future MCP server.

---

## 1. The core idea (token seam)

Claude Code subagents ("Fable delegating to subagents") run in their **own**
context and return only a final report to the parent — the parent never pays for
the subagent's intermediate reasoning. An opencode delegate is the **same shape,
on a different model**:

| | Model | Context | Parent pays for |
|---|---|---|---|
| Native Claude subagent | Anthropic (Opus/Sonnet/Haiku) | its own | final report |
| **opencode delegate** | **DeepSeek (or any)** | its own opencode session | **only what the tool returns** |

You **cannot** repoint a native Claude `Agent` subagent at DeepSeek — Claude
subagents run Anthropic models. So an MCP tool (or the current bash/`run`
dispatch) is the *only* seam to inject a non-Anthropic worker into the harness.
The MCP is the more subagent-like of the two: it can hold session state and
return structured results, not just stdout.

**The invariant that keeps the token math positive:** *only distilled output
crosses the seam into Claude.* A tool that returns a raw transcript or a 20-page
dump spends the savings. Design every tool to return summaries, diffs, verdicts,
or typed JSON.

### Token economics (measured)
A one-line DeepSeek reply cost **~17.6k input tokens ($0.0077)** on
`deepseek-v4-pro` — opencode sends its full agent/system prompt every turn. Cheap,
but **not per-call-free**. Implication: batch related asks into one session; don't
spray many cold one-turn sessions.

---

## 2. Inter-agent feature catalog

Grouped by purpose. ⚙️ = native opencode endpoint exists; 🔧 = wrapper/MCP convenience.

### Unlocks "seamless like Fable"
- **Completion signal** ⚙️ — opencode has an SSE event stream (`/global/event`,
  `/api/session/:id/event`). A watcher on it **wakes Claude when a delegate
  finishes** instead of polling. Pairs with a Claude Code hook. This is the piece
  that turns "call tool, block/poll" into "fire, get notified."

### Result contracts (keep token math positive)
- **Structured/typed returns** ⚙️ — the message API supports
  `format: json_schema`. The delegate returns *validated JSON*, not prose. Single
  biggest lever for cheap, reliable agent-to-agent handoff.
- **Cheap outcome inspection (no transcript)** ⚙️ — `GET /session/:id/diff`
  (files changed), `/session/:id/todo` (task list/progress), plus a
  **summarize-remotely** tool (opencode `POST /session/:id/summarize` summarizes
  server-side on DeepSeek; return only the summary).
- **Cost/token readout** ⚙️ (already in the session object) → a budget guard so a
  delegate can't silently run up cost.

### Control
- **steer / queue** ⚙️ — `POST /api/session/:id/prompt` with `delivery:"steer"`
  (inject into the running turn) or `"queue"` (after current). Returns an
  admission record, not the reply — then poll `status`/`history`.
- **abort / interrupt** ⚙️ — `POST /session/:id/abort`, `/api/session/:id/interrupt`.
- **wait** ⚙️ — `/api/session/:id/wait` blocks until the current turn completes.

### Safety
- **Revert / unrevert** ⚙️ — undo a delegate's file edits (`/session/:id/revert`).
  Essential when `task`/`build` can edit.
- **Permission surfacing** ⚙️ — `/session/:id/permissions/:pid`; if a delegate
  hits an approval gate, bubble it up rather than hang.

### Coordination
- **Context handoff** 🔧 — seed a delegate with files (`-f`) or a briefing message.
- **Fork** ⚙️ — branch a session (`/session/:id/fork`) to explore a variant
  without polluting the original.
- **Delegate registry** 🔧 — a local `role → session-id` map so Claude addresses
  delegates stably ("the reviewer", "the migrator") and runs several concurrently.
- **liveness / status** 🔧 — `GET /session/:id` → `time.updated`; compute
  "idle for Nm" without pulling the transcript. Distinguish working-vs-idle via
  the last assistant message lacking `time.completed`.

---

## 3. Recommended build order (for the MCP)

The three that most change day-to-day, in order:

1. **Structured returns** (`format: json_schema`) — makes delegation cheap and
   reliable; everything downstream benefits.
2. **Summarize-remotely** — the canonical "read a big session for pennies, Claude
   sees only the summary" tool.
3. **Completion-notify (SSE → Claude Code hook)** — removes polling; delivers the
   hands-off, Fable-like feel.

Everything else in §2 is refinement layered on top.

Suggested minimal MCP tool surface:
`start_session`, `send` (with `steer|queue|wait`), `status`, `summarize_session`,
`get_diff`, `delegate_task` (returns a tight typed report), `list_sessions`.
Each contract-designed to return distilled output.

---

## 4. Operational notes (hard-won)

- **Everything runs in the server context by default.** Run modes are server-backed
  and async: submit → get a session id → observe (`status`/`history`) → kill
  (`abort`). This replaced the original one-shot `opencode run` default, which was
  an unobservable blocking subprocess with no timeout — the cause of an 8-hour
  "review" that no one could see into. One-shot is now opt-in via `--synchronous`;
  `--follow [--timeout N]` waits (bounded) and prints the reply inline.
- **Wake-on-complete = `--await`, not the delegate calling back.** Don't have
  opencode invoke `claude --resume` — that forks a *new* Opus process (costs the
  tokens we're saving, can't target the live session). Instead the caller blocks:
  `--await` submits async then lives exactly as long as the turn, prints the
  distilled result, and **exits 0** the moment it completes. Launched as a
  background task, that exit is what re-invokes Claude Code. No fixed deadline
  (default ~24h backstop, `--timeout 0` = unbounded); exits non-zero on turn error
  or if the server goes unreachable (~40s). `--follow` is the older bounded (300s)
  foreground wait that *leaves the session running* on timeout. The run-mode slash
  commands default to `--await` (task/bulk add `--summarize`).
- **`--summarize` contract (verified v1.18.x).** `POST /session/:id/summarize`
  **requires** `?directory=<session.directory>` AND a body `{providerID,modelID}`
  (the doc marks the body absent and directory optional — both are actually
  required; a bare POST 400s "Expected object, got undefined"). It returns a bare
  `true` and *appends* an **assistant** message with `summary:true` whose text
  parts are the digest — read that back (poll; it takes a few s on the delegate).
  A **user** message also carries a `summary` field, but it's a diff-stats object —
  match `role==="assistant" && summary===true`, never just truthy. Summarize runs
  on the delegate model, so Claude reads a paragraph, not the transcript. Its
  output is opencode's compaction template (Objective/Work State/Files) — good for
  agentic task/bulk, overkill for a one-line ask (so ask/plan/review print the
  final message instead).
- **529 "Overloaded" is an Anthropic code; DeepSeek uses 503/429.** A consistent
  529 means the work was NOT going to DeepSeek — an unconfigured/fallback Anthropic
  model, or the Claude subagents' own calls during a capacity event. Pin the model
  (`--model deepseek/...`) and check `status`'s `lastError` / the error's
  `metadata.url` to see which backend actually failed.
- **Edit workers are isolated:** task/bulk call the repository's
  `spawn-agent.mjs`, which allocates and bootstraps one locked worktree, creates a
  directory-bound session on the single persistent server, verifies the returned
  directory, and launches `opencode run --attach ... --auto`. Edit/bash are
  pre-authorized (`permission:[{edit/bash,**,allow}]`).
- **A server inherits env only at launch.** If `opencode serve` starts before
  `DEEPSEEK_API_KEY` is exported, every turn 401s ("Authentication Fails
  (governor)") even though the key is valid. Export the key in your shell profile;
  start/restart the server from a shell that has it. Verify a key directly:
  `curl -s -o /dev/null -w '%{http_code}' https://api.deepseek.com/models -H "Authorization: Bearer $DEEPSEEK_API_KEY"` → `200`.
- **BSD/macOS `mktemp` only expands `X`s at the END of the template.** A template
  like `foo-XXXXXX.diff` (suffix after the X's) is used *literally* on macOS — so
  every run (and any concurrent run) collides with `mkstemp failed: File exists`.
  Use `foo.XXXXXX` (X's terminal). GNU mktemp tolerates the suffix; BSD does not.
- **`--model` must be `provider/model`** (e.g. `deepseek/deepseek-v4-pro`); a bare
  `deepseek-v4-pro` is rejected (it would mis-split into a bogus providerID).
- **`-f` is a greedy array flag** in `opencode run`. Keep the prompt BEFORE `-f`
  and `-f` terminal with a single value, else yargs eats the prompt as a filename.
- **`/session/:id` is an API route** and shadows the web SPA — it returns JSON,
  not the UI. The web UI routes by *project* (slugs like `kind-cabin`), not by the
  API session path.
- **The local server serves a full web UI** at `/` (self-contained, CSP `'self'`)
  and renders in Claude Code's browser pane — good for watching a delegate live.
  Sessions created via the raw API in an unregistered directory may not surface in
  the UI's project list; driving opencode through the UI (add project → create
  session) is the reliable path to see them.

---

## 5. Useful opencode endpoints (v1.18.x)

| Endpoint | Use |
|---|---|
| `POST /session` | create session (`{title?, agent?, model?:{id,providerID,variant?}}`) |
| `GET /session` | list sessions |
| `GET /session/:id` | one session (has `time.updated`, `cost`, `tokens`) |
| `DELETE /session/:id` | delete session |
| `POST /session/:id/message` | send prompt, **blocking**, returns full reply `{info, parts}` |
| `POST /session/:id/prompt_async` | send prompt, non-blocking |
| `POST /api/session/:id/prompt` | send with `delivery:steer\|queue`, `resume` |
| `GET /session/:id/message` | full transcript (messages → `parts[]` text) |
| `POST /session/:id/summarize` | server-side summarize/compact on the session model |
| `GET /session/:id/diff` | files changed by the session |
| `GET /session/:id/todo` | session todo list |
| `POST /session/:id/fork` | branch the session |
| `POST /session/:id/abort` / `/api/session/:id/interrupt` | stop a turn |
| `POST /session/:id/revert` / `/unrevert` | undo/redo file changes |
| `GET /global/event`, `/api/session/:id/event` | SSE event stream |
| `GET /doc` | OpenAPI 3.1 spec (auto-generated SDK source) |

Models on this DeepSeek account: `deepseek-v4-pro` (default), `deepseek-v4-flash`.
