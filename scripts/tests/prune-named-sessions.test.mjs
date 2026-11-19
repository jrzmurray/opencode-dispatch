import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pruneScript = path.join(scriptsDir, "prune-named-sessions.mjs");

function fixture(extraSessions = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prune-sessions-"));
  const repository = path.join(root, "repo");
  const registry = path.join(root, "worktrees", "repo", "registry");
  fs.mkdirSync(repository, { recursive: true });
  fs.mkdirSync(registry, { recursive: true });
  fs.writeFileSync(
    path.join(registry, "task-abc.json"),
    JSON.stringify({ taskId: "task-abc", sessionId: "ses_managed", repositoryRoot: repository, updatedAt: "2026-01-01T00:00:00Z" }),
  );
  const old = Date.now() - 3 * 86_400_000;
  const fresh = Date.now();
  const sessions = [
    { id: "ses_managed", title: "agent — brave-canyon", updated: old, directory: repository },
    { id: "ses_free", title: "review PR #42 — calm-wizard", updated: old, directory: repository },
    { id: "ses_new", title: "agent — fresh-otter", updated: fresh, directory: repository },
    { id: "ses_bad", title: "agent — Brave Canyon", updated: old, directory: repository },
    ...extraSessions,
  ];
  const dispatcher = path.join(root, "dispatcher.sh");
  fs.writeFileSync(
    dispatcher,
    `#!/usr/bin/env bash
set -e
mode="$1"; shift
if [ "$mode" = sessions ]; then
  if [ -n "\${PRUNE_ENV_LOG:-}" ]; then
    {
      printf 'username=%s\\n' "\${OPENCODE_SERVER_USERNAME:-}"
      printf 'server_password=%s\\n' "\${OPENCODE_SERVER_PASSWORD:-}"
      printf 'password=%s\\n' "\${OPENCODE_PASSWORD:-}"
      printf 'credentials=%s\\n' "\${OPENCODE_SERVER_CREDENTIALS:-}"
      printf 'ignored=%s\\n' "\${PRUNE_IGNORED:-}"
    } > "$PRUNE_ENV_LOG"
  fi
  printf '%s\\n' '${JSON.stringify(sessions)}'
  exit 0
fi
if [ "$mode" = teardown ]; then
  printf '%s\\n' "$*" >> "${path.join(root, "calls.log")}"
  case " $* " in
    *" --task "*)
      if [ "\${PRUNE_FAIL_TEARDOWN:-}" = "1" ]; then
        printf '%s\\n' '{"state":"removed","database":{"deleted":false,"reason":"simulated failure"}}'
      else
        printf '%s\\n' '{"state":"removed","database":{"deleted":true}}'
      fi ;;
    *) printf 'deleted %s\\n' "$*" ;;
  esac
  exit 0
fi
exit 2
`,
  );
  fs.chmodSync(dispatcher, 0o755);
  return { root, dispatcher, worktrees: path.join(root, "worktrees"), repository };
}

function runPrune(fx, args, extraEnv = {}) {
  const env = { ...process.env, OPENCODE_SESSION_ID: "", ...extraEnv };
  for (const key of [
    "OPENCODE_SERVER_USERNAME",
    "OPENCODE_SERVER_PASSWORD",
    "OPENCODE_PASSWORD",
    "OPENCODE_SERVER_CREDENTIALS",
    "OPENCODE_DISPATCH_ENV_FILE",
    "PRUNE_IGNORED",
    "PRUNE_ENV_LOG",
    "PRUNE_FAIL_TEARDOWN",
  ]) {
    if (!(key in extraEnv)) delete env[key];
  }
  return spawnSync(process.execPath, [pruneScript, "--dispatcher", fx.dispatcher, "--worktree-root", fx.worktrees, ...args], {
    encoding: "utf8",
    env,
  });
}

