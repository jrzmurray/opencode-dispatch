#!/usr/bin/env node
/**
 * api-dialect — the OpenCode v1/v2 compatibility layer.
 *
 * opencode-dispatch supports two server generations:
 *
 *   v1 — the original server API (/session, /permission, /question), on
 *        opencode 1.18.29 and newer (the supported floor).
 *   v2 — the revised API (/api/session, /api/permission/request, /api/form),
 *        on opencode 2.0 and newer.
 *
 * A server's dialect and the client binary's generation are separate facts:
 * the dialect is detected by probing the endpoint, the generation by running
 * `<bin> --version`. They must be paired — a v2 client cannot drive a v1
 * server and vice versa — so profiles carry an optional `bin` (per-profile,
 * no global default) and `api` (auto|v1|v2) and the pairing check runs before
 * anything launches.
 *
 * Everything dialect-specific lives behind this module and opencode-server.mjs;
 * the orchestration scripts stay generation-agnostic.
 */

export const API_V1 = "v1";
export const API_V2 = "v2";
export const API_KINDS = [API_V1, API_V2];

/** Minimum supported v1 release (the dual-entrypoint plugin floor). */
export const V1_MIN_VERSION = [1, 18, 29];

export const DEFAULT_USERNAME = "opencode";

/**
 * Parse a version string into [major, minor, patch]. Accepts plain versions
 * ("1.18.29", "2.0.32-beta.1") and full --version output ("opencode v2.0.32").
 * Returns null when no version-shaped token exists.
 */
export function parseVersion(text) {
  const match = String(text || "").match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Compare two [major, minor, patch] arrays. Returns -1, 0, or 1. */
export function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}

/** 2 for opencode >= 2.0.0, 1 for anything older (v1 line), null unparseable. */
export function versionGeneration(version) {
  if (!version) return null;
  return version[0] >= 2 ? 2 : 1;
}

function basicAuthHeader(username, password) {
  if (password === undefined || password === "") return undefined;
  return `Basic ${Buffer.from(`${username || DEFAULT_USERNAME}:${password}`).toString("base64")}`;
}

async function probeGet(fetchImpl, baseUrl, path, { headers, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
    const text = await response.text();
    return { status: response.status, text };
  } catch (error) {
    return { error: error?.name === "AbortError" ? "timed out" : error?.message || String(error) };
  } finally {
    clearTimeout(timer);
  }
}

function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Classify an OpenCode endpoint without assuming a dialect.
 *
 * v2 signals: GET /api/info → 200 JSON ({version,pid}); the v2 web UI served at
 * /session is HTML. v1 signals: GET /session → 200 JSON array.
 *
 * A 401/403 on /api/info is NOT a dialect signal: both generations guard every
 * route with basic auth before routing, so an authenticated v1 server also
 * answers 401 there. When the info probe is rejected, the legacy /session probe
 * decides: JSON ⇒ v1 with credentials accepted, HTML ⇒ v2 with credentials
 * rejected, rejected as well ⇒ auth required and dialect unknown.
 *
 * Returns { api, serverUp, authOk, authRequired, version, detail }. api is null
 * when the server is down, unrecognized, or authentication hides the dialect.
 */
