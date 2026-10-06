#!/usr/bin/env node
/**
 * Fail-closed preflight for a worker process.
 *
 * It can be used on its own or as a wrapper:
 *   node scripts/agent-worker-guard.mjs --metadata /path/task.json -- command args
 *
 * The launcher runs the check before starting OpenCode. The optional wrapper
 * mode is useful for other runtimes until a repo bootstrap hook consumes the
 * same environment contract.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";

import { AGENT_RECORD_VERSION, canonicalPath, getRepositoryInfo, getWorktreeAtPath } from "./worktree-utils.mjs";

function usage() {
  console.error(`Usage: node scripts/agent-worker-guard.mjs --metadata <task.json> [--expected-path <path>] [-- command ...]`);
}

function parseArgs(argv) {
  const options = { metadata: process.env.AGENT_METADATA_PATH || "", expectedPath: "", command: [] };
  let separator = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (separator) {
      options.command.push(arg);
      continue;
    }
    if (arg === "--") {
      separator = true;
    } else if (arg === "--metadata") {
      options.metadata = argv[++index] || "";
    } else if (arg === "--expected-path") {
      options.expectedPath = argv[++index] || "";
    } else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!options.metadata) throw new Error("--metadata is required");
  return options;
}

function readRecord(metadataPath) {
  const recordPath = canonicalPath(metadataPath);
  if (!fs.existsSync(recordPath)) throw new Error(`agent metadata not found: ${recordPath}`);
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  if (record.version !== AGENT_RECORD_VERSION) throw new Error(`unsupported agent metadata version: ${record.version ?? "missing"}`);
  if (!record.taskId || !record.worktreePath || !record.branch) throw new Error(`agent metadata is incomplete: ${recordPath}`);
  return { ...record, recordPath };
}

function assertWorker(record, expectedPath) {
  const repository = getRepositoryInfo(process.cwd());
  const cwd = canonicalPath(process.cwd());
  const expected = canonicalPath(expectedPath || record.worktreePath);
  if (record.repositoryId && record.repositoryId !== repository.repositoryId) {
    throw new Error(`worker repository mismatch: current=${repository.repositoryId}, expected=${record.repositoryId}`);
  }
  if (cwd !== expected || cwd !== canonicalPath(record.worktreePath)) {
    throw new Error(`worker cwd mismatch: cwd=${cwd}, expected=${record.worktreePath}`);
  }
  if (repository.isPrimary || repository.root === repository.primaryRoot) {
    throw new Error(`worker is running in the primary checkout: ${repository.root}`);
  }
  if (repository.root !== cwd) throw new Error(`git root mismatch: ${repository.root} (expected ${cwd})`);
  if (repository.branch !== record.branch) {
    throw new Error(`worker branch mismatch: current=${repository.branch}, expected=${record.branch}`);
  }
  const registered = getWorktreeAtPath(record.repositoryRoot, cwd);
  if (!registered) throw new Error(`worker path is not a registered git worktree: ${cwd}`);
  if (registered.branch !== record.branch) throw new Error(`registered branch mismatch: ${registered.branch} != ${record.branch}`);

  const environmentChecks = [
    ["AGENT_TASK_ID", record.taskId],
    ["AGENT_WORKTREE_PATH", record.worktreePath],
    ["AGENT_WORKTREE_BRANCH", record.branch],
    ["OPENCODE_SESSION_ID", record.sessionId],
  ];
  for (const [name, expectedValue] of environmentChecks) {
    if (process.env[name] && process.env[name] !== expectedValue) {
      throw new Error(`${name} mismatch: ${process.env[name]} != ${expectedValue}`);
    }
  }
  return { repository, cwd };
}

function runCommand(command, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env: process.env,
      stdio: "inherit",
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(signal ? 128 : code ?? 1));
  });
}

try {
  const options = parseArgs(process.argv.slice(2));
  const record = readRecord(options.metadata);
  const { cwd } = assertWorker(record, options.expectedPath);
  if (options.command.length === 0) {
    console.log(JSON.stringify({ ok: true, taskId: record.taskId, worktreePath: cwd, branch: record.branch, sessionId: record.sessionId }));
    process.exit(0);
  }
  process.exit(await runCommand(options.command, cwd));
} catch (error) {
  console.error(`agent-worker-guard: ${error?.message || String(error)}`);
  process.exit(1);
}
