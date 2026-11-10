import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isLocalServerUrl, OpenCodeClient } from "../opencode-server.mjs";
import { bootstrapWorker, buildWorkerArgs, resolveBootstrapCommand } from "../spawn-agent.mjs";
import {
  archiveTaskRecord,
  branchExists,
  createTaskId,
  createWorktree,
  getAgentLayout,
  getRepositoryInfo,
  getWorktreeAtPath,
  makeTaskPlan,
  readTaskRecord,
  removeWorktree,
  runGit,
  sanitizeSlug,
  withAgentLock,
  withAgentLockAsync,
  writeTaskRecord,
} from "../worktree-utils.mjs";


const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Tests may run inside an opencode session (the identity plugin injects
// OPENCODE_SESSION_* into tool shells); child processes under test must not
// inherit the test runner's own identity.
function scrubbedEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (key.startsWith("OPENCODE_SESSION_")) delete env[key];
  }
  return env;
}

function fixtureRepository() {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-source-"));
  const allocationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agent-allocation-"));
  runGit(["init", "-q"], repositoryRoot);
  runGit(["config", "user.email", "agent-test@example.invalid"], repositoryRoot);
  runGit(["config", "user.name", "Agent Test"], repositoryRoot);
  fs.writeFileSync(path.join(repositoryRoot, "README.md"), "fixture\n");
  runGit(["add", "README.md"], repositoryRoot);
  runGit(["commit", "-qm", "fixture"], repositoryRoot);
  return { repositoryRoot, allocationRoot, repository: getRepositoryInfo(repositoryRoot) };
}

test("isLocalServerUrl accepts loopback and local interface addresses only", () => {
  assert.equal(isLocalServerUrl("http://127.0.0.1:4096"), true);
  assert.equal(isLocalServerUrl("http://127.8.8.8:4096"), true);
  assert.equal(isLocalServerUrl("http://localhost:4096"), true);
  assert.equal(isLocalServerUrl("http://[::1]:4096"), true);
  assert.equal(isLocalServerUrl("http://8.8.8.8:4096"), false);
  assert.equal(isLocalServerUrl("https://opencode.example.com"), false);
  assert.equal(isLocalServerUrl(""), false);
  const local = Object.values(os.networkInterfaces())
    .flat()
    .find((entry) => entry && entry.family === "IPv4" && !entry.internal);
  if (local) assert.equal(isLocalServerUrl(`http://${local.address}:4096`), true);
});

test("slugs and task IDs are safe for paths and branches", () => {
  assert.equal(sanitizeSlug("  Fix / thing! "), "Fix-thing");
  const taskId = createTaskId("Fix / thing");
  assert.match(taskId, /^Fix-thing-[0-9a-f-]{12,}$/);
});

test("worktree allocation creates a unique branch and locked linked worktree", () => {
  const fixture = fixtureRepository();
  const layout = getAgentLayout(fixture.repository, { AGENT_WORKTREE_ROOT: fixture.allocationRoot });
  const taskId = createTaskId("unit");
  const plan = makeTaskPlan({
    repository: fixture.repository,
    layout,
    taskId,
    label: "unit",
    baseCommit: fixture.repository.head,
    branch: `ai/agent/${taskId}`,
  });
  const record = { ...plan, state: "worktree-created", createdAt: new Date().toISOString() };
  try {
    withAgentLock(layout, () => {
      writeTaskRecord(layout, record);
      createWorktree(fixture.repository, plan);
    });
    assert.equal(branchExists(fixture.repository.root, plan.branch), true);
    assert.equal(getWorktreeAtPath(fixture.repository.root, plan.worktreePath)?.branch, plan.branch);
    assert.deepEqual(readTaskRecord(layout, taskId).taskId, taskId);
    assert.equal(fs.existsSync(plan.worktreePath), true);
  } finally {
    removeWorktree(fixture.repository, record, { force: true, deleteBranch: true });
    fs.rmSync(fixture.allocationRoot, { recursive: true, force: true });
    fs.rmSync(fixture.repositoryRoot, { recursive: true, force: true });
  }
});

