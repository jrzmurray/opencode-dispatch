import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
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

test("probeServer classifies v2, auth-rejected, v1, the v2 spa, and a dead server", async () => {
  const v2 = await probeServer({
    baseUrl: "http://127.0.0.1:4096",
    fetchImpl: async (url) => String(url).endsWith("/api/info")
      ? jsonResponse({ version: "2.0.32", pid: 7 })
      : jsonResponse([]),
  });
  assert.equal(v2.api, API_V2);
  assert.equal(v2.version, "2.0.32");
  assert.equal(v2.authOk, true);
  assert.equal(v2.authRequired, false);

  // Both generations guard every route with basic auth: a 401 on /api/info
  // alone says nothing about the dialect.
  const rejected = await probeServer({
    baseUrl: "http://127.0.0.1:4096",
    fetchImpl: async () => jsonResponse({ _tag: "UnauthorizedError" }, 401),
  });
  assert.equal(rejected.api, null);
  assert.equal(rejected.serverUp, true);
  assert.equal(rejected.authOk, false);
  assert.equal(rejected.authRequired, true);
  assert.match(rejected.detail, /authentication required/);

  // An authenticated v1 server also 401s on the unknown /api/info route; the
  // legacy /session probe proves the dialect and that credentials were accepted.
  const v1Auth = await probeServer({
    baseUrl: "http://127.0.0.1:4096",
    fetchImpl: async (url) => String(url).endsWith("/api/info")
      ? jsonResponse({}, 401)
      : jsonResponse([]),
  });
  assert.equal(v1Auth.api, API_V1);
  assert.equal(v1Auth.authOk, true);
  assert.equal(v1Auth.authRequired, false);

  // A public v2 SPA with a protected API is still v2, but auth is required.
  const v2Auth = await probeServer({
    baseUrl: "http://127.0.0.1:4096",
    fetchImpl: async (url) => String(url).endsWith("/api/info")
      ? jsonResponse({}, 401)
      : new Response("<!doctype html><html></html>", { status: 200, headers: { "content-type": "text/html" } }),
  });
  assert.equal(v2Auth.api, API_V2);
  assert.equal(v2Auth.authOk, false);
  assert.equal(v2Auth.authRequired, true);

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
  // A 200 HTML page is not an auth failure.
  assert.equal(spa.authOk, true);
  assert.match(spa.detail, /web ui/);

  const down = await probeServer({
    baseUrl: "http://127.0.0.1:4096",
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.equal(down.api, null);
  assert.equal(down.serverUp, false);
});

test("a pinned dialect only fills in when the server cannot be classified", async () => {
  // Pin v2, reachable v1: detection wins.
  const reachable = new OpenCodeClient({
    baseUrl: "http://127.0.0.1:4096",
    api: API_V2,
    fetchImpl: async (url) => String(url).endsWith("/api/info")
      ? new Response("{}", { status: 404 })
      : jsonResponse([]),
  });
  assert.equal(await reachable.resolveApi(), API_V1);

  // Pin v1, server down: the pin supplies the dialect for launching.
  const down = new OpenCodeClient({
    baseUrl: "http://127.0.0.1:4096",
    api: API_V1,
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.equal(await down.resolveApi(), API_V1);

  // Credentials rejected: never mask the auth failure with the pin.
  const rejected = new OpenCodeClient({
    baseUrl: "http://127.0.0.1:4096",
    api: API_V1,
    fetchImpl: async () => jsonResponse({}, 401),
  });
  await assert.rejects(rejected.resolveApi(), /rejected the credentials/);
});

test("the default-username retry only rescues v2 and is used for later requests", async () => {
  const expected = (user) => `Basic ${Buffer.from(`${user}:pw`).toString("base64")}`;
  const v2Calls = [];
  const v2 = new OpenCodeClient({
    baseUrl: "http://127.0.0.1:4096",
    username: "custom",
    password: "pw",
    fetchImpl: async (url, options = {}) => {
      const pathname = new URL(String(url)).pathname;
      v2Calls.push({ pathname, authorization: options.headers?.authorization });
      if (options.headers?.authorization !== expected("opencode")) return jsonResponse({}, 401);
      if (pathname === "/api/info") return jsonResponse({ version: "2.0.32", pid: 1 });
      return jsonResponse({ data: [] });
    },
  });
  assert.equal(await v2.resolveApi(), API_V2);
  await v2.listSessions();
  const v2SessionCall = v2Calls.find((call) => call.pathname === "/api/session");
  assert.equal(v2SessionCall.authorization, expected("opencode"));

  // A v1 server that happens to accept the default username must not be
  // silently adopted: the configured custom username is still what requests use.
  const v1 = new OpenCodeClient({
    baseUrl: "http://127.0.0.1:4096",
    username: "custom",
    password: "pw",
    fetchImpl: async (url, options = {}) => {
      const pathname = new URL(String(url)).pathname;
      if (pathname === "/api/info") return jsonResponse({}, 401);
      if (pathname === "/session" && options.headers?.authorization === expected("opencode")) return jsonResponse([]);
      return jsonResponse({}, 401);
    },
  });
  await assert.rejects(v1.resolveApi(), /rejected the credentials/);
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

test("OpenCodeClient resolves credentials from the environment's relaxed map", () => {
  const previous = process.env.OPENCODE_SERVER_CREDENTIALS;
  process.env.OPENCODE_SERVER_CREDENTIALS = "{127.0.0.1:4096:{username:me,password:pw}}";
  try {
    const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096" });
    assert.equal(client.username, "me");
    assert.equal(client.password, "pw");
    const explicit = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", username: "other", password: "explicit" });
    assert.equal(explicit.username, "other");
    assert.equal(explicit.password, "explicit");
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_SERVER_CREDENTIALS;
    else process.env.OPENCODE_SERVER_CREDENTIALS = previous;
  }
});

test("v2 createSession uses location, renamed permission rules, and normalizes the reply", async () => {
  const { fetchImpl, calls } = scriptedFetch((parsed) => {
    if (parsed.pathname === "/api/info") return jsonResponse({ version: "2.0.32", pid: 1 });
    return jsonResponse({ data: { id: "ses_test", location: { directory: "/tmp/worker" } } });
  });
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
  const createCall = calls.find((call) => call.pathname === "/api/session");
  assert.equal(createCall.pathname, "/api/session");
  assert.deepEqual(createCall.body, {
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
    if (parsed.pathname === "/api/info") return jsonResponse({ version: "2.0.32", pid: 1 });
    if (parsed.pathname === "/api/session/ses_1") return jsonResponse({ data: { id: "ses_1", location: { directory: "/tmp/one" } } });
    if (parsed.pathname === "/api/session") return jsonResponse({ data: [{ id: "ses_1", location: { directory: "/tmp/one" } }] });
    return jsonResponse({ data: [] });
  });
  const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", api: API_V2, fetchImpl });
  const session = await client.getSession("ses_1", { directory: "/tmp/one" });
  assert.equal(session.directory, "/tmp/one");
  const getCall = calls.find((call) => call.method === "GET" && call.pathname === "/api/session/ses_1");
  assert.equal(getCall.headers["x-opencode-directory"], "%2Ftmp%2Fone");
  const list = await client.listSessions({ directory: "/tmp/one" });
  assert.equal(list.length, 1);
  assert.equal(list[0].directory, "/tmp/one");
});

test("v2 turn control uses interrupt, prompt, wait, and session-scoped permission replies", async () => {
  const { fetchImpl, calls } = scriptedFetch((parsed) => {
    if (parsed.pathname === "/api/info") return jsonResponse({ version: "2.0.32", pid: 1 });
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

test("v1 prompt_async submits the text as a text part", async () => {
  const { fetchImpl, calls } = scriptedFetch((parsed) => {
    if (parsed.pathname === "/api/info") return new Response("{}", { status: 404 });
    if (parsed.pathname === "/session") return jsonResponse([]);
    if (parsed.pathname.endsWith("/prompt_async")) return jsonResponse({ accepted: true });
    return jsonResponse({});
  });
  const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", api: API_V1, fetchImpl });
  await client.promptAsync("ses_1", {
    directory: "/tmp/worker",
    text: "hello",
    agent: "build",
    model: { providerID: "provider", id: "model", variant: "high" },
    noReply: true,
  });

  const prompt = calls.find((call) => call.pathname === "/session/ses_1/prompt_async");
  assert.equal(prompt.search, "?directory=%2Ftmp%2Fworker");
  assert.deepEqual(prompt.body, {
    parts: [{ type: "text", text: "hello" }],
    agent: "build",
    model: { providerID: "provider", modelID: "model" },
    variant: "high",
    noReply: true,
  });
});

test("v2 messages unwrap pages and normalize content parts; v1 items normalize too", async () => {
  const { fetchImpl } = scriptedFetch((parsed) => {
    if (parsed.pathname === "/api/info") return jsonResponse({ version: "2.0.32", pid: 1 });
    return jsonResponse({
      data: [
      { id: "msg_a", type: "assistant", time: { created: 1790000002000, completed: 1790000002100 }, content: [
        { type: "text", text: "done" },
        { type: "tool", id: "tool_1", name: "bash", executed: true, state: { status: "running", input: {} }, time: { created: 1790000002010, ran: 1790000002020 } },
      ] },
      { id: "msg_u", type: "user", time: { created: 1790000001000 }, text: "do it" },
      { id: "msg_idle", type: "idle", time: { created: 1790000002200 } },
      ],
      cursor: { previous: null, next: "older" },
    });
  });
  const client = new OpenCodeClient({ baseUrl: "http://127.0.0.1:4096", api: API_V2, fetchImpl });
  const page = await client.messagesPage("ses_1", { limit: 3, order: "desc" });
  assert.equal(page.cursor.next, "older");
  assert.deepEqual(page.messages.map((message) => message.role), ["assistant", "user", "idle"]);
  assert.equal(page.messages[0].text, "done");
  assert.equal(page.messages[0].completed, 1790000002100);
  assert.equal(page.messages[0].parts[1].kind, "tool");
  assert.equal(page.messages[0].parts[1].startedAt, 1790000002020);
  assert.equal(page.messages[1].text, "do it");
  assert.equal(page.messages[2].outcome, null);

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
    fetchImpl: async (url) => String(url).endsWith("/api/info")
      ? jsonResponse({ version: "2.0.32", pid: 1 })
      : new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
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
  const created = { id: "ses_new", title: "new", time: { created: 4000, updated: 4000 }, location: { directory: "/tmp/new" } };
  const writes = [];
  let prompted = null;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/info") return res.end(JSON.stringify({ version: "2.0.32", pid: 99 }));
    if (url.pathname === "/api/session" && req.method === "GET") return res.end(JSON.stringify({ data: sessions }));
    if (url.pathname === "/api/session" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        writes.push({ method: req.method, pathname: url.pathname, headers: req.headers, body: body ? JSON.parse(body) : undefined });
        res.end(JSON.stringify({ data: created }));
      });
      return undefined;
    }
    if (url.pathname === "/api/session/ses_a") return res.end(JSON.stringify({ data: sessions[0] }));
    if (url.pathname === "/api/session/ses_new") return res.end(JSON.stringify({ data: created }));
    if (url.pathname === "/api/session/ses_new/message") {
      return res.end(JSON.stringify({
        data: [
          { id: "msg_new_a", type: "assistant", time: { created: 5000, completed: 5100 }, content: [{ type: "text", text: "planned" }] },
          { id: "msg_new_u", type: "user", time: { created: 4000 }, text: "hello there" },
        ],
        cursor: { previous: null, next: null },
      }));
    }
    if (url.pathname === "/api/session/ses_new/agent" || url.pathname === "/api/session/ses_new/model" || url.pathname === "/api/session/ses_new/prompt") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        writes.push({ method: req.method, pathname: url.pathname, headers: req.headers, body: body ? JSON.parse(body) : undefined });
        res.end(JSON.stringify(url.pathname.endsWith("/prompt") ? { data: { id: "msg_new_u" } } : { data: {} }));
      });
      return undefined;
    }
    if (url.pathname === "/api/session/ses_a/interrupt" && req.method === "POST") {
      writes.push({ method: req.method, pathname: url.pathname, headers: req.headers });
      return res.end(JSON.stringify({ data: {} }));
    }
    if (url.pathname === "/api/session/ses_a/prompt" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        prompted = JSON.parse(body || "{}");
        writes.push({ method: req.method, pathname: url.pathname, headers: req.headers, body: prompted });
        res.end(JSON.stringify({ data: { id: "msg_admitted" } }));
      });
      return undefined;
    }
    if (url.pathname === "/api/session/ses_a/message") {
      const data = prompted
        ? [
            { id: "msg_send_a", type: "assistant", time: { created: 7000, completed: 7100 }, content: [{ type: "text", text: "new reply" }] },
            { id: "msg_send_u", type: "user", time: { created: 6000 }, text: "new task" },
            ...messages.ses_a,
          ]
        : messages.ses_a;
      return res.end(JSON.stringify({ data, cursor: { previous: null, next: null } }));
    }
    if (url.pathname === "/api/permission/request") return res.end(JSON.stringify({ location: { directory: "/tmp" }, data: [] }));
    if (url.pathname === "/api/form") return res.end(JSON.stringify({ location: { directory: "/tmp" }, data: [] }));
    res.statusCode = 404;
    res.end("{}");
  });
  return { server, sessions, writes, created };
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

test("oc-api sessions --json and delete speak v2", async () => {
  const deleted = [];
  const deleteHeaders = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/info") return res.end(JSON.stringify({ version: "2.0.32", pid: 99 }));
    if (url.pathname === "/api/session" && req.method === "GET") {
      return res.end(JSON.stringify({ data: [{ id: "ses_a", title: "alpha", time: { updated: 1700000000000 }, location: { directory: "/tmp/a" } }] }));
    }
    if (url.pathname === "/api/session/ses_a" && req.method === "GET") {
      return res.end(JSON.stringify({ data: { id: "ses_a", location: { directory: "/tmp/a" } } }));
    }
    if (url.pathname === "/api/session/ses_a" && req.method === "DELETE") {
      deleted.push("ses_a");
      deleteHeaders.push(req.headers["x-opencode-directory"] || "");
      return res.end(JSON.stringify({ data: { id: "ses_a" } }));
    }
    if (url.pathname === "/api/session/ses_missing" && req.method === "DELETE") {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "not found" }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const sessions = await runOcApi(["sessions", "--server", baseUrl, "--json"]);
    assert.equal(sessions.code, 0, sessions.stderr);
    const parsed = JSON.parse(sessions.stdout);
    assert.equal(parsed[0].id, "ses_a");
    assert.equal(parsed[0].updated, 1700000000000);

    const removed = await runOcApi(["delete", "--server", baseUrl, "--session", "ses_a", "--dir", "/tmp/a"]);
    assert.equal(removed.code, 0, removed.stderr);
    assert.match(removed.stdout, /deleted ses_a/);

    const missing = await runOcApi(["delete", "--server", baseUrl, "--session", "ses_missing"]);
    assert.equal(missing.code, 0, missing.stderr);
    assert.match(missing.stdout, /already gone ses_missing/);
    assert.deepEqual(deleted, ["ses_a"]);
    assert.equal(deleteHeaders[0], encodeURIComponent("/tmp/a"));
  } finally {
    server.close();
  }
});

test("oc-api delete speaks v1 with the legacy abort and delete routes", async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    calls.push(`${req.method} ${url.pathname}${url.search}`);
    res.setHeader("content-type", "application/json");
    if (url.pathname === "/api/info") {
      res.statusCode = 404;
      return res.end("{}");
    }
    if (url.pathname === "/session" && req.method === "GET") return res.end("[]");
    if (url.pathname === "/session/ses_v1" && req.method === "GET") {
      return res.end(JSON.stringify({ id: "ses_v1", directory: "/tmp/v1" }));
    }
    if (url.pathname === "/session/ses_v1/abort" && req.method === "POST") return res.end("{}");
    if (url.pathname === "/session/ses_v1" && req.method === "DELETE") return res.end("{}");
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const removed = await runOcApi(["delete", "--server", baseUrl, "--session", "ses_v1", "--dir", "/tmp/v1"]);
    assert.equal(removed.code, 0, removed.stderr);
    assert.match(removed.stdout, /deleted ses_v1/);
    assert.ok(calls.includes("POST /session/ses_v1/abort?directory=%2Ftmp%2Fv1"), calls.join(", "));
    assert.ok(calls.includes("DELETE /session/ses_v1?directory=%2Ftmp%2Fv1"), calls.join(", "));
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

// ---------------------------------------------------------------------------
// oc-api follow: v2 streams text in place, so parts grow between polls
// ---------------------------------------------------------------------------

function followServer({ failWithIdle = false } = {}) {
  let messageCalls = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (body) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/info") return json({ version: "2.0.32", pid: 42 });
    if (url.pathname === "/api/session/ses_follow") {
      const directory = decodeURIComponent(req.headers["x-opencode-directory"] || "/tmp/follow");
      return json({ data: { id: "ses_follow", location: { directory } } });
    }
    if (url.pathname === "/api/session/ses_follow/message") {
      messageCalls += 1;
      if (failWithIdle) {
        return json({
          data: [
            { id: "idle_1", type: "idle", time: { created: 1790000003000 }, outcome: "failed", error: { type: "provider.no-route", message: "no such model" } },
            { id: "user_1", type: "user", time: { created: 1790000001000 }, text: "do the thing" },
          ],
          cursor: { previous: null, next: null },
        });
      }
      // First poll: a partial assistant reply still streaming. Second poll:
      // the SAME part has grown in place, and the turn completed.
      const done = messageCalls > 1;
      return json({
        data: [
          {
            id: "assistant_1",
            type: "assistant",
            time: { created: 1790000002000, ...(done ? { completed: 1790000002500 } : {}) },
            content: [
              { type: "reasoning", text: "REASONING SECRET" },
              { type: "text", text: done ? "Hello world" : "Hel" },
            ],
          },
          { id: "user_1", type: "user", time: { created: 1790000001000 }, text: "say hello" },
        ],
        cursor: { previous: null, next: null },
      });
    }
    if (url.pathname === "/api/permission/request" || url.pathname === "/api/form") return json({ data: [] });
    if (url.pathname === "/api/session") return json({ data: [] });
    if (url.pathname === "/api/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"id":"evt_1","type":"session.execution.succeeded","data":{"sessionID":"ses_follow"}}\n\n');
      res.end();
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  return { server, calls: () => messageCalls };
}

test("oc-api follow prints text that grows in place, exactly once", async () => {
  const { server } = followServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const follow = await runOcApi(["follow", "--server", baseUrl, "--session", "ses_follow", "--timeout", "5"]);
    assert.equal(follow.code, 0, follow.stderr);
    assert.match(follow.stdout, /Hello world/);
    assert.equal((follow.stdout.match(/Hel/g) || []).length, 1, `streamed text was repeated:\n${follow.stdout}`);
    assert.doesNotMatch(follow.stdout, /REASONING SECRET/, "historical reasoning must not replay on a later poll");
    assert.match(follow.stdout, /\(done — ses_follow completed\)/);
  } finally {
    server.close();
  }
});

test("oc-api follow closes a completed line before a later message's text", async () => {
  let messageCalls = 0;
  let eventResponse = null;
  const user1 = { id: "user_1", type: "user", time: { created: 1000 }, text: "first" };
  const asst1 = (completed) => ({
    id: "asst_1",
    type: "assistant",
    time: { created: 2000, ...(completed ? { completed: 2500 } : {}) },
    content: [{ type: "text", text: "Hello" }],
  });
  const user2 = { id: "user_2", type: "user", time: { created: 4000 }, text: "next" };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (body) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/info") return json({ version: "2.0.32", pid: 42 });
    if (url.pathname === "/api/session/ses_frame") {
      return json({ data: { id: "ses_frame", location: { directory: "/tmp/frame" } } });
    }
    if (url.pathname === "/api/session/ses_frame/message") {
      messageCalls += 1;
      if (messageCalls === 1) return json({ data: [asst1(false), user1], cursor: { next: null } });
      if (messageCalls === 2) {
        json({ data: [user2, asst1(true), user1], cursor: { next: null } });
        // Wake the follower for the next poll without letting the stream die.
        eventResponse?.write('data: {"id":"e2","type":"session.updated","data":{"sessionID":"ses_frame"}}\n\n');
        return undefined;
      }
      return json({
        data: [
          { id: "asst_2", type: "assistant", time: { created: 5000, completed: 5500 }, content: [{ type: "text", text: "Reply" }] },
          user2,
          asst1(true),
          user1,
        ],
        cursor: { next: null },
      });
    }
    if (url.pathname === "/api/permission/request" || url.pathname === "/api/form") return json({ data: [] });
    if (url.pathname === "/api/session") return json({ data: [] });
    if (url.pathname === "/api/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      eventResponse = res;
      res.write('data: {"id":"e1","type":"session.updated","data":{"sessionID":"ses_frame"}}\n\n');
      return undefined;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const follow = await runOcApi(["follow", "--server", baseUrl, "--session", "ses_frame", "--timeout", "5"]);
    assert.equal(follow.code, 0, follow.stderr);
    assert.match(follow.stdout, /Hello\nnext\nReply/, `lines ran together:\n${follow.stdout}`);
  } finally {
    eventResponse?.end();
    server.close();
  }
});

test("oc-api follow completes on a failed idle turn and status surfaces the error", async () => {
  const { server } = followServer({ failWithIdle: true });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const follow = await runOcApi(["follow", "--server", baseUrl, "--session", "ses_follow", "--timeout", "5"]);
    assert.equal(follow.code, 0, follow.stderr);
    assert.match(follow.stdout, /\(failed — ses_follow turn failed: provider\.no-route/);

    const status = await runOcApi(["status", "--server", baseUrl, "--session", "ses_follow", "--tool-name", "dispatch"]);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, /state: {4}failed/);
    assert.match(status.stdout, /lastError: provider\.no-route/);
  } finally {
    server.close();
  }
});

test("oc-api follow --after skips the old turn and echoes only the new reply", async () => {
  let messageCalls = 0;
  const oldUser = { id: "u_old", type: "user", time: { created: 1000 }, text: "OLD USER PROMPT" };
  const oldAssistant = { id: "a_old", type: "assistant", time: { created: 2000, completed: 2100 }, content: [{ type: "text", text: "old reply" }] };
  const newUser = { id: "u_new", type: "user", time: { created: 5000 }, text: "NEW USER PROMPT" };
  const newAssistant = { id: "a_new", type: "assistant", time: { created: 6000, completed: 6100 }, content: [{ type: "text", text: "new reply" }] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (payload) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === "/api/info") return json({ version: "2.0.32", pid: 42 });
    if (url.pathname === "/api/session/ses_follow_after" && req.method === "GET") {
      return json({ data: { id: "ses_follow_after", location: { directory: "/tmp/follow-after" } } });
    }
    if (url.pathname === "/api/session/ses_follow_after/message") {
      messageCalls += 1;
      const data = messageCalls === 1
        ? [oldAssistant, oldUser]
        : [newAssistant, newUser, oldAssistant, oldUser];
      return json({ data, cursor: { previous: null, next: null } });
    }
    if (url.pathname === "/api/permission/request" || url.pathname === "/api/form") {
      return json({ location: { directory: "/tmp/follow-after" }, data: [] });
    }
    if (url.pathname === "/api/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"id":"e1","type":"session.updated","data":{"sessionID":"ses_follow_after"}}\n\n');
      return undefined;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const follow = await runOcApi([
      "follow", "--server", baseUrl, "--session", "ses_follow_after", "--dir", "/tmp/follow-after",
      "--after", "a_old", "--timeout", "5", "--mode", "send",
    ]);
    assert.equal(follow.code, 0, follow.stderr);
    assert.match(follow.stdout, /new reply/);
    assert.doesNotMatch(follow.stdout, /old reply/);
    assert.doesNotMatch(follow.stdout, /USER PROMPT/, "send's follow must not echo the prompt");
    assert.match(follow.stdout, /\(done — ses_follow_after completed\)/);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// v2 turn-level state: a completed assistant message is only one STEP
// ---------------------------------------------------------------------------

test("oc-api follow keeps streaming through completed steps until the turn is inactive", async () => {
  let messageCalls = 0;
  let active = true;
  const streams = new Set();
  const user = { id: "user_1", type: "user", time: { created: 1000 }, text: "go" };
  const step = (id, text, created) => ({
    id,
    type: "assistant",
    time: { created, completed: created + 10 },
    content: [{ type: "text", text }],
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (payload) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === "/api/info") return json({ version: "2.0.32", pid: 42 });
    if (url.pathname === "/api/session/ses_steps") {
      return json({ data: { id: "ses_steps", location: { directory: "/tmp/steps" } } });
    }
    if (url.pathname === "/api/session/active") {
      return json({ data: active ? { ses_steps: { type: "running" } } : {} });
    }
    if (url.pathname === "/api/session/ses_steps/message") {
      messageCalls += 1;
      if (messageCalls === 1) {
        return json({
          data: [step("step_1", "First step", 2000), user],
          cursor: { previous: null, next: null },
        });
      }
      if (messageCalls === 2) {
        return json({
          data: [step("step_2", "Second step", 3000), step("step_1", "First step", 2000), user],
          cursor: { previous: null, next: null },
        });
      }
      active = false;
      return json({
        data: [
          { id: "idle_1", type: "idle", time: { created: 4000 }, outcome: "succeeded" },
          step("step_2", "Second step", 3000),
          step("step_1", "First step", 2000),
          user,
        ],
        cursor: { previous: null, next: null },
      });
    }
    if (url.pathname === "/api/permission/request" || url.pathname === "/api/form") return json({ data: [] });
    if (url.pathname === "/api/session") return json({ data: [] });
    if (url.pathname === "/api/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      streams.add(res);
      const timer = setInterval(() => {
        if (!res.writableEnded) {
          res.write('data: {"id":"e","type":"session.updated","data":{"sessionID":"ses_steps"}}\n\n');
        }
      }, 25);
      res.on("close", () => {
        clearInterval(timer);
        streams.delete(res);
      });
      return undefined;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const follow = await runOcApi([
      "follow", "--server", baseUrl, "--session", "ses_steps", "--dir", "/tmp/steps", "--timeout", "5",
    ]);
    assert.equal(follow.code, 0, follow.stderr);
    assert.match(follow.stdout, /First step/);
    assert.match(follow.stdout, /Second step/, "follow exited on the first completed step");
    assert.ok(follow.stdout.indexOf("First step") < follow.stdout.indexOf("Second step"));
    assert.match(follow.stdout, /\(done — ses_steps completed\)/);
  } finally {
    for (const stream of streams) stream.destroy();
    server.close();
  }
});

test("oc-api status reports an active v2 turn as WORKING despite a completed last step", async () => {
  let active = true;
  const session = {
    id: "ses_active",
    title: "active",
    time: { created: 1000, updated: Date.now() },
    location: { directory: "/tmp/active" },
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (payload) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === "/api/info") return json({ version: "2.0.32", pid: 42 });
    if (url.pathname === "/api/session/ses_active") return json({ data: session });
    if (url.pathname === "/api/session/active") {
      return json({ data: active ? { ses_active: { type: "running" } } : {} });
    }
    if (url.pathname === "/api/session/ses_active/message") {
      return json({
        data: [
          {
            id: "step_1",
            type: "assistant",
            time: { created: 2000, completed: 2100 },
            content: [{ type: "text", text: "one step is done" }],
          },
          { id: "user_1", type: "user", time: { created: 1000 }, text: "go" },
        ],
        cursor: { previous: null, next: null },
      });
    }
    if (url.pathname === "/api/session") return json({ data: [session] });
    if (url.pathname === "/api/permission/request" || url.pathname === "/api/form") return json({ data: [] });
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const working = await runOcApi(["status", "--server", baseUrl, "--session", "ses_active", "--tool-name", "dispatch"]);
    assert.equal(working.code, 0, working.stderr);
    assert.match(working.stdout, /state: {4}WORKING/);

    const listed = await runOcApi(["status", "--server", baseUrl, "--limit", "5", "--tool-name", "dispatch"]);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /ses_active\s+WORKING/);

    active = false;
    const idle = await runOcApi(["status", "--server", baseUrl, "--session", "ses_active", "--tool-name", "dispatch"]);
    assert.equal(idle.code, 0, idle.stderr);
    assert.match(idle.stdout, /state: {4}idle/);
  } finally {
    server.close();
  }
});

test("oc-api status distinguishes a fresh or pending session from a finished one", async () => {
  const now = Date.now();
  const session = (id, title) => ({
    id,
    title,
    time: { created: now, updated: now },
    location: { directory: "/tmp/states" },
  });
  const sessions = [
    session("ses_fresh", "fresh"),
    session("ses_pending", "pending"),
    session("ses_partial", "partial"),
    session("ses_done", "done"),
    session("ses_failed", "failed"),
    session("ses_interrupted", "interrupted"),
  ];
  const user = { id: "user_1", type: "user", time: { created: now - 1000 }, text: "go" };
  const messages = {
    ses_fresh: [],
    ses_pending: [user],
    ses_partial: [
      { id: "step_1", type: "assistant", time: { created: now }, content: [{ type: "text", text: "partial" }] },
      user,
    ],
    ses_done: [
      { id: "step_1", type: "assistant", time: { created: now, completed: now + 1 }, content: [{ type: "text", text: "done" }] },
      user,
    ],
    ses_failed: [
      {
        id: "idle_1",
        type: "idle",
        time: { created: now },
        outcome: "failed",
        error: { type: "provider.no-route", message: "no such model" },
      },
      user,
    ],
    ses_interrupted: [
      { id: "idle_1", type: "idle", time: { created: now }, outcome: "interrupted" },
      user,
    ],
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (payload) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === "/api/info") return json({ version: "2.0.32", pid: 42 });
    if (url.pathname === "/api/session/active") return json({ data: {} });
    if (url.pathname === "/api/session") return json({ data: sessions });
    const match = url.pathname.match(/^\/api\/session\/(ses_[a-z]+)$/);
    if (match) {
      const found = sessions.find((entry) => entry.id === match[1]);
      if (found) return json({ data: found });
      res.statusCode = 404;
      return res.end("{}");
    }
    const messageMatch = url.pathname.match(/^\/api\/session\/(ses_[a-z]+)\/message$/);
    if (messageMatch) {
      return json({ data: messages[messageMatch[1]] || [], cursor: { previous: null, next: null } });
    }
    if (url.pathname === "/api/permission/request" || url.pathname === "/api/form") return json({ data: [] });
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const fresh = await runOcApi(["status", "--server", baseUrl, "--session", "ses_fresh", "--tool-name", "dispatch"]);
    assert.equal(fresh.code, 0, fresh.stderr);
    assert.match(fresh.stdout, /state: {4}initializing/);
    assert.doesNotMatch(fresh.stdout, /state: {4}idle/);

    const pending = await runOcApi(["status", "--server", baseUrl, "--session", "ses_pending", "--tool-name", "dispatch"]);
    assert.equal(pending.code, 0, pending.stderr);
    assert.match(pending.stdout, /state: {4}pending/);

    const partial = await runOcApi(["status", "--server", baseUrl, "--session", "ses_partial", "--tool-name", "dispatch"]);
    assert.equal(partial.code, 0, partial.stderr);
    assert.match(partial.stdout, /state: {4}WORKING/);
    assert.doesNotMatch(partial.stdout, /state: {4}(idle|stopped)/);

    const done = await runOcApi(["status", "--server", baseUrl, "--session", "ses_done", "--tool-name", "dispatch"]);
    assert.equal(done.code, 0, done.stderr);
    assert.match(done.stdout, /state: {4}idle/);

    const failed = await runOcApi(["status", "--server", baseUrl, "--session", "ses_failed", "--tool-name", "dispatch"]);
    assert.equal(failed.code, 0, failed.stderr);
    assert.match(failed.stdout, /state: {4}failed/);
    assert.match(failed.stdout, /lastError: provider\.no-route/);

    const interrupted = await runOcApi(["status", "--server", baseUrl, "--session", "ses_interrupted", "--tool-name", "dispatch"]);
    assert.equal(interrupted.code, 0, interrupted.stderr);
    assert.match(interrupted.stdout, /state: {4}interrupted/);

    const listed = await runOcApi(["status", "--server", baseUrl, "--limit", "10", "--tool-name", "dispatch"]);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /ses_fresh\s+initializing/);
    assert.match(listed.stdout, /ses_pending\s+pending/);
    assert.match(listed.stdout, /ses_partial\s+WORKING/);
    assert.match(listed.stdout, /ses_done\s+idle/);
    assert.match(listed.stdout, /ses_failed\s+failed/);
    assert.match(listed.stdout, /ses_interrupted\s+interrupted/);
    assert.match(listed.stdout, /2 session\(s\) initializing\/pending/);
    assert.match(listed.stdout, /1 session\(s\) working/);
    assert.match(listed.stdout, /1 session\(s\) failed/);
    assert.match(listed.stdout, /1 session\(s\) interrupted/);
  } finally {
    server.close();
  }
});

test("v1 status does not mistake a fresh session for a running one", async () => {
  const now = Date.now();
  const session = { id: "ses_v1_fresh", title: "fresh", time: { created: now, updated: now } };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (payload) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === "/api/info") {
      res.statusCode = 404;
      return res.end("{}");
    }
    if (url.pathname === "/session" && req.method === "GET") return json([session]);
    if (url.pathname === "/session/status") return json({ ses_v1_fresh: { type: "idle" } });
    if (url.pathname === "/session/ses_v1_fresh") return json(session);
    if (url.pathname === "/session/ses_v1_fresh/message") return json([]);
    if (url.pathname === "/permission" || url.pathname === "/question") return json([]);
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const fresh = await runOcApi(["status", "--server", baseUrl, "--session", "ses_v1_fresh", "--tool-name", "dispatch"]);
    assert.equal(fresh.code, 0, fresh.stderr);
    assert.match(fresh.stdout, /state: {4}initializing/);
    assert.doesNotMatch(fresh.stdout, /state: {4}idle/);

    const listed = await runOcApi(["status", "--server", baseUrl, "--limit", "10", "--tool-name", "dispatch"]);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /ses_v1_fresh\s+initializing/);
    assert.doesNotMatch(listed.stdout, /ses_v1_fresh\s+WORKING/);
  } finally {
    server.close();
  }
});

