---
description: Start, stop, or restart a persistent opencode server (named profiles)
argument-hint: '[<name>] [--listen <addr>] [--port <N>] [--host <addr>] [--stop | --restart]'
allowed-tools: Bash(bash:*), Bash(opencode:*)
---

Start, stop, or restart a persistent `opencode serve`. Server definitions are
**named profiles** in `~/.config/opencode-dispatch/servers.json` (sample:
`config/servers.json` in the repo; keys starting with `_` are ignored). Each
profile separates the **bind interface** (`listen` — what `opencode serve
--hostname` binds: `127.0.0.1`, `0.0.0.0`, or an interface IP) from the
**addressable host** the dispatcher reaches it at (`host` — never `0.0.0.0`).
`serve <name>` selects a profile (`serve pro` == `serve --server pro`);
`--server <name>` works on every mode. Default profile: `default`
(127.0.0.1:4096). Per-field precedence: CLI flag > env (`OPENCODE_DISPATCH_*`)
> definition.

Binding a non-loopback interface requires a `password` in the definition (or
`OPENCODE_SERVER_PASSWORD`); the dispatcher refuses to start an unauthenticated
non-local server. Auth for all requests is basic-auth: username
`OPENCODE_SERVER_USERNAME` (default `opencode`) + the password.

**Local credentials via `.env.local`:** a `.env.local` in the skill directory
(`OPENCODE_SERVER_USERNAME=` / `OPENCODE_SERVER_PASSWORD=`, see
`.env.local.example`) is loaded by every dispatch mode when present — the
server is launched with those credentials and every client authenticates with
them, falling back to the defaults when the file is absent. Values apply only
when the variable is not already set in your environment.

Modes:
- **No flag** — start the server if none is reachable (or confirm the running
  one). The launch args (dir/port/host) are recorded per server name.
- `--stop` — stop the running server. Found via that server's recorded launch
  args, or via explicit `--port`/`--host` if no record exists (a port is never
  guessed). Needs `lsof`. Stop/restart are LOCAL operations — a remote profile
  is managed on the machine it runs on.
- `--restart` — stop and start the server again **using the same arguments it
  was last invoked with** (from the per-name record). Pass
  `--port`/`--host`/`--listen`/`--dir` to override the recorded values, e.g.
  `serve pro --restart --port 5000`. Restarting is how config changes in
  `~/.config/opencode/opencode.json` take effect.
- `--listen <addr>` — override the bind interface for this launch only.

Examples:
```bash
# Default local server
opencode-dispatch.sh serve
# Named local profile (see servers.json) + confirm it
opencode-dispatch.sh serve pro
opencode-dispatch.sh sessions --server pro
# Stop/restart exactly that server
opencode-dispatch.sh serve pro --stop
opencode-dispatch.sh serve pro --restart
```

Raw slash-command arguments:
`$ARGUMENTS`

Run:
```bash
bash "$HOME/.claude/scripts/opencode-dispatch.sh" serve $ARGUMENTS
```

Report the URL/pid/log from the output. All profiles are listed by
`/opencode:setup`.

**Never pipe this command's output through `tail`** — the installed PreToolUse
hook blocks it; the output is already one line.
