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
 *   watch     Wait for a session to change or go idle (v2 events; used by
 *             `status --follow` as its gate). Exit 0 idle, 10 change,
 *             3 timeout, 7 unreachable. Without --session: any change.
 *   ask       List pending permission/question(form) asks.
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
 *   --tool-name <name>    Dispatcher name embedded in action hints
 *   --json                Machine-readable output where applicable
 *
 * Exit codes: 0 ok, 2 usage, 3 timeout, 5 not found, 7 unreachable,
 *             10 change (watch).
 */

import { execFileSync } from "node:child_process";

import { API_V1, API_V2, clientVersion, pairingStatus, probeServer } from "./api-dialect.mjs";
import { OpenCodeClient, OpenCodeServerError, normalizeAsk } from "./opencode-server.mjs";

const EXIT = { OK: 0, USAGE: 2, TIMEOUT: 3, NOT_FOUND: 5, UNREACHABLE: 7, CHANGE: 10 };

const COMMANDS = new Set(["detect", "version", "sessions", "status", "history", "follow", "watch", "ask"]);

function usage(message) {
  if (message) console.error(`oc-api: ${message}`);
  console.error("usage: node scripts/oc-api.mjs <detect|version|sessions|status|history|follow|watch|ask> [flags]");
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
    else if (arg === "--json") options.json = true;
    else usage(`unknown argument: ${arg}`);
  }
  if (options.api && !["auto", API_V1, API_V2].includes(options.api)) usage(`--api must be auto|v1|v2 (got: ${options.api})`);
  return options;
}

function clientFrom(options, { api } = {}) {
  return new OpenCodeClient({
    baseUrl: options.server || process.env.OPENCODE_SERVER_URL || "http://127.0.0.1:4096",
    username: options.username || process.env.OPENCODE_SERVER_USERNAME || "opencode",
    password: options.password || process.env.OPENCODE_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD,
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

/** Newest assistant message for a session, or null. */
async function lastMessage(client, sessionId, directory) {
  const page = await client.messagesPage(sessionId, { directory, limit: 1, order: "desc" });
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
 * Pending asks across every directory the server knows: the bare/default
 * location, the caller's --dir, and the directory of each known session
 * (mirrors the dispatcher's all_asks fanout). Individual failures are
 * tolerated; the result is deduplicated by kind+id.
 */
async function collectAsks(client, { directory } = {}) {
  const api = await client.resolveApi();
  const directories = new Set([""]);
  if (directory) directories.add(directory);
  try {
    const sessions = await client.listSessions({});
    for (const session of sessions.slice(0, 50)) {
      if (session.directory) directories.add(session.directory);
    }
  } catch {
    // session listing is a convenience for scope discovery; the bare query still works
  }
  const list = [...directories].slice(0, 25);
  const asks = new Map();
  await Promise.all(
    list.map(async (dir) => {
      const scope = dir ? { directory: dir } : {};
      try {
        for (const raw of await client.listPermissionRequests(scope)) {
          const ask = normalizeAsk(raw, api);
          if (ask) asks.set(`${ask.kind}:${ask.id}`, ask);
        }
      } catch {
        // a scope that rejects the query is skipped, not fatal
      }
      try {
        for (const raw of await client.listQuestionRequests(scope)) {
          const ask = normalizeAsk(raw, api);
          if (ask) asks.set(`${ask.kind}:${ask.id}`, ask);
        }
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
  const probe = await probeServer({
    baseUrl: options.server || process.env.OPENCODE_SERVER_URL || "http://127.0.0.1:4096",
    username: options.username || process.env.OPENCODE_SERVER_USERNAME || "opencode",
    password: options.password || process.env.OPENCODE_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD,
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
  let last = null;
  let messageCount = null;
  let more = false;
  if (api === API_V2) {
    const page = await client.messagesPage(sessionId, { directory: session.directory || options.dir, limit: 50, order: "desc" });
    messageCount = page.messages.length;
    // v2 always returns a continuable cursor, so "more" is a window heuristic:
    // a full page means older messages may exist beyond it.
    more = page.messages.length >= 50;
    last = page.messages.reduce((a, b) => (!a || (b.created || 0) >= (a.created || 0) ? b : a), null);
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
  const working = messageWorking(last);
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
    state = `WORKING — TOOL RUNNING (${tool.name} · ${duration}, no ask in queue — likely parked on a lost prompt or a dead turn; abort if it never finishes)`;
  } else if (stale) {
    state = `WORKING — STALE (${fmtAge(idle)} without activity; likely a dead turn — try ${options.toolName} abort ${session.id})`;
  } else {
    state = working ? "WORKING (turn in progress)" : "idle";
  }
  console.log(`state:    ${state}`);
  if (last?.error) {
    console.log(`lastError: ${last.error.type || "?"} ${last.error.status || ""} ${last.error.message || ""}`);
  }
}

async function statusAll(client, options) {
  const sessions = await client.listSessions({ limit: options.limit }).catch(fail);
  const shown = sessions.slice(0, options.limit);
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
      try {
        const last = await lastMessage(client, session.id, session.directory);
        if (!messageWorking(last)) return "idle";
        const updated = normTime(session.time?.updated) || 0;
        const idle = now - updated;
        const tool = stuckTool(last);
        const duration = tool?.startedAt ? fmtAge(Math.max(0, now - tool.startedAt)) : "";
        const toolLabel = tool ? `(${tool.name}${duration ? `·${duration}` : ""})` : "";
        return `${idle > 30 * 60 * 1000 ? "STALE" : "WORKING"}${toolLabel}`;
      } catch {
        return "idle";
      }
    }),
  );
  let parkedCount = 0;
  let workingCount = 0;
  shown.forEach((session, index) => {
    const updated = normTime(session.time?.updated) || 0;
    const state = states[index];
    if (state === "PERMASK" || state === "QUESTION") parkedCount += 1;
    if (state.startsWith("WORKING")) workingCount += 1;
    const age = updated ? `${fmtAge(now - updated)} ago` : "?";
    console.log(`${session.id}  ${state.padEnd(14)}  ${age.padStart(12)}  ${session.title || ""}`);
  });
  if (parkedCount) console.log(`… ${parkedCount} session(s) parked on an ask (see: ${options.toolName} permissions / allow)`);
  if (workingCount) console.log(`… ${workingCount} session(s) working`);
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
  } catch {
    console.error(`oc-api: session not found: ${options.session}`);
    process.exit(EXIT.NOT_FOUND);
  }
  const directory = session.directory || options.dir || undefined;
  const timeout = options.timeoutSet ? options.timeout : 0;
  const deadline = timeout > 0 ? Date.now() + timeout * 1000 : 0;
  console.log(`following ${options.session} (read-only; Ctrl-C to detach)`);

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

  const printNew = (messages) => {
    for (const message of messages) {
      if (message.role === "idle") continue;
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
    printNew(messages);
    await reportAsks();
    if (isDone(messages)) finish(messages);
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
      printNew(messages);
      await reportAsks();
      if (isDone(messages)) finish(messages);
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
    const last = await lastMessage(client, options.session, options.dir || undefined);
    return !messageWorking(last);
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
    case "watch": return commandWatch(options);
    case "ask": return commandAsk(options);
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
