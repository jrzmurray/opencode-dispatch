#!/usr/bin/env node
/**
 * Shared primitives for agent worktree orchestration.
 *
 * This module deliberately uses only Node.js built-ins. It never reads project
 * configuration files, copies environment files, or invokes a shell. The
 * caller owns the lifecycle; these helpers only identify repositories, reserve
 * paths, and persist task ownership records.
 */

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const configuredLockWait = Number.parseInt(process.env.AGENT_LOCK_TIMEOUT_MS || "30000", 10);
const LOCK_WAIT_MS = Number.isFinite(configuredLockWait) && configuredLockWait > 0 ? configuredLockWait : 30_000;
const LOCK_POLL_MS = 100;

export const AGENT_RECORD_VERSION = 1;

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith(`~${path.sep}`)) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function canonicalPath(value) {
  const absolute = path.resolve(expandHome(value));
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

export function isSameOrInside(candidate, parent) {
  const relative = path.relative(canonicalPath(parent), canonicalPath(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

export function sanitizeSlug(value, fallback = "agent") {
  const slug = String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 72);
  return slug || fallback;
}

export function createTaskId(label = "agent") {
  return `${sanitizeSlug(label)}-${crypto.randomUUID().slice(0, 12)}`;
}

export function runGit(args, cwd, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (allowFailure) return "";
    const detail = error?.stderr?.toString?.().trim() || error?.message || "git command failed";
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${detail}`);
  }
}

export function getRepositoryInfo(cwd = process.cwd()) {
  const root = canonicalPath(runGit(["rev-parse", "--show-toplevel"], cwd));
  const resolveGitPath = (value) => canonicalPath(path.isAbsolute(value) ? value : path.resolve(root, value));
  const gitDir = resolveGitPath(runGit(["rev-parse", "--git-dir"], root));
  const commonDir = resolveGitPath(runGit(["rev-parse", "--git-common-dir"], root));
  const primaryRoot = canonicalPath(path.dirname(commonDir));
  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], root);
  const head = runGit(["rev-parse", "HEAD"], root);
  const repositoryId = crypto.createHash("sha256").update(commonDir).digest("hex").slice(0, 16);

  return {
    root,
    gitDir,
    commonDir,
    primaryRoot,
    branch,
    head,
    repositoryId,
    isPrimary: gitDir === commonDir,
  };
}

function parseWorktreeRecord(record) {
  const result = {};
  for (const line of record.split("\n")) {
    const separator = line.indexOf(" ");
    if (separator < 0) {
      if (line === "detached") result.detached = true;
      continue;
    }
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    result[key] = value;
  }
  return {
    path: result.worktree ? canonicalPath(result.worktree) : "",
    head: result.HEAD || "",
    branch: result.branch?.replace(/^refs\/heads\//, "") || "",
    detached: Boolean(result.detached),
    locked: result.locked || null,
    prunable: result.prunable || null,
  };
}

export function listWorktrees(repositoryRoot) {
  const porcelain = runGit(["worktree", "list", "--porcelain"], repositoryRoot);
  const records = porcelain.split(/\n\n+/).map((record) => record.trim()).filter(Boolean);
  return records.map(parseWorktreeRecord).filter((record) => record.path);
}

export function getWorktreeAtPath(repositoryRoot, worktreePath) {
  const target = canonicalPath(worktreePath);
  return listWorktrees(repositoryRoot).find((entry) => entry.path === target) || null;
}

export function assertClean(repositoryRoot) {
  const dirty = runGit(["status", "--porcelain=v1", "--untracked-files=all"], repositoryRoot);
  if (dirty) {
    throw new Error(`source worktree is dirty; commit or stash changes before spawning a worker:\n${dirty}`);
  }
}

export function resolveCommit(repositoryRoot, ref) {
  return runGit(["rev-parse", "--verify", `${ref}^{commit}`], repositoryRoot);
}

export function branchExists(repositoryRoot, branch) {
  try {
    execFileSync("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
      cwd: repositoryRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

export function defaultWorktreeRoot(env = process.env) {
  return canonicalPath(env.AGENT_WORKTREE_ROOT || path.join(os.homedir(), ".local", "share", "agent-worktrees"));
}

export function branchPrefix(env = process.env) {
  const raw = env.AGENT_BRANCH_PREFIX || "ai/agent";
  const segments = raw.split("/").map((segment) => sanitizeSlug(segment, "agent")).filter(Boolean);
  return segments.join("/") || "ai/agent";
}

export function repositoryKey(repository) {
  return `${sanitizeSlug(path.basename(repository.primaryRoot))}-${repository.repositoryId}`;
}

export function getAgentLayout(repository, env = process.env) {
  const root = defaultWorktreeRoot(env);
  const repoKey = repositoryKey(repository);
  const repositoryRoot = path.join(root, repoKey);
  const registryRoot = canonicalPath(env.AGENT_REGISTRY_ROOT || path.join(repositoryRoot, "registry"));
  return {
    root,
    repoKey,
    repositoryRoot,
    worktreesRoot: path.join(repositoryRoot, "worktrees"),
    registryRoot,
    lockPath: path.join(root, ".agent-worktrees.lock"),
  };
}

export function assertSafeWorktreePath(repository, worktreePath) {
  const target = canonicalPath(worktreePath);
  if (target === repository.primaryRoot) {
    throw new Error(`refusing to use the primary checkout as a worker worktree: ${target}`);
  }
  for (const entry of listWorktrees(repository.root)) {
    if (isSameOrInside(target, entry.path)) {
      throw new Error(`worker path is inside an existing worktree: ${target} (existing: ${entry.path})`);
    }
  }
  return target;
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

export function taskRecordPath(layout, taskId) {
  if (!/^[A-Za-z0-9._-]+$/.test(taskId)) throw new Error(`invalid task id: ${taskId}`);
  return path.join(layout.registryRoot, `${taskId}.json`);
}

export function writeTaskRecord(layout, record) {
  writeJsonAtomic(taskRecordPath(layout, record.taskId), {
    ...record,
    version: AGENT_RECORD_VERSION,
    updatedAt: new Date().toISOString(),
  });
}

export function readTaskRecord(layout, taskId) {
  const recordPath = taskRecordPath(layout, taskId);
  if (!fs.existsSync(recordPath)) throw new Error(`agent task not found: ${taskId}`);
  const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  if (record.version !== AGENT_RECORD_VERSION) throw new Error(`unsupported agent record version for ${taskId}`);
  return { ...record, recordPath };
}

export function listTaskRecords(layout) {
  if (!fs.existsSync(layout.registryRoot)) return [];
  return fs
    .readdirSync(layout.registryRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      try {
        const record = JSON.parse(fs.readFileSync(path.join(layout.registryRoot, entry.name), "utf8"));
        return record.version === AGENT_RECORD_VERSION ? { ...record, recordPath: path.join(layout.registryRoot, entry.name) } : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function archiveTaskRecord(layout, record) {
  const archiveRoot = path.join(layout.registryRoot, "archive");
  fs.mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
  const archivedPath = path.join(archiveRoot, `${record.taskId}-${Date.now()}.json`);
  fs.renameSync(record.recordPath || taskRecordPath(layout, record.taskId), archivedPath);
  return archivedPath;
}

export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function processCommand(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

export function processWorkingDirectory(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return "";
  try {
    return canonicalPath(fs.readlinkSync(`/proc/${pid}/cwd`));
  } catch {
    try {
      const output = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const entry = output.split("\n").find((line) => line.startsWith("n"));
      return entry ? canonicalPath(entry.slice(1)) : "";
    } catch {
      return "";
    }
  }
}

export function sleepSync(milliseconds) {
  const until = Date.now() + milliseconds;
  while (Date.now() < until) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(LOCK_POLL_MS, until - Date.now()));
  }
}

export function withAgentLock(layout, callback) {
  fs.mkdirSync(layout.root, { recursive: true, mode: 0o700 });
  const lockPath = layout.lockPath;
  const started = Date.now();
  let acquired = false;
  while (!acquired) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      // From here the lock is OURS: a failure below must release it.
      try {
        fs.writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, {
          mode: 0o600,
        });
      } catch (writeError) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        throw writeError;
      }
      acquired = true;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        // mkdir failed for another reason (EACCES, I/O): we never acquired the
        // lock, so removing it here would clobber another process's mutex.
        throw error;
      }
      if (Date.now() - started >= LOCK_WAIT_MS) {
        throw new Error(`agent worktree registry is locked: ${lockPath}; inspect or remove that exact stale lock if no owner is running`);
      }
      sleepSync(LOCK_POLL_MS);
    }
  }
  try {
    return callback();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

export async function withAgentLockAsync(layout, callback) {
  fs.mkdirSync(layout.root, { recursive: true, mode: 0o700 });
  const lockPath = layout.lockPath;
  const started = Date.now();
  while (true) {
    try {
      fs.mkdirSync(lockPath, { mode: 0o700 });
      // From here the lock is OURS: a failure below must release it.
      try {
        fs.writeFileSync(path.join(lockPath, "owner.json"), `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, {
          mode: 0o600,
        });
      } catch (writeError) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        throw writeError;
      }
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        // mkdir failed for another reason (EACCES, I/O): we never acquired the
        // lock, so removing it here would clobber another process's mutex.
        throw error;
      }
      if (Date.now() - started >= LOCK_WAIT_MS) {
        throw new Error(`agent worktree registry is locked: ${lockPath}; inspect or remove that exact stale lock if no owner is running`);
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
  try {
    return await callback();
  } finally {
    fs.rmSync(lockPath, { recursive: true, force: true });
  }
}