test("prune-named-sessions matches only old em-dash slug titles", () => {
  const fx = fixture();
  try {
    const dry = runPrune(fx, []);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /matched\s*: 2 \(1 managed, 1 unmanaged\)/);
    assert.match(dry.stdout, /ses_managed/);
    assert.match(dry.stdout, /ses_free/);
    assert.doesNotMatch(dry.stdout, /ses_new/);
    assert.doesNotMatch(dry.stdout, /ses_bad/);
    assert.match(dry.stdout, /dry run/);
    assert.equal(fs.existsSync(path.join(fx.root, "calls.log")), false);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("prune-named-sessions --apply uses task teardown for workers and session delete for the rest", () => {
  const fx = fixture();
  try {
    const applied = runPrune(fx, ["--apply"]);
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /deleted\s*: 2\/2/);
    const calls = fs.readFileSync(path.join(fx.root, "calls.log"), "utf8").trim().split("\n");
    assert.ok(calls.some((line) => line.includes("--task task-abc") && line.includes(`--dir ${fx.repository}`)));
    assert.ok(calls.some((line) => line.includes("--session ses_free")));
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("prune-named-sessions --managed-only skips sessions without a worker record", () => {
  const fx = fixture();
  try {
    const applied = runPrune(fx, ["--apply", "--managed-only"]);
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /deleted\s*: 1\/1/);
    const calls = fs.readFileSync(path.join(fx.root, "calls.log"), "utf8");
    assert.match(calls, /--task task-abc/);
    assert.doesNotMatch(calls, /--session ses_free/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("prune-named-sessions refuses to cascade into an unselected child unless --cascade", () => {
  const old = Date.now() - 3 * 86_400_000;
  const fresh = Date.now();
  const fx = fixture([
    { id: "ses_parent", title: "agent — old-parent", slug: "old-parent", updated: old, directory: "/tmp/repo" },
    { id: "ses_child", title: "agent — fresh-child", slug: "fresh-child", updated: fresh, parentID: "ses_parent", directory: "/tmp/repo" },
  ]);
  try {
    const dry = runPrune(fx, []);
    assert.equal(dry.status, 0, dry.stderr);
    assert.match(dry.stdout, /blocked\s*: ses_parent/);
    assert.doesNotMatch(dry.stdout, /^  ses_parent/m);

    const applied = runPrune(fx, ["--apply", "--cascade"]);
    assert.equal(applied.status, 0, applied.stderr);
    const calls = fs.readFileSync(path.join(fx.root, "calls.log"), "utf8");
    assert.match(calls, /--session ses_parent/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("prune-named-sessions fails when teardown reports the session was not cleaned", () => {
  const fx = fixture();
  try {
    const applied = runPrune(fx, ["--apply"], { PRUNE_FAIL_TEARDOWN: "1" });
    assert.equal(applied.status, 1);
    assert.match(applied.stderr, /left the session in place/);
    assert.match(applied.stdout, /deleted\s*: 1\/2/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("prune-named-sessions unlocks a managed worktree before teardown", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prune-locked-"));
  const repository = path.join(root, "repo");
  const worktrees = path.join(root, "worktrees");
  const worktree = path.join(worktrees, "repo", "worktrees", "task-locked");
  const registry = path.join(worktrees, "repo", "registry");
  const callsLog = path.join(root, "calls.log");
  const git = (cwd, args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  try {
    fs.mkdirSync(repository, { recursive: true });
    git(repository, ["init", "-q"]);
    git(repository, ["config", "user.email", "prune@example.test"]);
    git(repository, ["config", "user.name", "Prune Test"]);
    fs.writeFileSync(path.join(repository, "README.md"), "hello\n");
    git(repository, ["add", "README.md"]);
    git(repository, ["commit", "-qm", "init"]);
    fs.mkdirSync(registry, { recursive: true });
    fs.mkdirSync(path.dirname(worktree), { recursive: true });
    git(repository, ["worktree", "add", "-q", "-b", "ai/agent/task-locked", worktree, "HEAD"]);
    git(repository, ["worktree", "lock", "--reason", "agent task task-locked", worktree]);
    fs.writeFileSync(
      path.join(registry, "task-locked.json"),
      JSON.stringify({
        taskId: "task-locked",
        sessionId: "ses_locked",
        repositoryRoot: repository,
        worktreePath: worktree,
        updatedAt: "2026-01-01T00:00:00Z",
      }),
    );

    const old = Date.now() - 3 * 86_400_000;
    const dispatcher = path.join(root, "dispatcher.sh");
    fs.writeFileSync(
      dispatcher,
      `#!/usr/bin/env bash
set -e
mode="$1"; shift
if [ "$mode" = sessions ]; then
  printf '%s\\n' '${JSON.stringify([{ id: "ses_locked", title: "agent — locked-otter", updated: old, directory: worktree }])}'
  exit 0
fi
if [ "$mode" = teardown ]; then
  if git -C "${repository}" worktree list --porcelain | grep -q '^locked'; then
    printf 'locked=yes\\n' >> "${callsLog}"
  else
    printf 'locked=no\\n' >> "${callsLog}"
  fi
  printf '%s\\n' '{"state":"removed","database":{"deleted":true}}'
  exit 0
fi
exit 2
`,
    );
    fs.chmodSync(dispatcher, 0o755);

    const applied = spawnSync(
      process.execPath,
      [pruneScript, "--dispatcher", dispatcher, "--worktree-root", worktrees, "--apply"],
      { encoding: "utf8", env: { ...process.env, OPENCODE_SESSION_ID: "" } },
    );
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /unlocked /);
    assert.equal(fs.readFileSync(callsLog, "utf8").trim(), "locked=no");
  } finally {
    spawnSync("git", ["worktree", "unlock", worktree], { cwd: repository, encoding: "utf8" });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prune-named-sessions lists each repository's worktrees once per run", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prune-cache-"));
  const repository = path.join(root, "repo");
  const worktrees = path.join(root, "worktrees");
  const registry = path.join(worktrees, "repo", "registry");
  const gitLog = path.join(root, "git.log");
  const callsLog = path.join(root, "calls.log");
  const bin = path.join(root, "bin");
  const realGit = spawnSync("which", ["git"], { encoding: "utf8" }).stdout.trim();
  const git = (cwd, args) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const old = Date.now() - 3 * 86_400_000;
  const taskIds = ["task-one", "task-two"];
  const worktreePaths = taskIds.map((taskId) => path.join(worktrees, "repo", "worktrees", taskId));
  try {
    fs.mkdirSync(repository, { recursive: true });
    git(repository, ["init", "-q"]);
    git(repository, ["config", "user.email", "prune@example.test"]);
    git(repository, ["config", "user.name", "Prune Test"]);
    fs.writeFileSync(path.join(repository, "README.md"), "hello\n");
    git(repository, ["add", "README.md"]);
    git(repository, ["commit", "-qm", "init"]);
    fs.mkdirSync(registry, { recursive: true });
    const sessions = taskIds.map((taskId, index) => {
      const worktree = worktreePaths[index];
      fs.mkdirSync(path.dirname(worktree), { recursive: true });
      git(repository, ["worktree", "add", "-q", "-b", `ai/agent/${taskId}`, worktree, "HEAD"]);
      git(repository, ["worktree", "lock", "--reason", `agent task ${taskId}`, worktree]);
      fs.writeFileSync(
        path.join(registry, `${taskId}.json`),
        JSON.stringify({ taskId, sessionId: `ses_${taskId}`, repositoryRoot: repository, worktreePath: worktree, updatedAt: "2026-01-01T00:00:00Z" }),
      );
      return { id: `ses_${taskId}`, title: `agent — ${taskId}-slug`, updated: old, directory: worktree };
    });

    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "git"),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "${gitLog}"\nexec "${realGit}" "$@"\n`,
    );
    fs.chmodSync(path.join(bin, "git"), 0o755);

    const dispatcher = path.join(root, "dispatcher.sh");
    fs.writeFileSync(
      dispatcher,
      `#!/usr/bin/env bash
set -e
mode="$1"; shift
if [ "$mode" = sessions ]; then
  printf '%s\\n' '${JSON.stringify(sessions)}'
  exit 0
fi
if [ "$mode" = teardown ]; then
  task=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --task) task="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  if [ -f "${repository}/.git/worktrees/$task/locked" ]; then
    printf '%s=locked\\n' "$task" >> "${callsLog}"
  else
    printf '%s=unlocked\\n' "$task" >> "${callsLog}"
  fi
  printf '%s\\n' '{"state":"removed","database":{"deleted":true}}'
  exit 0
fi
exit 2
`,
    );
    fs.chmodSync(dispatcher, 0o755);

    const applied = spawnSync(
      process.execPath,
      [pruneScript, "--dispatcher", dispatcher, "--worktree-root", worktrees, "--apply"],
      { encoding: "utf8", env: { ...process.env, OPENCODE_SESSION_ID: "", PATH: `${bin}:${process.env.PATH}` } },
    );
    assert.equal(applied.status, 0, applied.stderr);
    assert.match(applied.stdout, /deleted\s*: 2\/2/);
    const listCalls = fs.readFileSync(gitLog, "utf8").split("\n").filter((line) => line === "worktree list --porcelain");
    assert.equal(listCalls.length, 1);
    assert.equal(fs.readFileSync(callsLog, "utf8").trim().split("\n").sort().join(","), "task-one=unlocked,task-two=unlocked");
  } finally {
    for (const worktree of worktreePaths) {
      spawnSync("git", ["worktree", "unlock", worktree], { cwd: repository, encoding: "utf8" });
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("prune-named-sessions loads credential environment and exported passwords win", () => {
  const fx = fixture();
  try {
    const envFile = path.join(fx.root, "credentials.env");
    const envLog = path.join(fx.root, "env.log");
    fs.writeFileSync(
      envFile,
      [
        "OPENCODE_SERVER_USERNAME=file-user",
        "OPENCODE_SERVER_PASSWORD=file-pass",
        "OPENCODE_SERVER_CREDENTIALS={127.0.0.1:4096:{password:map-pass}}",
        "PRUNE_IGNORED=must-not-leak",
      ].join("\n"),
    );

    const fromFile = runPrune(fx, [], { OPENCODE_DISPATCH_ENV_FILE: envFile, PRUNE_ENV_LOG: envLog });
    assert.equal(fromFile.status, 0, fromFile.stderr);
    let seen = fs.readFileSync(envLog, "utf8");
    assert.match(seen, /^username=file-user$/m);
    assert.match(seen, /^server_password=file-pass$/m);
    assert.match(seen, /^password=file-pass$/m);
    assert.match(seen, /^credentials=\{"127\.0\.0\.1:4096":\{"password":"map-pass"\}\}$/m);
    assert.match(seen, /^ignored=$/m);

    const exported = runPrune(fx, [], { OPENCODE_DISPATCH_ENV_FILE: envFile, PRUNE_ENV_LOG: envLog, OPENCODE_PASSWORD: "exported-pass" });
    assert.equal(exported.status, 0, exported.stderr);
    seen = fs.readFileSync(envLog, "utf8");
    assert.match(seen, /^server_password=exported-pass$/m);
    assert.match(seen, /^password=exported-pass$/m);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});
