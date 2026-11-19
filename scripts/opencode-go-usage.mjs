#!/usr/bin/env node
/**
 * Print OpenCode Go rolling, weekly, and monthly quota percentages.
 *
 * Credentials are gathered from OPENCODE_API_KEY / OPENCODE_GO_API_KEYS,
 * ~/.config/opencode
 * provider config, and OpenCode's legacy auth.json / current SQLite store.
 * Exact duplicate keys are collapsed before any requests are made. Key values
 * are never printed.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const PROVIDER_IDS = new Set(["opencode-go", "opencode"]);
const here = path.dirname(fileURLToPath(import.meta.url));

function addKey(found, value, source) {
  if (typeof value !== "string") return;
  const key = value.trim();
  if (!key || key.length > 16_384 || key.includes("${")) return;
  const entry = found.get(key) || { key, sources: [] };
  if (!entry.sources.includes(source)) entry.sources.push(source);
  found.set(key, entry);
}

function parseKeyList(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text);
      const values = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === "object" ? Object.values(parsed) : [];
      return values.filter((value) => typeof value === "string").map((value) => value.trim()).filter(Boolean);
    } catch {
      // Treat malformed JSON as a plain delimiter-separated list below.
    }
  }
  return text
    .replace(/^(["'])(.*)\1$/s, "$2")
    .split(/[\s,;]+/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function envFileValues(file) {
  if (!fs.existsSync(file)) return new Map();
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return new Map();
  }
  const values = new Map();
  for (const rawLine of content.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    line = line.replace(/^export\s+/, "");
    const split = line.indexOf("=");
    if (split < 1) continue;
    const name = line.slice(0, split).trim();
    if (!["OPENCODE_GO_API_KEYS", "OPENCODE_API_KEY"].includes(name)) continue;
    let value = line.slice(split + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        try { value = JSON.parse(`"${value}"`); } catch { /* Keep the literal contents. */ }
      }
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    values.set(name, value);
  }
  return values;
}

function envFileCandidates(name) {
  const homeScripts = path.join(os.homedir(), ".claude", "scripts");
  const directories = [here, path.resolve(here, ".."), homeScripts];
  const files = directories.map((directory) => path.join(directory, name));
  if (name === ".env.local" && process.env.OPENCODE_DISPATCH_ENV_FILE) {
    files.unshift(path.resolve(process.env.OPENCODE_DISPATCH_ENV_FILE));
  }
  return [...new Set(files)];
}

/** Shell values win; otherwise .env.local wins over .env per variable. */
function apiEnvironmentValues() {
  const values = new Map();
  const sources = new Map();
  const names = ["OPENCODE_GO_API_KEYS", "OPENCODE_API_KEY"];
  for (const name of names) {
    if (process.env[name] !== undefined) {
      values.set(name, process.env[name]);
      sources.set(name, "environment");
    }
  }
  for (const fileName of [".env.local", ".env"]) {
    for (const file of envFileCandidates(fileName)) {
      for (const [name, value] of envFileValues(file)) {
        if (values.has(name)) continue;
        values.set(name, value);
        sources.set(name, fileName);
      }
    }
  }
  return { values, sources };
}

function stripJsonComments(source) {
  let output = "";
  let quote = "";
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (quote) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"') {
      quote = char;
      output += char;
    } else if (char === "/" && next === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n") i += 1;
      output += "\n";
    } else if (char === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") output += "\n";
        i += 1;
      }
      i += 1;
      output += " ";
    } else {
      output += char;
    }
  }
  return output;
}

function removeTrailingCommas(source) {
  let output = "";
  let quote = "";
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"') {
      quote = char;
      output += char;
    } else if (char === ",") {
      let next = i + 1;
      while (/\s/.test(source[next] || "")) next += 1;
      if (source[next] !== "}" && source[next] !== "]") output += char;
    } else {
      output += char;
    }
  }
  return output;
}

function readJsonc(file) {
  try {
    const text = fs.readFileSync(file, "utf8");
    return JSON.parse(removeTrailingCommas(stripJsonComments(text)));
  } catch {
    console.error(`warning: couldn't parse ${path.basename(file)}; skipping it`);
    return null;
  }
}

function collectNamedSecrets(value, found, source, depth = 0) {
  if (!value || typeof value !== "object" || depth > 8) return;
  for (const [name, item] of Object.entries(value)) {
    const normalized = name.toLowerCase().replace(/[-_]/g, "");
    if (["apikey", "key", "token", "accesstoken", "access"].includes(normalized)) {
      if (typeof item === "string") addKey(found, item, source);
    } else if (item && typeof item === "object") {
      collectNamedSecrets(item, found, source, depth + 1);
    }
  }
}

