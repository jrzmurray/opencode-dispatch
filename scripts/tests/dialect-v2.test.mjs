import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  API_V1,
  API_V2,
  V1_MIN_VERSION,
  clientVersion,
  pairingStatus,
  parseVersion,
  probeServer,
  versionGeneration,
} from "../api-dialect.mjs";
import { OpenCodeClient, mapPermissionRules, normalizeMessages } from "../opencode-server.mjs";
import { buildWorkerArgs } from "../spawn-agent.mjs";

const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function scriptedFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(String(url));
    calls.push({
      method: options.method || "GET",
      pathname: parsed.pathname,
      search: parsed.search,
      headers: options.headers || {},
      body: options.body ? JSON.parse(options.body) : undefined,
    });
    return handler(parsed, options, calls.length);
  };
  return { fetchImpl, calls };
}

// ---------------------------------------------------------------------------
// detection + pairing
// ---------------------------------------------------------------------------

test("version parsing agrees with the v1 floor policy", () => {
  assert.deepEqual(parseVersion("opencode v2.0.32"), [2, 0, 32]);
  assert.deepEqual(parseVersion("1.18.29"), [1, 18, 29]);
  assert.equal(parseVersion("no version here"), null);
  assert.equal(versionGeneration([2, 0, 32]), 2);
  assert.equal(versionGeneration([1, 18, 29]), 1);
  assert.equal(versionGeneration(null), null);
  assert.deepEqual(V1_MIN_VERSION, [1, 18, 29]);

  const floor = V1_MIN_VERSION.join(".");
  assert.equal(pairingStatus({ api: API_V1, generation: 1, version: floor }).ok, true);
  const below = pairingStatus({ api: API_V1, generation: 1, version: "1.18.9" });
  assert.equal(below.ok, false);
  assert.match(below.reason, /below the supported v1 floor/);
  assert.equal(pairingStatus({ api: API_V2, generation: 2, version: "2.0.32" }).ok, true);
  assert.equal(pairingStatus({ api: API_V1, generation: 2, version: "2.0.32" }).severity, "mismatch");
  assert.equal(pairingStatus({ api: API_V2, generation: 1, version: "1.18.29" }).severity, "mismatch");
  assert.equal(pairingStatus({ api: API_V2, generation: null }).severity, "unknown");
  assert.equal(pairingStatus({ api: null }).severity, "unreachable");
});