test("records can be archived without deleting the audit copy", () => {
  const fixture = fixtureRepository();
  const layout = getAgentLayout(fixture.repository, { AGENT_WORKTREE_ROOT: fixture.allocationRoot });
  const record = { taskId: "archive-test", state: "completed", recordPath: path.join(layout.registryRoot, "archive-test.json") };
  try {
    writeTaskRecord(layout, record);
    const archived = archiveTaskRecord(layout, readTaskRecord(layout, record.taskId));
    assert.equal(fs.existsSync(archived), true);
    assert.equal(fs.existsSync(record.recordPath), false);
  } finally {
    fs.rmSync(fixture.allocationRoot, { recursive: true, force: true });
    fs.rmSync(fixture.repositoryRoot, { recursive: true, force: true });
  }
});

test("the async registry lock stays held across awaited work", async () => {
  const fixture = fixtureRepository();
  const layout = getAgentLayout(fixture.repository, { AGENT_WORKTREE_ROOT: fixture.allocationRoot });
  const events = [];
  try {
    const first = withAgentLockAsync(layout, async () => {
      events.push("first-start");
      await new Promise((resolve) => setTimeout(resolve, 30));
      events.push("first-end");
    });
    const second = withAgentLockAsync(layout, async () => {
      events.push("second");
    });
    await Promise.all([first, second]);
    assert.deepEqual(events, ["first-start", "first-end", "second"]);
  } finally {
    fs.rmSync(fixture.allocationRoot, { recursive: true, force: true });
    fs.rmSync(fixture.repositoryRoot, { recursive: true, force: true });
  }
});

test("registry locks left by a dead process are reclaimed", async () => {
  const fixture = fixtureRepository();
  const layout = getAgentLayout(fixture.repository, { AGENT_WORKTREE_ROOT: fixture.allocationRoot });
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
  assert.ok(deadPid > 0);
  const plantStaleLock = () => {
    fs.mkdirSync(layout.lockPath, { mode: 0o700 });
    fs.writeFileSync(path.join(layout.lockPath, "owner.json"), JSON.stringify({ pid: deadPid, startedAt: new Date().toISOString() }));
  };
  try {
    plantStaleLock();
    let syncRan = false;
    withAgentLock(layout, () => {
      syncRan = true;
    });
    assert.equal(syncRan, true);
    assert.equal(fs.existsSync(layout.lockPath), false);

    plantStaleLock();
    let asyncRan = false;
    await withAgentLockAsync(layout, async () => {
      asyncRan = true;
    });
    assert.equal(asyncRan, true);
    assert.equal(fs.existsSync(layout.lockPath), false);
  } finally {
    fs.rmSync(fixture.allocationRoot, { recursive: true, force: true });
    fs.rmSync(fixture.repositoryRoot, { recursive: true, force: true });
  }
});

test("concurrent processes serialize stale registry-lock recovery", async () => {
  const fixture = fixtureRepository();
  const layout = getAgentLayout(fixture.repository, { AGENT_WORKTREE_ROOT: fixture.allocationRoot });
  const activePath = path.join(fixture.allocationRoot, "active-callback");
  const modulePath = path.resolve(scriptsDir, "worktree-utils.mjs");
  const childScript = `
    import fs from "node:fs";
    import path from "node:path";
    import { pathToFileURL } from "node:url";
    const { withAgentLockAsync } = await import(pathToFileURL(process.argv[1]).href);
    const lockPath = process.argv[2];
    const activePath = process.argv[3];
    await withAgentLockAsync({ root: path.dirname(lockPath), lockPath }, async () => {
      let fd;
      try {
        fd = fs.openSync(activePath, "wx");
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        fs.writeFileSync(activePath + ".overlap", String(process.pid) + "\\n", { flag: "a" });
        return;
      }
      fs.writeSync(fd, String(process.pid));
      await new Promise((resolve) => setTimeout(resolve, 60));
      fs.closeSync(fd);
      fs.unlinkSync(activePath);
    });
  `;
  const deadPid = spawnSync(process.execPath, ["-e", ""]).pid;
  fs.mkdirSync(layout.lockPath, { mode: 0o700 });
  fs.writeFileSync(path.join(layout.lockPath, "owner.json"), JSON.stringify({ pid: deadPid }));

  const runChild = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      childScript,
      modulePath,
      layout.lockPath,
      activePath,
    ], { env: scrubbedEnv(), stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr }));
  });

  try {
    const results = await Promise.all(Array.from({ length: 4 }, runChild));
    assert.deepEqual(results.map(({ code }) => code), [0, 0, 0, 0], results.map(({ stderr }) => stderr).join("\n"));
    assert.equal(fs.existsSync(`${activePath}.overlap`), false, "callbacks must not overlap after stale-lock recovery");
    assert.equal(fs.existsSync(layout.lockPath), false);
    assert.equal(fs.existsSync(`${layout.lockPath}.reclaim`), false);
  } finally {
    fs.rmSync(fixture.allocationRoot, { recursive: true, force: true });
    fs.rmSync(fixture.repositoryRoot, { recursive: true, force: true });
  }
});

