"use strict";

/**
 * Per-server credential resolution for opencode-dispatch.
 *
 * The single OPENCODE_SERVER_PASSWORD / OPENCODE_PASSWORD value is the OpenCode
 * client's own single-server contract; the dispatcher is the layer that talks
 * to several servers, so credentials are keyed by the address actually used.
 *
 * Lookup order (first match wins):
 *   1. OPENCODE_SERVER_CREDENTIALS (JSON object in the environment/.env.local)
 *   2. the selected profile's own username/password fields
 *   3. servers.json top-level "credentials", keyed by host or host:port
 *   4. the single OPENCODE_SERVER_PASSWORD / OPENCODE_PASSWORD fallback
 *
 * A map entry may be a password string or {username?, password?}.
 */

function normalizeHost(host) {
  return String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
}

/** Normalize a map key: full URL, [v6]:port, host:port, or bare host. */
function normalizeKey(key) {
  const raw = String(key || "").trim();
  if (!raw) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    let url;
    try {
      url = new URL(raw);
    } catch {
      return "";
    }
    const host = normalizeHost(url.hostname);
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    return `${host}:${port}`;
  }
  const bracketed = raw.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (bracketed) {
    const host = normalizeHost(bracketed[1]);
    return bracketed[2] ? `${host}:${bracketed[2]}` : host;
  }
  return raw.toLowerCase();
}

/** Candidate keys for a resolved endpoint, most specific first. */
function keysFor(host, port) {
  const normalized = normalizeHost(host);
  if (!normalized) return [];
  const value = String(port || "").trim();
  return value ? [`${normalized}:${value}`, normalized] : [normalized];
}

/** Parse a credentials map from an object or a JSON string. */
function normalizeMap(value, label = "credentials") {
  if (value === undefined || value === null || value === "") return {};
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new Error(`${label} must be a JSON object keyed by host or host:port: ${error.message}`);
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object keyed by host or host:port`);
  }
  const out = {};
  for (const [key, entry] of Object.entries(parsed)) {
    const normalized = normalizeKey(key);
    if (!normalized) continue;
    if (typeof entry === "string") {
      out[normalized] = { password: entry };
    } else if (entry && typeof entry === "object") {
      out[normalized] = {
        ...(entry.username !== undefined ? { username: String(entry.username) } : {}),
        ...(entry.password !== undefined ? { password: String(entry.password) } : {}),
      };
    }
  }
  return out;
}

function lookup(map, host, port) {
  for (const key of keysFor(host, port)) {
    if (Object.prototype.hasOwnProperty.call(map, key)) return { credential: map[key], key };
  }
  return null;
}

/**
 * Resolve the basic-auth pair for one endpoint.
 * Returns { username, password, source } where source names the winning layer.
 */
function resolveCredential({
  host,
  port,
  profile = {},
  serverCredentials,
  envCredentials,
  env = process.env,
} = {}) {
  const envMap = normalizeMap(envCredentials, "OPENCODE_SERVER_CREDENTIALS");
  const fileMap = normalizeMap(serverCredentials, 'servers.json "credentials"');

  const fromEnv = lookup(envMap, host, port);
  if (fromEnv) {
    return { username: fromEnv.credential.username, password: fromEnv.credential.password, source: `env:${fromEnv.key}` };
  }
  if (profile.username !== undefined || profile.password !== undefined) {
    return { username: profile.username, password: profile.password, source: "profile" };
  }
  const fromFile = lookup(fileMap, host, port);
  if (fromFile) {
    return { username: fromFile.credential.username, password: fromFile.credential.password, source: `credentials:${fromFile.key}` };
  }
  const password = env.OPENCODE_SERVER_PASSWORD || env.OPENCODE_PASSWORD;
  if (password) return { username: undefined, password, source: "env" };
  return { username: undefined, password: "", source: "none" };
}

module.exports = { normalizeHost, normalizeKey, keysFor, normalizeMap, resolveCredential };
