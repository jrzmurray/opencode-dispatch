#!/usr/bin/env node
/**
 * oc-api — normalized OpenCode API operations for opencode-dispatch.
 *
 * The dispatcher shell script performs orchestration (flags, loops, exit
 * codes) and delegates every dialect-sensitive operation here, so v1/v2 shape
 * differences live in exactly one place: api-dialect.mjs + opencode-server.mjs.
 *
 * Usage: node scripts/oc-api.mjs <command> [flags]
 *
 * Commands:
 *   detect    Classify the server (v1|v2|down), auth status, and — with
 *             --bin — client pairing. Exit 7 when the server is unreachable.
 *   version   Print a client binary's version and generation (for the shell's
 *             `--direct` gate); exit 2 when the version cannot be parsed.
 *   sessions  List sessions, newest first (dispatcher `sessions` format).
 *   status    Render liveness for one session or a one-line summary of all
 *             sessions (dispatcher `status` format).
 *   history   Render a session transcript (dispatcher `history` format).
 *   follow    Read-only stream of a running session until the turn completes.
 *             v2 uses the event stream; v1 without events is not supported
 *             here (the dispatcher keeps its polling loop for v1). Exit 0
 *             done / 3 timeout / 5 session not found / 7 unreachable.
 *   wait      Block until a running v2 turn settles, with the same progress
 *             heartbeats, ask announcements, stall guard, and exit codes as
 *             the dispatcher's v1 await loop. Exit 0 done, 3 timeout,
 *             7 unreachable, 8 stall.
 *   create    Create a session for a run mode (agent/model/title/permissions).
 *             Prints the new session id.
 *   submit    Submit prompt text from --prompt-file to an existing session.
 *             With --delivery steer|queue (v2), admit into a running turn and
 *             print the admission record instead of waiting.
 *   last      Print the newest message id (the baseline for `send`'s wait).
 *   where     Print a session's directory (for the dispatcher's banner and
 *             worktree-mismatch guard).
 *   interrupt Interrupt a session's in-progress turn (v2 `interrupt`).
 *   watch     Wait for a session to change or settle (v2 events; used by
 *             `status --follow` as its gate). Exit 0 settled (idle, failed,
 *             interrupted, or stopped), 10 change, 3 timeout, 7 unreachable.
 *             Without --session: any change.
 *   ask       List pending permission/question(form) asks.
 *   permissions List pending permission asks (dispatcher `permissions` format).
 *   allow     Approve one permission request (--always remembers the pattern).
 *   delete    Delete one session through the native server API (interrupts
 *             its turn and removes child sessions). A missing session is
 *             treated as already deleted.
 *
 * Common flags:
 *   --server <url>        Server URL (default $OPENCODE_SERVER_URL or
 *                         127.0.0.1:4096)
 *   --api <auto|v1|v2>    Dialect; auto probes (default auto). A pin is only
 *                         a fallback when the server cannot be classified.
 *   --password <pw>       Basic-auth password (default $OPENCODE_PASSWORD or
 *                         $OPENCODE_SERVER_PASSWORD)
 *   --username <u>        Basic-auth username (default opencode)
 *   --dir <path>          Location scoping (v1 ?directory=, v2 header)
 *   --after <message-id>  Completion baseline: ignore turns at or before this
 *                         message (used by `send` on an existing session)
 *   --delivery <mode>     steer|queue (v2 prompt admission; `submit`)
 *   --tool-name <name>    Dispatcher name embedded in action hints
 *   --json                Machine-readable output where applicable
 *
 * Exit codes: 0 ok, 2 usage, 3 timeout, 5 not found, 7 unreachable,
 *             10 change (watch).
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import credentials from "./server-credentials.cjs";
import { API_V1, API_V2, clientVersion, pairingStatus, probeServer } from "./api-dialect.mjs";
import { OpenCodeClient, OpenCodeServerError, normalizeAsk } from "./opencode-server.mjs";

const { resolveEnvCredential } = credentials;

const EXIT = { OK: 0, USAGE: 2, TIMEOUT: 3, NOT_FOUND: 5, UNREACHABLE: 7, STALL: 8, CHANGE: 10 };

const COMMANDS = new Set([
  "detect",
  "version",
  "sessions",
  "status",
  "history",
  "follow",
  "wait",
  "create",
  "submit",
  "last",
  "where",
  "interrupt",
  "watch",
  "ask",
  "permissions",
  "allow",
  "delete",
]);

function usage(message) {
  if (message) console.error(`oc-api: ${message}`);
  console.error("usage: node scripts/oc-api.mjs <detect|version|sessions|status|history|follow|wait|create|submit|last|where|interrupt|watch|ask|permissions|allow|delete> [flags]");
  console.error("       run with --help for the command reference");
  process.exit(EXIT.USAGE);
}

function parseArgs(argv) {
  const options = {
    command: "",
    server: "",
    api: "auto",
    password: "",
    username: "",
    dir: "",
    session: "",
    toolName: "opencode-dispatch.sh",
    limit: 50,
    tail: 100,
    tailSet: false,
    turns: "",
    since: "",
    timeout: 300,
    timeoutSet: false,
    bin: "",
    json: false,
    agent: "",
    model: "",
    variant: "",
    title: "",
    permission: "",
    promptFile: "",
    stall: 0,
    minMessages: 2,
    mode: "",
    after: "",
    delivery: "",
    request: "",
    always: false,
  };
  const args = [...argv];
  options.command = args.shift() || "";
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--server") options.server = args.shift() || "";
    else if (arg === "--api") options.api = args.shift() || "";
    else if (arg === "--password") options.password = args.shift() || "";
    else if (arg === "--username") options.username = args.shift() || "";
    else if (arg === "--dir") options.dir = args.shift() || "";
    else if (arg === "--session") options.session = args.shift() || "";
    else if (arg === "--tool-name") options.toolName = args.shift() || "";
    else if (arg === "--limit") options.limit = parseInt(args.shift() || "", 10) || 50;
    else if (arg === "--tail") { options.tail = parseInt(args.shift() || "", 10); options.tailSet = true; }
    else if (arg === "--turns") options.turns = args.shift() || "";
    else if (arg === "--since") options.since = args.shift() || "";
    else if (arg === "--timeout") { options.timeout = parseInt(args.shift() || "", 10); options.timeoutSet = true; }
    else if (arg === "--bin") options.bin = args.shift() || "";
    else if (arg === "--agent") options.agent = args.shift() || "";
    else if (arg === "--model") options.model = args.shift() || "";
    else if (arg === "--variant") options.variant = args.shift() || "";
    else if (arg === "--title") options.title = args.shift() || "";
    else if (arg === "--permission") options.permission = args.shift() || "";
    else if (arg === "--prompt-file") options.promptFile = args.shift() || "";
    else if (arg === "--stall") options.stall = parseInt(args.shift() || "", 10) || 0;
    else if (arg === "--min-messages") options.minMessages = parseInt(args.shift() || "", 10) || 2;
    else if (arg === "--mode") options.mode = args.shift() || "";
    else if (arg === "--after") options.after = args.shift() || "";
    else if (arg === "--delivery") options.delivery = args.shift() || "";
    else if (arg === "--request") options.request = args.shift() || "";
    else if (arg === "--always") options.always = true;
    else if (arg === "--json") options.json = true;
    else usage(`unknown argument: ${arg}`);
  }
  if (options.api && !["auto", API_V1, API_V2].includes(options.api)) usage(`--api must be auto|v1|v2 (got: ${options.api})`);
  return options;
}

function authFor(options, baseUrl) {
  const environment = resolveEnvCredential({ baseUrl });
  return {
    username: options.username || environment.username || process.env.OPENCODE_SERVER_USERNAME || "opencode",
    password: options.password || environment.password,
  };
}

function clientFrom(options, { api } = {}) {
  const baseUrl = options.server || process.env.OPENCODE_SERVER_URL || "http://127.0.0.1:4096";
  return new OpenCodeClient({
    baseUrl,
    ...authFor(options, baseUrl),
    api: api || options.api,
  });
}

function fail(error) {
  if (error instanceof OpenCodeServerError) {
    console.error(`oc-api: ${error.message}`);
    const unreachable = error.status === 0 || error.status === 401 || error.status === 403 || error.status >= 500;
    process.exit(unreachable ? EXIT.UNREACHABLE : EXIT.NOT_FOUND);
  }
  throw error;
}

function normTime(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value > 0 && value < 1e12 ? value * 1000 : value;
}

function fmtAge(ms) {
  let x = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(x / 3600);
  x %= 3600;
  const m = Math.floor(x / 60);
  const s = x % 60;
  return `${h ? `${h}h ` : ""}${h || m ? `${m}m ` : ""}${s}s`;
}

function iso(ms) {
  return ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) : "?";
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** "provider/model" (the dispatcher's --model form) → the adapter's shape. */
function parseModel(value, variant) {
  if (!value) return undefined;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) usage(`--model must be provider/model (got: ${value})`);
  return {
    providerID: value.slice(0, slash),
    id: value.slice(slash + 1),
    ...(variant ? { variant } : {}),
  };
}

