#!/usr/bin/env node
/**
 * Small OpenCode HTTP client used by the agent launcher and lifecycle tools.
 * It talks to an already-running server; it never starts one implicitly.
 *
 * The client is dialect-aware: it drives either the v1 server API
 * (/session, /permission, /question) or the v2 API (/api/session,
 * /api/permission/request, /api/form). Detection and pairing live in
 * api-dialect.mjs; everything above this module works on normalized shapes:
 *
 *   session  — the raw object plus `directory` (v2 nests it under
 *              `location.directory`) and `api`.
 *   message  — a flat item: { id, role, created, completed, error, text, parts }
 *              where v1 {info, parts} items and v2 content[] messages both map
 *              to it. `parts` carry { kind: "text"|"reasoning"|"tool", ... }.
 *   ask      — { kind: "permission"|"question", id, sessionID, action, resources,
 *              title, request } from v1 /permission + /question or v2
 *              /api/permission/request + /api/form (forms are v2 questions).
 *
 * v2 location scoping is the `x-opencode-directory` header (URI-encoded);
 * v1 scopes with the `?directory=` query parameter. Callers pass `directory`
 * and the client picks the mechanism.
 */

import os from "node:os";
import path from "node:path";

import { API_V1, API_V2, DEFAULT_USERNAME, probeServer } from "./api-dialect.mjs";

function normalizeBaseUrl(value) {
  const url = new URL(value || "http://127.0.0.1:4096");
  if (url.username || url.password) throw new Error("OpenCode server URL must not contain credentials; use OPENCODE_SERVER_USERNAME/PASSWORD");
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function basicAuthHeader(username, password) {
  if (password === undefined || password === "") return undefined;
  return `Basic ${Buffer.from(`${username || DEFAULT_USERNAME}:${password}`).toString("base64")}`;
}

function sameDirectory(left, right) {
  if (!left || !right) return false;
  return path.resolve(left) === path.resolve(right);
}

function normTime(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value > 0 && value < 1e12 ? value * 1000 : value;
}

/**
 * True when a server URL points at this machine: localhost names, loopback
 * addresses, or one of this host's own interface addresses. Direct SQL cleanup
 * against the local database is only trustworthy for such servers; a remote
 * server owns a different database, and its sessions must be deleted through
 * the API.
 */
export function isLocalServerUrl(value) {
  if (!value) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  // 127.0.0.0/8 is loopback by definition; the interface list only carries
  // 127.0.0.1, and other addresses in the block are loopback too.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) || host === "::1") return true;
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.address.toLowerCase() === host) return true;
    }
  }
  return false;
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

/** v1 permission actions renamed in v2. */
const V2_ACTION_RENAMES = { bash: "shell", task: "subagent", write: "edit", patch: "edit" };

/**
 * Normalize a permission rules array to the dialect's wire shape.
 * Accepts both v1 rules ({permission, pattern, action}) and v2 rules
 * ({action, resource, effect}); emits v1 or v2 depending on `api`.
 */
export function mapPermissionRules(rules, api) {
  if (!Array.isArray(rules) || rules.length === 0) return undefined;
  const normalized = rules.map((rule) => {
    if (rule && typeof rule === "object" && "permission" in rule) {
      return { action: rule.permission, resource: rule.pattern ?? "*", effect: rule.action ?? "allow" };
    }
    return { action: rule?.action, resource: rule?.resource ?? "*", effect: rule?.effect ?? "allow" };
  });
  if (api === API_V2) {
    return normalized.map((rule) => ({ ...rule, action: V2_ACTION_RENAMES[rule.action] || rule.action }));
  }
  return normalized.map((rule) => ({ permission: rule.action, pattern: rule.resource, action: rule.effect }));
}

/** Normalize a session object: v2 nests the directory under `location`. */
export function normalizeSession(raw, api) {
  if (!raw || typeof raw !== "object") return raw;
  const directory = raw.location?.directory ?? raw.directory ?? null;
  return { ...raw, directory, api };
}

function normalizeError(error, api) {
  if (!error) return null;
  if (api === API_V2) {
    return {
      status: typeof error.status === "number" ? error.status : null,
      message: error.message || error.type || "error",
      type: error.type || null,
    };
  }
  return {
    status: error.data?.statusCode ?? null,
    message: error.data?.message || error.name || "error",
    type: error.name || null,
  };
}