test("a submitted prompt is pending until its admission lands in the transcript", async () => {
  const oldUser = { id: "u_old", type: "user", time: { created: 1000 }, text: "old prompt" };
  const oldAssistant = {
    id: "a_old",
    type: "assistant",
    time: { created: 2000, completed: 2100 },
    content: [{ type: "text", text: "old reply" }],
  };
  const newUser = { id: "msg_new", type: "user", time: { created: 3000 }, text: "new prompt" };
  const newAssistant = {
    id: "a_new",
    type: "assistant",
    time: { created: 4000, completed: 4100 },
    content: [{ type: "text", text: "new reply" }],
  };
  let posted = false;
  let visible = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (payload) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === "/api/info") return json({ version: "2.0.32", pid: 42 });
    if (url.pathname === "/api/session/ses_send") {
      return json({ data: { id: "ses_send", location: { directory: "/tmp/send" } } });
    }
    if (url.pathname === "/api/session/active") return json({ data: {} });
    if (url.pathname === "/api/session/ses_send/message") {
      const data = visible
        ? [newAssistant, newUser, oldAssistant, oldUser]
        : [oldAssistant, oldUser];
      return json({ data, cursor: { previous: null, next: null } });
    }
    if (url.pathname === "/api/session/ses_send/prompt" && req.method === "POST") {
      posted = true;
      return json({ data: { id: "msg_new", sessionID: "ses_send", type: "user", delivery: "steer" } });
    }
    if (url.pathname === "/control/visible" && req.method === "POST") {
      visible = true;
      return json({ ok: true });
    }
    if (url.pathname === "/api/session") return json({ data: [{ id: "ses_send", location: { directory: "/tmp/send" } }] });
    if (url.pathname === "/api/permission/request" || url.pathname === "/api/form") return json({ data: [] });
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-pending-state-"));
  const promptFile = path.join(stateDir, "prompt.txt");
  fs.writeFileSync(promptFile, "new prompt");
  const env = { OPENCODE_DISPATCH_STATE_DIR: stateDir };
  try {
    const submitted = await runOcApi([
      "submit", "--server", baseUrl, "--session", "ses_send", "--dir", "/tmp/send",
      "--prompt-file", promptFile, "--after", "a_old",
    ], env);
    assert.equal(submitted.code, 0, submitted.stderr);
    assert.equal(posted, true);

    // The admission is in the POST response, but the user message is not in the
    // transcript yet. The marker must keep status out of idle.
    const pending = await runOcApi([
      "status", "--server", baseUrl, "--session", "ses_send", "--tool-name", "dispatch",
    ], env);
    assert.equal(pending.code, 0, pending.stderr);
    assert.match(pending.stdout, /state: {4}pending/);
    assert.doesNotMatch(pending.stdout, /state: {4}idle/);

    const listed = await runOcApi([
      "status", "--server", baseUrl, "--limit", "5", "--tool-name", "dispatch",
    ], env);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /ses_send\s+pending/);

    // watch uses the same marker: a completed old turn is not enough to settle.
    const watch = await runOcApi(["watch", "--server", baseUrl, "--session", "ses_send", "--timeout", "1"], env);
    assert.equal(watch.code, 3, `watch settled early: ${watch.stdout}\n${watch.stderr}`);

    // Make the admitted user message visible; the marker clears and the old
    // completed step no longer masks the new turn.
    await fetch(`${baseUrl}/control/visible`, { method: "POST" });
    const settled = await runOcApi([
      "status", "--server", baseUrl, "--session", "ses_send", "--tool-name", "dispatch",
    ], env);
    assert.equal(settled.code, 0, settled.stderr);
    assert.match(settled.stdout, /state: {4}idle/);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
    server.close();
  }
});

