#!/usr/bin/env node
/** Safely stop and remove one explicitly named agent task. */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { OpenCodeClient } from "./opencode-server.mjs";
import {
  archiveTaskRecord,
  canonicalPath,
  countDirty,
  getAgentLayout,
  getRepositoryInfo,
  isSameOrInside,
  processCommand,
  processIsAlive,
  processWorkingDirectory,
  readTaskRecord,
  removeWorktree,
  runGit,
  withAgentLockAsync,
  writeTaskRecord,
} from "./worktree-utils.mjs";

function usage() {
  console.error(`Usage: node scripts/agent-cleanup.mjs --task <id> [options]

Options:
  --task <id>                 Required exact task ID.
  --from <path>               Repository/worktree to inspect (default: cwd).
  --worktree-root <path>      Override AGENT_WORKTREE_ROOT.
  --server <url>              Existing OpenCode server (or record value).
  --force                     Abort session, terminate process, and remove dirty worktree.
  --delete-branch             Delete the worker branch after removing its worktree.
  --teardown                  Full teardown of a finished task: first print the files left
                              behind (first 80 bytes of the first 5), then remove the
                              worktree even if dirty and delete the session's rows from the
                              OpenCode database (session + event_sequence; event, message and
                              part cascade). Requires: a registered task whose worker
                              process has exited, no active turn, a reachable server whose
                              session directory matches the worktree (else "unknown",
                              refused), and, for the DB step, sqlite3 plus an existing
                              database (a DB failure is reported; the worktree is still
                              removed). --force bypasses the process/turn/server checks.
  --db <path>                 OpenCode database (default: $OPENCODE_DB or
                              ~/.local/share/opencode/opencode.db).
  --dry-run                   Report checks without changing anything.
  --json                      Print machine-readable output.
  -h, --help                  Show this help.

Without --force, active processes and active turns are never removed; dirty worktrees\nare removed only with --force or --teardown.`);
}

function parseArgs(argv) {
  const options = {
    task: "",
    from: process.cwd(),
    worktreeRoot: "",
    server: "",
    force: false,
    deleteBranch: false,
    teardown: false,
    db: "",
    dryRun: false,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--task") options.task = argv[++index] || "";
    else if (arg === "--from") options.from = argv[++index] || "";
    else if (arg === "--worktree-root") options.worktreeRoot = argv[++index] || "";
    else if (arg === "--server") options.server = argv[++index] || "";
    else if (arg === "--force") options.force = true;
    else if (arg === "--delete-branch") options.deleteBranch = true;
    else if (arg === "--teardown") options.teardown = true;
    else if (arg === "--db") options.db = argv[++index] || "";
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.task) throw new Error("--task is required");
  return options;
}

async function inspectSession(client, record) {
  if (!record.sessionId) return { checked: false, working: false };
  if (!client) return { checked: false, working: false, unknown: true, error: "no OpenCode server URL supplied" };
  try {
    const session = await client.getSession(record.sessionId, { directory: record.worktreePath });
    const messages = await client.messages(record.sessionId, { directory: record.worktreePath }).catch(() => []);
    const last = Array.isArray(messages) ? messages[messages.length - 1]?.info : null;
    const working = last?.role === "assistant" && !last?.time?.completed;
    const directory = session?.directory || null;
    return {
      checked: true,
      exists: Boolean(session?.id),
      working,
      directory,
      directoryMatches: Boolean(directory && canonicalPath(directory) === canonicalPath(record.worktreePath)),
      unknown: !session?.id || !directory,
    };
  } catch (error) {
    return { checked: true, exists: false, working: false, unknown: true, error: error?.message || String(error) };
  }
}

