#!/usr/bin/env node
/** Safely stop and remove one explicitly named agent task. */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isLocalServerUrl, OpenCodeClient } from "./opencode-server.mjs";
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
                              behind (first 80 bytes of the first 5), then ask a reachable
                              OpenCode server to delete the session through its native API
                              (interrupts the turn, removes the share, deletes child
                              sessions, emits session.deleted), then remove the worktree
                              even if dirty, then verify the rows are gone and fall back to
                              deleting them directly (session + event_sequence; event,
                              message and part cascade) only when the server delete failed.
                              The direct-SQL fallback and the post-delete verification only
                              run while the configured server is local (a loopback address
                              or one of this host's interface addresses); with a remote
                              server the session is deleted through it and local SQL
                              cleanup is disabled.
                              Requires: a registered task whose worker process has exited,
                              no active turn, a reachable server whose session directory
                              matches the worktree (else "unknown", refused). --force
                              bypasses the process/turn/server checks.
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

/**
 * Ask the server to delete the session before the worktree goes away, so the
 * native path runs: turn interrupted, share removed, child sessions deleted,
 * session.deleted published. A 404 means it was already deleted.
 */
async function deleteSessionViaServer(client, record, session) {
  if (!client) return { deleted: false, reason: "no OpenCode server URL supplied" };
  if (!record.sessionId) return { deleted: false, reason: "no session recorded" };
  // The server resolves sessions by ID alone (directory only picks the
  // instance), so a stale record whose session now lives elsewhere must not be
  // natively deleted (that would unshare and recurse into its children).
  if (session?.exists && !session.directoryMatches) {
    return { deleted: false, skipped: true, reason: "session directory does not match the worktree; refusing to delete by ID" };
  }
  await client.abortSession(record.sessionId, { directory: record.worktreePath }).catch(() => {});
  try {
    await client.deleteSession(record.sessionId, { directory: record.worktreePath });
  } catch (error) {
    if (error?.status === 404) return { deleted: true, alreadyGone: true };
    throw error;
  }
  return { deleted: true };
}

/** Read-only row counts for one session, used to verify a server-side delete. */
function countSessionRows(dbPath, sessionId) {
  if (!fs.existsSync(dbPath)) return { available: false, reason: `database not found: ${dbPath}` };
  const id = sqlQuote(sessionId);
  const count = (sql) => Number(execFileSync("sqlite3", ["-cmd", ".timeout 60000", dbPath, sql], { encoding: "utf8" }).trim() || 0);
  return {
    available: true,
    session: count(`SELECT count(*) FROM session WHERE id = ${id};`),
    eventSequence: count(`SELECT count(*) FROM event_sequence WHERE aggregate_id = ${id};`),
  };
}

/** Delete the session's rows from the OpenCode database. event rows cascade from event_sequence. */
function deleteSessionData(dbPath, sessionId) {
  if (!fs.existsSync(dbPath)) return { deleted: false, reason: `database not found: ${dbPath}` };
  const id = sqlQuote(sessionId);
  const count = (sql) => Number(execFileSync("sqlite3", ["-cmd", ".timeout 60000", dbPath, sql], { encoding: "utf8" }).trim() || 0);
  const before = { session: count(`SELECT count(*) FROM session WHERE id = ${id};`), eventSequence: count(`SELECT count(*) FROM event_sequence WHERE aggregate_id = ${id};`) };
  execFileSync(
    "sqlite3",
    ["-bail", "-cmd", "PRAGMA foreign_keys=ON;", "-cmd", ".timeout 60000", dbPath, `BEGIN IMMEDIATE; DELETE FROM session WHERE id = ${id}; DELETE FROM event_sequence WHERE aggregate_id = ${id}; COMMIT;`],
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

    const configuredServerUrl = options.server || record.serverUrl || process.env.OPENCODE_SERVER_URL || "";
    const client = configuredServerUrl ? new OpenCodeClient({ baseUrl: configuredServerUrl }) : null;
    // Direct SQL cleanup touches the LOCAL database, so it is only trustworthy
    // when the server (if any) is this machine: a loopback address or one of
    // this host's interface addresses. With a remote server the session must be
    // deleted through that server; the local SQL delete is disabled.
    const sqlCleanupAllowed = configuredServerUrl === "" || isLocalServerUrl(configuredServerUrl);
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

    // The server delete must run while the worktree still exists: the session's
    // directory is how the server resolves the session.
    let serverDelete;
    if (options.teardown && record.sessionId) {
      serverDelete = await deleteSessionViaServer(client, record, session).catch((error) => ({ deleted: false, reason: error?.message || String(error) }));
    }

    writeTaskRecord(layout, { ...record, state: "cleaning" });
    removeWorktree(repository, record, { force: discard, deleteBranch: options.deleteBranch });
    const logPath = archiveLog(layout, record);
    const archivedPath = archiveTaskRecord(layout, { ...record, state: "removed", archivedAt: new Date().toISOString(), recordPath: record.recordPath });
    let database;
    if (options.teardown && record.sessionId) {
      const dbPath = options.db || process.env.OPENCODE_DB || path.join(os.homedir(), ".local/share/opencode/opencode.db");
      try {
        if (serverDelete?.deleted) {
          if (!sqlCleanupAllowed) {
            database = { deleted: true, via: "server-api", verification: "skipped: server is not a local address" };
          } else {
            // Verification only: the server owns this deletion, and running the
            // SQL delete here could remove rows from a different database (a
            // second server's data dir) than the one the API just changed.
            const remaining = countSessionRows(dbPath, record.sessionId);
            database = remaining.available
              ? { deleted: true, via: "server-api", session: remaining.session, eventSequence: remaining.eventSequence, ...(remaining.session || remaining.eventSequence ? { verification: "rows remain after server delete" } : {}) }
              : { deleted: true, via: "server-api", verification: remaining.reason };
          }
        } else if (serverDelete?.skipped) {
          database = { deleted: false, reason: serverDelete.reason };
        } else if (!sqlCleanupAllowed) {
          database = { deleted: false, reason: `server ${configuredServerUrl} is not a local address; direct SQL cleanup disabled (delete the session through the server)`, ...(serverDelete?.reason ? { serverError: serverDelete.reason } : {}) };
        } else {
          const sql = deleteSessionData(dbPath, record.sessionId);
          database = { deleted: sql.deleted, via: "sql", session: sql.session, eventSequence: sql.eventSequence, ...(serverDelete?.reason ? { serverError: serverDelete.reason } : {}) };
        }
      } catch (error) {
        database = serverDelete?.deleted
          ? { deleted: true, via: "server-api", verificationError: error?.message || String(error) }
          : { deleted: false, reason: error?.message || String(error) };
      }
    }
    result = { ...checks, state: "removed", archivedRecord: archivedPath, archivedLog: logPath, branchDeleted: options.deleteBranch, ...(database ? { database } : {}) };
  });
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else if (options.dryRun) console.log(JSON.stringify(result, null, 2));
  else console.log(`removed ${record.taskId}\nworktree: ${record.worktreePath}\nbranch: ${record.branch}\nrecord: ${result.archivedRecord}`);
  if (result.database && !options.json && !options.dryRun) {
    const db = result.database;
    if (!db.deleted) console.log(`database: NOT cleaned (${db.reason})`);
    else if (db.via === "server-api") console.log(`database: deleted via OpenCode server (share and child sessions included)${db.verification ? ` — ${db.verification}` : ""}`);
    else console.log(`database: deleted via sqlite fallback (${db.session} session row(s), ${db.eventSequence} event_sequence row(s))${db.serverError ? ` — server delete skipped: ${db.serverError}` : ""}`);
  }
}

try {
  await main();
} catch (error) {
  console.error(`agent-cleanup: ${error?.message || String(error)}`);
  process.exitCode = 1;
}
