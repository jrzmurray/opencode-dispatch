import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { OpenCodeClient } from "../opencode-server.mjs";
import { buildWorkerArgs, resolveBootstrapCommand } from "../spawn-agent.mjs";
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
      env: {
        ...process.env,
        AGENT_TASK_ID: record.taskId,
        AGENT_WORKTREE_PATH: record.worktreePath,
        AGENT_WORKTREE_BRANCH: record.branch,
      },
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
  assert.match(calls[0].url, /directory=%2Ftmp%2Fworker/);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
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
    assert.deepEqual(result.database, { deleted: true, session: 1, eventSequence: 1 });
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
