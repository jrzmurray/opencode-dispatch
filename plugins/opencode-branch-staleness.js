// opencode-branch-staleness — report how far the session's working branch is
// behind origin/main, EVERY TURN, in the agent's own context.
//
// Port of a Claude Code UserPromptSubmit hook (report-branch-staleness.sh) to
// an opencode plugin. Why it exists: an agent in a long
// session treats its own HEAD as current — main moves under it, and in a
// worktree the illusion is stronger. A number in front of the agent every turn
// beats a memory note that loses to momentum.
//
// Delivery: the `experimental.chat.system.transform` hook appends a
// `<branch-staleness>` block to the system prompt before every LLM call (the
// opencode analog of UserPromptSubmit stdout joining context).
//
// CONTRACT (same as the shell hook):
//   - NEVER blocks: any failure adds nothing (a broken hook must not stop
//     work; a network outage is not an error worth surfacing).
//   - Throttled fetch: `git fetch` at most every OPENCODE_STALENESS_FETCH_TTL
//     (default 300s), stamped in the shared git-common-dir (one stamp for all
//     worktrees of a repo); every other turn reads cached remote state.
//   - Quiet when clean: zero commits behind appends nothing.
//   - Escalation at OPENCODE_STALENESS_NUDGE_AT (default 25) commits behind.
//   - HOT paths: optional comma-separated repo paths
//     (OPENCODE_STALENESS_HOT_PATHS); commits behind that touch them get
//     called out explicitly.

export const OpenCodeBranchStaleness = async ({ client }) => {
  const FETCH_TTL = parseInt(process.env.OPENCODE_STALENESS_FETCH_TTL || "300", 10)
  const NUDGE_AT = parseInt(process.env.OPENCODE_STALENESS_NUDGE_AT || "25", 10)
  const HOT_PATHS = (process.env.OPENCODE_STALENESS_HOT_PATHS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

  const dirCache = new Map() // sessionID -> directory
  const dirOf = async (sessionID) => {
    if (dirCache.has(sessionID)) return dirCache.get(sessionID)
    let dir = ""
    try {
      const s = await client.session.get({ path: { id: sessionID } })
      dir = s.directory || ""
    } catch (e) {}
    dirCache.set(sessionID, dir)
    return dir
  }

  // Bun shell with a fixed cwd; .nothrow() keeps every failure silent.
  const git = (dir, strings, ...vals) =>
    Bun.$(strings, ...vals).cwd(dir).quiet().nothrow()

  const stalenessBlock = async (dir) => {
    const root = (await git(dir)`git rev-parse --show-toplevel`).stdout
      .toString().trim()
    if (!root) return "" // not a git repo — silent
    const common = (await git(root)`git rev-parse --git-common-dir`).stdout
      .toString().trim()
    const commonDir = common.startsWith("/") ? common : root + "/" + common
    const stamp = commonDir + "/.staleness-fetch-stamp"

    const now = Math.floor(Date.now() / 1000)
    let last = 0
    try { last = parseInt(await Bun.file(stamp).text(), 10) || 0 } catch (e) {}

    if (now - last >= FETCH_TTL) {
      // Fire-and-forget fetch; never make the agent wait on the network.
      git(root)`git fetch origin main --quiet`.catch(() => {})
      try {
        const fs = await import("node:fs/promises")
        await fs.writeFile(stamp, String(now))
      } catch (e) {}
    }

    const behindRaw = (await git(root)`git rev-list --count HEAD..origin/main`).stdout
      .toString().trim()
    const behind = parseInt(behindRaw, 10)
    if (!(behind >= 0) || behind === 0) return "" // clean or unresolvable — silent

    const branch = (await git(root)`git rev-parse --abbrev-ref HEAD`).stdout
      .toString().trim() || "?"

    let hot = ""
    if (HOT_PATHS.length) {
      try {
        const out = await git(root)`git log --name-only --pretty=format: HEAD..origin/main -- ${HOT_PATHS.join(" ")}`
        const files = [...new Set(out.stdout.toString().split("\n").map((s) => s.trim()).filter(Boolean))].slice(0, 6)
        if (files.length) hot = "Missing commits touch documents/surfaces of record:\n" +
          files.map((f) => "  - " + f).join("\n") + "\n"
      } catch (e) {}
    }

    let lines = "<branch-staleness>\n"
    if (behind >= NUDGE_AT) {
      lines += branch + " is " + behind + " commits behind origin/main — far enough that \"what exists\" is probably wrong.\n"
      lines += "Before writing a spec, proposing a build, or claiming something is unbuilt: git log HEAD..origin/main\n"
    } else {
      lines += branch + " is " + behind + " commit(s) behind origin/main.\n"
    }
    if (hot) lines += hot
    lines += "</branch-staleness>"
    return lines
  }

  return {
    "experimental.chat.system.transform": async (input, output) => {
      if (!input.sessionID) return
      const dir = await dirOf(input.sessionID)
      if (!dir) return
      try {
        const block = await stalenessBlock(dir)
        if (block) output.system.push(block)
      } catch (e) {} // NEVER break a turn over staleness
    },
  }
}
