#!/usr/bin/env node
/**
 * Create one isolated local or server-managed Git worktree and submit a task
 * session. This is the only script that should allocate child agents.
 */

import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pathPosix from "node:path/posix";
import { fileURLToPath, pathToFileURL } from "node:url";

import { OpenCodeClient } from "./opencode-server.mjs";
import { resolveAgentModel } from "./agent-config.mjs";
import { API_V1, API_V2, clientAuthEnv, clientVersion, pairingStatus } from "./api-dialect.mjs";
import { deleteRemoteTaskRecord, writeRemoteTaskRecord } from "./remote-task-utils.mjs";
import {
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
  --from <path>               Source worktree (default: current directory).
  --project <id|name|path>    Select a remote OpenCode project and resolve its path.
  --worktree-root <path>      Override AGENT_WORKTREE_ROOT.
  --server <url>              Existing OpenCode server (or OPENCODE_SERVER_URL).
  --remote                    Create and run the worktree on a v2 server.
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
  --no-bootstrap              Skip the dispatcher bootstrap hook (project setup hooks still run).
  --prepare-only              Create and register the worktree, but do not contact the server.
  --dry-run                   Print the planned allocation without changing anything.
  --foreground                Keep the OpenCode client attached to this process.
  --opencode <path>           OpenCode executable (default: opencode).
  -h, --help                  Show this help.

Safety behavior:
  - Workers start from --base (default: HEAD); uncommitted source changes stay
    in the source worktree.
  - The child path and branch are generated under an atomic registry lock.
  - The server session directory must exactly match the child worktree before launch.
  - A bare, unattached OpenCode process is never started.`);
}

function parseArgs(argv) {
  const options = {
    label: "agent",
    base: "HEAD",
    from: process.cwd(),
    fromSet: false,
    project: "",
    server: process.env.OPENCODE_SERVER_URL || "",
    remote: false,
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
    else if (arg === "--from") { options.from = argv[++index] || ""; options.fromSet = true; }
    else if (arg === "--project") options.project = argv[++index] || "";
    else if (arg === "--worktree-root") options.worktreeRoot = argv[++index] || "";
    else if (arg === "--server") options.server = argv[++index] || "";
    else if (arg === "--remote") options.remote = true;
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

export function buildWorkerArgs(options, { serverUrl, worktreePath, sessionId, api = API_V1 }) {
  // v1 attaches to a server URL with an explicit session directory; v2
  // connects with --server and roots the session at the process cwd (the
  // worktree), because `run` has no --dir flag anymore.
  const args = api === API_V2
    ? ["run", "--server", serverUrl, "--session", sessionId]
    : ["run", "--attach", serverUrl, "--dir", worktreePath, "--session", sessionId];
  // Attached workers must opt into the configured autonomous permission mode.
  // Keep this adjacent to the server flags so every attached launch gets the
  // guardrail, including launches made by callers other than the dispatch
  // shell script.
  args.push("--auto");
  if (options.agent) args.push("--agent", options.agent);
  if (options.model) {
    if (api === API_V2) {
      // v2 joins the variant to the model reference: provider/model#variant.
      args.push("--model", options.variant ? `${options.model}#${options.variant}` : options.model);
    } else {
      args.push("--model", options.model);
    }
  }
  if (options.variant && api !== API_V2) args.push("--variant", options.variant);
  args.push("--", options.promptText);
  return args;
}

function updateRecord(layout, record, patch) {
  Object.assign(record, patch);
  writeTaskRecord(layout, record);
  return record;
}