function normalizeToolPart(part, api) {
  if (api === API_V2) {
    return {
      kind: "tool",
      id: part.id,
      name: part.name || "?",
      status: part.state?.status || "unknown",
      startedAt: normTime(part.time?.ran ?? part.time?.created),
      completedAt: normTime(part.time?.completed),
      input: part.state?.input,
    };
  }
  return {
    kind: "tool",
    id: part.callID || part.id,
    name: part.tool || "?",
    status: part.state?.status || "unknown",
    startedAt: normTime(part.state?.time?.start),
    completedAt: normTime(part.state?.time?.end),
    input: part.state?.input,
  };
}

function normalizePart(part, api) {
  if (!part || typeof part !== "object") return null;
  if (part.type === "text") return { kind: "text", text: part.text || "" };
  if (part.type === "reasoning") return { kind: "reasoning", text: part.text || "" };
  if (part.type === "tool") return normalizeToolPart(part, api);
  return null;
}

/**
 * Normalize a raw message list (v1 {info, parts} items or v2 content[]
 * messages) into flat user/assistant records. Non-conversation v2 messages
 * (idle, synthetic, system, compaction, ...) are dropped.
 */
export function normalizeMessages(rawItems, api) {
  if (!Array.isArray(rawItems)) return [];
  const out = [];
  for (const item of rawItems) {
    if (!item || typeof item !== "object") continue;
    if (api === API_V2) {
      if (item.type !== "user" && item.type !== "assistant") continue;
      if (item.type === "user") {
        const text = item.text || "";
        out.push({
          id: item.id,
          role: "user",
          created: normTime(item.time?.created),
          completed: normTime(item.time?.created),
          error: null,
          text,
          parts: text ? [{ kind: "text", text }] : [],
          raw: item,
        });
        continue;
      }
      const parts = (Array.isArray(item.content) ? item.content : []).map((part) => normalizePart(part, api)).filter(Boolean);
      out.push({
        id: item.id,
        role: "assistant",
        created: normTime(item.time?.created),
        completed: normTime(item.time?.completed),
        error: normalizeError(item.error, api),
        text: parts.filter((part) => part.kind === "text").map((part) => part.text).join("\n"),
        parts,
        raw: item,
      });
      continue;
    }
    const info = item.info || {};
    const parts = (Array.isArray(item.parts) ? item.parts : []).map((part) => normalizePart(part, api)).filter(Boolean);
    out.push({
      id: info.id,
      role: info.role || "user",
      created: normTime(info.time?.created),
      completed: normTime(info.time?.completed),
      error: normalizeError(info.error, api),
      text: parts.filter((part) => part.kind === "text").map((part) => part.text).join("\n"),
      parts,
      raw: item,
    });
  }
  return out;
}

/** Normalize a pending ask (permission or question/form) to one shape. */
export function normalizeAsk(raw, api) {
  if (!raw || typeof raw !== "object") return null;
  if (api === API_V2) {
    if ("action" in raw) {
      return {
        kind: "permission",
        id: raw.id,
        sessionID: raw.sessionID,
        action: raw.action || "?",
        resources: (raw.resources || []).join(" "),
        title: raw.message || raw.action || "?",
        request: raw,
      };
    }
    return {
      kind: "question",
      id: raw.id,
      sessionID: raw.sessionID,
      action: "form",
      resources: "",
      title: raw.title || "?",
      request: raw,
    };
  }
  if ("permission" in raw) {
    return {
      kind: "permission",
      id: raw.id,
      sessionID: raw.sessionID,
      action: raw.permission || "?",
      resources: (raw.patterns || []).join(" "),
      title: raw.permission || "?",
      request: raw,
    };
  }
  const question = (raw.questions || [])[0] || {};
  return {
    kind: "question",
    id: raw.id,
    sessionID: raw.sessionID,
    action: "question",
    resources: "",
    title: question.header || question.question || "?",
    request: raw,
  };
}

export class OpenCodeClient {
  /**
   * @param {object} options
   * @param {string} [options.api] "auto" (probe), "v1", or "v2".
   */
  constructor({
    baseUrl,
    username = process.env.OPENCODE_SERVER_USERNAME || DEFAULT_USERNAME,
    password = process.env.OPENCODE_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD,
    fetchImpl = globalThis.fetch,
    timeoutMs = 15_000,
    api = "auto",
  } = {}) {
    if (typeof fetchImpl !== "function") throw new Error("Node fetch is unavailable");
    this.baseUrl = normalizeBaseUrl(baseUrl || process.env.OPENCODE_SERVER_URL);
    this.username = username;
    this.password = password;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.apiSetting = api;
    this._resolvedApi = api === "auto" ? null : api;
    this._probe = null;
  }

