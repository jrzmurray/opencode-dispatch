#!/usr/bin/env node
/**
 * Prune old OpenCode sessions whose auto-generated title ends with an em dash
 * and a hyphenated slug: "… — brave-canyon".
 *
 * Sessions at least --hours old (default 24) are selected from the running
 * server. A selected session that belongs to an opencode-dispatch task/bulk
 * worker gets a full `opencode-dispatch.sh teardown --task <id>` (worktree +
 * session rows). A worker worktree left git-locked by an interrupted cleanup is
 * unlocked first. Sessions without a worker record (reviews, TUI sessions,
 * subagents) are deleted through the dispatcher's `teardown --session <id>`
 * native server delete.
 *
 * Usage:
 *   node scripts/prune-named-sessions.mjs [options]
 *
 * Options:
 *   --hours <n>            Minimum idle age in hours (default 24).
 *   --apply                Delete. Without it the script only reports.
 *   --force                Pass --force to task teardown (abort/kill + bypass
 *                          the active-turn checks). Use with care.
 *   --managed-only         Only tear down sessions with a worker record.
 *   --cascade              Allow deleting a matching parent whose descendants
 *                          are not all selected (the server delete cascades).
 *                          Without it such a parent is skipped.
 *   --profile <name>       opencode-dispatch server profile to use.
 *   --dispatcher <path>    Dispatcher to invoke (default: next to this script,
 *                          then ~/.claude/scripts/opencode-dispatch.sh).
 *   --worktree-root <path> Worker root (default: $AGENT_WORKTREE_ROOT or
 *                          ~/.local/share/agent-worktrees).
 *   --registry-root <path> Extra registry directory to scan (default:
 *                          $AGENT_REGISTRY_ROOT when set).
 *   --limit <n>            Sessions to fetch from the server (default 100000).
 *   --json                 Machine-readable summary.
 *   --quiet                Only print the summary and errors.
 *   -h, --help             Show this help.
 *
 * Server credentials are read from the same environment as the dispatcher:
 * OPENCODE_SERVER_USERNAME, OPENCODE_SERVER_PASSWORD / OPENCODE_PASSWORD, and
 * the address-keyed OPENCODE_SERVER_CREDENTIALS JSON map. A .env.local next to
 * the dispatcher, next to this script, or at ~/.claude/scripts/.env.local is
 * loaded for those four keys only; exported variables always win.
 *
 * The title test is deliberately narrow: the title must END with a literal
 * em dash surrounded by spaces followed by a hyphenated slug. "review PR #1 —
 * calm-wizard" and "agent — brave-canyon" match; "agent — Brave Canyon" does
 * not.
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import credentials from "./server-credentials.cjs";

const { normalizeMap } = credentials;

// The identity plugin appends " — " + session.slug, where the slug is a
// hyphenated lowercase token (brave-canyon, calm-wizard-2). Prefer that exact
// suffix when the API supplies a slug; the anchored pattern is the fallback for
// older servers that do not include it.
const TITLE_PATTERN = /(?:^|\s)\u2014\s+[a-z0-9]+(?:-[a-z0-9]+)+$/u;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;

function matchesTitle(session) {
  const title = String(session.title || "").trim();
  const slug = String(session.slug || "").trim();
  if (slug) return SLUG_PATTERN.test(slug) && title.endsWith(` \u2014 ${slug}`);
  return TITLE_PATTERN.test(title);
}

function usage(stream = process.stderr) {
  const source = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  const block = source.match(/\/\*\*([\s\S]*?)\*\//)?.[1] || "";
  stream.write(`${block.replace(/^ \* ?/gm, "").trim()}\n`);
}

function parseArgs(argv) {
  const options = {
    hours: 24,
    apply: false,
    force: false,
    managedOnly: false,
    cascade: false,
    profile: "",
    dispatcher: process.env.OPENCODE_DISPATCH_SCRIPT || "",
    worktreeRoot: process.env.AGENT_WORKTREE_ROOT || "",
    registryRoot: process.env.AGENT_REGISTRY_ROOT || "",
    limit: 100000,
    json: false,
    quiet: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--hours") options.hours = Number(argv[++index]);
    else if (arg === "--apply") options.apply = true;
    else if (arg === "--force") options.force = true;
    else if (arg === "--managed-only") options.managedOnly = true;
    else if (arg === "--cascade") options.cascade = true;
    else if (arg === "--profile") options.profile = argv[++index] || "";
    else if (arg === "--dispatcher") options.dispatcher = argv[++index] || "";
    else if (arg === "--worktree-root") options.worktreeRoot = argv[++index] || "";
    else if (arg === "--registry-root") options.registryRoot = argv[++index] || "";
    else if (arg === "--limit") options.limit = Number(argv[++index]);
    else if (arg === "--json") options.json = true;
    else if (arg === "--quiet") options.quiet = true;
    else if (arg === "--help" || arg === "-h") {
      usage(process.stdout);
      process.exit(0);
    } else {
      process.stderr.write(`unknown argument: ${arg}\n`);
      usage();
      process.exit(2);
    }
  }
  if (!Number.isFinite(options.hours) || options.hours < 1) {
    process.stderr.write("--hours must be a positive number\n");
    process.exit(2);
  }
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    process.stderr.write("--limit must be a positive integer\n");
    process.exit(2);
  }
  return options;
}

function resolveDispatcher(explicit) {
  if (explicit) return path.resolve(explicit);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const beside = path.join(here, "opencode-dispatch.sh");
  if (fs.existsSync(beside)) return beside;
  return path.join(os.homedir(), ".claude", "scripts", "opencode-dispatch.sh");
}

function resolveWorktreeRoot(explicit) {
  return path.resolve(explicit || path.join(os.homedir(), ".local", "share", "agent-worktrees"));
}

// Only these keys are accepted from a .env.local, matching the dispatcher's
// credential-only loader. The file is parsed, never sourced.
const CREDENTIAL_KEYS = new Set([
  "OPENCODE_SERVER_USERNAME",
  "OPENCODE_SERVER_PASSWORD",
  "OPENCODE_PASSWORD",
  "OPENCODE_SERVER_CREDENTIALS",
]);

function readCredentialFile(file) {
  const values = {};
  if (!file || !fs.existsSync(file)) return values;
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return values;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const split = line.indexOf("=");
    if (split < 1) continue;
    const key = line.slice(0, split).trim();
    if (!CREDENTIAL_KEYS.has(key)) continue;
    let value = line.slice(split + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

/** Candidate .env.local paths, most explicit first. */
function credentialFiles(dispatcher) {
  const files = [];
  if (process.env.OPENCODE_DISPATCH_ENV_FILE) files.push(path.resolve(process.env.OPENCODE_DISPATCH_ENV_FILE));
  const here = path.dirname(fileURLToPath(import.meta.url));
  files.push(path.join(path.dirname(dispatcher), ".env.local"));
  if (here !== path.dirname(dispatcher)) files.push(path.join(here, ".env.local"));
  files.push(path.join(os.homedir(), ".claude", "scripts", ".env.local"));
  return [...new Set(files)];
}

