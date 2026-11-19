#!/usr/bin/env node
/**
 * Resolve an agent's effective model from OpenCode's normalized configuration.
 *
 * v2 does not copy an agent's configured model onto a created session: the
 * session keeps an empty model and the turn falls back to the server's default
 * (observed: opencode/ll-alpha-free), ignoring the per-agent `model` in
 * opencode.json. Both dialects do honor the model when it is passed explicitly,
 * so the dispatcher resolves it once and sends it with create/submit.
 *
 * `opencode debug config` is the authoritative source: it lists the config
 * documents opencode actually loaded (global, project, system) after V1→V2
 * normalization. We only read model refs from it; nothing else is printed or
 * persisted.
 *
 * Usage:
 *   node scripts/agent-config.mjs --dir <project> --agent <name> [--bin <opencode>]
 *
 * Prints `{"model":"provider/model","variant":"<variant>"}` or `{}`.
 */

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** Normalize a model ref from either a V1 string or a normalized V2 object. */
export function normalizeModelRef(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const [ref, variant = ""] = value.split("#", 2);
    const slash = ref.indexOf("/");
    if (slash <= 0 || slash === ref.length - 1) return null;
    return { providerID: ref.slice(0, slash), model: ref.slice(slash + 1), variant };
  }
  if (typeof value === "object") {
    const providerID = value.providerID || value.provider || "";
    const model = value.model || value.id || value.modelID || "";
    if (!providerID || !model) return null;
    return { providerID, model, variant: value.variant || "" };
  }
  return null;
}

function mergeAgentMaps(info) {
  const maps = [];
  // Native `agents` wins over the legacy `agent` map when both are present.
  if (info.agent && typeof info.agent === "object") maps.push(info.agent);
  if (info.agents && typeof info.agents === "object") maps.push(info.agents);
  return maps;
}

/**
 * Return { providerID, model, variant } for the selected agent, falling back
 * to the effective top-level model. Returns null when the config cannot be
 * read (old client, not a project, malformed output) — callers then leave the
 * model unset and keep the previous behavior.
 */
export function resolveAgentModel({
  directory = ".",
  agent = "",
  bin = "opencode",
  execFileImpl = execFileSync,
  timeoutMs = 15_000,
} = {}) {
  if (!agent) return null;
  let raw;
  try {
    raw = execFileImpl(bin, ["debug", "config"], {
      cwd: directory,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return null;
  }
  let documents;
  try {
    documents = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (!Array.isArray(documents)) return null;

  let agentModel = null;
  let topModel = null;
  for (const document of documents) {
    if (!document || document.type !== "document" || !document.info) continue;
    const info = document.info;
    for (const map of mergeAgentMaps(info)) {
      const entry = map[agent];
      if (!entry || typeof entry !== "object") continue;
      const model = normalizeModelRef(entry.model);
      // A later document may override only prompts/permissions. Keep the last
      // model actually declared for this agent.
      if (model) agentModel = model;
    }
    const model = normalizeModelRef(info.model);
    if (model) topModel = model;
  }
  return agentModel || topModel;
}

function parseArgs(argv) {
  const options = { directory: process.cwd(), agent: "", bin: "opencode" };
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--dir") options.directory = args.shift() || options.directory;
    else if (arg === "--agent") options.agent = args.shift() || "";
    else if (arg === "--bin") options.bin = args.shift() || options.bin;
    else if (arg === "--help" || arg === "-h") {
      console.log("usage: node scripts/agent-config.mjs --dir <project> --agent <name> [--bin <opencode>]");
      process.exit(0);
    } else {
      console.error(`agent-config: unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const resolved = resolveAgentModel(options);
  if (!resolved) {
    console.log("{}");
    return;
  }
  console.log(JSON.stringify({
    model: `${resolved.providerID}/${resolved.model}`,
    variant: resolved.variant || "",
  }));
}

// Only run the CLI when executed directly; spawn-agent imports the function.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