  get api() {
    return this._resolvedApi;
  }

  get capabilities() {
    const api = this._resolvedApi;
    return {
      wait: api === API_V2,
      events: api === API_V2,
      forms: api === API_V2,
      steerQueue: api === API_V2 || api === API_V1,
      detected: Boolean(api),
    };
  }

  /** Resolve the dialect ('auto' probes the server). Throws when unknown. */
  async resolveApi({ force = false } = {}) {
    if (this._resolvedApi && !force) return this._resolvedApi;
    if (this.apiSetting !== "auto" && !force) {
      this._resolvedApi = this.apiSetting;
      return this._resolvedApi;
    }
    const probe = await probeServer({
      baseUrl: this.baseUrl,
      username: this.username,
      password: this.password,
      fetchImpl: this.fetchImpl,
      timeoutMs: Math.min(this.timeoutMs, 5_000),
    });
    this._probe = probe;
    if (!probe.api) {
      throw new OpenCodeServerError(`could not classify OpenCode server at ${this.baseUrl}: ${probe.detail}`, {
        status: 0,
        url: this.baseUrl,
      });
    }
    if (!probe.authOk) {
      throw new OpenCodeServerError(`OpenCode server at ${this.baseUrl} rejected the credentials: ${probe.detail}`, {
        status: 401,
        url: this.baseUrl,
      });
    }
    this._resolvedApi = probe.api;
    this._probe = probe;
    return this._resolvedApi;
  }

  /** Probe result when auto resolution ran; null otherwise. */
  get probe() {
    return this._probe;
  }

  locationHeaders(directory) {
    if (!directory || this._resolvedApi !== API_V2) return undefined;
    return { "x-opencode-directory": encodeURIComponent(directory) };
  }