test("oc-api watch waits on a running v2 turn instead of treating a completed step as idle", async () => {
  let active = true;
  const session = { id: "ses_watch", location: { directory: "/tmp/watch" } };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (payload) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === "/api/info") return json({ version: "2.0.32", pid: 42 });
    if (url.pathname === "/api/session/ses_watch") return json({ data: session });
    if (url.pathname === "/api/session/active") {
      return json({ data: active ? { ses_watch: { type: "running" } } : {} });
    }
    if (url.pathname === "/api/session/ses_watch/message") {
      return json({
        data: [
          {
            id: "step_1",
            type: "assistant",
            time: { created: 2000, completed: 2100 },
            content: [{ type: "text", text: "one step is done" }],
          },
        ],
        cursor: { previous: null, next: null },
      });
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const running = await runOcApi(["watch", "--server", baseUrl, "--session", "ses_watch", "--timeout", "1"]);
    assert.equal(running.code, 3, running.stderr);

    active = false;
    const idle = await runOcApi(["watch", "--server", baseUrl, "--session", "ses_watch", "--timeout", "1"]);
    assert.equal(idle.code, 0, idle.stderr);
  } finally {
    server.close();
  }
});

test("oc-api wait does not stop at a completed step while the v2 turn is still active", async () => {
  let messageCalls = 0;
  let active = true;
  const user = { id: "user_1", type: "user", time: { created: 1000 }, text: "go" };
  const step = (id, text, created) => ({
    id,
    type: "assistant",
    time: { created, completed: created + 10 },
    content: [{ type: "text", text }],
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (payload) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === "/api/info") return json({ version: "2.0.32", pid: 42 });
    if (url.pathname === "/api/session/ses_wait_steps") {
      return json({ data: { id: "ses_wait_steps", location: { directory: "/tmp/wait-steps" } } });
    }
    if (url.pathname === "/api/session/active") {
      return json({ data: active ? { ses_wait_steps: { type: "running" } } : {} });
    }
    if (url.pathname === "/api/session/ses_wait_steps/message") {
      messageCalls += 1;
      if (messageCalls === 1) {
        return json({
          data: [step("step_1", "intermediate step", 2000), user],
          cursor: { previous: null, next: null },
        });
      }
      active = false;
      return json({
        data: [step("step_2", "final answer", 3000), step("step_1", "intermediate step", 2000), user],
        cursor: { previous: null, next: null },
      });
    }
    if (url.pathname === "/api/permission/request" || url.pathname === "/api/form") return json({ data: [] });
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const wait = await runOcApi([
      "wait", "--server", baseUrl, "--session", "ses_wait_steps", "--dir", "/tmp/wait-steps",
      "--timeout", "5", "--min-messages", "2", "--mode", "task", "--tool-name", "dispatch",
    ]);
    assert.equal(wait.code, 0, wait.stderr);
    assert.match(wait.stdout, /final answer/);
    assert.doesNotMatch(wait.stdout, /intermediate step/, "wait returned a mid-turn step");
  } finally {
    server.close();
  }
});