test("probeServer classifies v2, v2-with-auth, v1, the v2 spa, and a dead server", async () => {
  const v2 = await probeServer({
    baseUrl: "http://127.0.0.1:4096",
    fetchImpl: async (url) => String(url).endsWith("/api/info")
      ? jsonResponse({ version: "2.0.32", pid: 7 })
      : jsonResponse([]),
  });
  assert.equal(v2.api, API_V2);
  assert.equal(v2.version, "2.0.32");
  assert.equal(v2.authOk, true);

  const v2auth = await probeServer({
    baseUrl: "http://127.0.0.1:4096",
    fetchImpl: async () => jsonResponse({ _tag: "UnauthorizedError" }, 401),
  });
  assert.equal(v2auth.api, API_V2);
  assert.equal(v2auth.authOk, false);

  const v1 = await probeServer({
    baseUrl: "http://127.0.0.1:4096",
    fetchImpl: async (url) => String(url).endsWith("/api/info") ? new Response("{}", { status: 404 }) : jsonResponse([]),
  });
  assert.equal(v1.api, API_V1);
  assert.equal(v1.authOk, true);

  const spa = await probeServer({
    baseUrl: "http://127.0.0.1:4096",
    fetchImpl: async (url) => String(url).endsWith("/api/info")
      ? new Response("{}", { status: 404 })
      : new Response("<!doctype html><html></html>", { status: 200, headers: { "content-type": "text/html" } }),
  });
  assert.equal(spa.api, API_V2);
  assert.equal(spa.authOk, false);
  assert.match(spa.detail, /web ui/);

  const down = await probeServer({
    baseUrl: "http://127.0.0.1:4096",
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.equal(down.api, null);
  assert.equal(down.serverUp, false);
});

test("clientVersion reads the binary generation", () => {
  const v2 = clientVersion("opencode", { execFileImpl: () => "2.0.32\n" });
  assert.equal(v2.version, "2.0.32");
  assert.equal(v2.generation, 2);
  const v1 = clientVersion("opencode-v1", { execFileImpl: () => "opencode v1.18.29" });
  assert.equal(v1.generation, 1);
  const missing = clientVersion("nope", { execFileImpl: () => { throw new Error("ENOENT"); } });
  assert.equal(missing.generation, null);
  assert.match(missing.error, /ENOENT/);
});

// ---------------------------------------------------------------------------
// v2 adapter
// ---------------------------------------------------------------------------

test("v2 createSession uses location, renamed permission rules, and normalizes the reply", async () => {
  const { fetchImpl, calls } = scriptedFetch(() => jsonResponse({ data: { id: "ses_test", location: { directory: "/tmp/worker" } } }));
  const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", api: API_V2, fetchImpl });
  const session = await client.createSession({
    directory: "/tmp/worker",
    title: "test",
    agent: "auto",
    model: { providerID: "deepseek", id: "deepseek-v4-pro", variant: "high" },
    permission: [
      { permission: "edit", pattern: "**", action: "allow" },
      { permission: "bash", pattern: "**", action: "allow" },
    ],
  });
  assert.equal(session.id, "ses_test");
  assert.equal(session.directory, "/tmp/worker");
  assert.equal(session.api, API_V2);
  assert.equal(calls[0].pathname, "/api/session");
  assert.deepEqual(calls[0].body, {
    title: "test",
    agent: "auto",
    model: { providerID: "deepseek", id: "deepseek-v4-pro", variant: "high" },
    location: { directory: "/tmp/worker" },
    permissions: [
      { action: "edit", resource: "**", effect: "allow" },
      { action: "shell", resource: "**", effect: "allow" },
    ],
  });
  assert.equal(mapPermissionRules([{ permission: "task", pattern: "*", action: "deny" }], API_V2)[0].action, "subagent");
});

test("v2 lookups carry the location header and unwrap {data}", async () => {
  const { fetchImpl, calls } = scriptedFetch((parsed) => {
    if (parsed.pathname === "/api/session/ses_1") return jsonResponse({ data: { id: "ses_1", location: { directory: "/tmp/one" } } });
    if (parsed.pathname === "/api/session") return jsonResponse({ data: [{ id: "ses_1", location: { directory: "/tmp/one" } }] });
    return jsonResponse({ data: [] });
  });
  const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", api: API_V2, fetchImpl });
  const session = await client.getSession("ses_1", { directory: "/tmp/one" });
  assert.equal(session.directory, "/tmp/one");
  assert.equal(calls[0].headers["x-opencode-directory"], "%2Ftmp%2Fone");
  const list = await client.listSessions({ directory: "/tmp/one" });
  assert.equal(list.length, 1);
  assert.equal(list[0].directory, "/tmp/one");
});

test("v2 turn control uses interrupt, prompt, wait, and session-scoped permission replies", async () => {
  const { fetchImpl, calls } = scriptedFetch((parsed) => {
    if (parsed.pathname.endsWith("/interrupt")) return jsonResponse({ interrupted: true });
    if (parsed.pathname.endsWith("/prompt")) return jsonResponse({ data: { id: "msg_new" } });
    if (parsed.pathname.endsWith("/wait")) return new Response("", { status: 200 });
    if (parsed.pathname.includes("/permission/")) return jsonResponse({ ok: true });
    return jsonResponse({ data: {} });
  });
  const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", api: API_V2, fetchImpl });
  await client.abortSession("ses_1", { directory: "/tmp/one" });
  assert.equal(calls.at(-1).pathname, "/api/session/ses_1/interrupt");

  await client.promptAsync("ses_1", { text: "hello" });
  assert.equal(calls.at(-1).pathname, "/api/session/ses_1/prompt");
  assert.deepEqual(calls.at(-1).body, { text: "hello" });

  await client.waitTurn("ses_1", { timeoutMs: 1000 });
  assert.equal(calls.at(-1).pathname, "/api/experimental/session/ses_1/wait");

  await client.replyPermissionRequest({ sessionId: "ses_1", requestId: "per_x", reply: "always" });
  assert.equal(calls.at(-1).pathname, "/api/session/ses_1/permission/per_x/reply");
  assert.deepEqual(calls.at(-1).body, { decision: "always" });
});

test("v2 messages unwrap pages and normalize content parts; v1 items normalize too", async () => {
  const { fetchImpl } = scriptedFetch(() => jsonResponse({
    data: [
      { id: "msg_a", type: "assistant", time: { created: 1790000002000, completed: 1790000002100 }, content: [
        { type: "text", text: "done" },
        { type: "tool", id: "tool_1", name: "bash", executed: true, state: { status: "running", input: {} }, time: { created: 1790000002010, ran: 1790000002020 } },
      ] },
      { id: "msg_u", type: "user", time: { created: 1790000001000 }, text: "do it" },
      { id: "msg_idle", type: "idle", time: { created: 1790000002200 } },
    ],
    cursor: { previous: null, next: "older" },
  }));
  const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", api: API_V2, fetchImpl });
  const page = await client.messagesPage("ses_1", { limit: 3, order: "desc" });
  assert.equal(page.cursor.next, "older");
  assert.deepEqual(page.messages.map((message) => message.role), ["assistant", "user"]);
  assert.equal(page.messages[0].text, "done");
  assert.equal(page.messages[0].completed, 1790000002100);
  assert.equal(page.messages[0].parts[1].kind, "tool");
  assert.equal(page.messages[0].parts[1].startedAt, 1790000002020);
  assert.equal(page.messages[1].text, "do it");

  const v1 = normalizeMessages([{
    info: { id: "msg_1", role: "assistant", time: { created: 1790000001000, completed: 1790000001100 } },
    parts: [{ type: "text", text: "v1 done" }, { type: "tool", tool: "bash", state: { status: "running", time: { start: 1790000001050 }, input: {} } }],
  }], API_V1);
  assert.equal(v1[0].text, "v1 done");
  assert.equal(v1[0].completed, 1790000001100);
  assert.equal(v1[0].parts[1].startedAt, 1790000001050);
});

test("the v2 event stream parses SSE frames and ignores heartbeats", async () => {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(": heartbeat\n\n"));
      controller.enqueue(encoder.encode('data: {"id":"evt_1","type":"session.created","data":{"sessionID":"ses_1"}}\n\n'));
      controller.enqueue(encoder.encode('data: {"id":"evt_2","type":"session.execution.succeeded","data":{"sessionID":"ses_1"}}\n\n'));
      controller.close();
    },
  });
  const client = new OpenCodeClient({
    baseUrl: "http://127.0.0.1:4096",
    api: API_V2,
    fetchImpl: async () => new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
  });
  const events = [];
  for await (const event of client.eventStream()) events.push(event);
  assert.deepEqual(events.map((event) => event.type), ["session.created", "session.execution.succeeded"]);
  assert.equal(events[0].data.sessionID, "ses_1");
});

