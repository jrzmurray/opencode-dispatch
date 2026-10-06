#!/usr/bin/env node
/**
 * Create one isolated Git worktree and launch one OpenCode client against the
 * existing server. This is the only script that should allocate child agents.
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { OpenCodeClient } from "./opencode-server.mjs";
import {
  assertClean,
  branchPrefix,
  canonicalPath,
  createTaskId,
  createWorktree,
  getAgentLayout,
  getRepositoryInfo,
  makeTaskPlan,
  removeWorktree,
  resolveCommit,
  withAgentLockAsync,
  writeTaskRecord,
} from "./worktree-utils.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const GUARD_SCRIPT = path.join(SCRIPT_DIR, "agent-worker-guard.mjs");

function usage() {
  console.error(`Usage: node scripts/spawn-agent.mjs [options] -- <task prompt>

Options:
  --label <name>              Human-readable label; task IDs remain unique.
  --base <ref>                Git ref to branch from (default: HEAD).
  --from <path>               Clean source worktree (default: current directory).
  --worktree-root <path>      Override AGENT_WORKTREE_ROOT.
  --server <url>              Existing OpenCode server (or OPENCODE_SERVER_URL).
  --parent-session <id>       Fork this server session instead of creating a new one.
  --agent <name>              OpenCode agent passed to the spawned client.
  --model <provider/model>    OpenCode model passed to the spawned client.
  --variant <name>            OpenCode model variant passed to the spawned client.
  --allow-edit                Allow edit tools in a newly created session.
  --allow-bash                Allow bash tools in a newly created session.
  --prompt-file <path>        Read the prompt from a file instead of argv.
  --bootstrap-cmd <cmd>       Shell command run in the child worktree after creation.
                              Default: "bootstrap" from <source>/.opencode-dispatch.json;
                              with neither, no bootstrap runs.
  --no-bootstrap              Skip child worktree bootstrap (testing/provisioned trees only).
  --prepare-only              Create and register the worktree, but do not contact the server.
  --dry-run                   Print the planned allocation without changing anything.
  --foreground                Keep the OpenCode client attached to this process.
  --opencode <path>           OpenCode executable (default: opencode).
  -h, --help                  Show this help.

Safety behavior:
  - The source worktree must be clean.
  - The child path and branch are generated under an atomic registry lock.
  - The server session directory must exactly match the child worktree before launch.
  - A bare, unattached OpenCode process is never started.`);
}

function parseArgs(argv) {
  const options = {
    label: "agent",
    base: "HEAD",
    from: process.cwd(),
    server: process.env.OPENCODE_SERVER_URL || "",
    parentSession: "",
    agent: "",
    model: "",
    variant: "",
    allowEdit: false,
    allowBash: false,
    promptFile: "",
    bootstrap: true,
    bootstrapCmd: "",
    worktreeRoot: "",
    prepareOnly: false,
    dryRun: false,
    foreground: false,
    opencode: "opencode",
    prompt: [],
  };
  let separator = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (separator) {
      options.prompt.push(arg);
      continue;
    }
    if (arg === "--") {
      separator = true;
    } else if (arg === "--label") options.label = argv[++index] || "";
    else if (arg === "--base") options.base = argv[++index] || "";
    else if (arg === "--from") options.from = argv[++index] || "";
    else if (arg === "--worktree-root") options.worktreeRoot = argv[++index] || "";
    else if (arg === "--server") options.server = argv[++index] || "";
    else if (arg === "--parent-session") options.parentSession = argv[++index] || "";
    else if (arg === "--agent") options.agent = argv[++index] || "";
    else if (arg === "--model") options.model = argv[++index] || "";
    else if (arg === "--variant") options.variant = argv[++index] || "";
    else if (arg === "--allow-edit") options.allowEdit = true;
    else if (arg === "--allow-bash") options.allowBash = true;
    else if (arg === "--prompt-file") options.promptFile = argv[++index] || "";
    else if (arg === "--bootstrap-cmd") options.bootstrapCmd = argv[++index] || "";
    else if (arg === "--no-bootstrap") options.bootstrap = false;
    else if (arg === "--prepare-only") options.prepareOnly = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--foreground") options.foreground = true;
    else if (arg === "--opencode") options.opencode = argv[++index] || "";
    else if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function promptFrom(options) {
  if (options.promptFile) {
    const promptPath = canonicalPath(options.promptFile);
    if (!fs.existsSync(promptPath)) throw new Error(`prompt file not found: ${promptPath}`);
    return fs.readFileSync(promptPath, "utf8");
  }
  return options.prompt.join(" ").trim();
}

function parseModel(value) {
  if (!value) return undefined;
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) throw new Error(`--model must be provider/model, received: ${value}`);
  return { providerID: value.slice(0, separator), id: value.slice(separator + 1) };
}

function resolveExecutable(command) {
  if (command.includes(path.sep)) {
    const absolute = canonicalPath(command);
    fs.accessSync(absolute, fs.constants.X_OK);
    return absolute;
  }
  try {
    return execFileSync("which", [command], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new Error(`OpenCode executable not found: ${command}`);
  }
}

export function buildWorkerArgs(options, { serverUrl, worktreePath, sessionId }) {
  const args = ["run", "--attach", serverUrl, "--dir", worktreePath, "--session", sessionId];
  // Attached workers must opt into the configured autonomous permission mode.
  // Keep this adjacent to --attach so every attached launch gets the guardrail,
  // including launches made by callers other than the dispatch shell script.
  args.push("--auto");
  if (options.agent) args.push("--agent", options.agent);
  if (options.model) args.push("--model", options.model);
  if (options.variant) args.push("--variant", options.variant);
  args.push("--", options.promptText);
  return args;
}

function updateRecord(layout, record, patch) {
  Object.assign(record, patch);
  writeTaskRecord(layout, record);
  return record;
}

function workerEnvironment(record, serverUrl) {
  return {
    ...process.env,
    AGENT_TASK_ID: record.taskId,
    AGENT_WORKTREE_PATH: record.worktreePath,
    AGENT_WORKTREE_BRANCH: record.branch,
    AGENT_METADATA_PATH: record.recordPath,
    OPENCODE_SESSION_ID: record.sessionId || "",
    OPENCODE_SERVER_URL: serverUrl,
  };
}

function sessionPermissions(options) {
  const permissions = [];
  if (options.allowEdit) permissions.push({ permission: "edit", pattern: "**", action: "allow" });
  if (options.allowBash) permissions.push({ permission: "bash", pattern: "**", action: "allow" });
  return permissions.length > 0 ? permissions : undefined;
}

function runGuard(record, env) {
  execFileSync(process.execPath, [GUARD_SCRIPT, "--metadata", record.recordPath, "--expected-path", record.worktreePath], {
    cwd: record.worktreePath,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export const REPO_CONFIG_FILE = ".opencode-dispatch.json";

/**
 * Resolve the per-repo bootstrap command: --bootstrap-cmd, else the "bootstrap"
 * string in <sourceRoot>/.opencode-dispatch.json, else null (no bootstrap).
 */