function terminate(pid) {
  if (!processIsAlive(pid)) return false;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
  const deadline = Date.now() + 5_000;
  while (processIsAlive(pid) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  if (processIsAlive(pid)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  return true;
}

function inspectProcess(record) {
  const alive = processIsAlive(record.pid);
  if (!alive) return { alive: false, matches: false };
  const command = processCommand(record.pid);
  const cwd = processWorkingDirectory(record.pid);
  const matches = Boolean(
    command &&
      record.sessionId &&
      command.includes(record.sessionId) &&
      cwd === canonicalPath(record.worktreePath),
  );
  return { alive, matches };
}

function archiveLog(layout, record) {
  if (!record.logPath) return null;
  const logPath = canonicalPath(record.logPath);
  const registryRoot = canonicalPath(layout.registryRoot);
  if (path.dirname(logPath) !== registryRoot) throw new Error(`refusing to archive a log outside the managed registry: ${record.logPath}`);
  if (!fs.existsSync(logPath)) return null;
  const archiveRoot = path.join(layout.registryRoot, "archive");
  fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
  const destination = path.join(archiveRoot, `${record.taskId}-${Date.now()}.log`);
  fs.renameSync(logPath, destination);
  return destination;
}

const PREVIEW_FILES = 5;
const PREVIEW_BYTES = 80;

/** Files a worker left uncommitted in its worktree, with a short text preview of the first few. */
function leftoverFiles(worktreePath) {
  if (!fs.existsSync(worktreePath)) return [];
  const output = runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], worktreePath);
  const entries = output.split("\0").filter(Boolean);
  const files = [];
  for (let index = 0; index < entries.length; index += 1) {
    const status = entries[index].slice(0, 2);
    files.push({ status: status.trim() || "?", path: entries[index].slice(3) });
    if (status[0] === "R" || status[0] === "C") index += 1; // skip the rename source
  }
  return files.map((file, index) => (index < PREVIEW_FILES ? { ...file, preview: previewFile(path.join(worktreePath, file.path)) } : file));
}