/**
 * Newest normalized message for a session, or null.
 *
 * v2 pages are newest-first and may lead with non-conversation records
 * (model-switched, agent-switched, synthetic, ...) that normalizeMessages
 * drops. A limit of 1 would then return null even though the session has a
 * transcript, so read a small window and take the newest conversation record.
 */
async function lastMessage(client, sessionId, directory) {
  const page = await client.messagesPage(sessionId, { directory, limit: 20, order: "desc" });
  let newest = null;
  for (const message of page.messages) {
    if (!newest || (message.created || 0) >= (newest.created || 0)) newest = message;
  }
  return newest;
}

/** Fetch a session by id, falling back to the unscoped lookup. */
async function getSessionWithFallback(client, sessionId, directory) {
  try {
    return await client.getSession(sessionId, { directory });
  } catch (error) {
    if (!directory) throw error;
    return client.getSession(sessionId);
  }
}

/**
 * Sessions with a turn currently running, from v2 `GET /api/session/active`.
 *
 * This is the authoritative turn-level signal. A completed assistant message
 * only marks the end of one model step: v2 turns span several assistant
 * messages (tool calls, follow-up steps), so message completion alone says
 * nothing about whether the turn is still working. Returns null when the
 * endpoint is unavailable (an older v2 build or a test double), letting
 * callers fall back to the message heuristic.
 */
async function activeSessionIds(client) {
  try {
    const data = await client.getSessionStatus();
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    return new Set(Object.keys(data));
  } catch {
    return null;
  }
}

/** True/false from the active map; null when the endpoint cannot answer. */
async function sessionRunning(client, sessionId) {
  const active = await activeSessionIds(client);
  if (!active) return null;
  return active.has(sessionId);
}

// ---------------------------------------------------------------------------
// pending sends: close the "new message not in the transcript yet" window
// ---------------------------------------------------------------------------
//
// A v2 prompt POST returns an admission record (with the user message id)
// before that message necessarily appears in GET /message. Without a marker, a
// status poll in that window sees the PREVIOUS terminal turn and reports idle,
// which made orchestrators cancel and re-run live workers. `submit` writes a
// local marker from the request/response state; status/watch/follow/wait treat
// it as pending until the admission id (or any new message after the baseline)
// appears, or the marker expires.
//
// This is deliberately a local marker: it covers sends issued through this
// dispatcher. The server-side `time.idle` fallback below covers the same window
// for clients that do not write one.

const PENDING_TTL_MS = 10 * 60 * 1000;

function pendingStateDir() {
  const root = process.env.OPENCODE_DISPATCH_STATE_DIR
    || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "opencode-dispatch");
  return path.join(root, "pending");
}

function pendingPath(baseUrl, sessionId) {
  const server = crypto.createHash("sha1").update(String(baseUrl || "")).digest("hex").slice(0, 12);
  const session = String(sessionId || "").replace(/[^A-Za-z0-9_.-]/g, "_");
  return path.join(pendingStateDir(), `${server}-${session}.json`);
}

function readPending(baseUrl, sessionId) {
  try {
    const file = pendingPath(baseUrl, sessionId);
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!data || data.server !== baseUrl || data.session !== sessionId) return null;
    if (!Number.isFinite(data.startedAt) || Date.now() - data.startedAt > PENDING_TTL_MS) {
      clearPending(baseUrl, sessionId);
      return null;
    }
    if (!Array.isArray(data.admissions)) data.admissions = [];
    return data;
  } catch {
    return null;
  }
}

function writePending(baseUrl, sessionId, data) {
  const file = pendingPath(baseUrl, sessionId);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data));
    fs.renameSync(temp, file);
  } catch {
    // The marker is best-effort: never fail a send or a status read over it.
  }
}

function clearPending(baseUrl, sessionId) {
  try {
    fs.rmSync(pendingPath(baseUrl, sessionId), { force: true });
  } catch {
    // already gone
  }
}

function beginPending(baseUrl, sessionId, delivery, baseline) {
  writePending(baseUrl, sessionId, {
    server: baseUrl,
    session: sessionId,
    startedAt: Date.now(),
    delivery: delivery || null,
    baseline: baseline || "",
    admissions: [],
  });
}

function recordPendingAdmission(baseUrl, sessionId, admissionId) {
  if (!admissionId) return;
  const data = readPending(baseUrl, sessionId);
  if (!data) return;
  if (!data.admissions.some((entry) => entry.id === admissionId)) {
    data.admissions.push({ id: admissionId, at: Date.now() });
  }
  writePending(baseUrl, sessionId, data);
}

/** Every unexpired marker for this server, keyed by session id. */
function listPending(baseUrl) {
  const map = new Map();
  let names;
  try {
    names = fs.readdirSync(pendingStateDir());
  } catch {
    return map;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(pendingStateDir(), name), "utf8"));
    } catch {
      continue;
    }
    if (!data || data.server !== baseUrl || !data.session) continue;
    if (!Number.isFinite(data.startedAt) || Date.now() - data.startedAt > PENDING_TTL_MS) {
      clearPending(baseUrl, data.session);
      continue;
    }
    if (!Array.isArray(data.admissions)) data.admissions = [];
    map.set(data.session, data);
  }
  return map;
}

/**
 * The marker while the send is still outstanding, else null. `messages` is a
 * normalized window (any order). We consider the send landed when its admission
 * id is present, or when the newest message is no longer the pre-send baseline
 * (a fresh session going from no messages to any message also counts).
 */
function pendingOutstanding(baseUrl, sessionId, messages) {
  const pending = readPending(baseUrl, sessionId);
  if (!pending) return null;
  const list = Array.isArray(messages) ? messages.filter(Boolean) : [];
  const ids = new Set(list.map((message) => message.id).filter(Boolean));
  const admissionSeen = pending.admissions.length > 0
    && pending.admissions.every((entry) => ids.has(entry.id));
  const newest = list.reduce(
    (chosen, message) => (!chosen || (message.created || 0) >= (chosen.created || 0) ? message : chosen),
    null,
  );
  const baseline = pending.baseline || "";
  const landed = baseline
    ? Boolean(newest?.id && newest.id !== baseline)
    : list.length > 0;
  if (admissionSeen || landed) {
    clearPending(baseUrl, sessionId);
    return null;
  }
  return pending;
}

/**
 * Pending asks across every directory the server knows: the bare/default
 * location, the caller's --dir, and the directory of each known session
 * (mirrors the dispatcher's all_asks fanout). Individual failures are
 * tolerated; the result is deduplicated by kind+id.
 */