test("oc-api last skips non-conversation records at the head of a v2 page", async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (payload) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === "/api/info") return json({ version: "2.0.32", pid: 42 });
    if (url.pathname === "/api/session/ses_last") {
      return json({ data: { id: "ses_last", location: { directory: "/tmp/last" } } });
    }
    if (url.pathname === "/api/session/ses_last/message") {
      return json({
        data: [
          { id: "switch_1", type: "model-switched", time: { created: 3000 } },
          {
            id: "assistant_1",
            type: "assistant",
            time: { created: 2000, completed: 2100 },
            content: [{ type: "text", text: "old reply" }],
          },
          { id: "user_1", type: "user", time: { created: 1000 }, text: "old prompt" },
        ],
        cursor: { previous: null, next: null },
      });
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const last = await runOcApi(["last", "--server", baseUrl, "--session", "ses_last", "--dir", "/tmp/last"]);
    assert.equal(last.code, 0, last.stderr);
    assert.equal(last.stdout.trim(), "assistant_1");
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// oc-api run-mode primitives + wait
// ---------------------------------------------------------------------------

test("oc-api create/submit/where/interrupt speak v2", async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      calls.push({
        method: req.method,
        pathname: url.pathname,
        headers: req.headers,
        body: body ? JSON.parse(body) : undefined,
      });
      const json = (payload) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(payload));
      };
      if (url.pathname === "/api/info") return json({ version: "2.0.32", pid: 7 });
      if (url.pathname === "/api/session" && req.method === "POST") {
        return json({ data: { id: "ses_new", location: { directory: "/tmp/run" } } });
      }
      if (url.pathname === "/api/session/ses_new") {
        return json({ data: { id: "ses_new", location: { directory: "/tmp/run" } } });
      }
      if (url.pathname === "/api/session/ses_new/message") {
        return json({
          data: [
            { id: "msg_new", type: "assistant", time: { created: 2000, completed: 2100 }, content: [{ type: "text", text: "newest" }] },
            { id: "msg_old", type: "user", time: { created: 1000 }, text: "old" },
          ],
          cursor: { previous: null, next: null },
        });
      }
      if (/^\/api\/session\/ses_new\/(agent|model|prompt|interrupt)$/.test(url.pathname)) {
        return json(url.pathname.endsWith("/prompt") ? { data: { id: "msg_admit" } } : { data: {} });
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const promptFile = path.join(os.tmpdir(), `oc-api-prompt-${process.pid}.txt`);
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-api-state-"));
  fs.writeFileSync(promptFile, "do it");
  try {
    const created = await runOcApi([
      "create", "--server", baseUrl, "--dir", "/tmp/run", "--agent", "auto",
      "--model", "deepseek/deepseek-v4-flash", "--variant", "high", "--title", "task",
      "--permission", '[{"permission":"edit","pattern":"**","action":"allow"}]',
    ]);
    assert.equal(created.code, 0, created.stderr);
    assert.equal(created.stdout.trim(), "ses_new");
    const createCall = calls.find((call) => call.pathname === "/api/session" && call.method === "POST");
    assert.deepEqual(createCall.body.location, { directory: "/tmp/run" });
    assert.deepEqual(createCall.body.permissions, [{ action: "edit", resource: "**", effect: "allow" }]);
    assert.equal(createCall.body.model.variant, "high");

    const submitted = await runOcApi([
      "submit", "--server", baseUrl, "--session", "ses_new", "--dir", "/tmp/run",
      "--prompt-file", promptFile, "--agent", "auto",
      "--model", "deepseek/deepseek-v4-flash", "--variant", "high",
    ], { OPENCODE_DISPATCH_STATE_DIR: stateDir });
    assert.equal(submitted.code, 0, submitted.stderr);
    const agentCall = calls.find((call) => call.pathname === "/api/session/ses_new/agent");
    assert.equal(agentCall.body.agent, "auto");
    const modelCall = calls.find((call) => call.pathname === "/api/session/ses_new/model");
    assert.deepEqual(modelCall.body.model, { providerID: "deepseek", id: "deepseek-v4-flash", variant: "high" });
    const promptCall = calls.find((call) => call.pathname === "/api/session/ses_new/prompt");
    assert.equal(promptCall.body.text, "do it");

    const last = await runOcApi(["last", "--server", baseUrl, "--session", "ses_new", "--dir", "/tmp/run"]);
    assert.equal(last.code, 0, last.stderr);
    assert.equal(last.stdout.trim(), "msg_new");

    // A delivery admission is one flat prompt request: no agent/model calls,
    // because the running turn keeps its configuration.
    calls.length = 0;
    const steered = await runOcApi([
      "submit", "--server", baseUrl, "--session", "ses_new", "--dir", "/tmp/run",
      "--prompt-file", promptFile, "--delivery", "steer", "--agent", "auto",
    ], { OPENCODE_DISPATCH_STATE_DIR: stateDir });
    assert.equal(steered.code, 0, steered.stderr);
    assert.match(steered.stdout, /steer admitted: id=msg_admit/);
    const deliveryCalls = calls.filter((call) => call.pathname !== "/api/info");
    assert.ok(!deliveryCalls.some((call) => /\/agent$/.test(call.pathname) || /\/model$/.test(call.pathname)), "delivery must not set the session agent/model");
    const admissions = deliveryCalls.filter((call) => call.pathname === "/api/session/ses_new/prompt");
    assert.equal(admissions.length, 1);
    assert.deepEqual(admissions[0].body, { text: "do it", delivery: "steer" });

    const where = await runOcApi(["where", "--server", baseUrl, "--session", "ses_new", "--dir", "/tmp/run"]);
    assert.equal(where.code, 0, where.stderr);
    assert.equal(where.stdout.trim(), "/tmp/run");

    const interrupted = await runOcApi(["interrupt", "--server", baseUrl, "--session", "ses_new", "--dir", "/tmp/run"]);
    assert.equal(interrupted.code, 0, interrupted.stderr);
    assert.match(interrupted.stdout, /interrupted ses_new/);
    assert.ok(calls.some((call) => call.pathname === "/api/session/ses_new/interrupt"), "interrupt must use the v2 route");
  } finally {
    fs.rmSync(promptFile, { force: true });
    fs.rmSync(stateDir, { recursive: true, force: true });
    server.close();
  }
});