function previewFile(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buffer = Buffer.alloc(PREVIEW_BYTES);
    const read = fs.readSync(fd, buffer, 0, PREVIEW_BYTES, 0);
    const bytes = buffer.subarray(0, read);
    if (bytes.includes(0)) return "<binary>";
    return bytes.toString("utf8").replace(/\s+/g, " ").trim();
  } catch {
    return "<unreadable>";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function formatLeftovers(files) {
  if (files.length === 0) return "teardown: no files left behind in the worktree";
  const lines = [`teardown: ${files.length} file(s) left behind in the worktree and about to be deleted:`];
  for (const file of files) {
    lines.push(`  ${file.status.padEnd(2)} ${file.path}`);
    if (file.preview !== undefined) lines.push(`       | ${file.preview}`);
  }
  if (files.length > PREVIEW_FILES) lines.push(`  … ${files.length - PREVIEW_FILES} more (no preview)`);
  return lines.join("\n");
}

function sqlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Delete the session's rows from the OpenCode database. event rows cascade from event_sequence. */
function deleteSessionData(dbPath, sessionId) {
  if (!fs.existsSync(dbPath)) return { deleted: false, reason: `database not found: ${dbPath}` };
  const id = sqlQuote(sessionId);
  const count = (sql) => Number(execFileSync("sqlite3", ["-cmd", ".timeout 60000", dbPath, sql], { encoding: "utf8" }).trim() || 0);
  const before = { session: count(`SELECT count(*) FROM session WHERE id = ${id};`), eventSequence: count(`SELECT count(*) FROM event_sequence WHERE aggregate_id = ${id};`) };
  execFileSync(
    "sqlite3",
    ["-cmd", "PRAGMA foreign_keys=ON;", "-cmd", ".timeout 60000", dbPath, `BEGIN IMMEDIATE; DELETE FROM session WHERE id = ${id}; DELETE FROM event_sequence WHERE aggregate_id = ${id}; COMMIT;`],
    { encoding: "utf8" },
  );
  return { deleted: true, ...before };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repository = getRepositoryInfo(options.from);
  const environment = { ...process.env };
  if (options.worktreeRoot) environment.AGENT_WORKTREE_ROOT = options.worktreeRoot;
  const layout = getAgentLayout(repository, environment);
  let record;
  let result;
  await withAgentLockAsync(layout, async () => {
    record = readTaskRecord(layout, options.task);
    if (record.repositoryId !== repository.repositoryId) throw new Error("task belongs to a different repository");

    const worktreePath = canonicalPath(record.worktreePath);
    const worktreesRoot = canonicalPath(layout.worktreesRoot);
    if (!isSameOrInside(worktreePath, worktreesRoot) || path.dirname(worktreePath) !== worktreesRoot) {
      throw new Error(`refusing cleanup for worktree outside the managed root: ${record.worktreePath}`);
    }

    const client = options.server || record.serverUrl ? new OpenCodeClient({ baseUrl: options.server || record.serverUrl }) : null;
    const session = await inspectSession(client, record);
    const workerProcess = inspectProcess(record);
    const pidAlive = workerProcess.alive;
    const dirty = fs.existsSync(worktreePath) ? countDirty(worktreePath) : 0;
    const leftovers = options.teardown ? leftoverFiles(worktreePath) : undefined;
    const checks = { taskId: record.taskId, worktreePath, branch: record.branch, pidAlive, process: workerProcess, session, dirtyFiles: dirty, ...(leftovers ? { leftovers } : {}), dryRun: options.dryRun };

    if (options.dryRun) {
      result = checks;
      return;
    }
    if ((pidAlive || session.working || session.unknown || (session.exists && !session.directoryMatches) || (dirty > 0 && !options.teardown)) && !options.force) {
      throw new Error(
        `refusing cleanup: ${pidAlive ? "worker process is alive; " : ""}${session.working ? "server turn is active; " : ""}${session.unknown ? "server state is unknown; " : ""}${session.exists && !session.directoryMatches ? "server session directory does not match; " : ""}${dirty > 0 ? `${dirty} dirty file(s); ` : ""}use --force only after reviewing the task`,
      );
    }

    if (pidAlive && !workerProcess.matches) {
      throw new Error("refusing cleanup: recorded PID is alive but does not match this OpenCode session and worktree");
    }

    if (options.teardown) console.error(formatLeftovers(leftovers));
    const discard = options.force || options.teardown;
    if (options.force && client && record.sessionId) await client.abortSession(record.sessionId, { directory: record.worktreePath }).catch(() => {});
    if (options.force && workerProcess.matches) terminate(record.pid);
    writeTaskRecord(layout, { ...record, state: "cleaning" });
    removeWorktree(repository, record, { force: discard, deleteBranch: options.deleteBranch });
    const logPath = archiveLog(layout, record);
    const archivedPath = archiveTaskRecord(layout, { ...record, state: "removed", archivedAt: new Date().toISOString(), recordPath: record.recordPath });
    let database;
    if (options.teardown && record.sessionId) {
      const dbPath = options.db || process.env.OPENCODE_DB || path.join(os.homedir(), ".local/share/opencode/opencode.db");
      try {
        database = deleteSessionData(dbPath, record.sessionId);
      } catch (error) {
        database = { deleted: false, reason: error?.message || String(error) };
      }
    }
    result = { ...checks, state: "removed", archivedRecord: archivedPath, archivedLog: logPath, branchDeleted: options.deleteBranch, ...(database ? { database } : {}) };
  });
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else if (options.dryRun) console.log(JSON.stringify(result, null, 2));
  else console.log(`removed ${record.taskId}\nworktree: ${record.worktreePath}\nbranch: ${record.branch}\nrecord: ${result.archivedRecord}`);
  if (result.database && !options.json && !options.dryRun) {
    const db = result.database;
    console.log(db.deleted ? `database: deleted ${db.session} session row(s), ${db.eventSequence} event_sequence row(s)` : `database: NOT cleaned (${db.reason})`);
  }
}

try {
  await main();
} catch (error) {
  console.error(`agent-cleanup: ${error?.message || String(error)}`);
  process.exitCode = 1;
}