export function makeTaskPlan({ repository, layout, taskId, label, baseCommit, branch }) {
  const worktreePath = path.join(layout.worktreesRoot, taskId);
  assertSafeWorktreePath(repository, worktreePath);
  return {
    taskId,
    label: label || taskId,
    repositoryId: repository.repositoryId,
    repositoryRoot: repository.root,
    primaryRoot: repository.primaryRoot,
    sourceWorktree: repository.root,
    baseCommit,
    branch,
    worktreePath,
    recordPath: taskRecordPath(layout, taskId),
  };
}

export function createWorktree(repository, plan) {
  if (fs.existsSync(plan.worktreePath)) throw new Error(`worker path already exists: ${plan.worktreePath}`);
  if (branchExists(repository.root, plan.branch)) {
    throw new Error(`worker branch already exists: ${plan.branch}`);
  }
  fs.mkdirSync(path.dirname(plan.worktreePath), { recursive: true, mode: 0o700 });
  runGit(["worktree", "add", "-b", plan.branch, plan.worktreePath, plan.baseCommit], repository.root);
  try {
    runGit(["worktree", "lock", "--reason", `agent task ${plan.taskId}`, plan.worktreePath], repository.root);
  } catch (error) {
    runGit(["worktree", "remove", "--force", plan.worktreePath], repository.root, { allowFailure: true });
    throw error;
  }
  return canonicalPath(plan.worktreePath);
}

export function removeWorktree(repository, record, { force = false, deleteBranch = false } = {}) {
  if (!record.taskId || !record.branch?.endsWith(`/${record.taskId}`)) {
    throw new Error(`refusing to remove a worktree with an unexpected worker branch: ${record.branch || "<missing>"}`);
  }
  const registered = getWorktreeAtPath(repository.root, record.worktreePath);
  if (!registered) {
    if (fs.existsSync(record.worktreePath)) throw new Error(`path exists but is not a registered worktree: ${record.worktreePath}`);
  } else if (registered.branch !== record.branch) {
    throw new Error(`worktree branch mismatch at ${record.worktreePath}: expected ${record.branch}, found ${registered.branch}`);
  }
  if (registered) runGit(["worktree", "unlock", record.worktreePath], repository.root, { allowFailure: true });
  if (registered) runGit(["worktree", "remove", ...(force ? ["--force"] : []), record.worktreePath], repository.root);
  if (deleteBranch) runGit(["branch", ...(force ? ["-D"] : ["-d"]), record.branch], repository.root);
}

export function countDirty(repositoryRoot) {
  const output = runGit(["status", "--porcelain=v1", "--untracked-files=all"], repositoryRoot);
  return output ? output.split("\n").length : 0;
}
