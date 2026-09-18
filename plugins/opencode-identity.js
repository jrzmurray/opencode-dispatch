// opencode-identity — gives every agent session a persistent, authoritative
// identity, whether it was spawned by a launcher or started from opencode
// itself (TUI, `opencode run`, serve).
//
// Hook 1 — shell.env: injects the EXECUTING session's own identity into every
// tool shell/terminal environment. Each agent (parent OR subagent) sees its
// own session id — no env inheritance, no directory guessing, no collisions:
//   OPENCODE_SESSION_ID        ses_...
//   OPENCODE_SESSION_SLUG      mighty-panda
//   OPENCODE_SESSION_TITLE     Implement parser — mighty-panda
//   OPENCODE_SESSION_AGENT     build
//   OPENCODE_SESSION_MODEL     deepseek/deepseek-v4-flash
//   OPENCODE_SESSION_DIRECTORY /abs/path
//
// Hook 2 — event session.created: appends " — <slug>" to the session title so
// every session carries a stable, human-readable label in all listings
// (/session, /session/{id}/children, TUI) and in claim records.
//
// Dependency-free plain JS; load from ~/.config/opencode/plugins/ (global) or
// <project>/.opencode/plugins/ (project) — both auto-load at startup.

export const OpenCodeIdentity = async ({ client }) => {
  const cache = new Map() // sessionID -> identity info

  const load = async (sessionID) => {
    if (cache.has(sessionID)) return cache.get(sessionID)
    try {
      const s = await client.session.get({ path: { id: sessionID } })
      const info = {
        slug: s.slug || "",
        title: s.title || "",
        agent: s.agent || "",
        model:
          (s.model && s.model.providerID && s.model.id
            ? s.model.providerID + "/" + s.model.id
            : ""),
        directory: s.directory || "",
      }
      cache.set(sessionID, info)
      return info
    } catch (e) {
      return null
    }
  }

  return {
    "shell.env": async (input, output) => {
      if (!input.sessionID) return // user terminals may not carry a session
      const info = await load(input.sessionID)
      if (!info) return
      output.env.OPENCODE_SESSION_ID = input.sessionID
      output.env.OPENCODE_SESSION_SLUG = info.slug
      output.env.OPENCODE_SESSION_TITLE = info.title
      output.env.OPENCODE_SESSION_AGENT = info.agent
      output.env.OPENCODE_SESSION_MODEL = info.model
      output.env.OPENCODE_SESSION_DIRECTORY = info.directory
    },

    event: async ({ event }) => {
      if (!event || event.type !== "session.created") return
      const { sessionID, info } = event.properties || {}
      if (!sessionID || !info) return
      cache.set(sessionID, {
        slug: info.slug || "",
        title: info.title || "",
        agent: info.agent || "",
        model:
          info.model && info.model.providerID && info.model.id
            ? info.model.providerID + "/" + info.model.id
            : "",
        directory: info.directory || "",
      })
      // Idempotent title suffix: never double-append the slug.
      const title = info.title || ""
      if (title && info.slug && !title.includes(" — " + info.slug) && !title.includes("-" + info.slug + " ")) {
        try {
          await client.session.update({
            path: { id: sessionID },
            body: { title: title + " — " + info.slug },
          })
        } catch (e) {
          /* title suffix is cosmetic; never fail session creation over it */
        }
      }
    },
  }
}