test("spawn-agent prepare-only uses the same allocation contract", () => {
  const fixture = fixtureRepository();
  const script = path.resolve(scriptsDir, "spawn-agent.mjs");
  try {
    const result = spawnSync(process.execPath, [
      script,
      "--from",
      fixture.repositoryRoot,
      "--worktree-root",
      fixture.allocationRoot,
      "--prepare-only",
      "--label",
      "subprocess",
      "--",
      "test task",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const record = JSON.parse(result.stdout);
    assert.equal(record.state, "worktree-created");
    assert.equal(getWorktreeAtPath(fixture.repository.root, record.worktreePath)?.branch, record.branch);
    const guard = spawnSync(process.execPath, [
      path.resolve(scriptsDir, "agent-worker-guard.mjs"),
      "--metadata",
      record.recordPath,
      "--expected-path",
      record.worktreePath,
    ], {
      cwd: record.worktreePath,
      env: scrubbedEnv({
        AGENT_TASK_ID: record.taskId,
        AGENT_WORKTREE_PATH: record.worktreePath,
        AGENT_WORKTREE_BRANCH: record.branch,
      }),
      encoding: "utf8",
    });
    assert.equal(guard.status, 0, guard.stderr);
    const status = spawnSync(process.execPath, [
      path.resolve(scriptsDir, "agent-status.mjs"),
      "--from",
      fixture.repositoryRoot,
      "--worktree-root",
      fixture.allocationRoot,
      "--task",
      record.taskId,
      "--json",
    ], { encoding: "utf8" });
    assert.equal(status.status, 0, status.stderr);
    assert.equal(JSON.parse(status.stdout)[0].state, "stopped-or-unknown");
    const cleanup = spawnSync(process.execPath, [
      path.resolve(scriptsDir, "agent-cleanup.mjs"),
      "--from",
      fixture.repositoryRoot,
      "--worktree-root",
      fixture.allocationRoot,
      "--task",
      record.taskId,
      "--delete-branch",
      "--json",
    ], { encoding: "utf8" });
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.equal(JSON.parse(cleanup.stdout).state, "removed");
    assert.equal(fs.existsSync(record.worktreePath), false);
  } finally {
    fs.rmSync(fixture.allocationRoot, { recursive: true, force: true });
    fs.rmSync(fixture.repositoryRoot, { recursive: true, force: true });
  }
});

test("OpenCode client sends directory routing and rejects a mismatch", async () => {
  const calls = [];
  const client = new OpenCodeClient({
    baseUrl: "http://127.0.0.1:4096",
    api: "v1",
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify({ id: "ses_test", directory: "/tmp/worker" }), { status: 200 });
    },
  });
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
  const createCall = calls.find((call) => call.options?.method === "POST");
  assert.match(createCall.url, /directory=%2Ftmp%2Fworker/);
  assert.deepEqual(JSON.parse(createCall.options.body), {
    title: "test",
    agent: "auto",
    model: { providerID: "deepseek", id: "deepseek-v4-pro", variant: "high" },
    permission: [
      { permission: "edit", pattern: "**", action: "allow" },
      { permission: "bash", pattern: "**", action: "allow" },
    ],
  });
  assert.doesNotThrow(() => OpenCodeClient.assertDirectory(session, "/tmp/worker"));
  assert.throws(() => OpenCodeClient.assertDirectory(session, "/tmp/other"), /directory mismatch/);
  assert.throws(() => new OpenCodeClient({ baseUrl: "http://user:secret@127.0.0.1:4096" }), /must not contain credentials/);
});

