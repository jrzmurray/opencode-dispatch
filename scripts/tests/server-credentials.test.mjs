import assert from "node:assert/strict";
import test from "node:test";

import credentials from "../server-credentials.cjs";
import { listProfiles, resolveProfile } from "../server-profiles.mjs";

const { keysFor, normalizeKey, normalizeMap, resolveCredential } = credentials;

test("credential keys normalize addresses without losing the port", () => {
  assert.deepEqual(keysFor("127.0.0.1", 4096), ["127.0.0.1:4096", "localhost:4096", "127.0.0.1", "localhost"]);
  assert.deepEqual(keysFor("LOCALHOST", "4096"), ["localhost:4096", "127.0.0.1:4096", "localhost", "127.0.0.1"]);
  assert.deepEqual(keysFor("192.0.2.50", 4096), ["192.0.2.50:4096", "192.0.2.50"]);
  assert.deepEqual(keysFor("", 4096), []);
  assert.equal(normalizeKey("http://192.0.2.50:4096"), "192.0.2.50:4096");
  assert.equal(normalizeKey("HTTPS://Example.COM"), "example.com:443");
  assert.equal(normalizeKey("[::1]:4096"), "::1:4096");
  assert.equal(normalizeKey("192.0.2.50:4096"), "192.0.2.50:4096");
});

test("the keyed layers are address-scoped and the single env value is only a fallback", () => {
  const project = { username: "profile-user", password: "profile-pw" };
  const fileMap = {
    "192.0.2.50:4096": { password: "file-port-pw" },
    "192.0.2.50": { password: "file-host-pw" },
    "198.51.100.7": "file-string-pw",
  };
  const envMap = JSON.stringify({ "192.0.2.50:4096": { username: "env-user", password: "env-pw" } });
  const env = { OPENCODE_SERVER_PASSWORD: "global-pw" };

  // Env map wins for its exact address.
  assert.deepEqual(
    resolveCredential({ host: "192.0.2.50", port: 4096, profile: project, serverCredentials: fileMap, envCredentials: envMap, env }),
    { username: "env-user", password: "env-pw", source: "env:192.0.2.50:4096" },
  );

  // The profile owns its own credential.
  assert.deepEqual(
    resolveCredential({ host: "203.0.113.9", port: 4096, profile: project, serverCredentials: fileMap, envCredentials: "", env }),
    { username: "profile-user", password: "profile-pw", source: "profile" },
  );

  // The address map applies to profiles that do not carry their own pair.
  assert.deepEqual(
    resolveCredential({ host: "192.0.2.50", port: 4096, profile: {}, serverCredentials: fileMap, envCredentials: "", env }),
    { username: undefined, password: "file-port-pw", source: "credentials:192.0.2.50:4096" },
  );
  assert.deepEqual(
    resolveCredential({ host: "192.0.2.50", port: 5000, profile: {}, serverCredentials: fileMap, envCredentials: "", env }),
    { username: undefined, password: "file-host-pw", source: "credentials:192.0.2.50" },
  );
  assert.deepEqual(
    resolveCredential({ host: "198.51.100.7", port: 4096, profile: {}, serverCredentials: fileMap, envCredentials: "", env }),
    { username: undefined, password: "file-string-pw", source: "credentials:198.51.100.7" },
  );

  // Only an unkeyed profile falls back to the one global password.
  assert.deepEqual(
    resolveCredential({ host: "203.0.113.9", port: 4096, profile: {}, serverCredentials: fileMap, envCredentials: "", env }),
    { username: undefined, password: "global-pw", source: "env" },
  );
  assert.deepEqual(
    resolveCredential({ host: "203.0.113.9", port: 4096, profile: {}, serverCredentials: {}, envCredentials: "", env: {} }),
    { username: undefined, password: "", source: "none" },
  );
});

test("a malformed keyed map is rejected instead of silently ignored", () => {
  assert.throws(() => normalizeMap("{not json}", "OPENCODE_SERVER_CREDENTIALS"), /must be a JSON object/);
  assert.throws(() => normalizeMap(["a"], "servers.json credentials"), /must be a JSON object/);
  assert.deepEqual(normalizeMap('{"127.0.0.1": "pw"}'), { "127.0.0.1": { password: "pw" } });
});

test("profile resolution keeps endpoint precedence and skips non-profiles", () => {
  const defs = {
    _doc: {},
    credentials: { "127.0.0.1:4096": "map-pw" },
    alpha: { listen: "127.0.0.1", port: 4096, username: "u", password: "p" },
    beta: { listen: "0.0.0.0", host: "192.0.2.9", port: 5000 },
  };
  const alpha = resolveProfile({
    defs,
    name: "alpha",
    file: "servers.json",
    cliListen: "0.0.0.0",
    cliHost: "10.0.0.5",
    cliPort: "6000",
    env: {},
  });
  assert.equal(alpha.listen, "0.0.0.0");
  assert.equal(alpha.host, "10.0.0.5");
  assert.equal(alpha.port, 6000);
  assert.equal(alpha.username, "u");
  assert.equal(alpha.password, "p");

  const beta = resolveProfile({ defs, name: "beta", file: "servers.json", env: {} });
  assert.equal(beta.host, "192.0.2.9");
  assert.equal(beta.password, "");

  assert.deepEqual(
    listProfiles({ defs, file: "servers.json", env: {} }).map((profile) => profile.name),
    ["alpha", "beta"],
  );
  assert.throws(() => resolveProfile({ defs, name: "credentials", file: "servers.json" }), /reserved key/);
  assert.throws(() => resolveProfile({ defs: { bad: { api: "v3" } }, name: "bad", file: "servers.json" }), /invalid api/);
  assert.throws(() => resolveProfile({ defs: { bad: { host: "0.0.0.0" } }, name: "bad", file: "servers.json" }), /no reachable address/);
});

test("binding 0.0.0.0 keys credentials by the connection host, not the bind address", () => {
  const defs = {
    loop: { listen: "0.0.0.0", host: "localhost", port: 4096 },
    lan: { listen: "0.0.0.0", host: "192.0.2.50", port: 4096 },
    credentials: { "127.0.0.1:4096": "loop-pw", "192.0.2.50:4096": "lan-pw" },
  };
  // Connecting through localhost resolves the 127.0.0.1 key.
  const loop = resolveProfile({ defs, name: "loop", file: "servers.json", env: {} });
  assert.equal(loop.password, "loop-pw");

  // A wildcard bind does not make the local key apply to a different host.
  const lan = resolveProfile({ defs, name: "lan", file: "servers.json", env: {} });
  assert.equal(lan.password, "lan-pw");

  // The wildcard bind itself is never a connection address.
  assert.throws(
    () => resolveProfile({ defs: { noHost: { listen: "0.0.0.0" } }, name: "noHost", file: "servers.json", env: {} }),
    /no reachable address/,
  );
});