function collectConfigCredentials(file, found, source) {
  if (!fs.existsSync(file)) return;
  const config = readJsonc(file);
  if (!config || typeof config !== "object") return;
  for (const providerMap of [config.provider, config.providers]) {
    if (!providerMap || typeof providerMap !== "object") continue;
    for (const providerID of PROVIDER_IDS) {
      collectNamedSecrets(providerMap[providerID], found, source);
    }
  }
}

function dataDirectories() {
  const home = os.homedir();
  const xdgData = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  const directories = [
    process.env.OPENCODE_DATA_HOME,
    path.join(xdgData, "opencode"),
  ].filter(Boolean).map((directory) => path.resolve(directory));
  if (process.env.OPENCODE_DB) directories.push(path.dirname(path.resolve(process.env.OPENCODE_DB)));
  return [...new Set(directories)];
}

function databasePaths(directories) {
  const paths = [];
  if (process.env.OPENCODE_DB) paths.push(path.resolve(process.env.OPENCODE_DB));
  for (const directory of directories) {
    try {
      for (const name of fs.readdirSync(directory)) {
        if (/^opencode.*\.db$/i.test(name)) paths.push(path.join(directory, name));
      }
    } catch {
      // Missing data directories are normal on machines without OpenCode.
    }
  }
  return [...new Set(paths)];
}

function addStoredCredential(found, providerID, credential, source) {
  if (!PROVIDER_IDS.has(String(providerID || "").replace(/\/+$/, ""))) return;
  if (!credential || typeof credential !== "object") return;
  if (typeof credential.key === "string") addKey(found, credential.key, source);
  if (typeof credential.token === "string") addKey(found, credential.token, source);
  if (typeof credential.access === "string") addKey(found, credential.access, source);
  collectNamedSecrets(credential, found, source);
}

function collectLegacyAuth(file, found) {
  if (!fs.existsSync(file)) return;
  let credentials;
  try {
    credentials = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    console.error(`warning: couldn't parse ${path.basename(file)}; skipping it`);
    return;
  }
  if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) return;
  for (const [providerID, credential] of Object.entries(credentials)) {
    addStoredCredential(found, providerID, credential, "OpenCode auth store");
  }
}

async function queryCredentialRows(databasePath) {
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      database.exec("PRAGMA query_only = ON");
      const credentialTable = database
        .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'credential'")
        .get();
      if (!credentialTable) return [];
      return database
        .prepare("SELECT integration_id, value FROM credential WHERE integration_id IN (?, ?)")
        .all("opencode-go", "opencode");
    } finally {
      database.close();
    }
  } catch (nodeSqliteError) {
    // Keep support for Node versions without node:sqlite when the sqlite3 CLI
    // is available. The query is static and the database is opened read-only.
    try {
      const schema = execFileSync("sqlite3", [
        "-readonly", databasePath,
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'credential' LIMIT 1;",
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1024 * 1024 });
      if (!schema.trim()) return [];
      const raw = execFileSync("sqlite3", [
        "-readonly", "-json", databasePath,
        "SELECT integration_id, value FROM credential WHERE integration_id IN ('opencode-go', 'opencode');",
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 4 * 1024 * 1024 });
      const rows = JSON.parse(raw || "[]");
      return Array.isArray(rows) ? rows : [];
    } catch {
      throw nodeSqliteError;
    }
  }
}

async function collectDatabaseCredentials(files, found) {
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    try {
      const rows = await queryCredentialRows(file);
      for (const row of rows) {
        let credential;
        try { credential = JSON.parse(row.value); } catch { continue; }
        addStoredCredential(found, row.integration_id, credential, "OpenCode auth store");
      }
    } catch {
      console.error(`warning: couldn't inspect ${path.basename(file)}; skipping it`);
    }
  }
}