function workerEnvironment(record, serverUrl, auth = {}) {
  return {
    ...process.env,
    // Give the launched client binary the credentials for the dialect it must
    // speak (v1: OPENCODE_SERVER_PASSWORD; v2: OPENCODE_PASSWORD [+ fallback]).
    ...clientAuthEnv(auth.api, { username: auth.username, password: auth.password }),
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

export function bootstrapWorker(record, options, repository, serverUrl, auth) {
  // The config normally lives in the source checkout. For a linked worktree,
  // an untracked config may exist only in the primary repository root, so fall
  // back there before deciding there is no hook.
  let command = resolveBootstrapCommand(options, repository.root);
  if (!command && repository.primaryRoot && repository.primaryRoot !== repository.root) {
    command = resolveBootstrapCommand(options, repository.primaryRoot);
  }
  record.bootstrapCommand = command || "";
  if (!command) return null;
  const env = {
    ...workerEnvironment(record, serverUrl, auth),
    WORKTREE_TASK_ID: record.taskId,
    WORKTREE_SOURCE_PATH: repository.root,
    WORKTREE_ORIGIN: "spawned-agent",
    WORKTREE_BOOTSTRAP_CHILD: "0",
    WORKTREE_SESSION_START: "0",
  };
  process.stderr.write(`spawn-agent: bootstrap: ${command}\n`);
  try {
    execFileSync("/bin/sh", ["-c", command], {
      cwd: record.worktreePath,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const output = [String(error?.stderr || "").trim(), String(error?.stdout || "").trim()]
      .filter(Boolean)
      .join("\n");
    const detail = output || error?.message || String(error);
    throw new Error(
      `bootstrap failed in ${record.worktreePath}: ${command}\n${detail}\n` +
      "The hook runs in the child worktree, which contains tracked files only. " +
      "Commit any script it references, or pass --bootstrap-cmd with an absolute path.",
    );
  }
  process.stderr.write("spawn-agent: bootstrap: ok\n");
  return command;
}

function launchWorker(options, record, serverUrl, layout, auth) {
  const executable = resolveExecutable(options.opencode);
  const args = buildWorkerArgs(options, { serverUrl, worktreePath: record.worktreePath, sessionId: record.sessionId, api: auth.api });
  const logPath = options.foreground ? null : path.join(layout.registryRoot, `${record.taskId}.log`);
  if (logPath) fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  const logFd = logPath ? fs.openSync(logPath, "a", 0o600) : undefined;
  const child = spawn(executable, args, {
    cwd: record.worktreePath,
    env: workerEnvironment(record, serverUrl, auth),
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

function projectPath(project) {
  return project?.canonical || project?.directory || project?.worktree || project?.root || "";
}

function sameRemotePath(left, right) {
  return Boolean(left && right && pathPosix.normalize(left) === pathPosix.normalize(right));
}

function selectRemoteProject(projects, selector) {
  const byIdOrName = projects.filter((project) => project.id === selector || project.name === selector);
  if (byIdOrName.length === 1) return byIdOrName[0];
  if (byIdOrName.length > 1) {
    throw new Error(`remote project selector "${selector}" matches multiple projects; use a project ID or canonical path`);
  }
  const isPath = pathPosix.isAbsolute(selector);
  const matches = projects.filter((project) => {
    const canonical = projectPath(project);
    return isPath
      ? sameRemotePath(canonical, selector)
      : Boolean(canonical && pathPosix.basename(canonical) === selector);
  });
  if (matches.length === 0) {
    const available = projects.map((project) => `${project.name ? `${project.name} (` : ""}${project.id || "?"}${project.name ? ")" : ""}: ${projectPath(project) || "<no canonical path>"}`).join("; ");
    throw new Error(`remote project "${selector}" was not found. Available projects: ${available || "none"}`);
  }
  if (matches.length > 1) throw new Error(`remote project selector "${selector}" is ambiguous; use --project with a project ID or canonical path`);
  return matches[0];
}

async function remoteBootstrapCommand(client, options, sourcePath, canonicalPath) {
  if (!options.bootstrap) return "";
  if (options.bootstrapCmd) return options.bootstrapCmd;

  for (const directory of [...new Set([sourcePath, canonicalPath].filter(Boolean))]) {
    let contents;
    try {
      contents = await client.readFile(REPO_CONFIG_FILE, directory);
    } catch (error) {
      if (error?.status === 404) continue;
      throw new Error(`could not read ${REPO_CONFIG_FILE} from remote project ${directory}: ${error?.message || String(error)}`);
    }
    let config;
    try {
      config = JSON.parse(contents);
    } catch (error) {
      throw new Error(`invalid remote ${directory}/${REPO_CONFIG_FILE}: ${error.message}`);
    }
    const command = config?.bootstrap;
    if (command === undefined || command === null || command === "") continue;
    if (typeof command !== "string") throw new Error(`remote ${directory}/${REPO_CONFIG_FILE}: "bootstrap" must be a string`);
    return command;
  }
  return "";
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function remoteBootstrapScript(command, record, sourcePath, serverUrl) {
  const env = {
    AGENT_TASK_ID: record.taskId,
    AGENT_WORKTREE_PATH: record.worktreePath,
    AGENT_WORKTREE_BRANCH: record.branch,
    // The task record lives on the dispatching machine, not on the remote host.
    AGENT_METADATA_PATH: "",
    OPENCODE_SESSION_ID: "",
    OPENCODE_SERVER_URL: serverUrl,
    WORKTREE_TASK_ID: record.taskId,
    WORKTREE_SOURCE_PATH: sourcePath,
    WORKTREE_ORIGIN: "spawned-agent",
    WORKTREE_BOOTSTRAP_CHILD: "0",
    WORKTREE_SESSION_START: "0",
  };
  return [
    "set -e",
    ...Object.entries(env).map(([key, value]) => `export ${key}=${shellQuote(value)}`),
    command,
  ].join("\n");
}

const REMOTE_BOOTSTRAP_TIMEOUT_MS = 30 * 60 * 1000;

async function runRemoteBootstrap(client, command, record, sourcePath) {
  const shell = await client.createShell({
    directory: record.worktreePath,
    cwd: record.worktreePath,
    command: remoteBootstrapScript(command, record, sourcePath, client.baseUrl),
    timeout: REMOTE_BOOTSTRAP_TIMEOUT_MS,
  });
  if (!shell?.id) throw new Error("OpenCode server did not return a shell ID for remote bootstrap");

  try {
    const deadline = Date.now() + REMOTE_BOOTSTRAP_TIMEOUT_MS + 15_000;
    let status;
    while (Date.now() < deadline) {
      status = await client.getShell(shell.id, { directory: record.worktreePath });
      if (status?.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    if (!status || status.status === "running") {
      throw new Error(`remote bootstrap exceeded ${Math.round(REMOTE_BOOTSTRAP_TIMEOUT_MS / 60_000)} minutes`);
    }
    if (status.status !== "exited" || Number(status.exit) !== 0) {
      let output = "";
      try {
        const result = await client.getShellOutput(shell.id, { directory: record.worktreePath });
        output = result?.output || "";
      } catch (error) {
        output = `could not retrieve bootstrap output: ${error?.message || String(error)}`;
      }
      const detail = output.trim() ? `\n${output.trim()}` : "";
      throw new Error(`remote bootstrap failed (${status.status}${status.exit === undefined ? "" : `, exit ${status.exit}`})${detail}`);
    }
  } finally {
    await client.removeShell(shell.id, { directory: record.worktreePath }).catch(() => {});
  }
}

function remoteTaskPrompt(options) {
  const steps = [];
  steps.push(`Before implementation, save the complete task brief below verbatim to .opencode-task-brief.md in this worktree. Add it to the path returned by git rev-parse --git-path info/exclude so it is not included in changes. Re-read the brief before each major implementation step and whenever context is unclear.`);
  steps.push(`Keep scratch files inside this worktree. Implement the task in this remote worktree and report the files changed and any checks you ran.`);
  steps.push(`Complete task brief:\n\n\`\`\`text\n${options.promptText}\n\`\`\``);
  return steps.join("\n\n");
}

async function runRemoteTask(options) {
  if (options.parentSession) throw new Error("--parent-session is not supported for remote worktree tasks yet");
  if (options.base && options.base !== "HEAD") {
    throw new Error("custom --base refs are not supported by the remote worktree API; set the remote project to the desired base first");
  }
  if (!options.project && !pathPosix.isAbsolute(options.from)) {
    throw new Error(`remote --from must be an absolute path on the server: ${options.from}`);
  }
  if (options.worktreeRoot && !pathPosix.isAbsolute(options.worktreeRoot)) {
    throw new Error(`remote --worktree-root must be an absolute path on the server: ${options.worktreeRoot}`);
  }
  if (!options.server) throw new Error("--server or OPENCODE_SERVER_URL is required");

  const client = new OpenCodeClient({ baseUrl: options.server });
  await client.health();
  if (client.api !== API_V2) throw new Error("remote task/bulk workers require an OpenCode v2 server with the worktree API");
  if (options.project && options.fromSet) throw new Error("use either --project or --from, not both");
  const project = selectRemoteProject(await client.listProjects(), options.project || options.from);
  const canonicalPath = projectPath(project);
  if (!canonicalPath || !pathPosix.isAbsolute(canonicalPath)) {
    throw new Error(`remote project ${project.id || options.project || options.from} did not provide an absolute canonical path`);
  }
  const sourcePath = options.project ? canonicalPath : options.from;
  const projectId = project.id || projectPath(project);
  if (!projectId) throw new Error(`the remote project at ${sourcePath} has no project ID`);
  const bootstrapCommand = await remoteBootstrapCommand(client, options, sourcePath, canonicalPath);

  const taskId = createTaskId(options.label);
  const prefix = branchPrefix(process.env).replace(/\/+$/, "");
  const branch = `${prefix}/${taskId}`;
  const requestedDirectory = options.worktreeRoot
    ? pathPosix.join(options.worktreeRoot, taskId)
    : undefined;
  let worktree;
  let record = {
    taskId,
    label: options.label,
    remote: true,
    state: "creating-worktree",
    branch,
    repositoryRoot: canonicalPath,
    repositoryId: String(projectId),
    projectId: String(projectId),
    sourcePath,
    worktreePath: requestedDirectory || "",
    serverUrl: client.baseUrl,
    serverApi: client.api,
    sessionId: null,
    pid: null,
    createdAt: new Date().toISOString(),
  };
  let sessionId = "";
  try {
    worktree = await client.createWorktree({
      projectID: projectId,
      from: sourcePath,
      branch,
      ...(requestedDirectory ? { directory: requestedDirectory } : {}),
      name: taskId,
    });
    const nested = worktree?.worktree || worktree?.data?.worktree || worktree;
    const worktreePath = nested?.directory || nested?.path || nested?.worktreePath || nested?.worktree?.directory || requestedDirectory || "";
    if (!worktreePath || !pathPosix.isAbsolute(worktreePath)) {
      throw new Error(`remote worktree API did not return an absolute worktree directory (received: ${String(worktreePath)})`);
    }
    if (sameRemotePath(worktreePath, sourcePath)) throw new Error("remote worktree API returned the source project directory; refusing to edit the shared project");
    record = { ...record, worktreePath, branch: nested?.branch || branch, bootstrapCommand, state: bootstrapCommand ? "bootstrapping" : "creating-session" };
    record = writeRemoteTaskRecord(record);

    if (bootstrapCommand) {
      await runRemoteBootstrap(client, bootstrapCommand, record, sourcePath);
      record = writeRemoteTaskRecord({ ...record, state: "creating-session" });
    }

    const selectedModel = parseModel(options.model);
    const sessionModel = selectedModel
      ? { ...selectedModel, ...(options.variant ? { variant: options.variant } : {}) }
      : undefined;
    const session = await client.createSession({
      directory: worktreePath,
      title: options.label,
      agent: options.agent || "auto",
      model: sessionModel,
      permission: sessionPermissions(options),
    });
    if (!session?.id) throw new Error("OpenCode server did not return a session ID");
    sessionId = session.id;
    OpenCodeClient.assertDirectory(session, worktreePath);
    record = writeRemoteTaskRecord({ ...record, sessionId, state: "submitting" });
    await client.promptAsync(sessionId, {
      directory: worktreePath,
      text: remoteTaskPrompt(options),
      agent: options.agent || "auto",
      model: sessionModel,
    });
    record = writeRemoteTaskRecord({ ...record, state: "running" });
    console.log(JSON.stringify({ ...record, branch: record.branch, bootstrapCommand: record.bootstrapCommand || "(none)", logPath: null }));
  } catch (error) {
    let cleanupError = "";
    if (sessionId) {
      await client.abortSession(sessionId, { directory: record.worktreePath }).catch(() => {});
      try { await client.deleteSession(sessionId, { directory: record.worktreePath }); }
      catch (cleanup) { if (cleanup?.status !== 404) cleanupError = cleanup?.message || String(cleanup); }
    }
    if (!cleanupError && worktree && record.worktreePath) {
      try { await client.removeWorktree({ projectID: projectId, directory: record.worktreePath, force: true }); }
      catch (cleanup) { cleanupError = cleanup?.message || String(cleanup); }
    }
    if (cleanupError) {
      writeRemoteTaskRecord({ ...record, state: "failed-cleanup-required", sessionId, cleanupError, error: error?.message || String(error) });
      throw new Error(`${error?.message || String(error)}; remote cleanup also failed: ${cleanupError}`);
    }
    deleteRemoteTaskRecord(record);
    throw error;
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  options.promptText = promptFrom(options);
  if (options.remote && options.prepareOnly) throw new Error("--prepare-only is not supported for remote workers; remote task launch creates and submits the session in one operation");
  if (!options.dryRun && !options.prepareOnly && !options.promptText) throw new Error("a task prompt is required");
  if (!options.dryRun && !options.prepareOnly && !options.server) throw new Error("--server or OPENCODE_SERVER_URL is required");
  if (options.remote) {
    if (options.dryRun) {
      const taskId = createTaskId(options.label);
      const prefix = branchPrefix(process.env).replace(/\/+$/, "");
      console.log(JSON.stringify({ taskId, branch: `${prefix}/${taskId}`, project: options.project || null, sourcePath: options.project ? null : options.from, worktreeRoot: options.worktreeRoot || null, serverUrl: options.server, state: "dry-run", remote: true }, null, 2));
      return;
    }
    await runRemoteTask(options);
    return;
  }
  // A v2 session keeps no model unless one is sent. When the caller did not
  // pass --model, use the selected agent's effective model from opencode.json
  // (the dispatcher normally resolves this already; this covers direct use).
  if (!options.model && options.agent) {
    const resolved = resolveAgentModel({
      directory: options.from,
      agent: options.agent,
      bin: options.opencode,
    });
    if (resolved) {
      options.model = `${resolved.providerID}/${resolved.model}`;
      if (!options.variant && resolved.variant) options.variant = resolved.variant;
    }
  }
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
  let workerAuth = null;
  if (client) {
    // Preflight before allocating anything: reach the server, classify its
    // dialect, and refuse a client binary from the wrong generation.
    resolveExecutable(options.opencode);
    await client.health();
    const binary = clientVersion(options.opencode, { execFileImpl: execFileSync });
    const pairing = pairingStatus({ api: client.api, generation: binary.generation, version: binary.version });
    if (pairing.severity === "mismatch") throw new Error(pairing.reason);
    if (pairing.severity === "unknown") console.error(`spawn-agent: warning: ${pairing.reason}`);
    workerAuth = { api: client.api, username: client.username, password: client.password };
  }
  if (options.variant && !options.model) console.error("spawn-agent: warning: --variant without --model is ignored");
  // The registry lock covers ONLY shared-registry mutations (record + git
  // worktree creation, and rollback's removal). Bootstrap (minutes) and the
  // foreground worker run must NOT hold it — a foreground agent would
  // otherwise serialize every concurrent spawn-agent/agent-cleanup into the
  // 30s acquire timeout.
  await withAgentLockAsync(layout, async () => {
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
    bootstrapWorker(record, options, repository, serverUrl, workerAuth);
    updateRecord(layout, record, { state: "bootstrapped" });

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
    record.serverApi = client.api;
    OpenCodeClient.assertDirectory(session, record.worktreePath);
    updateRecord(layout, record, { sessionId: session.id, state: "session-created", serverApi: client.api });

    const workerAuthForLaunch = workerAuth || { api: client.api, username: client.username, password: client.password };
    const env = workerEnvironment(record, serverUrl, workerAuthForLaunch);
    runGuard(record, env);
    const child = launchWorker(options, record, serverUrl, layout, workerAuthForLaunch);
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