test("attached workers always select autonomous mode", () => {
  const args = buildWorkerArgs({ agent: "auto", model: "", variant: "", promptText: "do work" }, {
    serverUrl: "http://127.0.0.1:4096",
    worktreePath: "/tmp/worker",
    sessionId: "ses_test",
  });
  assert.deepEqual(args.slice(0, 8), [
    "run", "--attach", "http://127.0.0.1:4096", "--dir", "/tmp/worker", "--session", "ses_test", "--auto",
  ]);
});

test("bootstrap command resolves from --bootstrap-cmd, then repo config, then nothing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bootstrap-cfg-"));
  try {
    assert.equal(resolveBootstrapCommand({ bootstrap: true, bootstrapCmd: "" }, root), null);
    fs.writeFileSync(path.join(root, ".opencode-dispatch.json"), JSON.stringify({ bootstrap: "node setup.mjs" }));
    assert.equal(resolveBootstrapCommand({ bootstrap: true, bootstrapCmd: "" }, root), "node setup.mjs");
    assert.equal(resolveBootstrapCommand({ bootstrap: true, bootstrapCmd: "make x" }, root), "make x");
    assert.equal(resolveBootstrapCommand({ bootstrap: false, bootstrapCmd: "make x" }, root), null);
    fs.writeFileSync(path.join(root, ".opencode-dispatch.json"), "{ nope");
    assert.throws(() => resolveBootstrapCommand({ bootstrap: true, bootstrapCmd: "" }, root), /invalid/);
    fs.writeFileSync(path.join(root, ".opencode-dispatch.json"), JSON.stringify({ bootstrap: 3 }));
    assert.throws(() => resolveBootstrapCommand({ bootstrap: true, bootstrapCmd: "" }, root), /must be a string/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bootstrapWorker runs the repo hook in the child worktree and records it", () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bootstrap-source-"));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bootstrap-child-"));
  fs.writeFileSync(path.join(source, ".opencode-dispatch.json"), JSON.stringify({ bootstrap: "printf ran > marker.txt" }));
  const record = {
    taskId: "bootstrap-test",
    worktreePath: worktree,
    branch: "ai/agent/bootstrap-test",
    recordPath: path.join(source, "record.json"),
    sessionId: null,
  };
  try {
    const command = bootstrapWorker(
      record,
      { bootstrap: true, bootstrapCmd: "" },
      { root: source, primaryRoot: source },
      "http://127.0.0.1:1",
      { api: "v2", username: "opencode", password: "pw" },
    );
    assert.equal(command, "printf ran > marker.txt");
    assert.equal(fs.readFileSync(path.join(worktree, "marker.txt"), "utf8"), "ran");
    assert.equal(record.bootstrapCommand, command);
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test("bootstrapWorker falls back to the primary root and surfaces command failures", () => {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bootstrap-source-"));
  const primary = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bootstrap-primary-"));
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bootstrap-child-"));
  const record = {
    taskId: "bootstrap-test",
    worktreePath: worktree,
    branch: "ai/agent/bootstrap-test",
    recordPath: path.join(source, "record.json"),
    sessionId: null,
  };
  const options = { bootstrap: true, bootstrapCmd: "" };
  const auth = { api: "v2", username: "opencode", password: "pw" };
  try {
    fs.writeFileSync(path.join(primary, ".opencode-dispatch.json"), JSON.stringify({ bootstrap: "printf primary > primary.txt" }));
    const command = bootstrapWorker(record, options, { root: source, primaryRoot: primary }, "http://127.0.0.1:1", auth);
    assert.equal(command, "printf primary > primary.txt");
    assert.equal(fs.readFileSync(path.join(worktree, "primary.txt"), "utf8"), "primary");

    fs.writeFileSync(path.join(primary, ".opencode-dispatch.json"), JSON.stringify({ bootstrap: "node missing-bootstrap.mjs" }));
    assert.throws(
      () => bootstrapWorker(record, options, { root: source, primaryRoot: primary }, "http://127.0.0.1:1", auth),
      (error) => /bootstrap failed/.test(error.message)
        && /missing-bootstrap\.mjs/.test(error.message)
        && /Cannot find module|MODULE_NOT_FOUND/.test(error.message),
    );
  } finally {
    fs.rmSync(source, { recursive: true, force: true });
    fs.rmSync(primary, { recursive: true, force: true });
    fs.rmSync(worktree, { recursive: true, force: true });
  }
});

test("spawn-agent documents the --bootstrap-cmd hook in --help", () => {
  const help = spawnSync(process.execPath, [path.resolve(scriptsDir, "spawn-agent.mjs"), "--help"], { encoding: "utf8" });
  assert.match(help.stderr, /--bootstrap-cmd/);
});

test("agent-cleanup --teardown reports leftovers, removes the worktree, and deletes session rows", { skip: spawnSync("sqlite3", ["-version"]).status !== 0 }, () => {
  const fixture = fixtureRepository();
  const dbPath = path.join(fixture.allocationRoot, "opencode.db");
  try {
    const prepared = spawnSync(process.execPath, [
      path.resolve(scriptsDir, "spawn-agent.mjs"),
      "--from", fixture.repositoryRoot,
      "--worktree-root", fixture.allocationRoot,
      "--prepare-only",
      "--label", "teardown",
      "--",
      "test task",
    ], { encoding: "utf8" });
    assert.equal(prepared.status, 0, prepared.stderr);
    const record = JSON.parse(prepared.stdout);
    record.sessionId = "ses_teardown";
    writeTaskRecord(getAgentLayout(fixture.repository, { AGENT_WORKTREE_ROOT: fixture.allocationRoot }), record);

    for (let index = 0; index < 7; index += 1) fs.writeFileSync(path.join(record.worktreePath, `left-${index}.txt`), `file ${index} ${"x".repeat(200)}`);
    spawnSync("sqlite3", [dbPath, `
      PRAGMA foreign_keys=ON;
      CREATE TABLE session (id text PRIMARY KEY);
      CREATE TABLE event_sequence (aggregate_id text PRIMARY KEY, seq integer NOT NULL);
      CREATE TABLE event (id text PRIMARY KEY, aggregate_id text NOT NULL REFERENCES event_sequence(aggregate_id) ON DELETE CASCADE);
      INSERT INTO session VALUES ('ses_teardown'), ('ses_other');
      INSERT INTO event_sequence VALUES ('ses_teardown', 1), ('ses_other', 1);
      INSERT INTO event VALUES ('e1', 'ses_teardown'), ('e2', 'ses_other');`], { encoding: "utf8" });

    const cleanup = spawnSync(process.execPath, [
      path.resolve(scriptsDir, "agent-cleanup.mjs"),
      "--from", fixture.repositoryRoot,
      "--worktree-root", fixture.allocationRoot,
      "--task", record.taskId,
      "--teardown", "--force",
      "--db", dbPath,
      "--json",
    ], { encoding: "utf8" });
    assert.equal(cleanup.status, 0, cleanup.stderr);
    assert.match(cleanup.stderr, /7 file\(s\) left behind/);
    assert.match(cleanup.stderr, /\| file 0 x{60}/);
    assert.match(cleanup.stderr, /2 more \(no preview\)/);
    const result = JSON.parse(cleanup.stdout);
    assert.equal(result.leftovers.length, 7);
    assert.equal(result.leftovers[0].preview.length <= 80, true);
    assert.equal(result.leftovers[5].preview, undefined);
    assert.equal(result.database.deleted, true);
    assert.equal(result.database.via, "sql");
    assert.equal(result.database.session, 1);
    assert.equal(result.database.eventSequence, 1);
    assert.equal(fs.existsSync(record.worktreePath), false);

    const remaining = (sql) => spawnSync("sqlite3", [dbPath, sql], { encoding: "utf8" }).stdout.trim();
    assert.equal(remaining("SELECT group_concat(id) FROM session"), "ses_other");
    assert.equal(remaining("SELECT group_concat(aggregate_id) FROM event_sequence"), "ses_other");
    assert.equal(remaining("SELECT group_concat(id) FROM event"), "e2");
  } finally {
    fs.rmSync(fixture.allocationRoot, { recursive: true, force: true });
    fs.rmSync(fixture.repositoryRoot, { recursive: true, force: true });
  }
});

test("agent-cleanup --teardown deletes the session via the OpenCode server when reachable", { skip: spawnSync("sqlite3", ["-version"]).status !== 0 }, async () => {
  const fixture = fixtureRepository();
  const dbPath = path.join(fixture.allocationRoot, "opencode.db");
  const calls = [];
  let deleteDirectory = null;
  let worktreeExistedAtDelete = null;
  let stubWorktreePath = null;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    calls.push(`${req.method} ${url.pathname}`);
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && url.pathname === "/session") {
      // v1 dialect signal used by the client's auto-detection probe.
      res.end("[]");
      return;
    }
    if (req.method === "GET" && url.pathname === "/session/ses_teardown") {
      res.end(JSON.stringify({ id: "ses_teardown", directory: url.searchParams.get("directory") || "" }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/session/ses_teardown/message") {
      res.end("[]");
      return;
    }
    if (req.method === "POST" && url.pathname === "/session/ses_teardown/abort") {
      res.end("true");
      return;
    }
    if (req.method === "DELETE" && url.pathname === "/session/ses_teardown") {
      deleteDirectory = url.searchParams.get("directory");
      worktreeExistedAtDelete = stubWorktreePath ? fs.existsSync(stubWorktreePath) : null;
      // Simulate the server deleting the session row in its database, but NOT
      // the event_sequence row: if the tool fell back to SQL afterwards, it
      // would delete that row too, and the assertions below would catch it.
      spawnSync("sqlite3", [dbPath, "DELETE FROM session WHERE id = 'ses_teardown';"]);
      res.end("true");
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const prepared = spawnSync(process.execPath, [
      path.resolve(scriptsDir, "spawn-agent.mjs"),
      "--from", fixture.repositoryRoot,
      "--worktree-root", fixture.allocationRoot,
      "--prepare-only",
      "--label", "teardown-api",
      "--",
      "test task",
    ], { encoding: "utf8" });
    assert.equal(prepared.status, 0, prepared.stderr);
    const record = JSON.parse(prepared.stdout);
    record.sessionId = "ses_teardown";
    stubWorktreePath = record.worktreePath;
    writeTaskRecord(getAgentLayout(fixture.repository, { AGENT_WORKTREE_ROOT: fixture.allocationRoot }), record);

    spawnSync("sqlite3", [dbPath, `
      PRAGMA foreign_keys=ON;
      CREATE TABLE session (id text PRIMARY KEY);
      CREATE TABLE event_sequence (aggregate_id text PRIMARY KEY, seq integer NOT NULL);
      INSERT INTO session VALUES ('ses_teardown'), ('ses_other');
      INSERT INTO event_sequence VALUES ('ses_teardown', 1), ('ses_other', 1);`], { encoding: "utf8" });

    // No --force: the stub reports a matching directory, so the normal teardown
    // guards must pass and a dropped ?directory= would be caught here.
    // Async spawn, not spawnSync: this test's stub server shares the event loop,
    // and a blocking spawn would starve it so the child's requests time out.
    const child = spawn(process.execPath, [
      path.resolve(scriptsDir, "agent-cleanup.mjs"),
      "--from", fixture.repositoryRoot,
      "--worktree-root", fixture.allocationRoot,
      "--task", record.taskId,
      "--teardown",
      "--server", `http://127.0.0.1:${server.address().port}`,
      "--db", dbPath,
      "--json",
    ]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 0, stderr);
    const result = JSON.parse(stdout);
    assert.equal(result.database.deleted, true);
    assert.equal(result.database.via, "server-api");
    assert.ok(calls.includes("DELETE /session/ses_teardown"), `expected a DELETE to the server, saw: ${calls.join(", ")}`);
    assert.ok(calls.includes("POST /session/ses_teardown/abort"), `expected an abort, saw: ${calls.join(", ")}`);
    assert.equal(deleteDirectory, record.worktreePath, "the DELETE must carry the worktree as its directory");
    assert.equal(worktreeExistedAtDelete, true, "the session must be deleted before the worktree is removed");
    assert.equal(fs.existsSync(record.worktreePath), false);

    // The stub deleted the session row but not the event_sequence row. If the
    // tool had run its SQL fallback after the server delete, that row would be
    // gone too — its survival proves the delete was verification-only.
    assert.equal(result.database.session, 0);
    assert.equal(result.database.eventSequence, 1);
    assert.equal(result.database.verification, "rows remain after server delete");
    const remaining = (sql) => spawnSync("sqlite3", [dbPath, sql], { encoding: "utf8" }).stdout.trim();
    assert.equal(remaining("SELECT group_concat(id) FROM session"), "ses_other");
    assert.equal(remaining("SELECT count(*) FROM event_sequence WHERE aggregate_id = 'ses_teardown'"), "1");
    assert.equal(remaining("SELECT count(*) FROM event_sequence WHERE aggregate_id = 'ses_other'"), "1");
  } finally {
    server.close();
    fs.rmSync(fixture.allocationRoot, { recursive: true, force: true });
    fs.rmSync(fixture.repositoryRoot, { recursive: true, force: true });
  }
});

test("agent-cleanup --teardown never falls back to v1 SQL on a v2 server", { skip: spawnSync("sqlite3", ["-version"]).status !== 0 }, async () => {
  const fixture = fixtureRepository();
  const dbPath = path.join(fixture.allocationRoot, "opencode.db");
  const calls = [];
  let deleteResponse = 500;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    calls.push(`${req.method} ${url.pathname}`);
    res.setHeader("content-type", "application/json");
    const directory = decodeURIComponent(req.headers["x-opencode-directory"] || "");
    if (url.pathname === "/api/info") return res.end(JSON.stringify({ version: "2.0.32", pid: 5 }));
    if (req.method === "GET" && url.pathname === "/api/session/ses_teardown") {
      return res.end(JSON.stringify({ data: { id: "ses_teardown", location: { directory } } }));
    }
    if (req.method === "GET" && url.pathname === "/api/session/ses_teardown/message") {
      return res.end(JSON.stringify({ data: [], cursor: { previous: null, next: null } }));
    }
    if (url.pathname === "/api/session" || url.pathname === "/api/permission/request" || url.pathname === "/api/form") {
      return res.end(JSON.stringify({ data: [] }));
    }
    if (req.method === "POST" && url.pathname === "/api/session/ses_teardown/interrupt") {
      return res.end("{}");
    }
    if (req.method === "DELETE" && url.pathname === "/api/session/ses_teardown") {
      res.statusCode = deleteResponse;
      return res.end(JSON.stringify({ error: "delete failed" }));
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const prepared = spawnSync(process.execPath, [
      path.resolve(scriptsDir, "spawn-agent.mjs"),
      "--from", fixture.repositoryRoot,
      "--worktree-root", fixture.allocationRoot,
      "--prepare-only",
      "--label", "teardown-v2",
      "--",
      "test task",
    ], { encoding: "utf8" });
    assert.equal(prepared.status, 0, prepared.stderr);
    const record = JSON.parse(prepared.stdout);
    record.sessionId = "ses_teardown";
    record.serverApi = "v2";
    writeTaskRecord(getAgentLayout(fixture.repository, { AGENT_WORKTREE_ROOT: fixture.allocationRoot }), record);

    // The v1 tables are populated to prove the fallback never touches them on
    // a v2 server (a bogus "success" would delete these rows).
    spawnSync("sqlite3", [dbPath, `
      PRAGMA foreign_keys=ON;
      CREATE TABLE session (id text PRIMARY KEY);
      CREATE TABLE event_sequence (aggregate_id text PRIMARY KEY, seq integer NOT NULL);
      INSERT INTO session VALUES ('ses_teardown'), ('ses_other');
      INSERT INTO event_sequence VALUES ('ses_teardown', 1), ('ses_other', 1);`], { encoding: "utf8" });

    const child = spawn(process.execPath, [
      path.resolve(scriptsDir, "agent-cleanup.mjs"),
      "--from", fixture.repositoryRoot,
      "--worktree-root", fixture.allocationRoot,
      "--task", record.taskId,
      "--teardown",
      "--server", `http://127.0.0.1:${server.address().port}`,
      "--db", dbPath,
      "--json",
    ]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 0, stderr);
    const result = JSON.parse(stdout);
    assert.ok(calls.includes("DELETE /api/session/ses_teardown"), `expected a DELETE, saw: ${calls.join(", ")}`);
    assert.equal(result.database.deleted, false);
    assert.equal(result.database.via, undefined);
    assert.match(result.database.reason, /v2 server; direct SQL cleanup is v1-only/);
    assert.equal(fs.existsSync(record.worktreePath), false);

    const remaining = (sql) => spawnSync("sqlite3", [dbPath, sql], { encoding: "utf8" }).stdout.trim();
    assert.equal(remaining("SELECT count(*) FROM session WHERE id = 'ses_teardown'"), "1", "the v1 SQL fallback must not run on v2");
    assert.equal(remaining("SELECT count(*) FROM event_sequence WHERE aggregate_id = 'ses_teardown'"), "1");
  } finally {
    server.close();
    fs.rmSync(fixture.allocationRoot, { recursive: true, force: true });
    fs.rmSync(fixture.repositoryRoot, { recursive: true, force: true });
  }
});

test("agent-cleanup --teardown verifies a v2 server delete against the v2 tables", { skip: spawnSync("sqlite3", ["-version"]).status !== 0 }, async () => {
  const fixture = fixtureRepository();
  const dbPath = path.join(fixture.allocationRoot, "opencode.db");
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    calls.push(`${req.method} ${url.pathname}`);
    res.setHeader("content-type", "application/json");
    const directory = decodeURIComponent(req.headers["x-opencode-directory"] || "");
    if (url.pathname === "/api/info") return res.end(JSON.stringify({ version: "2.0.32", pid: 7 }));
    if (req.method === "GET" && url.pathname === "/api/session/ses_teardown") {
      return res.end(JSON.stringify({ data: { id: "ses_teardown", location: { directory } } }));
    }
    if (req.method === "GET" && url.pathname === "/api/session/ses_teardown/message") {
      return res.end(JSON.stringify({ data: [], cursor: { previous: null, next: null } }));
    }
    if (url.pathname === "/api/session" || url.pathname === "/api/permission/request" || url.pathname === "/api/form") {
      return res.end(JSON.stringify({ data: [] }));
    }
    if (req.method === "POST" && url.pathname === "/api/session/ses_teardown/interrupt") {
      return res.end("{}");
    }
    if (req.method === "DELETE" && url.pathname === "/api/session/ses_teardown") {
      spawnSync("sqlite3", [dbPath, "PRAGMA foreign_keys=ON; DELETE FROM session_v2 WHERE id = 'ses_teardown';"]);
      return res.end("{}");
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const prepared = spawnSync(process.execPath, [
      path.resolve(scriptsDir, "spawn-agent.mjs"),
      "--from", fixture.repositoryRoot,
      "--worktree-root", fixture.allocationRoot,
      "--prepare-only",
      "--label", "teardown-v2-ok",
      "--",
      "test task",
    ], { encoding: "utf8" });
    assert.equal(prepared.status, 0, prepared.stderr);
    const record = JSON.parse(prepared.stdout);
    record.sessionId = "ses_teardown";
    record.serverApi = "v2";
    writeTaskRecord(getAgentLayout(fixture.repository, { AGENT_WORKTREE_ROOT: fixture.allocationRoot }), record);

    spawnSync("sqlite3", [dbPath, `
      PRAGMA foreign_keys=ON;
      CREATE TABLE session_v2 (id text PRIMARY KEY);
      CREATE TABLE session_message (id text PRIMARY KEY, session_id text REFERENCES session_v2(id) ON DELETE CASCADE);
      INSERT INTO session_v2 VALUES ('ses_teardown'), ('ses_other');
      INSERT INTO session_message VALUES ('m1', 'ses_teardown'), ('m2', 'ses_teardown'), ('m3', 'ses_other');`], { encoding: "utf8" });

    const child = spawn(process.execPath, [
      path.resolve(scriptsDir, "agent-cleanup.mjs"),
      "--from", fixture.repositoryRoot,
      "--worktree-root", fixture.allocationRoot,
      "--task", record.taskId,
      "--teardown",
      "--server", `http://127.0.0.1:${server.address().port}`,
      "--db", dbPath,
      "--json",
    ]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => child.on("close", resolve));
    assert.equal(code, 0, stderr);
    const result = JSON.parse(stdout);
    assert.equal(result.database.deleted, true);
    assert.equal(result.database.via, "server-api");
    assert.equal(result.database.session, 0);
    assert.equal(result.database.sessionMessages, 0);
    assert.equal(result.database.verification, undefined);
    assert.equal(fs.existsSync(record.worktreePath), false);

    const remaining = (sql) => spawnSync("sqlite3", [dbPath, sql], { encoding: "utf8" }).stdout.trim();
    assert.equal(remaining("SELECT group_concat(id) FROM session_v2"), "ses_other");
    assert.equal(remaining("SELECT group_concat(id) FROM session_message"), "m3");
  } finally {
    server.close();
    fs.rmSync(fixture.allocationRoot, { recursive: true, force: true });
    fs.rmSync(fixture.repositoryRoot, { recursive: true, force: true });
  }
});