  async request(method, pathname, { query = {}, body, timeoutMs = this.timeoutMs, headers: extraHeaders } = {}) {
    const url = new URL(`${this.baseUrl}${pathname}`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }
    const headers = { accept: "application/json", ...extraHeaders };
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

  /** Health check: v1 lists sessions, v2 reports server info. */
  async health() {
    const api = await this.resolveApi();
    if (api === API_V2) return this.request("GET", "/api/info", { timeoutMs: Math.min(this.timeoutMs, 5_000) });
    return this.request("GET", "/session", { timeoutMs: Math.min(this.timeoutMs, 5_000) });
  }

  async createSession({ directory, parentId, title, agent, model, permission } = {}) {
    const api = await this.resolveApi();
    if (api === API_V2) {
      const body = {
        ...(parentId ? { parentID: parentId } : {}),
        ...(title ? { title } : {}),
        ...(agent ? { agent } : {}),
        ...(model ? { model } : {}),
        ...(directory ? { location: { directory } } : {}),
        ...(permission ? { permissions: mapPermissionRules(permission, api) } : {}),
      };
      const response = await this.request("POST", "/api/session", { body });
      return normalizeSession(response?.data, api);
    }
    const response = await this.request("POST", "/session", {
      query: { directory },
      body: {
        ...(parentId ? { parentID: parentId } : {}),
        ...(title ? { title } : {}),
        ...(agent ? { agent } : {}),
        ...(model ? { model } : {}),
        ...(permission ? { permission } : {}),
      },
    });
    return normalizeSession(response, api);
  }

  async forkSession(parentId, { directory, messageId } = {}) {
    const api = await this.resolveApi();
    if (api === API_V2) {
      const response = await this.request("POST", `/api/session/${encodeURIComponent(parentId)}/fork`, {
        headers: this.locationHeaders(directory),
        body: { before: messageId || null },
      });
      return normalizeSession(response?.data, api);
    }
    const response = await this.request("POST", `/session/${encodeURIComponent(parentId)}/fork`, {
      query: { directory },
      body: messageId ? { messageID: messageId } : {},
    });
    return normalizeSession(response, api);
  }

  async getSession(sessionId, { directory } = {}) {
    const api = await this.resolveApi();
    if (api === API_V2) {
      const response = await this.request("GET", `/api/session/${encodeURIComponent(sessionId)}`, {
        headers: this.locationHeaders(directory),
      });
      return normalizeSession(response?.data, api);
    }
    const response = await this.request("GET", `/session/${encodeURIComponent(sessionId)}`, { query: { directory } });
    return normalizeSession(response, api);
  }

  async listSessions({ directory, limit } = {}) {
    const api = await this.resolveApi();
    if (api === API_V2) {
      const response = await this.request("GET", "/api/session", {
        query: { directory, limit },
      });
      return (response?.data || []).map((session) => normalizeSession(session, api));
    }
    const response = await this.request("GET", "/session", { query: { directory } });
    return (Array.isArray(response) ? response : []).map((session) => normalizeSession(session, api));
  }

  async getSessionStatus({ directory } = {}) {
    const api = await this.resolveApi();
    if (api === API_V2) {
      const response = await this.request("GET", "/api/session/active", { headers: this.locationHeaders(directory) });
      return response?.data;
    }
    return this.request("GET", "/session/status", { query: { directory } });
  }

  /** Interrupt the in-progress turn (v1 "abort" is v2 "interrupt"). */
  async interruptSession(sessionId, { directory } = {}) {
    const api = await this.resolveApi();
    if (api === API_V2) {
      return this.request("POST", `/api/session/${encodeURIComponent(sessionId)}/interrupt`, {
        headers: this.locationHeaders(directory),
      });
    }
    return this.request("POST", `/session/${encodeURIComponent(sessionId)}/abort`, { query: { directory } });
  }

  /** Back-compat alias for interruptSession. */
  abortSession(sessionId, options) {
    return this.interruptSession(sessionId, options);
  }

  /** Native session delete: interrupts the turn, removes the share, deletes child sessions, emits session.deleted. */
  async deleteSession(sessionId, { directory } = {}) {
    const api = await this.resolveApi();
    if (api === API_V2) {
      return this.request("DELETE", `/api/session/${encodeURIComponent(sessionId)}`, {
        headers: this.locationHeaders(directory),
      });
    }
    return this.request("DELETE", `/session/${encodeURIComponent(sessionId)}`, { query: { directory } });
  }

  /** v2 session agent/model are session state, switched through their own routes. */
  async setSessionAgent(sessionId, agent, { directory } = {}) {
    const api = await this.resolveApi();
    if (api !== API_V2) throw new OpenCodeServerError("setting a session agent is a v2 capability", { status: 0 });
    return this.request("POST", `/api/session/${encodeURIComponent(sessionId)}/agent`, {
      headers: this.locationHeaders(directory),
      body: { agent },
    });
  }

  async setSessionModel(sessionId, model, { directory } = {}) {
    const api = await this.resolveApi();
    if (api !== API_V2) throw new OpenCodeServerError("setting a session model is a v2 capability", { status: 0 });
    return this.request("POST", `/api/session/${encodeURIComponent(sessionId)}/model`, {
      headers: this.locationHeaders(directory),
      body: { model },
    });
  }

  /**
   * Submit a prompt without waiting for the turn.
   * v1: POST /session/:id/prompt_async. v2: set agent/model on the session
   * first (they are session state), then POST /api/session/:id/prompt.
   * `model` may be { providerID, id|modelID, variant }.
   */
  async promptAsync(sessionId, { directory, text, agent, model, noReply = false } = {}) {
    const api = await this.resolveApi();
    const body = { parts: [{ type: "text", text }], ...(agent ? { agent } : {}), ...(model ? { model } : {}), ...(noReply ? { noReply: true } : {}) };
    if (api === API_V2) {
      if (agent) await this.setSessionAgent(sessionId, agent, { directory });
      if (model) {
        const ref = { providerID: model.providerID, id: model.id || model.modelID, ...(model.variant ? { variant: model.variant } : {}) };
        await this.setSessionModel(sessionId, ref, { directory });
      }
      const response = await this.request("POST", `/api/session/${encodeURIComponent(sessionId)}/prompt`, {
        headers: this.locationHeaders(directory),
        body: { text },
      });
      return response?.data;
    }
    return this.request("POST", `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
      query: { directory },
      body: {
        parts: body.parts,
        ...(agent ? { agent } : {}),
        ...(model ? { model: { providerID: model.providerID, modelID: model.id || model.modelID } } : {}),
        ...(model?.variant ? { variant: model.variant } : {}),
        ...(noReply ? { noReply: true } : {}),
      },
    });
  }

  /** One page of messages, normalized: { messages, cursor }. */
  async messagesPage(sessionId, { directory, limit, order, type, cursor } = {}) {
    const api = await this.resolveApi();
    if (api === API_V2) {
      const response = await this.request("GET", `/api/session/${encodeURIComponent(sessionId)}/message`, {
        headers: this.locationHeaders(directory),
        query: { limit, order, type, cursor },
      });
      return { messages: normalizeMessages(response?.data, api), cursor: response?.cursor || null };
    }
    const response = await this.request("GET", `/session/${encodeURIComponent(sessionId)}/message`, { query: { directory } });
    return { messages: normalizeMessages(response, api), cursor: null };
  }

  /**
   * Normalized messages in chronological order (oldest → newest), matching
   * the v1 API's natural order. v2 returns newest-first pages, so the window
   * is fetched with `order=desc` and reversed. On v1 all messages are returned
   * regardless of `limit`.
   */
  async messages(sessionId, { directory, limit = 200 } = {}) {
    const api = await this.resolveApi();
    if (api === API_V2) {
      const page = await this.messagesPage(sessionId, { directory, limit, order: "desc" });
      return [...page.messages].reverse();
    }
    const page = await this.messagesPage(sessionId, { directory });
    return page.messages;
  }

  /** Pending permission requests (v1 /permission, v2 /api/permission/request). */
  async listPermissionRequests({ directory } = {}) {
    const api = await this.resolveApi();
    if (api === API_V2) {
      const response = await this.request("GET", "/api/permission/request", { headers: this.locationHeaders(directory) });
      return response?.data || [];
    }
    const response = await this.request("GET", "/permission", { query: { directory } });
    return Array.isArray(response) ? response : [];
  }

  /** Pending questions (v1 /question) or forms (v2 /api/form). */
  async listQuestionRequests({ directory } = {}) {
    const api = await this.resolveApi();
    if (api === API_V2) {
      const response = await this.request("GET", "/api/form", { headers: this.locationHeaders(directory) });
      return response?.data || [];
    }
    const response = await this.request("GET", "/question", { query: { directory } });
    return Array.isArray(response) ? response : [];
  }

  /**
   * Reply to a permission request. `reply` is "once" | "always" | "reject"
   * (v1 accepted only once|always). v2 needs the owning sessionID.
   */
  async replyPermissionRequest({ sessionId, requestId, directory, reply = "once" } = {}) {
    const api = await this.resolveApi();
    if (api === API_V2) {
      if (!sessionId) throw new OpenCodeServerError("v2 permission replies need the owning sessionID", { status: 0 });
      return this.request("POST", `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`, {
        headers: this.locationHeaders(directory),
        body: { decision: reply },
      });
    }
    return this.request("POST", `/permission/${encodeURIComponent(requestId)}/reply`, {
      query: { directory },
      body: { reply },
    });
  }

  /** Wait server-side for the current turn to settle (v2 capability). */
  async waitTurn(sessionId, { directory, timeoutMs } = {}) {
    const api = await this.resolveApi();
    if (api !== API_V2) throw new OpenCodeServerError("wait is a v2 capability", { status: 0 });
    return this.request("POST", `/api/experimental/session/${encodeURIComponent(sessionId)}/wait`, {
      headers: this.locationHeaders(directory),
      timeoutMs,
    });
  }

  /**
   * Server-sent event stream (v2 capability). Yields { id, type, data }.
   * The stream is live-only (no replay, no auto-reconnect): callers must
   * resync state after a stream ends or fails.
   */
  async *eventStream({ signal } = {}) {
    const api = await this.resolveApi();
    if (api !== API_V2) throw new OpenCodeServerError("the event stream is a v2 capability", { status: 0 });
    const url = new URL(`${this.baseUrl}/api/event`);
    const headers = { accept: "text/event-stream" };
    const auth = basicAuthHeader(this.username, this.password);
    if (auth) headers.authorization = auth;
    let response;
    try {
      response = await this.fetchImpl(url, { method: "GET", headers, signal });
    } catch (error) {
      if (error?.name === "AbortError") return;
      throw new OpenCodeServerError(`could not subscribe to events: ${error?.message || String(error)}`, { url: url.toString() });
    }
    if (!response.ok || !response.body) {
      throw new OpenCodeServerError(`event subscription failed (HTTP ${response.status})`, { status: response.status, url: url.toString() });
    }
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      if (signal?.aborted) return;
      buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        if (!line || line.startsWith(":")) continue; // heartbeat / comment
        if (!line.startsWith("data:")) continue; // event:/id:/retry: fields unused
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          yield JSON.parse(payload);
        } catch {
          // ignore malformed frames; the stream may still be healthy
        }
      }
    }
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