/**
 * Credential environment for dispatcher children. Exported variables win over
 * any .env.local; the two password names are one slot, as in the dispatcher.
 */
function credentialEnvironment(dispatcher) {
  const fromFiles = {};
  for (const file of credentialFiles(dispatcher)) {
    for (const [key, value] of Object.entries(readCredentialFile(file))) {
      if (fromFiles[key] === undefined) fromFiles[key] = value;
    }
  }
  const env = { ...process.env };
  const exportedPassword = env.OPENCODE_SERVER_PASSWORD || env.OPENCODE_PASSWORD || "";
  for (const key of CREDENTIAL_KEYS) {
    if (key === "OPENCODE_PASSWORD" || key === "OPENCODE_SERVER_PASSWORD") continue;
    if (env[key] === undefined && fromFiles[key] !== undefined) env[key] = fromFiles[key];
  }
  // The two password names are one slot: an exported value under either name
  // must win over either name in a file (matching the dispatcher's loader).
  const filePassword = fromFiles.OPENCODE_SERVER_PASSWORD || fromFiles.OPENCODE_PASSWORD || "";
  const password = exportedPassword || filePassword;
  if (password) env.OPENCODE_SERVER_PASSWORD = password;
  if (password) env.OPENCODE_PASSWORD = password;
  // Canonicalize through the shared parser so the dispatcher gets valid JSON
  // even when the user supplied the JavaScript-style object form.
  if (env.OPENCODE_SERVER_CREDENTIALS) {
    env.OPENCODE_SERVER_CREDENTIALS = JSON.stringify(normalizeMap(env.OPENCODE_SERVER_CREDENTIALS, "OPENCODE_SERVER_CREDENTIALS"));
  }
  return env;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  return result;
}