export async function probeServer({
  baseUrl,
  username = DEFAULT_USERNAME,
  password,
  fetchImpl = globalThis.fetch,
  timeoutMs = 3_000,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const base = String(baseUrl || "").replace(/\/+$/, "");
  if (!base) return { api: null, serverUp: false, authOk: false, authRequired: false, version: null, detail: "no server URL" };
  const headers = {};
  const auth = basicAuthHeader(username, password);
  if (auth) headers.authorization = auth;

  // v2 first: the v2 API is authoritative about itself.
  const info = await probeGet(fetchImpl, base, "/api/info", { headers, timeoutMs });
  const infoAuthRequired = !info.error && (info.status === 401 || info.status === 403);
  if (!info.error && info.status === 200) {
    const parsed = tryJson(info.text);
    if (parsed && typeof parsed === "object" && ("version" in parsed || "pid" in parsed)) {
      return {
        api: API_V2,
        serverUp: true,
        authOk: true,
        authRequired: false,
        version: typeof parsed.version === "string" ? parsed.version : null,
        detail: "v2 /api/info",
      };
    }
  }

  // v1: /session answers JSON only on the v1 API.
  const legacy = await probeGet(fetchImpl, base, "/session", { headers, timeoutMs });
  if (!legacy.error) {
    if (legacy.status === 200) {
      const parsed = tryJson(legacy.text);
      if (Array.isArray(parsed)) {
        // The credentials reached the v1 router even if /api/info 401'd
        // (v1 answers that unknown route behind its auth middleware).
        return { api: API_V1, serverUp: true, authOk: true, authRequired: false, version: null, detail: "v1 session list" };
      }
      if (parsed === undefined && /^\s*</.test(legacy.text)) {
        // The v2 web UI is served at /session; a parseable JSON result would
        // have been the v1 API. A public SPA with a protected API is still v2.
        return {
          api: API_V2,
          serverUp: true,
          authOk: !infoAuthRequired,
          authRequired: infoAuthRequired,
          version: null,
          detail: infoAuthRequired
            ? `v2 web ui (the api requires authentication; HTTP ${info.status} on /api/info)`
            : "v2 web ui (the legacy /session route no longer serves the api)",
        };
      }
    }
    if (legacy.status === 401 || legacy.status === 403) {
      return {
        api: null,
        serverUp: true,
        authOk: false,
        authRequired: true,
        version: null,
        detail: `authentication required; dialect unknown (HTTP ${legacy.status} on /session)`,
      };
    }
    return {
      api: null,
      serverUp: true,
      authOk: false,
      authRequired: infoAuthRequired,
      version: null,
      detail: infoAuthRequired
        ? `authentication required; dialect unknown (HTTP ${info.status} on /api/info)`
        : `unrecognized server response (HTTP ${legacy.status} on /session)`,
    };
  }
  if (infoAuthRequired) {
    // /api/info answered even though the legacy probe could not: the server is
    // up, but authentication hides which generation it is.
    return {
      api: null,
      serverUp: true,
      authOk: false,
      authRequired: true,
      version: null,
      detail: `authentication required; dialect unknown (HTTP ${info.status} on /api/info)`,
    };
  }
  return {
    api: null,
    serverUp: false,
    authOk: false,
    authRequired: false,
    version: null,
    detail: `server unreachable (${info.error || legacy.error})`,
  };
}

/**
 * Detect the client binary generation by running `<bin> --version`.
 * Returns { bin, version, generation, error } (version as "x.y.z").
 */
export function clientVersion(bin = "opencode", { execFileImpl } = {}) {
  if (typeof execFileImpl !== "function") {
    throw new Error("clientVersion requires an execFileSync implementation");
  }
  try {
    const raw = String(
      execFileImpl(bin, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    ).trim();
    const parsed = parseVersion(raw);
    return {
      bin,
      version: parsed ? parsed.join(".") : null,
      generation: versionGeneration(parsed),
      raw,
    };
  } catch (error) {
    return { bin, version: null, generation: null, error: error?.message || String(error) };
  }
}

/**
 * Pair a server dialect with a client binary generation.
 *
 * Returns { ok, reason, severity } where severity is one of "ok", "unknown",
 * "unreachable", or "mismatch". A null generation (binary missing or
 * unparseable) is "unknown", not a hard failure — read-only HTTP modes do not
 * launch the binary.
 */
export function pairingStatus({ api, generation, version } = {}) {
  if (!api) return { ok: false, severity: "unreachable", reason: "server dialect unknown (server unreachable or unrecognized)" };
  if (generation === null || generation === undefined) {
    return { ok: false, severity: "unknown", reason: "client binary version could not be determined" };
  }
  if (api === API_V1 && generation !== 1) {
    return {
      ok: false,
      severity: "mismatch",
      reason: `server speaks v1 but the client binary is v2 (${version || "unknown"}) — set this profile's \"bin\" to an opencode 1.18.x binary`,
    };
  }
  if (api === API_V2 && generation !== 2) {
    return {
      ok: false,
      severity: "mismatch",
      reason: `server speaks v2 but the client binary is v1 (${version || "unknown"}) — set this profile's \"bin\" to an opencode 2.x binary`,
    };
  }
  if (api === API_V1 && version) {
    const parsed = parseVersion(version);
    if (parsed && compareVersions(parsed, V1_MIN_VERSION) < 0) {
      return {
        ok: false,
        severity: "mismatch",
        reason: `opencode ${version} is below the supported v1 floor (${V1_MIN_VERSION.join(".")})`,
      };
    }
  }
  return { ok: true, severity: "ok", reason: `paired ${api} server ↔ ${generation === 2 ? "v2" : "v1"} client` };
}

/**
 * Environment variables that make an OpenCode CLIENT binary talk to a server
 * of the given dialect with the resolved credentials. v2 prefers its own name
 * but still reads the v1 one; v1 knows only the v1 names.
 */
export function clientAuthEnv(api, { username = DEFAULT_USERNAME, password } = {}) {
  if (!password) return {};
  if (api === API_V2) {
    return { OPENCODE_PASSWORD: password, OPENCODE_SERVER_PASSWORD: password };
  }
  return { OPENCODE_SERVER_PASSWORD: password, ...(username && username !== DEFAULT_USERNAME ? { OPENCODE_SERVER_USERNAME: username } : {}) };
}