test("v2 worker launches use --server and the joined model variant", () => {
  const args = buildWorkerArgs(
    { agent: "auto", model: "deepseek/deepseek-v4-pro", variant: "high", promptText: "do work" },
    { serverUrl: "http://127.0.0.1:4096", worktreePath: "/tmp/worker", sessionId: "ses_x", api: API_V2 },
  );
  assert.deepEqual(args, [
    "run", "--server", "http://127.0.0.1:4096", "--session", "ses_x", "--auto",
    "--agent", "auto", "--model", "deepseek/deepseek-v4-pro#high", "--", "do work",
  ]);
  assert.equal(args.includes("--dir"), false);
});

// ---------------------------------------------------------------------------
// oc-api CLI (against a v2 HTTP server)
// ---------------------------------------------------------------------------

function v2Server() {
  const sessions = [
    { id: "ses_a", title: "alpha", time: { created: 1000, updated: 2000 }, cost: 0.5, model: { providerID: "deepseek", id: "deepseek-v4-flash" }, location: { directory: "/tmp/a" } },
    { id: "ses_b", title: "beta", time: { created: 1000, updated: 3000 }, location: { directory: "/tmp/b" } },
  ];
  const messages = {
    ses_a: [
      { id: "msg_a", type: "assistant", time: { created: 1500, completed: 1600 }, content: [{ type: "text", text: "done the thing" }] },
      { id: "msg_u", type: "user", time: { created: 1000 }, text: "do the thing" },
    ],
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/info") return res.end(JSON.stringify({ version: "2.0.32", pid: 99 }));
    if (url.pathname === "/api/session") return res.end(JSON.stringify({ data: sessions }));
    if (url.pathname === "/api/session/ses_a") return res.end(JSON.stringify({ data: sessions[0] }));
    if (url.pathname === "/api/session/ses_a/message") return res.end(JSON.stringify({ data: messages.ses_a, cursor: { previous: null, next: null } }));
    if (url.pathname === "/api/permission/request") return res.end(JSON.stringify({ location: { directory: "/tmp" }, data: [] }));
    if (url.pathname === "/api/form") return res.end(JSON.stringify({ location: { directory: "/tmp" }, data: [] }));
    res.statusCode = 404;
    res.end("{}");
  });
  return { server, sessions };
}

