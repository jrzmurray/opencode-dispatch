#!/usr/bin/env node
/** Local ownership records for tasks whose worktrees live on an OpenCode server. */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const REMOTE_TASK_RECORD_VERSION = 1;

function stateRoot(env = process.env) {
  return env.OPENCODE_DISPATCH_STATE_DIR
    || path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "opencode-dispatch");
}

function normalizeServerUrl(value) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function remoteTaskRegistryRoot(serverUrl, env = process.env) {
  const normalized = normalizeServerUrl(serverUrl);
  const key = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 20);
  return path.join(stateRoot(env), "remote-tasks", key);
}

function recordPath(serverUrl, taskId, env = process.env) {
  if (!/^[A-Za-z0-9._-]+$/.test(taskId || "")) throw new Error(`invalid task id: ${taskId}`);
  return path.join(remoteTaskRegistryRoot(serverUrl, env), `${taskId}.json`);
}

function writeAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(path.dirname(filePath), 0o700); } catch {}
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filePath);
}

export function writeRemoteTaskRecord(record, env = process.env) {
  const normalized = normalizeServerUrl(record.serverUrl);
  const file = recordPath(normalized, record.taskId, env);
  const { recordPath: _recordPath, ...persisted } = record;
  const value = {
    ...persisted,
    serverUrl: normalized,
    version: REMOTE_TASK_RECORD_VERSION,
    updatedAt: new Date().toISOString(),
  };
  writeAtomic(file, value);
  return { ...value, recordPath: file };
}

export function readRemoteTaskRecord(taskId, serverUrl = "", env = process.env) {
  if (!/^[A-Za-z0-9._-]+$/.test(taskId || "")) throw new Error(`invalid task id: ${taskId}`);
  const candidates = serverUrl
    ? [recordPath(serverUrl, taskId, env)]
    : (() => {
        const root = path.join(stateRoot(env), "remote-tasks");
        if (!fs.existsSync(root)) return [];
        return fs.readdirSync(root, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(root, entry.name, `${taskId}.json`));
      })();
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    if (record.version !== REMOTE_TASK_RECORD_VERSION) throw new Error(`unsupported remote task record version for ${taskId}`);
    if (record.taskId !== taskId) continue;
    if (serverUrl && normalizeServerUrl(record.serverUrl) !== normalizeServerUrl(serverUrl)) continue;
    return { ...record, recordPath: file };
  }
  throw new Error(`remote agent task not found: ${taskId}`);
}

export function listRemoteTaskRecords(serverUrl = "", env = process.env) {
  const roots = serverUrl
    ? [remoteTaskRegistryRoot(serverUrl, env)]
    : (() => {
        const root = path.join(stateRoot(env), "remote-tasks");
        return fs.existsSync(root)
          ? fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name))
          : [];
      })();
  return roots.flatMap((root) => {
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => {
        try {
          const record = JSON.parse(fs.readFileSync(path.join(root, entry.name), "utf8"));
          return record.version === REMOTE_TASK_RECORD_VERSION ? { ...record, recordPath: path.join(root, entry.name) } : null;
        } catch { return null; }
      })
      .filter(Boolean);
  }).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export function archiveRemoteTaskRecord(record) {
  const root = path.dirname(record.recordPath || recordPath(record.serverUrl, record.taskId));
  const archive = path.join(root, "archive");
  fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
  const destination = path.join(archive, `${record.taskId}-${Date.now()}.json`);
  if (record.recordPath && fs.existsSync(record.recordPath)) fs.renameSync(record.recordPath, destination);
  return destination;
}

export function deleteRemoteTaskRecord(record) {
  if (!record.recordPath) return;
  const expectedRoot = path.resolve(remoteTaskRegistryRoot(record.serverUrl));
  const file = path.resolve(record.recordPath);
  if (path.dirname(file) !== expectedRoot) throw new Error(`refusing to remove a remote task record outside its registry: ${record.recordPath}`);
  fs.rmSync(file, { force: true });
}
