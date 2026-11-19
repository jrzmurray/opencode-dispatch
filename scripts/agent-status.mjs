#!/usr/bin/env node
/** Report local or remote task ownership records and server/worktree health. */

import fs from "node:fs";
import path from "node:path";

import { isLocalServerUrl, OpenCodeClient } from "./opencode-server.mjs";
import { listRemoteTaskRecords, readRemoteTaskRecord } from "./remote-task-utils.mjs";
import {
  canonicalPath,
  countDirty,
  getAgentLayout,
  getRepositoryInfo,
  getWorktreeAtPath,
  isSameOrInside,
  listTaskRecords,
  processCommand,
  processIsAlive,
  processWorkingDirectory,
  runGit,
} from "./worktree-utils.mjs";

function usage() {
  console.error(`Usage: node scripts/agent-status.mjs [options]

Options:
  --task <id>                 Show one task.
  --from <path>               Repository/worktree to inspect (default: cwd).
  --worktree-root <path>      Override AGENT_WORKTREE_ROOT.
  --server <url>              Existing OpenCode server (or OPENCODE_SERVER_URL).
  --json                      Print machine-readable JSON.
  -h, --help                  Show this help.`);
}

function parseArgs(argv) {
  const options = { task: "", from: process.cwd(), worktreeRoot: "", server: process.env.OPENCODE_SERVER_URL || "", json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--task") options.task = argv[++index] || "";
    else if (arg === "--from") options.from = argv[++index] || "";
    else if (arg === "--worktree-root") options.worktreeRoot = argv[++index] || "";
    else if (arg === "--server") options.server = argv[++index] || "";
    else if (arg === "--json") options.json = true;
    else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function localHealth(record, layout) {
  const worktreePath = canonicalPath(record.worktreePath);
  const result = {
    pathSafe: false,
    pathExists: fs.existsSync(worktreePath),
    registered: false,
    branch: null,
    branchMatches: false,
    dirtyFiles: null,
    pidAlive: processIsAlive(record.pid),
    processMatches: false,
    processIdentity: "not-running",
  };
  if (result.pidAlive) {
    const command = processCommand(record.pid);
    const cwd = processWorkingDirectory(record.pid);
    result.processMatches = Boolean(
      command &&
        record.sessionId &&
        command.includes(record.sessionId) &&
        cwd === worktreePath,
    );
    result.processIdentity = command ? (result.processMatches ? "match" : "mismatch") : "unknown";
  }
  const worktreesRoot = canonicalPath(layout.worktreesRoot);
  if (!isSameOrInside(worktreePath, worktreesRoot) || path.dirname(worktreePath) !== worktreesRoot) {
    result.error = `record points outside the managed worktree root: ${record.worktreePath}`;
    return result;
  }
  result.pathSafe = true;
  try {
    if (!result.pathExists) return result;
    const registered = getWorktreeAtPath(record.repositoryRoot, worktreePath);
    result.registered = Boolean(registered);
    result.branch = registered?.branch || runGit(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath, { allowFailure: true }) || null;
    result.branchMatches = result.branch === record.branch;
    if (result.registered) result.dirtyFiles = countDirty(worktreePath);
  } catch (error) {
    result.error = error?.message || String(error);
  }
  return result;
}

async function serverHealth(client, record) {
  if (!client || !record.sessionId) return { checked: false };
  try {
    const session = await client.getSession(record.sessionId, { directory: record.worktreePath });
    return {
      checked: true,
      exists: Boolean(session?.id),
      directory: session?.directory || null,
      directoryMatches: Boolean(session?.directory && canonicalPath(session.directory) === canonicalPath(record.worktreePath)),
      title: session?.title || null,
    };
  } catch (error) {
    return { checked: true, exists: false, error: error?.message || String(error) };
  }
}

async function remoteServerHealth(client, record) {
  if (!client || !record.sessionId) return { checked: false, exists: false, directoryMatches: false };
  try {
    const session = await client.getSession(record.sessionId, { directory: record.worktreePath });
    const messages = await client.messages(record.sessionId, { directory: record.worktreePath, limit: 20 }).catch(() => []);
    const last = messages.at(-1);
    const working = last?.role === "user" || (last?.role === "assistant" && !last?.completed);
    return {
      checked: true,
      exists: Boolean(session?.id),
      directory: session?.directory || null,
      directoryMatches: Boolean(session?.directory && path.posix.normalize(session.directory) === path.posix.normalize(record.worktreePath)),
      working,
      title: session?.title || null,
    };
  } catch (error) {
    return { checked: true, exists: false, directoryMatches: false, error: error?.message || String(error) };
  }
}

function remoteTaskState(record, server) {
  if (!server.checked) return "server-unreachable";
  if (!server.exists) return "session-missing";
  if (!server.directoryMatches) return "session-directory-mismatch";
  if (record.state === "failed-cleanup-required") return record.state;
  if (record.state === "completed" || record.state === "failed") return record.state;
  if (server.working) return "running";
  return "idle";
}

async function remoteRows(records, serverUrl) {
  const rows = [];
  for (const record of records) {
    const configuredServerUrl = serverUrl || record.serverUrl;
    const client = configuredServerUrl ? new OpenCodeClient({ baseUrl: configuredServerUrl }) : null;
    const server = await remoteServerHealth(client, record);
    rows.push({
      taskId: record.taskId,
      label: record.label,
      state: remoteTaskState(record, server),
      branch: record.branch,
      worktreePath: record.worktreePath,
      sessionId: record.sessionId,
      pid: null,
      remote: true,
      local: { remote: true, pathExists: null, dirtyFiles: null, pidAlive: false },
      server,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      recordPath: record.recordPath,
    });
  }
  return rows;
}

function deriveState(record, local, server) {
  if (!local.pathSafe) return "invalid-record-path";
  if (!local.pathExists) return "missing-worktree";
  if (!local.registered) return "unregistered-worktree";
  if (!local.branchMatches) return "branch-mismatch";
  if (local.pidAlive && !local.processMatches) return "pid-mismatch";
  if (local.pidAlive) return "running";
  if (server.checked && server.exists && !server.directoryMatches) return "session-directory-mismatch";
  if (record.state === "failed-cleanup-required") return record.state;
  if (record.state === "completed" || record.state === "failed") return record.state;
  return "stopped-or-unknown";
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.task) {
    let remote = null;
    try { remote = readRemoteTaskRecord(options.task, options.server); } catch {}
    if (remote) {
      const rows = await remoteRows([remote], options.server);
      if (options.json) console.log(JSON.stringify(rows, null, 2));
      else {
        const row = rows[0];
        console.log("TASK\tSTATE\tBRANCH\tPID\tDIRTY\tWORKTREE\tSESSION");
        console.log([row.taskId, row.state, row.branch, "-", "remote", row.worktreePath, row.sessionId || "-"].join("\t"));
      }
      return;
    }
    if (options.server && !isLocalServerUrl(options.server)) {
      throw new Error(`remote agent task not found: ${options.task}`);
    }
  } else if (options.server && !isLocalServerUrl(options.server)) {
    const rows = await remoteRows(listRemoteTaskRecords(options.server), options.server);
    if (options.json) console.log(JSON.stringify(rows, null, 2));
    else if (rows.length === 0) console.log("No remote agent records.");
    else {
      console.log("TASK\tSTATE\tBRANCH\tPID\tDIRTY\tWORKTREE\tSESSION");
      for (const row of rows) console.log([row.taskId, row.state, row.branch, "-", "remote", row.worktreePath, row.sessionId || "-"].join("\t"));
    }
    return;
  }
  const repository = getRepositoryInfo(options.from);
  const environment = { ...process.env };
  if (options.worktreeRoot) environment.AGENT_WORKTREE_ROOT = options.worktreeRoot;
  const layout = getAgentLayout(repository, environment);
  const records = options.task ? [readOne(layout, options.task)] : listTaskRecords(layout);
  const rows = [];
  for (const record of records) {
    const local = localHealth(record, layout);
    const client = options.server || record.serverUrl ? new OpenCodeClient({ baseUrl: options.server || record.serverUrl }) : null;
    const server = await serverHealth(client, record);
    rows.push({
      taskId: record.taskId,
      label: record.label,
      state: deriveState(record, local, server),
      branch: record.branch,
      worktreePath: record.worktreePath,
      sessionId: record.sessionId,
      pid: record.pid,
      local,
      server,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      recordPath: record.recordPath,
    });
  }
  if (options.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log("No active agent records.");
    return;
  }
  console.log("TASK\tSTATE\tBRANCH\tPID\tDIRTY\tWORKTREE\tSESSION");
  for (const row of rows) {
    console.log([
      row.taskId,
      row.state,
      row.branch,
      row.pid || "-",
      row.local.dirtyFiles ?? "-",
      row.worktreePath,
      row.sessionId || "-",
    ].join("\t"));
  }
}

function readOne(layout, taskId) {
  const records = listTaskRecords(layout);
  const record = records.find((entry) => entry.taskId === taskId);
  if (!record) throw new Error(`agent task not found: ${taskId}`);
  return record;
}

try {
  await main();
} catch (error) {
  console.error(`agent-status: ${error?.message || String(error)}`);
  process.exitCode = 1;
}