function runOcApi(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.resolve(scriptsDir, "oc-api.mjs"), ...args], {
      env: { ...process.env, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("oc-api detect/sessions/history/status speak v2", async () => {
  const { server } = v2Server();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const detect = await runOcApi(["detect", "--server", baseUrl, "--json"]);
    assert.equal(detect.code, 0, detect.stderr);
    assert.equal(JSON.parse(detect.stdout).api, API_V2);

    const sessions = await runOcApi(["sessions", "--server", baseUrl]);
    assert.equal(sessions.code, 0, sessions.stderr);
    assert.match(sessions.stdout, /ses_b .* beta/);
    assert.ok(sessions.stdout.indexOf("ses_b") < sessions.stdout.indexOf("ses_a"), "newest session first");

    const history = await runOcApi(["history", "--server", baseUrl, "--session", "ses_a", "--turns", "1"]);
    assert.equal(history.code, 0, history.stderr);
    assert.match(history.stdout, /── user @ /);
    assert.match(history.stdout, /do the thing/);
    assert.match(history.stdout, /── assistant @ /);
    assert.match(history.stdout, /done the thing/);

    const status = await runOcApi(["status", "--server", baseUrl, "--session", "ses_a", "--tool-name", "dispatch"]);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /messages: 2\s+cost: \$0\.5/);
    assert.match(status.stdout, /state: {4}idle/);
  } finally {
    server.close();
  }
});

test("oc-api detects a v1 server through the legacy session list", async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/api/info") {
      res.statusCode = 404;
      return res.end("{}");
    }
    if (url.pathname === "/session") {
      res.setHeader("content-type", "application/json");
      return res.end("[]");
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const detect = await runOcApi(["detect", "--server", `http://127.0.0.1:${server.address().port}`, "--json"]);
    assert.equal(detect.code, 0, detect.stderr);
    assert.equal(JSON.parse(detect.stdout).api, API_V1);
  } finally {
    server.close();
  }
});
