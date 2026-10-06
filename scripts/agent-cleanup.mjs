#!/usr/bin/env node
/** Safely stop and remove one explicitly named agent task. */

import fs from "node:fs";
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
  --dry-run                   Report checks without changing anything.
  --json                      Print machine-readable output.
  -h, --help                  Show this help.

Without --force, active processes, active turns, and dirty worktrees are never removed.`);
}

function parseArgs(argv) {
  const options = {
    task: "",
    from: process.cwd(),
    worktreeRoot: "",
    server: "",
    force: false,
    deleteBranch: false,
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
    const checks = { taskId: record.taskId, worktreePath, branch: record.branch, pidAlive, process: workerProcess, session, dirtyFiles: dirty, dryRun: options.dryRun };

    if (options.dryRun) {
      result = checks;
      return;
    }
    if ((pidAlive || session.working || session.unknown || (session.exists && !session.directoryMatches) || dirty > 0) && !options.force) {
      throw new Error(
        `refusing cleanup: ${pidAlive ? "worker process is alive; " : ""}${session.working ? "server turn is active; " : ""}${session.unknown ? "server state is unknown; " : ""}${session.exists && !session.directoryMatches ? "server session directory does not match; " : ""}${dirty > 0 ? `${dirty} dirty file(s); ` : ""}use --force only after reviewing the task`,
      );
    }

    if (pidAlive && !workerProcess.matches) {
      throw new Error("refusing cleanup: recorded PID is alive but does not match this OpenCode session and worktree");
    }

    if (options.force && client && record.sessionId) await client.abortSession(record.sessionId, { directory: record.worktreePath }).catch(() => {});
    if (options.force && workerProcess.matches) terminate(record.pid);
    writeTaskRecord(layout, { ...record, state: "cleaning" });
    removeWorktree(repository, record, { force: options.force, deleteBranch: options.deleteBranch });
    const logPath = archiveLog(layout, record);
    const archivedPath = archiveTaskRecord(layout, { ...record, state: "removed", archivedAt: new Date().toISOString(), recordPath: record.recordPath });
    result = { ...checks, state: "removed", archivedRecord: archivedPath, archivedLog: logPath, branchDeleted: options.deleteBranch };
  });
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else console.log(`removed ${record.taskId}\nworktree: ${record.worktreePath}\nbranch: ${record.branch}\nrecord: ${result.archivedRecord}`);
}

try {
  await main();
} catch (error) {
  console.error(`agent-cleanup: ${error?.message || String(error)}`);
  process.exitCode = 1;
}