function updatedMs(session) {
  for (const value of [session.updated, session.time?.updated, session.time?.created]) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value < 1e12 ? value * 1000 : value;
    }
  }
  return null;
}

function addRegistry(registry, records) {
  let entries;
  try {
    entries = fs.readdirSync(registry, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    let record;
    try {
      record = JSON.parse(fs.readFileSync(path.join(registry, entry.name), "utf8"));
    } catch {
      continue;
    }
    if (!record?.sessionId || !record?.taskId || (!record?.repositoryRoot && !record?.primaryRoot)) continue;
    const previous = records.get(record.sessionId);
    if (!previous || String(record.updatedAt || "") > String(previous.updatedAt || "")) {
      records.set(record.sessionId, record);
    }
  }
}

/** sessionId -> newest registry record, across every repository under the root. */
function loadWorkerRecords(root, registryRoot = "") {
  const records = new Map();
  if (fs.existsSync(root)) {
    let repos = [];
    try {
      repos = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      repos = [];
    }
    for (const repo of repos) {
      if (!repo.isDirectory()) continue;
      addRegistry(path.join(root, repo.name, "registry"), records);
    }
  }
  // AGENT_REGISTRY_ROOT replaces <worktreeRoot>/<repo>/registry in
  // worktree-utils; scan it directly so custom layouts stay managed.
  if (registryRoot) addRegistry(path.resolve(registryRoot), records);
  return records;
}

function fmtDate(ms) {
  return ms ? new Date(ms).toISOString().replace("T", " ").slice(0, 19) : "?";
}

function canonicalPath(value) {
  const absolute = path.resolve(value);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

function isInside(parent, child) {
  const relative = path.relative(canonicalPath(parent), canonicalPath(child));
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== "..";
}

/** canonical worktree path -> locked state, from one `git worktree list`. */
function readWorktreeLocks(repositoryRoot) {
  const locks = new Map();
  const listed = run("git", ["worktree", "list", "--porcelain"], { cwd: repositoryRoot });
  if (listed.status !== 0) return locks;
  for (const block of listed.stdout.split(/\n\n+/)) {
    const lines = block.split("\n");
    const registered = lines.find((line) => line.startsWith("worktree "));
    if (!registered) continue;
    const locked = lines.some((line) => line === "locked" || line.startsWith("locked "));
    locks.set(canonicalPath(registered.slice("worktree ".length)), locked);
  }
  return locks;
}

/**
 * The launcher locks every worker worktree. Teardown unlocks it too, but an
 * interrupted teardown can leave the lock behind; clear it before teardown so
 * a retry always starts from an unlocked worktree. Only paths under the
 * configured worker root are touched. The per-repository listing is cached so
 * pruning hundreds of sessions does not re-list the same repository each time.
 */
function unlockWorktree(record, worktreeRoot, cache) {
  const worktreePath = record.worktreePath || "";
  if (!worktreePath || !isInside(worktreeRoot, worktreePath)) return null;
  const repositoryRoot = [record.repositoryRoot, record.primaryRoot].find((candidate) => candidate && fs.existsSync(candidate)) || "";
  if (!repositoryRoot) return null;
  const cacheKey = record.repositoryId || canonicalPath(repositoryRoot);
  let locks = cache.get(cacheKey);
  if (!locks) {
    try {
      locks = readWorktreeLocks(repositoryRoot);
    } catch (error) {
      return { error: error?.message || String(error) };
    }
    cache.set(cacheKey, locks);
  }
  const target = canonicalPath(worktreePath);
  if (!locks.get(target)) return null;
  let child;
  try {
    child = run("git", ["worktree", "unlock", target], { cwd: repositoryRoot });
  } catch (error) {
    return { error: error?.message || String(error) };
  }
  if (child.status === 0) {
    locks.set(target, false);
    return { unlocked: true };
  }
  return { error: (child.stderr || child.stdout || `exit ${child.status}`).trim() };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const dispatcher = resolveDispatcher(options.dispatcher);
  if (!fs.existsSync(dispatcher)) {
    process.stderr.write(`dispatcher not found: ${dispatcher}\n`);
    process.exit(2);
  }
  const worktreeRoot = resolveWorktreeRoot(options.worktreeRoot);
  const worktreeCache = new Map();
  let childEnv;
  try {
    childEnv = credentialEnvironment(dispatcher);
  } catch (error) {
    process.stderr.write(`${error?.message || String(error)}\n`);
    process.exit(2);
  }

  const listArgs = ["sessions", "--tail", String(options.limit), "--json"];
  if (options.profile) listArgs.push("--server", options.profile);
  let listed;
  try {
    listed = run(dispatcher, listArgs, { env: childEnv });
  } catch (error) {
    process.stderr.write(`could not run the dispatcher: ${error?.message || String(error)}\n`);
    process.exit(1);
  }
  if (listed.status !== 0) {
    process.stderr.write(listed.stderr || `could not list sessions (exit ${listed.status})\n`);
    process.exit(listed.status || 1);
  }
  let sessions;
  try {
    sessions = JSON.parse(listed.stdout);
  } catch {
    process.stderr.write("could not parse the dispatcher's session list as JSON\n");
    process.exit(1);
  }

  const cutoff = Date.now() - options.hours * 3_600_000;
  const self = process.env.OPENCODE_SESSION_ID || "";
  const records = loadWorkerRecords(worktreeRoot, options.registryRoot);
  const skipped = [];
  const byId = new Map(sessions.filter((session) => session?.id).map((session) => [session.id, session]));
  const childrenByParent = new Map();
  for (const session of byId.values()) {
    const parent = session.parentID || session.parentId || session.parent_id || "";
    if (!parent) continue;
    if (!childrenByParent.has(parent)) childrenByParent.set(parent, []);
    childrenByParent.get(parent).push(session.id);
  }

  const candidates = sessions
    .filter((session) => {
      if (!session?.id || !matchesTitle(session)) return false;
      const updated = updatedMs(session);
      return updated !== null && updated <= cutoff;
    })
    .map((session) => {
      const record = records.get(session.id) || null;
      return { session, record, managed: Boolean(record) };
    });

  if (self && matchesTitle(byId.get(self) || {})) {
    skipped.push({ id: self, title: byId.get(self)?.title || "", reason: "current session" });
  }

  // Managed teardowns first: the native delete cascades to matching children,
  // so many unmanaged candidates then disappear before their turn.
  candidates.sort((left, right) => Number(right.managed) - Number(left.managed));
  const selected = options.managedOnly ? candidates.filter((item) => item.managed) : candidates;
  const selectedIds = new Set(selected.map((item) => item.session.id));
  const blocked = [];

  /** Every descendant id, including the start id. */
  const descendants = (id) => {
    const found = new Set();
    const stack = [id];
    while (stack.length > 0) {
      const current = stack.pop();
      if (found.has(current)) continue;
      found.add(current);
      for (const child of childrenByParent.get(current) || []) stack.push(child);
    }
    return found;
  };

  // A native delete cascades to every child. Refuse to delete an ancestor when
  // that would also remove a session outside the selection (fresh, non-matching,
  // the current session, or unmanaged under --managed-only).
  const toDelete = options.cascade
    ? selected
    : selected.filter((item) => {
        const unsafe = [...descendants(item.session.id)].find((id) => id !== item.session.id && (id === self || !selectedIds.has(id)));
        if (!unsafe) return true;
        const child = byId.get(unsafe);
        blocked.push({
          id: item.session.id,
          title: item.session.title || "",
          reason: `would cascade to ${unsafe}${child?.title ? ` (${child.title})` : ""}`,
        });
        return false;
      });

  if (options.json) {
    const summary = {
      cutoff: new Date(cutoff).toISOString(),
      hours: options.hours,
      matched: candidates.length,
      managed: candidates.filter((item) => item.managed).length,
      unmanaged: candidates.filter((item) => !item.managed).length,
      selected: toDelete.length,
      apply: options.apply,
      skipped,
      blocked,
      sessions: toDelete.map(({ session, record, managed }) => ({
        id: session.id,
        title: session.title || "",
        updated: new Date(updatedMs(session)).toISOString(),
        directory: session.directory || null,
        managed,
        taskId: record?.taskId || null,
      })),
      results: [],
    };
    if (!options.apply || toDelete.length === 0) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return;
    }
    const results = [];
    let failed = 0;
    for (const item of toDelete) {
      const result = deleteOne(item, { options, dispatcher, worktreeRoot, childEnv, worktreeCache });
      results.push(result);
      if (!result.ok) failed += 1;
    }
    summary.results = results;
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (failed) process.exit(1);
    return;
  }

  process.stdout.write(`cutoff   : idle for at least ${options.hours}h (before ${fmtDate(cutoff)})\n`);
  process.stdout.write(`pattern  : title ends with " \u2014 <hyphenated-slug>"\n`);
  process.stdout.write(`matched  : ${candidates.length} (${candidates.filter((item) => item.managed).length} managed, ${candidates.filter((item) => !item.managed).length} unmanaged)\n`);
  if (options.managedOnly) process.stdout.write(`selected : ${toDelete.length} managed session(s) (--managed-only)\n`);
  for (const skip of skipped) {
    process.stdout.write(`skipped  : ${skip.id} (${skip.reason})\n`);
  }
  for (const skip of blocked) {
    process.stdout.write(`blocked  : ${skip.id} (${skip.reason}; use --cascade to override)\n`);
  }

  if (!options.quiet) {
    for (const { session, record } of toDelete) {
      const label = record ? `task ${record.taskId}` : "no worker record";
      process.stdout.write(`  ${session.id}  ${fmtDate(updatedMs(session))}  ${session.title || ""}  [${label}]\n`);
    }
  }

  if (!options.apply) {
    process.stdout.write(`dry run  : no sessions deleted (pass --apply to delete)\n`);
    return;
  }

  let removed = 0;
  let failed = 0;
  toDelete.forEach((item, index) => {
    if (!options.quiet) process.stdout.write(`[${index + 1}/${toDelete.length}] ${item.session.title || item.session.id}\n`);
    const result = deleteOne(item, { options, dispatcher, worktreeRoot, childEnv, worktreeCache });
    if (result.ok) removed += 1;
    else {
      failed += 1;
      process.stderr.write(`  failed: ${result.error || "unknown error"}\n`);
    }
  });
  process.stdout.write(`deleted  : ${removed}/${toDelete.length} session(s)${failed ? `, ${failed} failed` : ""}\n`);
  if (failed) process.exit(1);
}

function deleteSessionOnly({ session, options, dispatcher, childEnv, result }) {
  const args = ["teardown", "--session", session.id];
  if (session.directory) args.push("--dir", session.directory);
  if (options.profile) args.push("--server", options.profile);
  let child;
  try {
    child = run(dispatcher, args, { env: childEnv });
  } catch (error) {
    result.error = error?.message || String(error);
    return result;
  }
  result.stdout = (child.stdout || "").trim();
  result.stderr = (child.stderr || "").trim();
  result.exitCode = child.status;
  if (child.status !== 0) {
    result.error = result.stderr || result.stdout || `exit ${child.status}`;
    return result;
  }
  result.ok = true;
  if (!options.quiet && !options.json && result.stdout) process.stdout.write(`${indent(result.stdout)}\n`);
  return result;
}

function deleteOne({ session, record, managed }, { options, dispatcher, worktreeRoot, childEnv, worktreeCache }) {
  const result = { id: session.id, title: session.title || "", managed, ok: false, taskId: record?.taskId || null };
  if (!managed) return deleteSessionOnly({ session, options, dispatcher, childEnv, result });

  const repositoryRoot = [record.repositoryRoot, record.primaryRoot].find((candidate) => candidate && fs.existsSync(candidate)) || "";
  if (!repositoryRoot) {
    result.fallback = "worker repository no longer exists";
    result.warning = "session deleted without worktree cleanup";
    return deleteSessionOnly({ session, options, dispatcher, childEnv, result });
  }

  // Unlock first: a stale lock from an interrupted teardown makes the retry
  // fail when the cleanup helper tries to remove the worktree.
  const unlock = unlockWorktree(record, worktreeRoot, worktreeCache);
  if (unlock?.unlocked) {
    result.unlocked = true;
    if (!options.quiet && !options.json) process.stdout.write(`  unlocked ${record.worktreePath}\n`);
  } else if (unlock?.error) {
    result.unlockError = unlock.error;
  }

  const args = ["teardown", "--task", record.taskId, "--dir", repositoryRoot, "--json"];
  if (worktreeRoot) args.push("--worktree-root", worktreeRoot);
  if (options.force) args.push("--force");
  let child;
  try {
    child = run(dispatcher, args, { cwd: repositoryRoot, env: childEnv });
  } catch (error) {
    // A deleted/moved source checkout makes spawn fail before teardown can run.
    result.fallback = "worker repository is not usable";
    result.warning = `session deleted without worktree cleanup (${error?.message || String(error)})`;
    return deleteSessionOnly({ session, options, dispatcher, childEnv, result });
  }
  result.stdout = (child.stdout || "").trim();
  result.stderr = (child.stderr || "").trim();
  result.exitCode = child.status;
  if (child.status !== 0) {
    result.error = result.stderr || result.stdout || `exit ${child.status}`;
    return result;
  }

  let teardown;
  try {
    teardown = JSON.parse(result.stdout);
  } catch {
    // An older dispatcher may not forward --json; never call an unverified
    // teardown a failure if it exited 0.
    result.ok = true;
    result.warning = "teardown did not return JSON; session deletion was not verified";
    return result;
  }
  if (teardown?.database?.deleted === false || /rows remain/i.test(String(teardown?.database?.verification || ""))) {
    result.error = `teardown left the session in place: ${teardown?.database?.reason || teardown?.database?.verification || "database not cleaned"}`;
    return result;
  }
  result.ok = true;
  result.teardown = {
    state: teardown.state,
    database: teardown.database,
    archivedRecord: teardown.archivedRecord,
  };
  if (!options.quiet && !options.json) {
    process.stdout.write(`  removed ${record.taskId}\n`);
    if (result.stderr) process.stderr.write(`${indent(result.stderr)}\n`);
  }
  return result;
}

function indent(text) {
  return text.split("\n").map((line) => `  ${line}`).join("\n");
}

main();