async function collectAsks(client, { directory } = {}) {
  const api = await client.resolveApi();
  const directories = new Set([""]);
  if (directory) directories.add(directory);
  const sessionDirs = new Map();
  try {
    const sessions = await client.listSessions({});
    for (const session of sessions.slice(0, 50)) {
      if (session.directory) {
        directories.add(session.directory);
        sessionDirs.set(session.id, session.directory);
      }
    }
  } catch {
    // session listing is a convenience for scope discovery; the bare query still works
  }
  const list = [...directories].slice(0, 25);
  const asks = new Map();
  const remember = (raw, dir) => {
    const ask = normalizeAsk(raw, api);
    if (!ask) return;
    // The request may be global (v2); reply through the OWNING session's
    // directory, not whichever scope happened to list it first.
    const scopeDir = sessionDirs.get(ask.sessionID) || dir || "";
    const key = `${ask.kind}:${ask.id}`;
    const existing = asks.get(key);
    if (!existing) {
      ask.directory = scopeDir;
      asks.set(key, ask);
      return;
    }
    if (scopeDir && (!existing.directory || existing.directory !== scopeDir)) existing.directory = scopeDir;
  };
  await Promise.all(
    list.map(async (dir) => {
      const scope = dir ? { directory: dir } : {};
      try {
        for (const raw of await client.listPermissionRequests(scope)) remember(raw, dir);
      } catch {
        // a scope that rejects the query is skipped, not fatal
      }
      try {
        for (const raw of await client.listQuestionRequests(scope)) remember(raw, dir);
      } catch {
        // as above
      }
    }),
  );
  return [...asks.values()];
}

function askLabel(ask) {
  if (ask.kind === "permission") {
    return `(${ask.id} ${ask.action} ${ask.resources})`.trim();
  }
  return `(${ask.id} ${ask.title})`;
}

/**
 * Working/finished state of a normalized message (mirrors the v1 heuristics).
 * A trailing user message means the turn was submitted but the assistant row
 * has not landed yet — it is pending, not idle. An idle marker is terminal.
 */
function messageWorking(message) {
  if (!message) return false;
  if (message.role === "user") return true;
  return message.role === "assistant" && !message.completed;
}

/**
 * State of a session with NO active turn, derived from its newest normalized
 * message. A freshly created session has no transcript and is NOT idle: it has
 * not been prompted yet. A trailing user message is a submitted prompt whose
 * assistant reply has not landed. Callers treat an incomplete assistant step as
 * working before calling this (it may be driven by another server process over
 * the shared database, or be a dead turn that becomes STALE). A failed or
 * interrupted idle record gets its own state. Only a cleanly completed turn is
 * `idle`; `stopped` remains a defensive fallback for a partial step.
 */
function inactiveState(last) {
  if (!last) return "initializing";
  if (last.role === "user") return "pending";
  if (last.role === "assistant" && !last.completed) return "stopped";
  if (last.role === "idle") {
    if (last.outcome === "interrupted") return "interrupted";
    if (last.outcome === "failed" || last.error) return "failed";
    return "idle";
  }
  if (last.role === "assistant" && last.error) return "failed";
  return "idle";
}

function stuckTool(message) {
  if (!message || !Array.isArray(message.parts)) return null;
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index];
    if (part.kind === "tool" && part.status === "running" && !part.completedAt) return part;
  }
  return null;
}

// ---------------------------------------------------------------------------
// detect
// ---------------------------------------------------------------------------

async function commandDetect(options) {
  const baseUrl = options.server || process.env.OPENCODE_SERVER_URL || "http://127.0.0.1:4096";
  const probe = await probeServer({
    baseUrl,
    ...authFor(options, baseUrl),
  });
  let pairing = null;
  if (options.bin) {
    const version = clientVersion(options.bin, { execFileImpl: execFileSync });
    pairing = version.generation === null
      ? { ok: false, severity: "unknown" }
      : pairingStatus({ api: probe.api, generation: version.generation, version: version.version });
    pairing.client = version;
  }
  if (options.json) {
    console.log(JSON.stringify({ ...probe, pairing }, null, 2));
  } else if (!probe.serverUp) {
    console.log(`down (${probe.detail})`);
  } else if (!probe.api) {
    console.log(`unrecognized (${probe.detail})`);
  } else {
    const auth = probe.authOk ? "auth:ok" : "auth:required";
    const version = probe.version ? ` ${probe.version}` : "";
    console.log(`${probe.api}${version} (${auth}; ${probe.detail})`);
    if (pairing) console.log(`pairing: ${pairing.ok ? "ok" : pairing.severity} — ${pairing.reason || ""}`);
  }
  process.exit(probe.serverUp && probe.api ? EXIT.OK : EXIT.UNREACHABLE);
}

// ---------------------------------------------------------------------------
// version
// ---------------------------------------------------------------------------