function discoverCredentials() {
  const found = new Map();
  const apiEnv = apiEnvironmentValues();
  for (const name of ["OPENCODE_GO_API_KEYS", "OPENCODE_API_KEY"]) {
    const raw = apiEnv.values.get(name);
    const source = apiEnv.sources.get(name);
    const keys = name === "OPENCODE_API_KEY" ? [raw] : parseKeyList(raw);
    for (const value of keys) addKey(found, value, source);
  }

  const home = os.homedir();
  const configDirs = [
    process.env.XDG_CONFIG_HOME,
    path.join(home, ".config"),
  ].filter(Boolean).map((directory) => path.join(path.resolve(directory), "opencode"));
  const dataDirs = dataDirectories();
  for (const file of [
    ...[...new Set(configDirs)].flatMap((directory) => [
      path.join(directory, "opencode.json"),
      path.join(directory, "opencode.jsonc"),
    ]),
    ...dataDirs.flatMap((directory) => [
      path.join(directory, "opencode.json"),
      path.join(directory, "opencode.jsonc"),
    ]),
    ...(process.platform === "darwin" ? [
      "/Library/Application Support/opencode/opencode.json",
      "/Library/Application Support/opencode/opencode.jsonc",
    ] : process.platform === "linux" ? ["/etc/opencode/opencode.json", "/etc/opencode/opencode.jsonc"] : []),
  ]) {
    collectConfigCredentials(file, found, "OpenCode config");
  }

  for (const directory of dataDirs) {
    collectLegacyAuth(path.join(directory, "auth.json"), found);
  }
  return { found, databaseFiles: databasePaths(dataDirs) };
}

function percentNumber(value) {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return null;
  return number;
}

/** Return Go usage percentages as numbers for one API key. */
export async function getOpenCodeGoUsage(apiKey) {
  if (typeof apiKey !== "string" || !apiKey.trim()) throw new TypeError("apiKey must be a non-empty string");
  const response = await fetch(USAGE_URL, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey.trim()}`,
      "User-Agent": "opencode-go-usage/1.0",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  const usage = payload?.usage || payload;
  const result = {};
  for (const period of ["rolling", "weekly", "monthly"]) {
    const percent = percentNumber(usage?.[period]?.percent);
    if (percent === null) throw new Error(`response did not include ${period} usage`);
    result[period] = percent;
  }
  return result;
}

/** Return usage for distinct keys, in first-seen order; keys are not returned. */
export async function getOpenCodeGoUsages(apiKeys) {
  if (typeof apiKeys === "string") apiKeys = [apiKeys];
  if (!apiKeys || typeof apiKeys[Symbol.iterator] !== "function") {
    throw new TypeError("apiKeys must be an iterable of strings");
  }
  const uniqueKeys = [...new Set([...apiKeys].filter((key) => typeof key === "string").map((key) => key.trim()).filter(Boolean))];
  const usages = [];
  for (const key of uniqueKeys) usages.push(await getOpenCodeGoUsage(key));
  return usages;
}

/** Discover configured credentials and return their usage without exposing keys. */
export async function getConfiguredOpenCodeGoUsages() {
  const { found, databaseFiles } = discoverCredentials();
  await collectDatabaseCredentials(databaseFiles, found);
  const results = [];
  for (const credential of found.values()) {
    results.push({ sources: [...credential.sources], ...await getOpenCodeGoUsage(credential.key) });
  }
  return results;
}

function main() {
  if (process.argv.slice(2).some((arg) => !["--help", "-h"].includes(arg))) {
    console.error("usage: node scripts/opencode-go-usage.mjs [--help]");
    process.exitCode = 2;
    return;
  }
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("usage: node scripts/opencode-go-usage.mjs [--help]");
    console.log("Print rolling, weekly, and monthly OpenCode Go usage percentages.");
    console.log("Reads OPENCODE_GO_API_KEYS / OPENCODE_API_KEY, OpenCode config, and OpenCode's auth store.");
    return;
  }

  const { found, databaseFiles } = discoverCredentials();
  void (async () => {
    await collectDatabaseCredentials(databaseFiles, found);
    const credentials = [...found.values()];
    if (!credentials.length) {
      console.error("No OpenCode Go credentials found. Set OPENCODE_API_KEY / OPENCODE_GO_API_KEYS or connect OpenCode Go in OpenCode.");
      process.exitCode = 1;
      return;
    }
    let failures = 0;
    for (const [index, credential] of credentials.entries()) {
      const label = `Key ${index + 1}${credential.sources.length ? ` (${credential.sources.join(", ")})` : ""}`;
      try {
        const usage = await getOpenCodeGoUsage(credential.key);
        console.log(`${label}`);
        console.log(`  Rolling: ${usage.rolling}%`);
        console.log(`  Weekly:  ${usage.weekly}%`);
        console.log(`  Monthly: ${usage.monthly}%`);
      } catch (error) {
        failures += 1;
        const message = error?.name === "TimeoutError" ? "request timed out" : error.message || "request failed";
        console.error(`${label}: ${message}`);
      }
    }
    if (failures) process.exitCode = 1;
  })().catch(() => {
    console.error("Unable to collect OpenCode Go usage.");
    process.exitCode = 1;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
