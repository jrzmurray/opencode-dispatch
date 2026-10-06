#!/usr/bin/env node
/**
 * Small OpenCode HTTP client used by the agent launcher and lifecycle tools.
 * It talks to an already-running server; it never starts one implicitly.
 */

import path from "node:path";

function normalizeBaseUrl(value) {
  const url = new URL(value || "http://127.0.0.1:4096");
  if (url.username || url.password) throw new Error("OpenCode server URL must not contain credentials; use OPENCODE_SERVER_USERNAME/PASSWORD");
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function basicAuthHeader(username, password) {
  if (password === undefined || password === "") return undefined;
  return `Basic ${Buffer.from(`${username || "opencode"}:${password}`).toString("base64")}`;
}

function sameDirectory(left, right) {
  if (!left || !right) return false;
  return path.resolve(left) === path.resolve(right);
}

export class OpenCodeServerError extends Error {
  constructor(message, { status = 0, body = "", url = "" } = {}) {
    super(message);
    this.name = "OpenCodeServerError";
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

export class OpenCodeClient {
  constructor({ baseUrl, username = process.env.OPENCODE_SERVER_USERNAME || "opencode", password = process.env.OPENCODE_SERVER_PASSWORD, fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
    if (typeof fetchImpl !== "function") throw new Error("Node fetch is unavailable");
    this.baseUrl = normalizeBaseUrl(baseUrl || process.env.OPENCODE_SERVER_URL);
    this.username = username;
    this.password = password;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(method, pathname, { query = {}, body, timeoutMs = this.timeoutMs } = {}) {
    const url = new URL(`${this.baseUrl}${pathname}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    const headers = { accept: "application/json" };
    const auth = basicAuthHeader(this.username, this.password);
    if (auth) headers.authorization = auth;
    if (body !== undefined) headers["content-type"] = "application/json";

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        const detail = text.replace(/\s+/g, " ").trim().slice(0, 500);
        throw new OpenCodeServerError(`OpenCode server returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`, {
          status: response.status,
          body: detail,
          url: url.toString(),
        });
      }
      if (!text) return undefined;
      try {
        return JSON.parse(text);
      } catch {
        throw new OpenCodeServerError("OpenCode server returned invalid JSON", { status: response.status, body: text.slice(0, 500), url: url.toString() });
      }
    } catch (error) {
      if (error instanceof OpenCodeServerError) throw error;
      if (error?.name === "AbortError") throw new OpenCodeServerError(`OpenCode server request timed out: ${method} ${pathname}`, { url: url.toString() });
      throw new OpenCodeServerError(`could not reach OpenCode server: ${error?.message || String(error)}`, { url: url.toString() });
    } finally {
      clearTimeout(timer);
    }
  }

  health() {
    return this.request("GET", "/session", { timeoutMs: Math.min(this.timeoutMs, 5_000) });
  }

  createSession({ directory, parentId, title, agent, model, permission } = {}) {
    return this.request("POST", "/session", {
      query: { directory },
      body: {
        ...(parentId ? { parentID: parentId } : {}),
        ...(title ? { title } : {}),
        ...(agent ? { agent } : {}),
        ...(model ? { model } : {}),
        ...(permission ? { permission } : {}),
      },
    });
  }

  forkSession(parentId, { directory, messageId } = {}) {
    return this.request("POST", `/session/${encodeURIComponent(parentId)}/fork`, {
      query: { directory },
      body: messageId ? { messageID: messageId } : {},
    });
  }

  getSession(sessionId, { directory } = {}) {
    return this.request("GET", `/session/${encodeURIComponent(sessionId)}`, { query: { directory } });
  }

  listSessions({ directory } = {}) {
    return this.request("GET", "/session", { query: { directory } });
  }

  getSessionStatus({ directory } = {}) {
    return this.request("GET", "/session/status", { query: { directory } });
  }

  abortSession(sessionId, { directory } = {}) {
    return this.request("POST", `/session/${encodeURIComponent(sessionId)}/abort`, { query: { directory } });
  }

  async promptAsync(sessionId, { directory, text, agent, model, noReply = false } = {}) {
    const body = {
      parts: [{ type: "text", text }],
      ...(agent ? { agent } : {}),
      ...(model ? { model } : {}),
      ...(noReply ? { noReply: true } : {}),
    };
    return this.request("POST", `/session/${encodeURIComponent(sessionId)}/prompt_async`, { query: { directory }, body });
  }

  messages(sessionId, { directory } = {}) {
    return this.request("GET", `/session/${encodeURIComponent(sessionId)}/message`, { query: { directory } });
  }

  static assertDirectory(session, expectedDirectory) {
    const actual = session?.directory;
    if (!actual || !sameDirectory(actual, expectedDirectory)) {
      throw new OpenCodeServerError(
        `server session directory mismatch: expected ${expectedDirectory}, received ${actual || "<missing>"}`,
      );
    }
    return true;
  }
}
