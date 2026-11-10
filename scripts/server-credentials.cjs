"use strict";

/**
 * Per-server credential resolution for opencode-dispatch.
 *
 * The single OPENCODE_SERVER_PASSWORD / OPENCODE_PASSWORD value is the OpenCode
 * client's own single-server contract; the dispatcher is the layer that talks
 * to several servers, so credentials are keyed by the address actually used.
 *
 * Lookup order (each field uses the first defined value):
 *   1. OPENCODE_SERVER_CREDENTIALS (object in the environment/.env.local;
 *      JSON or JavaScript-style {host:port:{password:pw}} syntax)
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
  // localhost and 127.0.0.1 are the same IPv4 loopback in practice; a
  // credential keyed under either name should serve the other.
  const aliases = normalized === "localhost"
    ? ["127.0.0.1"]
    : normalized === "127.0.0.1" ? ["localhost"] : [];
  const hosts = [normalized, ...aliases];
  const keys = [];
  if (value) for (const item of hosts) keys.push(`${item}:${value}`);
  for (const item of hosts) keys.push(item);
  return keys;
}

// ---------------------------------------------------------------------------
// Credential map parsing
// ---------------------------------------------------------------------------
//
// The documented format is JSON, but the environment value is frequently
// written as a JavaScript-style object:
//
//   {127.0.0.1:4096:{password:secret}}
//
// That is not JSON (unquoted keys and values). Accept both forms in one shared
// parser so every caller (dispatcher, profile resolver, prune script, tests)
// behaves the same. Bare values are taken literally; quote a value that
// contains a comma, brace, or trailing whitespace.

function stripQuoted(text) {
  const value = text.trim();
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    if (value.startsWith('"')) {
      try {
        return JSON.parse(value);
      } catch {
        // Fall through to the permissive unquote below.
      }
    }
    return value.slice(1, -1).replace(/\\(['"\\])/g, "$1");
  }
  return value;
}

/** Split at a delimiter only at the current object/array level, ignoring quotes. */
function splitTopLevel(text, delimiter = ",") {
  const parts = [];
  let depth = 0;
  let quote = "";
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") depth -= 1;
    else if (char === delimiter && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Top-level colon positions, ignoring colons inside quotes or nested braces. */
function topLevelColons(text) {
  const positions = [];
  let depth = 0;
  let quote = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") depth -= 1;
    else if (char === ":" && depth === 0) positions.push(index);
  }
  return positions;
}

function isUrlKey(text) {
  try {
    const url = new URL(text);
    return Boolean(url.protocol && url.hostname);
  } catch {
    return false;
  }
}

/**
 * A key is a host, host:port, bracketed IPv6 address, or URL. Testing the key
 * prefix lets us keep the colon in 127.0.0.1:4096 while finding the colon that
 * starts its value.
 */
function isCredentialKey(text) {
  const value = text.trim();
  if (!value) return false;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return stripQuoted(value).length > 0;
  }
  return (
    isUrlKey(value) ||
    /^\[[0-9A-Fa-f:.]+\](?::\d+)?$/.test(value) ||
    /^[A-Za-z0-9._-]+(?::\d+)?$/.test(value)
  );
}

/** Locate the entry's key/value colon, allowing a colon inside the key. */
function findEntrySeparator(entry) {
  const positions = topLevelColons(entry);
  let best = -1;
  for (const position of positions) {
    if (isCredentialKey(entry.slice(0, position))) best = position;
  }
  if (best >= 0) return best;
  if (positions.length > 0) return positions[positions.length - 1];
  throw new Error(`expected "key: value" in {${entry.trim()}}`);
}

