#!/usr/bin/env node
/**
 * Resolve one named server profile (or list all profiles) from servers.json.
 *
 * The shell orchestrator used to do this in an inline Node heredoc, but macOS
 * bash 3.2 mangles complex heredocs inside process substitutions. Keeping the
 * logic here also makes the precedence rules unit-testable.
 *
 * Precedence for endpoint fields: CLI flag > OPENCODE_DISPATCH_* env > profile
 * > default. Credentials: OPENCODE_SERVER_CREDENTIALS > profile fields >
 * top-level "credentials" map > single env password fallback.
 *
 * CLI:
 *   node server-profiles.mjs            one line for $SRV_NAME (default: default)
 *   node server-profiles.mjs --list     one line per profile
 *
 * Fields (unit-separator joined): name, listen, host, port, dir, password,
 * model, api, bin, username.
 */

import fs from "node:fs";
import { pathToFileURL } from "node:url";

import credentials from "./server-credentials.cjs";

const { resolveCredential } = credentials;
const FIELD_SEPARATOR = "\x1f";

export function loadDefinitions(file) {
  if (!file || !fs.existsSync(file)) return {};
  let defs;
  try {
    defs = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`);
  }
  if (!defs || typeof defs !== "object" || Array.isArray(defs)) {
    throw new Error(`${file} must contain a JSON object of server profiles`);
  }
  return defs;
}

function isLoopback(address) {
  return address === "localhost" || address === "::1" || /^127\./.test(address);
}

/**
 * Resolve one profile. Throws with an actionable message on invalid config.
 * `env` supplies the single-password fallback and the credentials map.
 */
export function resolveProfile({
  defs = {},
  name = "default",
  serverExplicit = false,
  file = "servers.json",
  cliListen = "",
  cliHost = "",
  cliPort = "",
  envListen = "",
  envHost = "",
  envPort = "",
  env = process.env,
} = {}) {
  // A host override that exactly matches a configured profile should inherit
  // that endpoint's directory, API pin, model, client binary, and credentials.
  // This lets `--host ideapad5.home` target the same remote project as
  // `--server ideapad5`, while an explicit --server remains authoritative.
  if (!serverExplicit && name === "default" && (cliHost || envHost)) {
    const targetHost = String(cliHost || envHost).toLowerCase().replace(/\.$/, "");
    const targetPort = Number.parseInt(cliPort || envPort || "4096", 10);
    const matches = Object.entries(defs).filter(([candidateName, candidate]) => {
      if (candidateName.startsWith("_") || candidateName === "credentials" || !candidate || typeof candidate !== "object") return false;
      const candidateHost = String(candidate.host || (isLoopback(candidate.listen || "127.0.0.1") ? candidate.listen || "127.0.0.1" : "")).toLowerCase().replace(/\.$/, "");
      const candidatePort = Number.parseInt(candidate.port || "4096", 10);
      return candidateHost === targetHost && candidatePort === targetPort;
    });
    if (matches.length > 1) throw new Error(`multiple server profiles match ${targetHost}:${targetPort}; pass --server <name>`);
    if (matches.length === 1) name = matches[0][0];
  }
  if (name === "credentials") {
    throw new Error(`"credentials" is a reserved key in ${file} (address-keyed credential map), not a server profile`);
  }
  const profile = defs[name] || {};
  if (name !== "default" && !(name in defs)) {
    throw new Error(`no server definition "${name}" in ${file}`);
  }

  const listen = cliListen || envListen || profile.listen || "127.0.0.1";
  const host = cliHost || envHost || profile.host || (isLoopback(listen) ? listen : "");
  const port = parseInt(cliPort || envPort || profile.port || "4096", 10);
  const api = profile.api || "";
  if (api && !["auto", "v1", "v2"].includes(api)) {
    throw new Error(`server "${name}" has invalid api "${api}" (use auto|v1|v2)`);
  }
  if (!(port >= 1 && port <= 65535)) {
    throw new Error(`invalid port ${port} for server "${name}"`);
  }
  if (host === "" || host === "0.0.0.0" || host === "::") {
    throw new Error(`server "${name}" has no reachable address (host can never be 0.0.0.0/::) — set "host", or bind loopback and let the host default to it`);
  }

  const envPassword = env.ENV_PASSWORD || env.OPENCODE_SERVER_PASSWORD || env.OPENCODE_PASSWORD;
  const credential = resolveCredential({
    host,
    port,
    profile,
    serverCredentials: defs.credentials,
    envCredentials: env.ENV_CREDENTIALS ?? env.OPENCODE_SERVER_CREDENTIALS ?? "",
    env: { ...env, OPENCODE_SERVER_PASSWORD: envPassword },
  });

  return {
    name,
    listen,
    host,
    port,
    dir: profile.dir || "",
    password: credential.password || "",
    model: profile.model || "",
    api,
    bin: profile.bin || "",
    username: credential.username || "",
    credentialSource: credential.source,
  };
}

/** All real profiles (skips documentation keys and the credentials map). */
export function listProfiles({ defs = {}, file = "servers.json", env = process.env } = {}) {
  return Object.keys(defs)
    .filter((name) => !name.startsWith("_") && name !== "credentials")
    .map((name) => resolveProfile({ defs, name, file, env }));
}

export function profileLine(profile) {
  return [
    profile.name,
    profile.listen,
    profile.host,
    profile.port,
    profile.dir,
    profile.password,
    profile.model,
    profile.api,
    profile.bin,
    profile.username,
  ].join(FIELD_SEPARATOR);
}

function main() {
  const file = process.env.SERVERS_FILE || "";
  let defs;
  try {
    defs = loadDefinitions(file);
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
  try {
    if (process.argv.includes("--list")) {
      for (const profile of listProfiles({ defs, file, env: process.env })) {
        process.stdout.write(`${profileLine(profile)}\n`);
      }
    } else {
      const profile = resolveProfile({
        defs,
        name: process.env.SRV_NAME || "default",
        serverExplicit: process.env.SERVER_EXPLICIT === "1",
        file,
        cliListen: process.env.CLI_LISTEN,
        cliHost: process.env.CLI_HOST,
        cliPort: process.env.CLI_PORT,
        envListen: process.env.ENV_LISTEN,
        envHost: process.env.ENV_HOST,
        envPort: process.env.ENV_PORT,
        env: process.env,
      });
      process.stdout.write(`${profileLine(profile)}\n`);
    }
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