export function resolveBootstrapCommand(options, sourceRoot) {
  if (!options.bootstrap) return null;
  if (options.bootstrapCmd) return options.bootstrapCmd;
  const configPath = path.join(sourceRoot, REPO_CONFIG_FILE);
  if (!fs.existsSync(configPath)) return null;
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`invalid ${configPath}: ${error.message}`);
  }
  const command = config?.bootstrap;
  if (command === undefined || command === null || command === "") return null;
  if (typeof command !== "string") throw new Error(`${configPath}: "bootstrap" must be a string`);
  return command;
}

function bootstrapWorker(record, options, repository, serverUrl) {
  const command = resolveBootstrapCommand(options, repository.root);
  if (!command) return;
  const env = {
    ...workerEnvironment(record, serverUrl),
    WORKTREE_TASK_ID: record.taskId,
    WORKTREE_SOURCE_PATH: repository.root,
    WORKTREE_ORIGIN: "spawned-agent",
    WORKTREE_BOOTSTRAP_CHILD: "0",
    WORKTREE_SESSION_START: "0",
  };
  execFileSync("/bin/sh", ["-c", command], {
    cwd: record.worktreePath,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function launchWorker(options, record, serverUrl, layout) {
  const executable = resolveExecutable(options.opencode);
  const args = buildWorkerArgs(options, { serverUrl, worktreePath: record.worktreePath, sessionId: record.sessionId });
  const logPath = options.foreground ? null : path.join(layout.registryRoot, `${record.taskId}.log`);
  if (logPath) fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  const logFd = logPath ? fs.openSync(logPath, "a", 0o600) : undefined;
  const child = spawn(executable, args, {
    cwd: record.worktreePath,
    env: workerEnvironment(record, serverUrl),
    detached: !options.foreground,
    shell: false,
    stdio: options.foreground ? "inherit" : ["ignore", logFd, logFd],
  });
  if (logFd !== undefined) fs.closeSync(logFd);
  child.once("error", async (error) => {
    try {
      await withAgentLockAsync(layout, () => {
        if (fs.existsSync(record.recordPath)) {
          updateRecord(layout, record, { state: "failed", error: error?.message || String(error) });
        }
      });
    } catch {
      // The controller may have already archived the task. Never recreate its
      // active record from an asynchronous child-process callback.
    }
  });
  if (!child.pid) throw new Error("OpenCode process did not provide a PID");
  record.logPath = logPath;
  record.pid = child.pid;
  record.state = "running";
  writeTaskRecord(layout, record);
  if (!options.foreground) child.unref();
  return child;
}

async function rollback({ repository, layout, record, client, sessionId, error }) {
  updateRecord(layout, record, { state: "failed", error: error?.message || String(error) });
  if (client && sessionId) await client.abortSession(sessionId, { directory: record.worktreePath }).catch(() => {});
  try {
    removeWorktree(repository, record, { force: true, deleteBranch: true });
    fs.rmSync(record.recordPath, { force: true });
  } catch (cleanupError) {
    updateRecord(layout, record, {
      state: "failed-cleanup-required",
      cleanupError: cleanupError?.message || String(cleanupError),
    });
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  options.promptText = promptFrom(options);
  if (!options.dryRun && !options.prepareOnly && !options.promptText) throw new Error("a task prompt is required");
  if (!options.dryRun && !options.prepareOnly && !options.server) throw new Error("--server or OPENCODE_SERVER_URL is required");
  const selectedModel = parseModel(options.model);
  const sessionModel = selectedModel
    ? { ...selectedModel, ...(options.variant ? { variant: options.variant } : {}) }
    : undefined;

  const repository = getRepositoryInfo(options.from);
  const baseCommit = resolveCommit(repository.root, options.base);
  const environment = { ...process.env };
  if (options.worktreeRoot) environment.AGENT_WORKTREE_ROOT = options.worktreeRoot;
  const layout = getAgentLayout(repository, environment);
  const taskId = createTaskId(options.label);
  const prefix = branchPrefix(environment).replace(/\/+$/, "");
  const branch = `${prefix}/${taskId}`;
  const plan = makeTaskPlan({ repository, layout, taskId, label: options.label, baseCommit, branch });

  if (options.dryRun) {
    const dryRunClient = options.server ? new OpenCodeClient({ baseUrl: options.server }) : null;
    console.log(JSON.stringify({ ...plan, state: "dry-run", serverUrl: dryRunClient?.baseUrl || null }, null, 2));
    return;
  }

  let record;
  let outputRecord;
  const client = options.prepareOnly || options.dryRun ? null : new OpenCodeClient({ baseUrl: options.server });
  const serverUrl = client?.baseUrl || null;
  // The registry lock covers ONLY shared-registry mutations (record + git
  // worktree creation, and rollback's removal). Bootstrap (minutes) and the
  // foreground worker run must NOT hold it — a foreground agent would
  // otherwise serialize every concurrent spawn-agent/agent-cleanup into the
  // 30s acquire timeout.
  await withAgentLockAsync(layout, async () => {
    assertClean(repository.root);
    record = {
      ...plan,
      state: "reserved",
      serverUrl,
      sessionId: null,
      pid: null,
      logPath: null,
      createdAt: new Date().toISOString(),
    };
    writeTaskRecord(layout, record);
    try {
      createWorktree(repository, plan);
      updateRecord(layout, record, { state: "worktree-created" });
    } catch (error) {
      await rollback({ repository, layout, record, client, sessionId: null, error });
      throw error;
    }
  });
  if (options.prepareOnly) {
    console.log(JSON.stringify({ ...record, recordPath: record.recordPath }));
    return;
  }

  try {
    updateRecord(layout, record, { state: "bootstrapping" });
    bootstrapWorker(record, options, repository, serverUrl);
    updateRecord(layout, record, { state: "bootstrapped" });

    await client.health();
    updateRecord(layout, record, { state: "creating-session" });
    const session = options.parentSession
      ? await client.forkSession(options.parentSession, { directory: record.worktreePath })
      : await client.createSession({
          directory: record.worktreePath,
          title: options.label,
          agent: options.agent || undefined,
          model: sessionModel,
          permission: sessionPermissions(options),
        });
    if (!session?.id) throw new Error("OpenCode server did not return a session ID");
    record.sessionId = session.id;
    OpenCodeClient.assertDirectory(session, record.worktreePath);
    updateRecord(layout, record, { sessionId: session.id, state: "session-created" });

    const env = workerEnvironment(record, serverUrl);
    runGuard(record, env);
    const child = launchWorker(options, record, serverUrl, layout);
    if (options.foreground) {
      const exitCode = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve(signal ? 128 : code ?? 1));
      });
      updateRecord(layout, record, { state: exitCode === 0 ? "completed" : "failed", exitCode });
      process.exitCode = exitCode;
    }
    outputRecord = { ...record, recordPath: record.recordPath };
  } catch (error) {
    // Rollback mutates the shared registry (worktree removal) — take the lock
    // for it; we are OUTSIDE the acquisition phase here so this cannot
    // self-deadlock.
    await withAgentLockAsync(layout, async () => {
      await rollback({ repository, layout, record, client, sessionId: record.sessionId, error });
    });
    throw error;
  }
  // Keep the machine-readable handoff on one line so shell callers can safely
  // separate it from an attached client's human-readable output.
  console.log(JSON.stringify(outputRecord));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(`spawn-agent: ${error?.message || String(error)}`);
    process.exitCode = 1;
  }
}