function waitServer({ failWithIdle = false, alwaysWorking = false } = {}) {
  let messageCalls = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (payload) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === "/api/info") return json({ version: "2.0.32", pid: 42 });
    if (url.pathname === "/api/session/ses_wait" && req.method === "GET") {
      return json({ data: { id: "ses_wait", location: { directory: "/tmp/wait" } } });
    }
    if (url.pathname === "/api/session/ses_wait/message") {
      messageCalls += 1;
      const user = { id: "user_1", type: "user", time: { created: 1790000001000 }, text: "do the thing" };
      if (failWithIdle) {
        return json({
          data: [
            { id: "idle_1", type: "idle", time: { created: 1790000003000 }, outcome: "failed", error: { type: "provider.no-route", message: "no such model" } },
            user,
          ],
          cursor: { previous: null, next: null },
        });
      }
      if (alwaysWorking) {
        return json({
          data: [
            {
              id: "assistant_1",
              type: "assistant",
              time: { created: 1790000002000 },
              content: [{ type: "tool", name: "bash", time: { ran: 1790000002000 }, state: { status: "running" } }],
            },
            user,
          ],
          cursor: { previous: null, next: null },
        });
      }
      if (messageCalls < 2) {
        return json({ data: [user], cursor: { previous: null, next: null } });
      }
      return json({
        data: [
          {
            id: "assistant_1",
            type: "assistant",
            time: { created: 1790000002000, completed: 1790000002500 },
            content: [{ type: "text", text: "finished the thing" }],
          },
          user,
        ],
        cursor: { previous: null, next: null },
      });
    }
    if (url.pathname === "/api/permission/request" || url.pathname === "/api/form") {
      return json({ location: { directory: "/tmp/wait" }, data: [] });
    }
    res.statusCode = 404;
    res.end("{}");
  });
  return { server };
}

test("oc-api wait blocks to completion and prints the final reply", async () => {
  const { server } = waitServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const wait = await runOcApi([
      "wait", "--server", baseUrl, "--session", "ses_wait", "--dir", "/tmp/wait",
      "--timeout", "5", "--min-messages", "2", "--mode", "task", "--tool-name", "dispatch",
    ]);
    assert.equal(wait.code, 0, wait.stderr);
    assert.match(wait.stdout, /finished the thing/);
    assert.match(wait.stderr, /\(session: ses_wait\)/);
  } finally {
    server.close();
  }
});

test("oc-api wait reports a failed idle turn without a reply", async () => {
  const { server } = waitServer({ failWithIdle: true });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const wait = await runOcApi([
      "wait", "--server", baseUrl, "--session", "ses_wait", "--timeout", "5", "--mode", "task",
    ]);
    assert.equal(wait.code, 0, wait.stderr);
    assert.match(wait.stderr, /ERROR .*no such model/);
  } finally {
    server.close();
  }
});

test("oc-api wait honours its timeout and stall guard", async () => {
  const { server } = waitServer({ alwaysWorking: true });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const timedOut = await runOcApi([
      "wait", "--server", baseUrl, "--session", "ses_wait", "--timeout", "1", "--mode", "task", "--tool-name", "dispatch",
    ]);
    assert.equal(timedOut.code, 3, timedOut.stderr);
    assert.match(timedOut.stderr, /still running after 1s/);

    const stalled = await runOcApi([
      "wait", "--server", baseUrl, "--session", "ses_wait", "--timeout", "30", "--stall", "1", "--mode", "task", "--tool-name", "dispatch",
    ]);
    assert.equal(stalled.code, 8, stalled.stderr);
    assert.match(stalled.stderr, /STALLED: no activity for 1s/);
  } finally {
    server.close();
  }
});

test("oc-api wait --after ignores a previously completed turn", async () => {
  let messageCalls = 0;
  const oldUser = { id: "u_old", type: "user", time: { created: 1000 }, text: "old" };
  const oldAssistant = { id: "a_old", type: "assistant", time: { created: 2000, completed: 2100 }, content: [{ type: "text", text: "old reply" }] };
  const newUser = { id: "u_new", type: "user", time: { created: 5000 }, text: "new" };
  const newAssistant = { id: "a_new", type: "assistant", time: { created: 6000, completed: 6100 }, content: [{ type: "text", text: "new reply" }] };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (payload) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === "/api/info") return json({ version: "2.0.32", pid: 42 });
    if (url.pathname === "/api/session/ses_after" && req.method === "GET") {
      return json({ data: { id: "ses_after", location: { directory: "/tmp/after" } } });
    }
    if (url.pathname === "/api/session/ses_after/message") {
      messageCalls += 1;
      const data = messageCalls === 1
        ? [oldAssistant, oldUser]
        : [newAssistant, newUser, oldAssistant, oldUser];
      return json({ data, cursor: { previous: null, next: null } });
    }
    if (url.pathname === "/api/permission/request" || url.pathname === "/api/form") {
      return json({ location: { directory: "/tmp/after" }, data: [] });
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const wait = await runOcApi([
      "wait", "--server", baseUrl, "--session", "ses_after", "--dir", "/tmp/after",
      "--after", "a_old", "--timeout", "5", "--min-messages", "2", "--mode", "send",
    ]);
    assert.equal(wait.code, 0, wait.stderr);
    assert.match(wait.stdout, /new reply/);
    assert.doesNotMatch(wait.stdout, /old reply/);
  } finally {
    server.close();
  }
});

// ---------------------------------------------------------------------------
// shell gating + per-profile binary resolution
// ---------------------------------------------------------------------------