async function commandVersion(options) {
  const info = clientVersion(options.bin || "opencode", { execFileImpl: execFileSync });
  if (options.json) {
    console.log(JSON.stringify(info));
  } else if (info.generation) {
    console.log(`${info.version} (v${info.generation})`);
  } else {
    console.log(`unknown${info.error ? ` (${info.error})` : ""}`);
  }
  process.exit(info.generation ? EXIT.OK : EXIT.USAGE);
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

async function commandSessions(options) {
  const client = clientFrom(options);
  const sessions = await client.listSessions({ limit: options.limit }).catch(fail);
  const normalized = sessions
    .map((session) => ({ ...session, updated: normTime(session.time?.updated) }))
    .sort((left, right) => (right.updated || 0) - (left.updated || 0));
  if (options.json) {
    console.log(JSON.stringify(normalized, null, 2));
    return;
  }
  const shown = normalized.slice(0, options.limit);
  for (const session of shown) {
    console.log(`${session.id}  ${iso(session.updated)}  ${session.title || ""}`);
  }
  if (normalized.length > shown.length) {
    console.log(`… ${normalized.length - shown.length} older session(s) not shown (raise --tail).`);
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function renderAskState(parked, toolName, sessionId) {
  const head = parked.kind === "permission" ? "PERMISSION PROMPT" : "QUESTION ASK";
  const act = parked.kind === "permission"
    ? `approve: ${toolName} allow ${parked.id} [--always]`
    : "no reply path on a headless server (the agent is waiting on a human)";
  const detail = parked.kind === "permission"
    ? `${parked.id} ${parked.action}${parked.resources ? ` ${parked.resources}` : ""}`
    : `${parked.id} [question] ${parked.title}`;
  return `WORKING — ${head} (${detail}) — ${act}   |   abort: ${toolName} abort ${sessionId}`;
}

async function statusSingle(client, options, sessionId) {
  let session;
  try {
    session = await getSessionWithFallback(client, sessionId, options.dir || undefined);
  } catch (error) {
    console.error("oc-api: session not found");
    process.exit(EXIT.NOT_FOUND);
  }
  const api = await client.resolveApi();
  let activeIds = null;
  let pending = null;
  let last = null;
  let messageCount = null;
  let more = false;
  if (api === API_V2) {
    // Turn-level state comes from /api/session/active; the message stream only
    // provides the newest step (tool detail, errors) for the display.
    activeIds = await activeSessionIds(client);
    const page = await client.messagesPage(sessionId, { directory: session.directory || options.dir, limit: 50, order: "desc" });
    messageCount = page.messages.length;
    // v2 always returns a continuable cursor, so "more" is a window heuristic:
    // a full page means older messages may exist beyond it.
    more = page.messages.length >= 50;
    last = page.messages.reduce((a, b) => (!a || (b.created || 0) >= (a.created || 0) ? b : a), null);
    pending = pendingOutstanding(client.baseUrl, sessionId, page.messages);
  } else {
    const messages = await client.messages(sessionId, { directory: session.directory || options.dir }).catch(() => []);
    messageCount = Array.isArray(messages) ? messages.length : 0;
    last = messages[messages.length - 1] || null;
  }
  const asks = await collectAsks(client, { directory: session.directory || options.dir });
  const parked = asks.find((ask) => ask.sessionID === sessionId);
  const updated = normTime(session.time?.updated);
  const now = Date.now();
  const idle = Math.max(0, now - (updated || 0));
  const active = activeIds ? activeIds.has(sessionId) : null;
  // An incomplete assistant step means the turn has not finished, even if this
  // server does not list the session as active (it may be driven by another
  // server process over the shared database). The active map is what prevents
  // a COMPLETED step mid-turn from being mistaken for a finished turn.
  const partialStep = last?.role === "assistant" && !last.completed;
  const working = active === null ? messageWorking(last) : active || partialStep;
  const tool = stuckTool(last);
  const stale = working && idle > 30 * 60 * 1000;

  console.log(`session:  ${session.id}`);
  console.log(`title:    ${session.title || ""}`);
  console.log(`model:    ${session.model?.providerID || "?"}/${session.model?.id || "?"}`);
  console.log(`messages: ${messageCount === null ? "?" : `${messageCount}${more ? "+" : ""}`}   cost: $${session.cost ?? 0}`);
  console.log(`updated:  ${iso(updated)}${updated ? `  (${fmtAge(idle)} ago)` : ""}`);
  let state;
  if (parked) {
    state = renderAskState(parked, options.toolName, session.id);
  } else if (working && tool) {
    const duration = tool.startedAt ? fmtAge(Math.max(0, now - tool.startedAt)) : "?";
    state = `WORKING — TOOL RUNNING (${tool.name} · ${duration})`;
  } else if (stale) {
    state = `WORKING — STALE (${fmtAge(idle)} without activity; likely a dead turn — try ${options.toolName} abort ${session.id})`;
  } else if (working) {
    state = "WORKING (turn in progress)";
  } else if (pending) {
    state = `pending (${fmtAge(Math.max(0, now - pending.startedAt))})`;
  } else {
    const settled = inactiveState(last);
    if (settled === "initializing") {
      const created = normTime(session.time?.created);
      state = created ? `initializing (${fmtAge(Math.max(0, now - created))})` : "initializing";
    } else if (settled === "pending") {
      const since = last?.created ? fmtAge(Math.max(0, now - last.created)) : "?";
      state = `pending — prompt submitted; assistant reply not started (${since} ago)`;
    } else if (settled === "stopped") {
      state = "stopped — last assistant step is incomplete and no turn is active";
    } else if (settled === "failed") {
      state = "failed — last turn failed (see lastError)";
    } else if (settled === "interrupted") {
      state = "interrupted — last turn was interrupted";
    } else {
      state = "idle";
    }
  }
  console.log(`state:    ${state}`);
  if (last?.error) {
    console.log(`lastError: ${last.error.type || "?"} ${last.error.status || ""} ${last.error.message || ""}`);
  }
}

async function statusAll(client, options) {
  const sessions = await client.listSessions({ limit: options.limit }).catch(fail);
  const shown = sessions.slice(0, options.limit);
  // One turn-level query for the whole list (v2 only: the v1 /session/status
  // response is not the same active-session contract). `null` means the
  // endpoint is unavailable; each row then falls back to the message heuristic.
  const api = await client.resolveApi();
  const activeIds = api === API_V2 ? await activeSessionIds(client) : null;
  const pendingMap = api === API_V2 ? listPending(client.baseUrl) : new Map();
  const asks = await collectAsks(client, { directory: options.dir || undefined });
  const parkedBySession = new Map();
  for (const ask of asks) {
    if (!parkedBySession.has(ask.sessionID)) parkedBySession.set(ask.sessionID, ask);
  }
  const now = Date.now();
  const states = await Promise.all(
    shown.map(async (session) => {
      const parked = parkedBySession.get(session.id);
      if (parked) return parked.kind === "permission" ? "PERMASK" : "QUESTION";
      const running = activeIds ? activeIds.has(session.id) : null;
      const pending = pendingMap.get(session.id) || null;
      try {
        // Even an inactive row needs its newest message: no transcript yet is
        // `initializing`, a trailing user message is `pending`, and only a terminal
        // turn is `idle`. An incomplete assistant step still counts as working.
        const last = await lastMessage(client, session.id, session.directory);
        const outstanding = pending ? pendingOutstanding(client.baseUrl, session.id, last ? [last] : []) : null;
        const partialStep = last?.role === "assistant" && !last.completed;
        const working = running === null ? messageWorking(last) : running || partialStep;
        if (!working) return outstanding ? "pending" : inactiveState(last);
        const updated = normTime(session.time?.updated) || 0;
        const idle = now - updated;
        const tool = stuckTool(last);
        const duration = tool?.startedAt ? fmtAge(Math.max(0, now - tool.startedAt)) : "";
        const toolLabel = tool ? `(${tool.name}${duration ? `·${duration}` : ""})` : "";
        return `${idle > 30 * 60 * 1000 ? "STALE" : "WORKING"}${toolLabel}`;
      } catch {
        // A failed read is not proof the turn is over. Never report idle in
        // that case: an orchestrator would cancel a live worker.
        if (running === true) return "WORKING";
        return pending ? "pending" : "unknown";
      }
    }),
  );
  let parkedCount = 0;
  let workingCount = 0;
  let initializingCount = 0;
  let stoppedCount = 0;
  let failedCount = 0;
  let interruptedCount = 0;
  let unknownCount = 0;
  shown.forEach((session, index) => {
    const updated = normTime(session.time?.updated) || 0;
    const state = states[index];
    if (state === "PERMASK" || state === "QUESTION") parkedCount += 1;
    if (state.startsWith("WORKING")) workingCount += 1;
    if (state === "initializing" || state === "pending") initializingCount += 1;
    else if (state === "stopped") stoppedCount += 1;
    else if (state === "failed") failedCount += 1;
    else if (state === "interrupted") interruptedCount += 1;
    else if (state === "unknown") unknownCount += 1;
    const age = updated ? `${fmtAge(now - updated)} ago` : "?";
    console.log(`${session.id}  ${state.padEnd(14)}  ${age.padStart(12)}  ${session.title || ""}`);
  });
  if (parkedCount) console.log(`… ${parkedCount} session(s) parked on an ask (see: ${options.toolName} permissions / allow)`);
  if (workingCount) console.log(`… ${workingCount} session(s) working`);
  if (initializingCount) console.log(`… ${initializingCount} session(s) initializing/pending (not done — do not cancel or re-run).`);
  if (stoppedCount) console.log(`… ${stoppedCount} session(s) stopped mid-turn (inspect before re-running).`);
  if (failedCount) console.log(`… ${failedCount} session(s) failed (inspect before re-running).`);
  if (interruptedCount) console.log(`… ${interruptedCount} session(s) interrupted.`);
  if (unknownCount) console.log(`… ${unknownCount} session(s) state unknown (message read failed — do not treat as done).`);
  if (sessions.length > shown.length) console.log(`… ${sessions.length - shown.length} older session(s) not shown (raise --tail).`);
}

async function commandStatus(options) {
  const client = clientFrom(options);
  if (options.session) {
    await statusSingle(client, options, options.session);
  } else {
    await statusAll(client, options);
  }
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

function parseSince(value) {
  if (!value) return 0;
  const match = String(value).match(/^([0-9]+)\s*([smhdw])$/i);
  if (!match) {
    console.error(`bad --since "${value}" (use e.g. 30s 10m 6h 1d 2w)`);
    process.exit(EXIT.USAGE);
  }
  const amount = parseInt(match[1], 10);
  const unit = { s: 1e3, m: 6e4, h: 36e5, d: 864e5, w: 6048e5 }[match[2].toLowerCase()];
  return Date.now() - amount * unit;
}

/** Fetch enough of the newest messages to cover the requested window (v2 pages). */
async function fetchHistoryMessages(client, options, directory, cutoff = 0) {
  const api = await client.resolveApi();
  if (api !== API_V2) {
    const messages = await client.messages(options.session, { directory }).catch(fail);
    return messages;
  }
  const neededTurns = parseInt(options.turns, 10) > 0 ? parseInt(options.turns, 10) : 2;
  const collected = [];
  let cursor = null;
  let userCount = 0;
  for (let page = 0; page < 20; page += 1) {
    // v2 rejects `order` together with a cursor (the cursor encodes the
    // order/direction); only the first page selects it.
    const query = cursor ? { directory, limit: 100, cursor } : { directory, limit: 100, order: "desc" };
    const result = await client.messagesPage(options.session, query).catch(fail);
    collected.push(...result.messages);
    userCount += result.messages.filter((message) => message.role === "user").length;
    cursor = result.cursor?.next || null;
    // --since needs the whole requested window, not just N turns: keep paging
    // until a fetched message predates the cutoff (or the cursor runs out).
    const reachedCutoff = cutoff > 0 && result.messages.some((message) => message.created && message.created < cutoff);
    if (!cursor || reachedCutoff || (cutoff <= 0 && userCount >= neededTurns) || collected.length >= 2000) break;
  }
  return collected.sort((left, right) => (left.created || 0) - (right.created || 0));
}

async function commandHistory(options) {
  if (!options.session) usage("history needs --session <id>");
  const client = clientFrom(options);
  let session = null;
  try {
    session = await getSessionWithFallback(client, options.session, options.dir || undefined);
  } catch (error) {
    console.error("oc-api: session not found (server unreachable or no such session)");
    process.exit(EXIT.NOT_FOUND);
  }
  const messages = await fetchHistoryMessages(client, options, session?.directory || options.dir || undefined, parseSince(options.since));
  const cutoff = parseSince(options.since);
  let kept = messages.filter((message) => !(cutoff && message.created && message.created < cutoff));
  const turns = parseInt(options.turns, 10);
  if (turns > 0) {
    const userIndexes = kept.map((message, index) => (message.role === "user" ? index : -1)).filter((index) => index >= 0);
    if (userIndexes.length > turns) kept = kept.slice(userIndexes[userIndexes.length - turns]);
  }
  const lines = [];
  for (const message of kept) {
    const text = (message.parts || []).filter((part) => part.kind === "text" && part.text).map((part) => part.text).join("\n").trim();
    if (!text) continue;
    lines.push(`── ${message.role}${message.created ? ` @ ${iso(message.created)}` : ""} ──`);
    for (const line of text.split("\n")) lines.push(line);
    lines.push("");
  }
  const cap = options.tailSet ? options.tail || 100 : turns > 0 ? Infinity : 100;
  const out = lines.length > cap ? lines.slice(-cap) : lines;
  if (lines.length > cap) console.log(`… showing last ${cap} of ${lines.length} lines (raise --tail) …`);
  if (out.length) process.stdout.write(`${out.join("\n")}\n`);
}

// ---------------------------------------------------------------------------
// run-mode primitives (create / submit / where / interrupt)
// ---------------------------------------------------------------------------

async function commandCreate(options) {
  const client = clientFrom(options);
  let permission;
  if (options.permission) {
    try {
      permission = JSON.parse(options.permission);
    } catch {
      usage("--permission must be a JSON array");
    }
  }
  const session = await client.createSession({
    directory: options.dir || undefined,
    title: options.title || undefined,
    agent: options.agent || undefined,
    model: parseModel(options.model, options.variant),
    permission,
  }).catch(fail);
  if (!session?.id) {
    console.error("oc-api: server did not return a session id");
    process.exit(EXIT.UNREACHABLE);
  }
  console.log(session.id);
}

async function commandSubmit(options) {
  if (!options.session) usage("submit needs --session <id>");
  if (!options.promptFile) usage("submit needs --prompt-file <path>");
  if (options.delivery && !["steer", "queue"].includes(options.delivery)) {
    usage(`--delivery must be steer|queue (got: ${options.delivery})`);
  }
  let text;
  try {
    text = fs.readFileSync(options.promptFile, "utf8");
  } catch {
    console.error(`oc-api: prompt file not readable: ${options.promptFile}`);
    process.exit(EXIT.USAGE);
  }
  const client = clientFrom(options);
  const api = await client.resolveApi().catch(fail);
  if (options.delivery && api !== API_V2) {
    console.error("oc-api: --delivery requires a v2 server (v1 has no steer/queue field)");
    process.exit(EXIT.USAGE);
  }
  // Scope the prompt to the session's actual directory. The caller's --dir is
  // a hint (a direct session id may live in another worktree); the lookup
  // falls back to the unscoped route. A lookup failure is left to the submit
  // to report, so a missing session still gets the API's error.
  let directory = options.dir || undefined;
  try {
    const session = await getSessionWithFallback(client, options.session, directory);
    directory = session?.directory || directory;
  } catch {
    // submit will surface the real error
  }
  // v2: record the send BEFORE the request so a concurrent status poll cannot
  // see the previous terminal turn and call a live worker idle. The baseline is
  // the newest message that existed before this send; the admission id from the
  // response is the precise "this message landed" marker. `send` passes its
  // already-computed baseline; run modes fall back to reading it here.
  if (api === API_V2) {
    let baseline = options.after || "";
    if (!baseline) {
      baseline = (await lastMessage(client, options.session, directory).catch(() => null))?.id || "";
    }
    beginPending(client.baseUrl, options.session, options.delivery || null, baseline);
  }
  let result;
  try {
    result = await client.promptAsync(options.session, {
      directory,
      text,
      agent: options.agent || undefined,
      model: parseModel(options.model, options.variant),
      delivery: options.delivery || undefined,
    });
  } catch (error) {
    if (api === API_V2) clearPending(client.baseUrl, options.session);
    fail(error);
  }
  if (api === API_V2) recordPendingAdmission(client.baseUrl, options.session, result?.id);
  // A steer/queue admission is the whole result: print its id and let the
  // caller poll status/history. A normal submit stays quiet (the wait loop
  // owns stdout).
  if (options.delivery) {
    const data = result || {};
    console.log(`${options.delivery} admitted: id=${data.id || "?"}`);
  }
}

async function commandLast(options) {
  if (!options.session) usage("last needs --session <id>");
  const client = clientFrom(options);
  let directory = options.dir || undefined;
  try {
    const session = await getSessionWithFallback(client, options.session, directory);
    directory = session?.directory || directory;
  } catch {
    // messages() below reports the error
  }
  // The baseline must be a NORMALIZED message id: the follow/wait loops slice
  // the normalized transcript at it. Asking for a single newest message is not
  // enough — v2 can lead with non-conversation records (model-switched, ...)
  // that normalizeMessages drops, which used to yield an empty baseline and
  // let `send` mistake the session's OLD idle turn for the new one.
  const messages = await client.messages(options.session, { directory, limit: 50 }).catch(fail);
  const last = messages[messages.length - 1];
  if (last?.id) console.log(last.id);
}

async function commandWhere(options) {
  if (!options.session) usage("where needs --session <id>");
  const client = clientFrom(options);
  const session = await getSessionWithFallback(client, options.session, options.dir || undefined).catch(fail);
  const directory = session?.directory || "";
  if (options.json) console.log(JSON.stringify({ id: options.session, directory }));
  else console.log(directory);
}

async function commandInterrupt(options) {
  if (!options.session) usage("interrupt needs --session <id>");
  const client = clientFrom(options);
  await client.interruptSession(options.session, { directory: options.dir || undefined }).catch(fail);
  console.log(`interrupted ${options.session}`);
}

// ---------------------------------------------------------------------------
// wait (v2 blocking equivalent of the dispatcher's v1 await loop)
// ---------------------------------------------------------------------------

async function commandWait(options) {
  if (!options.session) usage("wait needs --session <id>");
  const client = clientFrom(options);
  const probe = await client.resolveApi().catch(fail);
  if (probe !== API_V2) {
    console.error("oc-api: wait requires a v2 server (the dispatcher polls v1 directly)");
    process.exit(EXIT.USAGE);
  }
  let session;
  try {
    session = await client.getSession(options.session, { directory: options.dir || undefined });
  } catch (error) {
    if (error instanceof OpenCodeServerError && error.status === 404 && options.dir) {
      session = await client.getSession(options.session).catch(fail);
    } else {
      fail(error);
    }
  }
  const directory = session?.directory || options.dir || undefined;
  const timeout = options.timeoutSet ? options.timeout : 0;
  const deadline = timeout > 0 ? Date.now() + timeout * 1000 : 0;
  const stall = options.stall || 0;
  const minMessages = options.minMessages || 2;
  const toolName = options.toolName || "opencode-dispatch.sh";
  const label = options.mode ? `[${options.mode}]` : "";
  const after = options.after || "";
  const fetchWindow = async () => {
    const page = await client.messagesPage(options.session, { directory, limit: 50, order: "desc" });
    return [...page.messages].reverse();
  };
  // `send` on an existing session must ignore the turn that was already
  // finished when it submitted. `after` is the newest message id at submit
  // time; everything up to and including it is history.
  const turnMessages = (messages) => {
    if (!after) return messages;
    const index = messages.findIndex((message) => message.id === after);
    return index === -1 ? messages : messages.slice(index + 1);
  };
  const lastMessageOf = (messages) => messages[messages.length - 1] || null;
  const activity = (messages) => {
    let newest = 0;
    for (const message of messages) {
      for (const value of [message.created, message.completed]) {
        if (typeof value === "number" && value > newest) newest = value;
      }
      for (const part of message.parts || []) {
        for (const value of [part.startedAt, part.completedAt]) {
          if (typeof value === "number" && value > newest) newest = value;
        }
      }
    }
    return newest;
  };
  const isWorking = (messages) => {
    const last = lastMessageOf(messages);
    if (!last) return true; // the submitted turn has not landed yet
    if (last.role === "user") return true;
    return last.role === "assistant" && !last.completed;
  };
  const isDone = (messages) => {
    if (messages.length < minMessages) return false;
    const last = lastMessageOf(messages);
    if (!last) return false;
    if (last.role === "idle") return true;
    return last.role === "assistant" && Boolean(last.completed);
  };
  const turnError = (messages) => {
    const last = lastMessageOf(messages);
    if (!last) return null;
    if (last.error) return last.error;
    if (last.role === "idle" && last.outcome && last.outcome !== "succeeded") {
      return { status: null, message: last.outcome };
    }
    return null;
  };
  const runningTool = (messages) => {
    const last = lastMessageOf(messages);
    if (!last || !Array.isArray(last.parts)) return null;
    for (let index = last.parts.length - 1; index >= 0; index -= 1) {
      const part = last.parts[index];
      if (part.kind === "tool" && part.status === "running" && !part.completedAt) return part;
    }
    return null;
  };
  const questionHeader = (tool) => {
    const question = tool?.input?.questions?.[0];
    return question
      ? String(question.header || question.question || "").replace(/\s+/g, "_").slice(0, 40)
      : "";
  };
  const findAsk = async () => {
    const api = await client.resolveApi();
    const scope = { directory };
    const raw = [
      ...(await client.listPermissionRequests(scope).catch(() => [])),
      ...(await client.listQuestionRequests(scope).catch(() => [])),
    ];
    for (const item of raw) {
      const ask = normalizeAsk(item, api);
      if (ask && ask.sessionID === options.session) return ask;
    }
    return null;
  };
  const printFinal = (messages) => {
    const assistant = [...messages].reverse().find((message) => message.role === "assistant");
    const error = assistant?.error || turnError(messages);
    if (error) {
      const detail = `ERROR ${error.status ?? ""} ${error.message || ""}`.replace(/\s+/g, " ").trim();
      console.error(detail);
    } else {
      const text = (assistant?.parts || [])
        .filter((part) => part.kind === "text" && part.text)
        .map((part) => part.text)
        .join("\n")
        .trim();
      console.log(text);
    }
    console.error(`(session: ${options.session})`);
  };

  let prevMx = null;
  let lastChange = Date.now();
  let lastBeat = 0;
  let prevAskKey = "";
  let fails = 0;
  for (;;) {
    let messages;
    try {
      messages = await fetchWindow();
      fails = 0;
    } catch (error) {
      if (error instanceof OpenCodeServerError && error.status === 404) {
        console.error(`oc-api: session not found: ${options.session}`);
        process.exit(EXIT.NOT_FOUND);
      }
      fails += 1;
      if (fails >= 20) {
        console.error(`${label ? `${label} ` : ""}server unreachable for ~40s; giving up on ${options.session} (may still be running server-side).`);
        process.exit(EXIT.UNREACHABLE);
      }
      await sleep(2000);
      continue;
    }
    const turn = turnMessages(messages);
    const now = Date.now();
    // A completed assistant message is only one finished STEP. On v2 the turn
    // can still be running (a tool call or the next model step), so completion
    // additionally requires /api/session/active to no longer list the session.
    // `null` means that endpoint is unavailable: keep the message heuristic.
    const running = await sessionRunning(client, options.session);
    const pending = pendingOutstanding(client.baseUrl, options.session, turn);
    if ((turnError(turn) || isDone(turn)) && !pending && running !== true) {
      printFinal(turn);
      process.exit(EXIT.OK);
    }
    const working = running === null ? isWorking(turn) : running;
    const newest = activity(turn);
    if (prevMx === null || newest !== prevMx) {
      prevMx = newest;
      lastChange = now;
    }
    const tool = runningTool(turn);
    let ask = null;
    if (working) {
      ask = await findAsk();
      if (!ask && tool && tool.name === "question") {
        ask = {
          kind: "question",
          id: "que_stream",
          action: "question",
          resources: "",
          title: questionHeader(tool) || "?",
        };
      }
    }
    const askKey = ask ? `${ask.kind}:${ask.id}` : "";
    if (askKey && askKey !== prevAskKey) {
      console.error(`${label} ${options.session} PARKED on an ask (request ${ask.id}${ask.kind === "question" ? " [question]" : ""})`);
      console.error(`        abort: ${toolName} abort ${options.session}`);
      prevAskKey = askKey;
      lastBeat = now;
    } else if (!askKey && prevAskKey) {
      console.error(`${label} ${options.session} ask resolved — resuming.`);
      prevAskKey = "";
      lastBeat = now;
    }
    // Heartbeat every ~30s. It names the state, message count, idle seconds,
    // and either the parked ask or the running tool (the v1 loop's format).
    if (now - lastBeat >= 30_000) {
      const idle = Math.max(0, Math.floor((now - lastChange) / 1000));
      let state;
      let detail = "";
      if (ask) {
        state = `parked on ask [${ask.id}]`;
        detail = ask.kind === "question" ? ask.title : [ask.action, ask.resources].filter(Boolean).join(" ");
      } else if (working) {
        state = "working";
        if (tool) detail = `tool ${tool.name} ${Math.max(0, Math.floor((now - (tool.startedAt || now)) / 1000))}s`;
      } else {
        state = "waiting";
      }
      console.error(`${state} · ${turn.length} msgs · ${idle}s idle${detail ? ` · ${detail}` : ""}`);
      lastBeat = now;
    }
    if (stall > 0 && now - lastChange >= stall * 1000) {
      if (ask) {
        console.error(`${label} session ${options.session} STALLED: parked on an ask for ${stall}s (request ${ask.id}).`);
        console.error(`abort: ${toolName} abort ${options.session}`);
      } else {
        console.error(`${label} session ${options.session} STALLED: no activity for ${stall}s (likely a hung turn); giving up.`);
        console.error(`watch: ${toolName} status ${options.session}   |   abort: ${toolName} abort ${options.session}`);
      }
      process.exit(EXIT.STALL);
    }
    if (deadline && now >= deadline) {
      if (ask) {
        console.error(`${label} session ${options.session} still running after ${timeout}s (parked on an ask: ${ask.id}).`);
      } else {
        console.error(`${label} session ${options.session} still running after ${timeout}s; exiting non-zero (still running server-side).`);
        console.error(`watch: ${toolName} status ${options.session}`);
      }
      process.exit(EXIT.TIMEOUT);
    }
    const remaining = deadline ? Math.max(250, deadline - Date.now()) : 2000;
    await sleep(Math.min(2000, remaining));
  }
}

// ---------------------------------------------------------------------------
// follow (v2 event-driven; the v1 path stays in the dispatcher)
// ---------------------------------------------------------------------------

async function commandFollow(options) {
  if (!options.session) usage("follow needs --session <id>");
  const client = clientFrom(options);
  const probe = await client.resolveApi().catch(fail);
  if (probe !== API_V2) {
    console.error("oc-api: follow via oc-api requires a v2 server (the dispatcher polls v1 directly)");
    process.exit(EXIT.USAGE);
  }
  let session;
  try {
    session = await client.getSession(options.session, { directory: options.dir || undefined });
  } catch (error) {
    // A direct session id may live outside the caller's --dir; retry unscoped
    // before declaring it missing.
    if (options.dir) {
      try {
        session = await client.getSession(options.session);
      } catch {
        console.error(`oc-api: session not found: ${options.session}`);
        process.exit(EXIT.NOT_FOUND);
      }
    } else {
      console.error(`oc-api: session not found: ${options.session}`);
      process.exit(EXIT.NOT_FOUND);
    }
  }
  const directory = session.directory || options.dir || undefined;
  const timeout = options.timeoutSet ? options.timeout : 0;
  const deadline = timeout > 0 ? Date.now() + timeout * 1000 : 0;
  const after = options.after || "";
  console.log(`${options.mode ? `[${options.mode}] ` : ""}following ${options.session} (read-only; Ctrl-C to detach)`);

  // messageId -> Map(partIndex -> { chars, noted }). v2 mutates a streaming
  // text part in place, so part count is not enough: track the emitted
  // character count and write only the delta.
  const printed = new Map();
  const noticed = new Set();
  let first = true;
  let atLineStart = true;
  // The text part that owns the currently open output line, if any.
  let openPart = null;

  const write = (text) => {
    if (!text) return;
    process.stdout.write(text);
    atLineStart = text.endsWith("\n");
  };
  const endLine = () => {
    if (!atLineStart) {
      process.stdout.write("\n");
      atLineStart = true;
    }
  };
  const note = (line) => {
    endLine();
    console.log(line);
    openPart = null;
  };
  const closeIfOpen = (message) => {
    if (openPart && openPart.messageId === message.id) {
      endLine();
      openPart = null;
    }
  };

  // `send` on an existing session: ignore the turn that was already finished
  // at submit time. The user prompt is not echoed (v1 follow prints only the
  // reply); `send` is the only caller that sets --after.
  const turnMessages = (messages) => {
    if (!after) return messages;
    const index = messages.findIndex((message) => message.id === after);
    return index === -1 ? messages : messages.slice(index + 1);
  };
  const printNew = (messages) => {
    for (const message of messages) {
      if (message.role === "idle") continue;
      if (after && message.role === "user") continue;
      let seen = printed.get(message.id);
      if (!seen) {
        seen = new Map();
        printed.set(message.id, seen);
      }
      const parts = message.parts || [];
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        const state = seen.get(index) || { chars: 0, noted: false };
        if (part.kind === "text") {
          const text = part.text || "";
          if (text.length > state.chars) {
            // A different text part starts its own line (matches the old
            // per-part output), including a part that arrived empty and grew.
            if (!openPart || openPart.messageId !== message.id || openPart.index !== index) {
              endLine();
              openPart = { messageId: message.id, index };
            }
            write(text.slice(state.chars));
            state.chars = text.length;
          }
        } else if (part.kind === "reasoning") {
          if (!state.noted) {
            if (!first && part.text) note(`· ${part.text.split("\n")[0].slice(0, 120)}`);
            // Mark historical reasoning even when suppressed, or the next
            // frame treats it as new and splits the stream.
            state.noted = true;
          }
        } else if (part.kind === "tool" && part.status === "running" && !state.noted) {
          note(`(tool: ${part.name} running)`);
          state.noted = true;
        }
        seen.set(index, state);
      }
      // Close the line on completion even when this frame added no text. The
      // per-message owner check keeps an earlier (already-printed) message from
      // closing a newer message's still-open stream.
      if (message.completed || message.role === "user") closeIfOpen(message);
    }
    first = false;
  };

  const reportAsks = async () => {
    try {
      const asks = await collectAsks(client, { directory });
      for (const ask of asks) {
        if (ask.sessionID !== options.session || noticed.has(ask.id)) continue;
        noticed.add(ask.id);
        if (ask.kind === "permission") {
          console.log(`(parked: permission ask ${ask.id} — ${ask.action} ${ask.resources})`);
        } else {
          console.log(`(parked: question ask ${ask.id} — waiting on a human)`);
        }
      }
    } catch {
      // ask reporting is best-effort; never fail the follow over it
    }
  };

  const fetchWindow = async () => {
    const page = await client.messagesPage(options.session, { directory, limit: 50, order: "desc" });
    return [...page.messages].reverse();
  };

  // Initial frame: print the transcript as it stands, then subscribe.
  const isDone = (messages) => {
    const last = messages[messages.length - 1];
    if (!last) return false;
    if (last.role === "idle") return true;
    return last.role === "assistant" && Boolean(last.completed);
  };
  // A completed assistant message is only one finished STEP on v2: the turn
  // may continue with a tool call or another model step. Only the active
  // session map can say the TURN is over. A null answer (endpoint unavailable)
  // preserves the old message-only behaviour. A pending send marker also keeps
  // follow open: the new user message may not have landed yet.
  const turnFinished = async (messages) => {
    if (pendingOutstanding(client.baseUrl, options.session, messages)) return false;
    return (await sessionRunning(client, options.session)) !== true;
  };
  const finish = (messages) => {
    endLine();
    const last = messages[messages.length - 1];
    const unsettled = last?.role === "idle" && (last.error || (last.outcome && last.outcome !== "succeeded"));
    if (unsettled) {
      const label = last.error || last.outcome === "failed" ? "failed" : last.outcome;
      const detail = last.error ? `: ${last.error.type || "error"} ${last.error.message || ""}`.trimEnd() : "";
      console.log(`(${label} — ${options.session} turn ${label}${detail})`);
    } else {
      console.log(`(done — ${options.session} completed)`);
    }
    process.exit(EXIT.OK);
  };
  try {
    const messages = await fetchWindow();
    const turn = turnMessages(messages);
    printNew(turn);
    await reportAsks();
    if (isDone(turn) && (await turnFinished(turn))) finish(turn);
  } catch {
    console.error(`oc-api: could not read session ${options.session}`);
    process.exit(EXIT.UNREACHABLE);
  }

  // Event subscription: wakes the fetch loop. The stream is live-only, so a
  // dead stream degrades to the same cadence as the v1 polling loop.
  let pending = [];
  let streamDead = false;
  const controller = new AbortController();
  const watch = (async () => {
    try {
      for await (const event of client.eventStream({ signal: controller.signal })) {
        const sessionID = event?.data?.sessionID;
        if (sessionID === options.session || (sessionID === undefined && String(event?.type || "").startsWith("session."))) {
          pending.push(event);
        }
      }
    } catch {
      // handled below
    }
    if (!controller.signal.aborted) streamDead = true;
  })();
  void watch;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const timeoutExit = () => {
    console.log(`(timeout after ${timeout}s — session still running; follow again or watch: ${client.baseUrl})`);
    process.exit(EXIT.TIMEOUT);
  };

  for (;;) {
    if (pending.length > 0) {
      pending = [];
    } else {
      // Wait for an event, the 10s safety poll, or the deadline.
      const remaining = deadline ? deadline - Date.now() : Infinity;
      if (remaining <= 0) timeoutExit();
      const waitMs = Math.min(remaining, 10_000);
      const started = Date.now();
      while (pending.length === 0 && Date.now() - started < waitMs) await sleep(250);
      if (pending.length === 0 && deadline && Date.now() >= deadline) timeoutExit();
    }
    try {
      const messages = await fetchWindow();
      const turn = turnMessages(messages);
      printNew(turn);
      await reportAsks();
      if (isDone(turn) && (await turnFinished(turn))) finish(turn);
    } catch {
      // transient fetch failure; keep waiting
    }
    if (streamDead) await sleep(1000);
  }
}

// ---------------------------------------------------------------------------
// watch (v2 events gate for `status --follow`)
// ---------------------------------------------------------------------------

async function commandWatch(options) {
  const client = clientFrom(options);
  const probe = await client.resolveApi().catch(fail);
  if (probe !== API_V2) {
    console.error("oc-api: watch requires a v2 server");
    process.exit(EXIT.USAGE);
  }
  const timeout = options.timeoutSet ? options.timeout : 0;
  const deadline = timeout > 0 ? Date.now() + timeout * 1000 : 0;

  const sessionIdle = async () => {
    if (!options.session) return false;
    // v2's turn-level signal: a completed assistant message can still be the
    // middle of a turn. With no active turn, an incomplete assistant step still
    // means the turn is not settled; a fresh session (no transcript) or a
    // submitted-but-not-started prompt is not done either. Failed/interrupted
    // turns are settled (the caller re-reads status and reacts to the state).
    const running = await sessionRunning(client, options.session);
    const last = await lastMessage(client, options.session, options.dir || undefined);
    const pending = pendingOutstanding(client.baseUrl, options.session, last ? [last] : []);
    const partialStep = last?.role === "assistant" && !last.completed;
    if (running === true || partialStep || pending) return false;
    const settled = inactiveState(last);
    return settled !== "initializing" && settled !== "pending";
  };

  if (options.session && (await sessionIdle().catch(() => false))) {
    process.exit(EXIT.OK);
  }

  const controller = new AbortController();
  let streamDead = false;
  let change = false;
  const relevant = (event) => {
    if (!options.session) return true;
    const sessionID = event?.data?.sessionID;
    if (sessionID === options.session) return true;
    return sessionID === undefined && String(event?.type || "").startsWith("session.");
  };
  const watcher = (async () => {
    try {
      for await (const event of client.eventStream({ signal: controller.signal })) {
        if (relevant(event)) {
          change = true;
          return;
        }
      }
      streamDead = true;
    } catch {
      streamDead = true;
    }
  })();
  void watcher;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let lastCheck = Date.now();
  for (;;) {
    if (deadline && Date.now() >= deadline) process.exit(EXIT.TIMEOUT);
    if (change) {
      change = false;
      if (options.session && (await sessionIdle().catch(() => false))) process.exit(EXIT.OK);
      process.exit(EXIT.CHANGE);
    }
    // Safety net: even with a dead or silent stream, re-check state every 10s
    // (session-scoped) so a missed terminal event cannot hang the caller.
    if (Date.now() - lastCheck >= 10_000) {
      lastCheck = Date.now();
      if (options.session && (await sessionIdle().catch(() => false))) process.exit(EXIT.OK);
      if (streamDead && !options.session) {
        // Without a session there is nothing to poll; surface the stream loss.
        console.error("oc-api: event stream lost");
        process.exit(EXIT.UNREACHABLE);
      }
    }
    await sleep(150);
  }
}

// ---------------------------------------------------------------------------
// ask
// ---------------------------------------------------------------------------

async function commandAsk(options) {
  const client = clientFrom(options);
  const asks = await collectAsks(client, { directory: options.dir || undefined }).catch(fail);
  const filtered = options.session ? asks.filter((ask) => ask.sessionID === options.session) : asks;
  if (options.json) {
    console.log(JSON.stringify(filtered.map((ask) => ({
      kind: ask.kind,
      id: ask.id,
      sessionID: ask.sessionID,
      action: ask.action,
      resources: ask.resources,
      title: ask.title,
    })), null, 2));
    return;
  }
  if (filtered.length === 0) {
    console.log("no pending asks");
    return;
  }
  for (const ask of filtered) {
    console.log(`${ask.kind === "permission" ? "permission" : "question"}  ${ask.id}`);
    console.log(`  session:  ${ask.sessionID}`);
    console.log(`  action:   ${ask.action}${ask.resources ? ` ${ask.resources}` : ""}`);
    if (ask.kind === "question") console.log(`  question: ${ask.title}`);
    console.log("");
  }
}

// ---------------------------------------------------------------------------
// permissions / allow (v1 and v2)
// ---------------------------------------------------------------------------

async function commandPermissions(options) {
  const client = clientFrom(options);
  const asks = await collectAsks(client, { directory: options.dir || undefined }).catch(fail);
  const pending = asks.filter((ask) => ask.kind === "permission");
  if (pending.length === 0) {
    console.log("no pending permission requests");
    return;
  }
  for (const ask of pending) {
    const raw = ask.request || {};
    console.log(ask.id);
    console.log(`  permission: ${ask.action || "?"}`);
    console.log(`  patterns:   ${ask.resources || "(none)"}`);
    console.log(`  session:    ${ask.sessionID || "?"}`);
    const tool = raw.tool;
    if (tool) {
      console.log(`  tool:       ${typeof tool === "string" ? tool : tool.callID || JSON.stringify(tool)}`);
    } else if (raw.source?.type === "tool" && raw.source.id) {
      console.log(`  tool:       ${raw.source.id}`);
    }
    if (raw.metadata?.command) console.log(`  command:    ${String(raw.metadata.command).slice(0, 200)}`);
    if (raw.metadata?.title) console.log(`  title:      ${raw.metadata.title}`);
    if (raw.message) console.log(`  message:    ${String(raw.message).slice(0, 200)}`);
    console.log("");
  }
  console.log(`approve with: ${options.toolName} allow <requestID> [--always]`);
}

async function commandAllow(options) {
  if (!options.request) usage("allow needs --request <id>");
  const client = clientFrom(options);
  const asks = await collectAsks(client, { directory: options.dir || undefined }).catch(fail);
  const ask = asks.find((entry) => entry.kind === "permission" && entry.id === options.request);
  if (!ask) {
    console.error(`oc-api: permission request not found or already answered: ${options.request}`);
    const pending = asks.filter((entry) => entry.kind === "permission");
    if (pending.length === 0) {
      console.error("  no pending permission requests on this server");
    } else {
      console.error("  pending permission requests:");
      for (const entry of pending) {
        console.error(`    ${entry.id}  ${entry.action} ${entry.resources}  (${entry.sessionID})`);
      }
    }
    process.exit(EXIT.NOT_FOUND);
  }
  const reply = options.always ? "always" : "once";
  try {
    await client.replyPermissionRequest({
      sessionId: ask.sessionID,
      requestId: ask.id,
      directory: ask.directory || options.dir || undefined,
      reply,
    });
  } catch (error) {
    if (error instanceof OpenCodeServerError) {
      console.error(`oc-api: reply to ${ask.id} failed: ${error.message}`);
      process.exit(error.status === 404 ? EXIT.NOT_FOUND : EXIT.UNREACHABLE);
    }
    throw error;
  }
  console.log(`allowed ${ask.id} (${reply})`);
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

async function commandDelete(options) {
  if (!options.session) usage("delete needs --session <id>");
  const client = clientFrom(options);
  let directory = options.dir || undefined;
  let session = null;
  try {
    session = await client.getSession(options.session, { directory });
  } catch (error) {
    if (!(error instanceof OpenCodeServerError) || error.status !== 404) throw error;
  }
  if (!session) {
    // A 404 may mean the session is already gone, or that the supplied --dir
    // scoped the lookup to the wrong instance. List before declaring success;
    // a list failure (auth, unreachable) is an error, not "already gone".
    let sessions;
    try {
      sessions = await client.listSessions({});
    } catch (error) {
      if (!(error instanceof OpenCodeServerError) || error.status !== 404) throw error;
      sessions = [];
    }
    session = sessions.find((item) => item.id === options.session) || null;
  }
  if (!session) {
    if (options.json) console.log(JSON.stringify({ id: options.session, deleted: false, missing: true }));
    else console.log(`already gone ${options.session}`);
    return;
  }
  directory = session.directory || directory;
  // Mirror agent-cleanup: stop a live turn before deleting. An idle session
  // rejects the interrupt, which is harmless.
  await client.abortSession(options.session, { directory }).catch(() => {});
  try {
    await client.deleteSession(options.session, { directory });
  } catch (error) {
    // A concurrent cascade may remove it between the lookup and the delete.
    if (!(error instanceof OpenCodeServerError) || error.status !== 404) throw error;
    if (options.json) console.log(JSON.stringify({ id: options.session, deleted: false, missing: true }));
    else console.log(`already gone ${options.session}`);
    return;
  }
  if (options.json) console.log(JSON.stringify({ id: options.session, deleted: true }));
  else console.log(`deleted ${options.session}`);
}

// ---------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help || !COMMANDS.has(options.command)) usage(options.command ? undefined : "a command is required");
  switch (options.command) {
    case "detect": return commandDetect(options);
    case "version": return commandVersion(options);
    case "sessions": return commandSessions(options);
    case "status": return commandStatus(options);
    case "history": return commandHistory(options);
    case "follow": return commandFollow(options);
    case "wait": return commandWait(options);
    case "create": return commandCreate(options);
    case "submit": return commandSubmit(options);
    case "last": return commandLast(options);
    case "where": return commandWhere(options);
    case "interrupt": return commandInterrupt(options);
    case "watch": return commandWatch(options);
    case "ask": return commandAsk(options);
    case "permissions": return commandPermissions(options);
    case "allow": return commandAllow(options);
    case "delete": return commandDelete(options);
    default: usage(`unknown command: ${options.command}`);
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof OpenCodeServerError) fail(error);
  console.error(`oc-api: ${error?.message || String(error)}`);
  process.exit(1);
}