/** Find the matching close brace for a value that starts with "{". */
function matchingBrace(text) {
  let depth = 0;
  let quote = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function parseRelaxedValue(text, label) {
  const value = text.trim();
  if (!value) return "";
  if (value.startsWith("{")) {
    const end = matchingBrace(value);
    if (end < 0) throw new Error(`unclosed object in ${label}`);
    if (value.slice(end + 1).trim()) throw new Error(`unexpected text after object in ${label}`);
    return parseRelaxedObject(value, label);
  }
  if (value.startsWith("[")) {
    try {
      return JSON.parse(value);
    } catch {
      throw new Error(`arrays in ${label} must use JSON syntax`);
    }
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return stripQuoted(value);
  }
  return value;
}

/** Parse a JavaScript-style object literal with unquoted keys/values. */
function parseRelaxedObject(text, label = "credentials") {
  const source = text.trim();
  if (!source.startsWith("{")) throw new Error(`expected an object starting with "{" in ${label}`);
  const end = matchingBrace(source);
  if (end < 0) throw new Error(`unclosed object in ${label}`);
  if (source.slice(end + 1).trim()) throw new Error(`unexpected text after object in ${label}`);
  const body = source.slice(1, end);
  const out = {};
  for (const rawEntry of splitTopLevel(body)) {
    const entry = rawEntry.trim();
    if (!entry) continue;
    const separator = findEntrySeparator(entry);
    const key = stripQuoted(entry.slice(0, separator));
    if (!key) throw new Error(`empty key in ${label}`);
    out[key] = parseRelaxedValue(entry.slice(separator + 1), label);
  }
  return out;
}

/** Parse a credentials map from an object, JSON, or JavaScript-style object. */
function normalizeMap(value, label = "credentials") {
  if (value === undefined || value === null || value === "") return {};
  let parsed = value;
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return {};
    try {
      parsed = JSON.parse(text);
    } catch (jsonError) {
      try {
        parsed = parseRelaxedObject(text, label);
      } catch (relaxedError) {
        throw new Error(
          `${label} must be an object keyed by host or host:port: ${jsonError.message} (relaxed parse: ${relaxedError.message}); ` +
            'example: {127.0.0.1:4096:{password:"secret"}}',
        );
      }
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be an object keyed by host or host:port`);
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
  const fromFile = lookup(fileMap, host, port);
  const globalPassword = env.OPENCODE_SERVER_PASSWORD || env.OPENCODE_PASSWORD;
  const layers = [
    fromEnv && { credential: fromEnv.credential, source: `env:${fromEnv.key}` },
    (profile.username !== undefined || profile.password !== undefined)
      && { credential: profile, source: "profile" },
    fromFile && { credential: fromFile.credential, source: `credentials:${fromFile.key}` },
    globalPassword && { credential: { password: globalPassword }, source: "env" },
  ].filter(Boolean);

  const username = layers.find(({ credential }) => credential.username !== undefined)?.credential.username;
  const password = layers.find(({ credential }) => credential.password !== undefined)?.credential.password ?? "";
  const source = layers[0]?.source || "none";
  return { username, password, source };
}

/**
 * Resolve the credential for a server URL using the process environment (or a
 * supplied env). This is the one entry point Node clients should use so the
 * address-keyed map, its relaxed syntax, and the single-password fallback all
 * behave identically.
 */
function resolveEnvCredential({ baseUrl, env = process.env } = {}) {
  const fallback = {
    username: undefined,
    password: env.OPENCODE_PASSWORD || env.OPENCODE_SERVER_PASSWORD || "",
    source: env.OPENCODE_PASSWORD || env.OPENCODE_SERVER_PASSWORD ? "env" : "none",
  };
  let url;
  try {
    url = new URL(String(baseUrl || ""));
  } catch {
    return fallback;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return resolveCredential({
    host,
    port,
    envCredentials: env.OPENCODE_SERVER_CREDENTIALS ?? env.ENV_CREDENTIALS ?? "",
    env,
  });
}

module.exports = { normalizeHost, normalizeKey, keysFor, normalizeMap, parseRelaxedObject, resolveCredential, resolveEnvCredential };