function shellEnv(extra = {}) {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-dispatch-shim-"));
  fs.symlinkSync(process.execPath, path.join(shimDir, "node"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "oc-dispatch-home-"));
  const tmp = path.join(home, "tmp");
  fs.mkdirSync(tmp, { recursive: true });
  return {
    env: {
      ...process.env,
      PATH: `${shimDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
      HOME: home,
      TMPDIR: tmp,
      OPENCODE_DISPATCH_SERVERS: path.join(home, "servers.json"),
      OPENCODE_DISPATCH_STATE_DIR: path.join(home, "state"),
      OPENCODE_SERVER_PASSWORD: "",
      OPENCODE_PASSWORD: "",
      OPENCODE_DISPATCH_API: "",
      ...extra,
    },
    cleanup: () => {
      fs.rmSync(shimDir, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function runDispatch(args, env) {
  return new Promise((resolve) => {
    const child = spawn("bash", [path.resolve(scriptsDir, "opencode-dispatch.sh"), ...args], { env, cwd: env.HOME });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("v1-only modes refuse a v2 server while read-only modes need no opencode on PATH", async () => {
  const { server } = v2Server();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const shim = shellEnv({
    OPENCODE_DISPATCH_HOST: "127.0.0.1",
    OPENCODE_DISPATCH_PORT: String(server.address().port),
  });
  try {
    const permissions = await runDispatch(["permissions"], shim.env);
    assert.equal(permissions.code, 0, permissions.stderr);
    assert.match(permissions.stdout, /no pending permission requests/);

    const sessions = await runDispatch(["sessions"], shim.env);
    assert.equal(sessions.code, 0, sessions.stderr);
    assert.match(sessions.stdout, /ses_a/);
  } finally {
    shim.cleanup();
    server.close();
  }
});

test("permissions and allow speak v2 through the owning session", async () => {
  const replies = [];
  const session = {
    id: "ses_perm",
    title: "permission test",
    time: { created: Date.now(), updated: Date.now() },
    location: { directory: "/tmp/perm" },
  };
  const request = {
    id: "per_1",
    sessionID: "ses_perm",
    action: "bash",
    resources: ["git status"],
    message: "run git status",
    metadata: { command: "git status", title: "git status" },
    source: { type: "tool", messageID: "msg_1", id: "call_1" },
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (payload) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === "/api/info") return json({ version: "2.0.32", pid: 42 });
    if (url.pathname === "/api/session") return json({ data: [session] });
    if (url.pathname === "/api/session/ses_perm") return json({ data: session });
    if (url.pathname === "/api/permission/request") return json({ data: [request] });
    if (url.pathname === "/api/form") return json({ data: [] });
    if (url.pathname === "/api/session/ses_perm/permission/per_1/reply" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        replies.push({ body: JSON.parse(body || "{}"), directory: req.headers["x-opencode-directory"] || "" });
        json({ data: {} });
      });
      return undefined;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const shim = shellEnv({
    OPENCODE_DISPATCH_HOST: "127.0.0.1",
    OPENCODE_DISPATCH_PORT: String(server.address().port),
  });
  try {
    const listed = await runDispatch(["permissions"], shim.env);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, /per_1/);
    assert.match(listed.stdout, /permission: bash/);
    assert.match(listed.stdout, /patterns: {3}git status/);
    assert.match(listed.stdout, /session: {4}ses_perm/);
    assert.match(listed.stdout, /command: {4}git status/);
    assert.match(listed.stdout, /approve with: opencode-dispatch\.sh allow <requestID> \[--always\]/);

    const allowed = await runDispatch(["allow", "per_1", "--always"], shim.env);
    assert.equal(allowed.code, 0, `${allowed.stderr}\n${allowed.stdout}`);
    assert.match(allowed.stdout, /allowed per_1 \(always\)/);
    assert.equal(replies.length, 1);
    assert.deepEqual(replies[0].body, { decision: "always" });
    assert.equal(replies[0].directory, encodeURIComponent("/tmp/perm"));

    const missing = await runDispatch(["allow", "per_missing"], shim.env);
    assert.equal(missing.code, 5, `${missing.stderr}\n${missing.stdout}`);
    assert.match(missing.stderr, /not found or already answered/);
  } finally {
    shim.cleanup();
    server.close();
  }
});

test("abort and server-backed run modes speak v2", async () => {
  const { server, writes } = v2Server();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const shim = shellEnv({
    OPENCODE_DISPATCH_HOST: "127.0.0.1",
    OPENCODE_DISPATCH_PORT: String(server.address().port),
  });
  try {
    const abort = await runDispatch(["abort", "ses_a"], shim.env);
    assert.equal(abort.code, 0, abort.stderr);
    assert.match(abort.stdout, /aborted in-progress turn for ses_a/);
    assert.ok(writes.some((call) => call.pathname === "/api/session/ses_a/interrupt"), "abort must use the v2 interrupt route");

    // `plan` exercises the shared run-mode path: create via /api/session,
    // set the agent, submit the prompt, and read the directory for the banner.
    const plan = await runDispatch(["plan", "hello there"], shim.env);
    assert.equal(plan.code, 0, `${plan.stderr}\n${plan.stdout}`);
    assert.doesNotMatch(plan.stderr, /not v2-ready/);
    assert.match(plan.stderr, /\[plan\] session ses_new started in the background/);
    assert.match(plan.stdout, /planned/);
    assert.ok(writes.some((call) => call.pathname === "/api/session" && call.method === "POST"), "run modes must create the session through the adapter");
    assert.ok(writes.some((call) => call.pathname === "/api/session/ses_new/agent"), "the agent is set on v2 before submitting");
    assert.ok(writes.some((call) => call.pathname === "/api/session/ses_new/prompt"), "the prompt is submitted on v2");
  } finally {
    shim.cleanup();
    server.close();
  }
});

test("follow and status --follow stay alive for their whole timer interval on a running v2 turn", async () => {
  const session = {
    id: "ses_running",
    title: "running",
    time: { created: 1000, updated: Date.now() },
    location: { directory: "/tmp/running" },
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (payload) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === "/api/info") return json({ version: "2.0.32", pid: 42 });
    if (url.pathname === "/api/session/ses_running") return json({ data: session });
    if (url.pathname === "/api/session/active") return json({ data: { ses_running: { type: "running" } } });
    if (url.pathname === "/api/session/ses_running/message") {
      // The newest assistant message is COMPLETE, but the turn is still
      // running: this is the exact shape that used to end `follow` early.
      return json({
        data: [
          {
            id: "step_1",
            type: "assistant",
            time: { created: 2000, completed: 2100 },
            content: [{ type: "text", text: "one step is done" }],
          },
          { id: "user_1", type: "user", time: { created: 1000 }, text: "go" },
        ],
        cursor: { previous: null, next: null },
      });
    }
    if (url.pathname === "/api/session") return json({ data: [session] });
    if (url.pathname === "/api/permission/request" || url.pathname === "/api/form") return json({ data: [] });
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const shim = shellEnv({
    OPENCODE_DISPATCH_HOST: "127.0.0.1",
    OPENCODE_DISPATCH_PORT: String(server.address().port),
  });
  try {
    let started = Date.now();
    const follow = await runDispatch(["follow", "ses_running", "--timeout", "2"], shim.env);
    let elapsed = Date.now() - started;
    assert.equal(follow.code, 3, `${follow.stderr}\n${follow.stdout}`);
    assert.match(follow.stdout, /one step is done/);
    assert.match(follow.stdout, /\(timeout after 2s/);
    assert.doesNotMatch(follow.stdout, /\(done — ses_running completed\)/);
    assert.ok(elapsed >= 1800, `follow exited after ${elapsed}ms instead of its 2s timer`);

    started = Date.now();
    const status = await runDispatch(["status", "ses_running", "--follow", "--timeout", "2"], shim.env);
    elapsed = Date.now() - started;
    assert.equal(status.code, 0, `${status.stderr}\n${status.stdout}`);
    assert.match(status.stdout, /state: {4}WORKING/);
    assert.match(status.stderr, /\(timeout after 2s — still following stopped/);
    assert.ok(elapsed >= 1800, `status --follow exited after ${elapsed}ms instead of its 2s timer`);
  } finally {
    shim.cleanup();
    server.close();
  }
});

test("status --follow does not finish a fresh v2 session that has not initialized", async () => {
  const session = {
    id: "ses_fresh",
    title: "fresh",
    time: { created: Date.now(), updated: Date.now() },
    location: { directory: "/tmp/fresh" },
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (payload) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === "/api/info") return json({ version: "2.0.32", pid: 42 });
    if (url.pathname === "/api/session/ses_fresh") return json({ data: session });
    if (url.pathname === "/api/session/active") return json({ data: {} });
    if (url.pathname === "/api/session/ses_fresh/message") {
      return json({ data: [], cursor: { previous: null, next: null } });
    }
    if (url.pathname === "/api/session") return json({ data: [session] });
    if (url.pathname === "/api/permission/request" || url.pathname === "/api/form") return json({ data: [] });
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const shim = shellEnv({
    OPENCODE_DISPATCH_HOST: "127.0.0.1",
    OPENCODE_DISPATCH_PORT: String(server.address().port),
  });
  try {
    const started = Date.now();
    const status = await runDispatch(["status", "ses_fresh", "--follow", "--timeout", "2"], shim.env);
    const elapsed = Date.now() - started;
    assert.equal(status.code, 0, `${status.stderr}\n${status.stdout}`);
    assert.match(status.stdout, /state: {4}initializing/);
    assert.doesNotMatch(status.stdout, /state: {4}idle/);
    assert.match(status.stderr, /\(timeout after 2s — still following stopped/);
    assert.ok(elapsed >= 1800, `status --follow exited after ${elapsed}ms instead of its 2s timer`);
  } finally {
    shim.cleanup();
    server.close();
  }
});

function installFakeOpencode(env, configDocuments) {
  const shimDir = env.PATH.split(":")[0];
  const bin = path.join(shimDir, "opencode");
  fs.writeFileSync(bin, `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("2.0.32"); process.exit(0); }
if (process.argv[2] === "debug" && process.argv[3] === "config") {
  console.log(JSON.stringify(${JSON.stringify(configDocuments)}));
  process.exit(0);
}
process.exit(0);
`, { mode: 0o755 });
  return bin;
}

test("run modes resolve the selected agent's model from opencode.json", async () => {
  const { server, writes } = v2Server();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const shim = shellEnv({
    OPENCODE_DISPATCH_HOST: "127.0.0.1",
    OPENCODE_DISPATCH_PORT: String(server.address().port),
  });
  installFakeOpencode(shim.env, [
    {
      type: "document",
      path: "/home/.config/opencode/opencode.json",
      info: {
        model: { providerID: "test", model: "default-model" },
        agents: {
          plan: { model: { providerID: "test", model: "plan-model", variant: "max" } },
        },
      },
    },
  ]);
  try {
    const plan = await runDispatch(["plan", "hello there"], shim.env);
    assert.equal(plan.code, 0, `${plan.stderr}\n${plan.stdout}`);
    const created = writes.find((call) => call.pathname === "/api/session" && call.method === "POST");
    assert.deepEqual(created.body.model, { providerID: "test", id: "plan-model", variant: "max" });
    const modelCall = writes.find((call) => call.pathname === "/api/session/ses_new/model");
    assert.deepEqual(modelCall.body.model, { providerID: "test", id: "plan-model", variant: "max" });
  } finally {
    shim.cleanup();
    server.close();
  }
});

test("an explicit --model overrides the agent's configured model", async () => {
  const { server, writes } = v2Server();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const shim = shellEnv({
    OPENCODE_DISPATCH_HOST: "127.0.0.1",
    OPENCODE_DISPATCH_PORT: String(server.address().port),
  });
  installFakeOpencode(shim.env, [
    {
      type: "document",
      path: "/home/.config/opencode/opencode.json",
      info: {
        agents: {
          plan: { model: { providerID: "test", model: "plan-model", variant: "max" } },
        },
      },
    },
  ]);
  try {
    const plan = await runDispatch(["plan", "--model", "test/explicit-model", "hello there"], shim.env);
    assert.equal(plan.code, 0, `${plan.stderr}\n${plan.stdout}`);
    const created = writes.find((call) => call.pathname === "/api/session" && call.method === "POST");
    assert.deepEqual(created.body.model, { providerID: "test", id: "explicit-model" });
    const modelCall = writes.find((call) => call.pathname === "/api/session/ses_new/model");
    assert.deepEqual(modelCall.body.model, { providerID: "test", id: "explicit-model" });
  } finally {
    shim.cleanup();
    server.close();
  }
});

test("task completes on v2 through the isolated worker launcher", async () => {
  const { server } = v2Server();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oc-dispatch-task-"));
  const worktree = path.join(root, "worker");
  const spawnAgent = path.join(root, "spawn-agent.mjs");
  fs.writeFileSync(
    spawnAgent,
    `#!/usr/bin/env node
import fs from "node:fs";
const dir = process.env.FAKE_WORKTREE;
fs.mkdirSync(dir, { recursive: true });
console.log(JSON.stringify({ sessionId: "ses_new", worktreePath: dir, taskId: "task-test", branch: "agent/task-test" }));
`,
    { mode: 0o755 },
  );
  const shim = shellEnv({
    OPENCODE_DISPATCH_HOST: "127.0.0.1",
    OPENCODE_DISPATCH_PORT: String(server.address().port),
    OPENCODE_ORCHESTRATION_ROOT: root,
    FAKE_WORKTREE: worktree,
  });
  try {
    const task = await runDispatch(["task", "--timeout", "5", "hello there"], shim.env);
    assert.equal(task.code, 0, `${task.stderr}\n${task.stdout}`);
    assert.doesNotMatch(task.stderr, /not v2-ready/);
    assert.match(task.stdout, /started \[task\]/);
    assert.match(task.stdout, /planned/);
    assert.match(task.stderr, /\[task\] session ses_new started in the background/);
  } finally {
    shim.cleanup();
    fs.rmSync(root, { recursive: true, force: true });
    server.close();
  }
});

test("send on v2 waits for the new turn instead of the old idle reply", async () => {
  const { server } = v2Server();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const shim = shellEnv({
    OPENCODE_DISPATCH_HOST: "127.0.0.1",
    OPENCODE_DISPATCH_PORT: String(server.address().port),
  });
  try {
    const send = await runDispatch(["send", "ses_a", "new task", "--wait", "--timeout", "5"], shim.env);
    assert.equal(send.code, 0, `${send.stderr}\n${send.stdout}`);
    assert.doesNotMatch(send.stderr, /not v2-ready/);
    assert.match(send.stdout, /new reply/);
    assert.doesNotMatch(send.stdout, /done the thing/, "the previous turn's reply must not be returned");
  } finally {
    shim.cleanup();
    server.close();
  }
});

test("send --steer on v2 uses the delivery field and returns an admission", async () => {
  const { server, writes } = v2Server();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const shim = shellEnv({
    OPENCODE_DISPATCH_HOST: "127.0.0.1",
    OPENCODE_DISPATCH_PORT: String(server.address().port),
  });
  try {
    const steer = await runDispatch(["send", "ses_a", "change direction", "--steer"], shim.env);
    assert.equal(steer.code, 0, `${steer.stderr}\n${steer.stdout}`);
    assert.match(steer.stdout, /steer admitted: id=msg_admitted/);
    const admit = writes.find((call) => call.pathname === "/api/session/ses_a/prompt");
    assert.equal(admit.body.delivery, "steer");
    assert.match(admit.body.text, /change direction/);
  } finally {
    shim.cleanup();
    server.close();
  }
});

test("send's default follow times out cleanly instead of exiting 3", async () => {
  const session = {
    id: "ses_send",
    title: "send",
    time: { created: 1000, updated: Date.now() },
    location: { directory: "/tmp/send" },
  };
  const oldUser = { id: "u_old", type: "user", time: { created: 1000 }, text: "old prompt" };
  const oldAssistant = {
    id: "a_old",
    type: "assistant",
    time: { created: 2000, completed: 2100 },
    content: [{ type: "text", text: "old reply" }],
  };
  const newUser = { id: "u_new", type: "user", time: { created: 3000 }, text: "new task" };
  const newAssistant = {
    id: "a_new",
    type: "assistant",
    time: { created: 4000, completed: 4100 },
    content: [{ type: "text", text: "new partial reply" }],
  };
  let prompted = false;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const json = (payload) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === "/api/info") return json({ version: "2.0.32", pid: 42 });
    if (url.pathname === "/api/session/ses_send") return json({ data: session });
    if (url.pathname === "/api/session/active") return json({ data: { ses_send: { type: "running" } } });
    if (url.pathname === "/api/session/ses_send/message") {
      return json({
        data: prompted ? [newAssistant, newUser, oldAssistant, oldUser] : [oldAssistant, oldUser],
        cursor: { previous: null, next: null },
      });
    }
    if (url.pathname === "/api/session/ses_send/prompt" && req.method === "POST") {
      prompted = true;
      return json({ data: { id: "msg_new" } });
    }
    if (url.pathname === "/api/session") return json({ data: [session] });
    if (url.pathname === "/api/permission/request" || url.pathname === "/api/form") return json({ data: [] });
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const shim = shellEnv({
    OPENCODE_DISPATCH_HOST: "127.0.0.1",
    OPENCODE_DISPATCH_PORT: String(server.address().port),
  });
  try {
    const started = Date.now();
    const send = await runDispatch(["send", "ses_send", "new task", "--timeout", "2"], shim.env);
    const elapsed = Date.now() - started;
    assert.equal(send.code, 0, `${send.stderr}\n${send.stdout}`);
    assert.match(send.stdout, /new partial reply/);
    assert.match(send.stdout, /\(timeout after 2s/);
    assert.doesNotMatch(send.stdout, /old reply/, "send echoed the previous turn");
    assert.ok(elapsed >= 1800, `send's follow exited after ${elapsed}ms instead of its 2s timer`);
  } finally {
    shim.cleanup();
    server.close();
  }
});

test("setup reports auth-required unknown dialects instead of unreachable", async () => {
  const server = http.createServer((req, res) => {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: "unauthorized" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const shim = shellEnv({
    OPENCODE_DISPATCH_HOST: "127.0.0.1",
    OPENCODE_DISPATCH_PORT: String(server.address().port),
  });
  fs.writeFileSync(shim.env.OPENCODE_DISPATCH_SERVERS, JSON.stringify({
    default: { host: "127.0.0.1", port: server.address().port },
  }));
  try {
    const setup = await runDispatch(["setup"], shim.env);
    assert.equal(setup.code, 0, setup.stderr);
    assert.match(setup.stdout, /auth required \(dialect unknown\)/);
    assert.match(setup.stdout, / default +listen:127\.0\.0\.1 +-> 127\.0\.0\.1:\d+ +auth /);
  } finally {
    shim.cleanup();
    server.close();
  }
});

test("profile and address-keyed credentials are independent of the single env password", async () => {
  const authServer = (password) => {
    const expected = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
    return http.createServer((req, res) => {
      if (req.headers.authorization !== expected) {
        res.statusCode = 401;
        return res.end("{}");
      }
      const url = new URL(req.url, "http://127.0.0.1");
      res.setHeader("content-type", "application/json");
      if (url.pathname === "/api/info") return res.end(JSON.stringify({ version: "2.0.32", pid: 1 }));
      if (url.pathname === "/api/session") return res.end(JSON.stringify({ data: [] }));
      if (url.pathname === "/api/permission/request" || url.pathname === "/api/form") return res.end(JSON.stringify({ data: [] }));
      res.statusCode = 404;
      res.end("{}");
    });
  };
  const alpha = authServer("alpha-pw");
  const beta = authServer("beta-pw");
  await new Promise((resolve) => alpha.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => beta.listen(0, "127.0.0.1", resolve));

  const shim = shellEnv({
    // The single value must NOT override either address-scoped credential.
    OPENCODE_SERVER_PASSWORD: "global-pw",
  });
  fs.writeFileSync(shim.env.OPENCODE_DISPATCH_SERVERS, JSON.stringify({
    alpha: { host: "127.0.0.1", port: alpha.address().port, password: "alpha-pw" },
    beta: { host: "127.0.0.1", port: beta.address().port },
    credentials: {
      [`127.0.0.1:${beta.address().port}`]: { password: "beta-pw" },
    },
  }));
  try {
    const alphaRun = await runDispatch(["sessions", "--server", "alpha"], shim.env);
    assert.equal(alphaRun.code, 0, alphaRun.stderr);
    const betaRun = await runDispatch(["sessions", "--server", "beta"], shim.env);
    assert.equal(betaRun.code, 0, betaRun.stderr);
  } finally {
    shim.cleanup();
    alpha.close();
    beta.close();
  }
});

test("serve launches the local server with the same credential the clients read", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-dispatch-serve-"));
  const recordEnv = path.join(dir, "server-env.json");
  const recordPid = path.join(dir, "server-pid");
  const bin = path.join(dir, "opencode-fake.mjs");
  fs.writeFileSync(bin, `#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
fs.writeFileSync(process.env.RECORD_ENV, JSON.stringify({
  OPENCODE_PASSWORD: process.env.OPENCODE_PASSWORD,
  OPENCODE_SERVER_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD,
  OPENCODE_SERVER_USERNAME: process.env.OPENCODE_SERVER_USERNAME,
  OPENCODE_SERVER_CREDENTIALS: process.env.OPENCODE_SERVER_CREDENTIALS,
}));
fs.writeFileSync(process.env.RECORD_PID, String(process.pid));
http.createServer((req, res) => {
  if (req.url.startsWith("/session")) {
    res.setHeader("content-type", "application/json");
    res.end("[]");
  } else {
    res.statusCode = 404;
    res.end("{}");
  }
}).listen(port, "127.0.0.1");
`, { mode: 0o755 });
  const port = await freePort();
  const servers = path.join(dir, "servers.json");
  fs.writeFileSync(servers, JSON.stringify({
    alpha: { host: "127.0.0.1", port, password: "profile-pw", bin },
  }));
  const shim = shellEnv({
    OPENCODE_DISPATCH_SERVERS: servers,
    OPENCODE_PASSWORD: "stale-env-pw",
    RECORD_ENV: recordEnv,
    RECORD_PID: recordPid,
  });
  let pid = null;
  try {
    const result = await runDispatch(["serve", "--server", "alpha"], shim.env);
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    const recorded = JSON.parse(fs.readFileSync(recordEnv, "utf8"));
    assert.equal(recorded.OPENCODE_SERVER_PASSWORD, "profile-pw", "server must use the profile credential");
    assert.equal(recorded.OPENCODE_PASSWORD, "profile-pw", "both dialect names must carry the same resolved pair");
    assert.equal(recorded.OPENCODE_SERVER_USERNAME, "opencode");
    assert.equal(recorded.OPENCODE_SERVER_CREDENTIALS, undefined, "an ambient keyed map must not reach the server");
    pid = Number(fs.readFileSync(recordPid, "utf8"));
  } finally {
    if (pid) {
      try { process.kill(pid); } catch { /* already gone */ }
    }
    shim.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("serve starts a v2 server and reports the detected dialect", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-dispatch-serve-v2-"));
  const recordEnv = path.join(dir, "server-env.json");
  const recordPid = path.join(dir, "server-pid");
  const bin = path.join(dir, "opencode-v2-fake.mjs");
  fs.writeFileSync(bin, `#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
const args = process.argv.slice(2);
const port = Number(args[args.indexOf("--port") + 1]);
fs.writeFileSync(process.env.RECORD_ENV, JSON.stringify({
  OPENCODE_PASSWORD: process.env.OPENCODE_PASSWORD,
  OPENCODE_SERVER_PASSWORD: process.env.OPENCODE_SERVER_PASSWORD,
  OPENCODE_SERVER_USERNAME: process.env.OPENCODE_SERVER_USERNAME,
  OPENCODE_SERVER_CREDENTIALS: process.env.OPENCODE_SERVER_CREDENTIALS,
}));
fs.writeFileSync(process.env.RECORD_PID, String(process.pid));
http.createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url.startsWith("/api/info")) {
    res.end(JSON.stringify({ version: "2.0.32", pid: process.pid }));
  } else {
    res.statusCode = 404;
    res.end("{}");
  }
}).listen(port, "127.0.0.1");
`, { mode: 0o755 });
  const port = await freePort();
  const servers = path.join(dir, "servers.json");
  fs.writeFileSync(servers, JSON.stringify({
    v2alpha: { host: "127.0.0.1", port, password: "v2-pw", bin },
  }));
  const shim = shellEnv({
    OPENCODE_DISPATCH_SERVERS: servers,
    OPENCODE_PASSWORD: "stale-env-pw",
    RECORD_ENV: recordEnv,
    RECORD_PID: recordPid,
  });
  let pid = null;
  try {
    const result = await runDispatch(["serve", "--server", "v2alpha"], shim.env);
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /dialect: v2/);
    const recorded = JSON.parse(fs.readFileSync(recordEnv, "utf8"));
    assert.equal(recorded.OPENCODE_SERVER_PASSWORD, "v2-pw");
    assert.equal(recorded.OPENCODE_PASSWORD, "v2-pw");
    assert.equal(recorded.OPENCODE_SERVER_USERNAME, "opencode");
    pid = Number(fs.readFileSync(recordPid, "utf8"));
  } finally {
    if (pid) {
      try { process.kill(pid); } catch { /* already gone */ }
    }
    shim.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("serve refuses a v2 profile with no password before launching", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-dispatch-v2-nopw-"));
  const marker = path.join(dir, "launched");
  const bin = path.join(dir, "opencode-v2-nopw.mjs");
  fs.writeFileSync(bin, `#!/usr/bin/env node
import fs from "node:fs";
if (process.argv.includes("--version")) { console.log("2.0.32"); process.exit(0); }
if (process.argv[2] === "debug" && process.argv[3] === "config") { console.log("{}"); process.exit(0); }
fs.writeFileSync(process.env.RECORD_LAUNCH, "launched");
`, { mode: 0o755 });
  const port = await freePort();
  const servers = path.join(dir, "servers.json");
  fs.writeFileSync(servers, JSON.stringify({ nopw: { host: "127.0.0.1", port, api: "v2", bin } }));
  const shim = shellEnv({ OPENCODE_DISPATCH_SERVERS: servers, RECORD_LAUNCH: marker });
  try {
    const result = await runDispatch(["serve", "--server", "nopw"], shim.env);
    assert.equal(result.code, 2, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stderr, /always requires basic auth/);
    assert.doesNotMatch(result.stderr, /did not come up/);
    assert.equal(fs.existsSync(marker), false, "the server must not be launched");
  } finally {
    shim.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("serve refuses a v2 binary with no password when no api pin is set", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-dispatch-v2-gen-"));
  const marker = path.join(dir, "launched");
  const bin = path.join(dir, "opencode-v2-gen.mjs");
  fs.writeFileSync(bin, `#!/usr/bin/env node
import fs from "node:fs";
if (process.argv.includes("--version")) { console.log("2.0.32"); process.exit(0); }
if (process.argv[2] === "debug" && process.argv[3] === "config") { console.log("{}"); process.exit(0); }
fs.writeFileSync(process.env.RECORD_LAUNCH, "launched");
`, { mode: 0o755 });
  const port = await freePort();
  const servers = path.join(dir, "servers.json");
  fs.writeFileSync(servers, JSON.stringify({ gen2: { host: "127.0.0.1", port, bin } }));
  const shim = shellEnv({ OPENCODE_DISPATCH_SERVERS: servers, RECORD_LAUNCH: marker });
  try {
    const result = await runDispatch(["serve", "--server", "gen2"], shim.env);
    assert.equal(result.code, 2, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stderr, /always requires basic auth/);
    assert.equal(fs.existsSync(marker), false, "the server must not be launched");
  } finally {
    shim.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("run-mode auto-start refuses a v2 server with no password", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-dispatch-v2-auto-"));
  const marker = path.join(dir, "launched");
  const bin = path.join(dir, "opencode-v2-auto.mjs");
  fs.writeFileSync(bin, `#!/usr/bin/env node
import fs from "node:fs";
if (process.argv.includes("--version")) { console.log("2.0.32"); process.exit(0); }
if (process.argv[2] === "debug" && process.argv[3] === "config") { console.log("{}"); process.exit(0); }
fs.writeFileSync(process.env.RECORD_LAUNCH, "launched");
`, { mode: 0o755 });
  const port = await freePort();
  const servers = path.join(dir, "servers.json");
  fs.writeFileSync(servers, JSON.stringify({ auto2: { host: "127.0.0.1", port, api: "v2", bin } }));
  const shim = shellEnv({ OPENCODE_DISPATCH_SERVERS: servers, RECORD_LAUNCH: marker });
  try {
    const plan = await runDispatch(["plan", "--server", "auto2", "hello"], shim.env);
    assert.equal(plan.code, 2, `${plan.stderr}\n${plan.stdout}`);
    assert.match(plan.stderr, /always requires basic auth/);
    assert.doesNotMatch(plan.stderr, /could not create session/);
    assert.equal(fs.existsSync(marker), false, "the server must not be launched");
  } finally {
    shim.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("serve reports auth rejection for an already-running v2 server", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-dispatch-v2-auth-"));
  const bin = path.join(dir, "opencode-v2-auth.mjs");
  fs.writeFileSync(bin, `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("2.0.32"); process.exit(0); }
`, { mode: 0o755 });
  const expected = `Basic ${Buffer.from("opencode:good-pw").toString("base64")}`;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/api/info") {
      if (req.headers.authorization !== expected) {
        res.statusCode = 401;
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ _tag: "UnauthorizedError", message: "Authentication required" }));
      }
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ version: "2.0.32", pid: process.pid }));
    }
    if (url.pathname === "/session") {
      // v2 serves the web UI publicly; that is how the dialect is classified
      // even when /api/info is 401.
      res.setHeader("content-type", "text/html");
      return res.end("<!doctype html><html></html>");
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const servers = path.join(dir, "servers.json");
  const writeProfile = (password) => fs.writeFileSync(servers, JSON.stringify({
    auth: { host: "127.0.0.1", port, password, bin },
  }));
  const shim = shellEnv({ OPENCODE_DISPATCH_SERVERS: servers });
  try {
    writeProfile("wrong-pw");
    const bad = await runDispatch(["serve", "--server", "auth"], shim.env);
    assert.equal(bad.code, 5, `${bad.stderr}\n${bad.stdout}`);
    assert.match(bad.stderr, /authentication was rejected/);
    assert.doesNotMatch(bad.stdout, /already running/);

    writeProfile("good-pw");
    const good = await runDispatch(["serve", "--server", "auth"], shim.env);
    assert.equal(good.code, 0, `${good.stderr}\n${good.stdout}`);
    assert.match(good.stdout, /already running .*dialect: v2/);
  } finally {
    shim.cleanup();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("--direct refuses the profile's v2 binary (version output parsing)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-dispatch-bin-"));
  const bin = path.join(dir, "opencode-v2");
  fs.writeFileSync(bin, "#!/bin/sh\necho 'opencode v2.0.32'\n", { mode: 0o755 });
  const servers = path.join(dir, "servers.json");
  fs.writeFileSync(servers, JSON.stringify({ default: { port: 4096, bin } }));
  const shim = shellEnv({ OPENCODE_DISPATCH_SERVERS: servers });
  try {
    const result = await runDispatch(["ask", "--direct", "hello"], shim.env);
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /--direct with a v2 client is not wired yet/);
  } finally {
    shim.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
