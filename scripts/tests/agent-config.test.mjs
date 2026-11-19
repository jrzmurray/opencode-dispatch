import assert from "node:assert/strict";
import test from "node:test";

import { normalizeModelRef, resolveAgentModel } from "../agent-config.mjs";

test("normalizeModelRef accepts v1 strings and normalized v2 objects", () => {
  assert.deepEqual(normalizeModelRef("deepseek/deepseek-v4-pro"), {
    providerID: "deepseek",
    model: "deepseek-v4-pro",
    variant: "",
  });
  assert.deepEqual(normalizeModelRef("opencode-go/deepseek-v4.1-flash#max"), {
    providerID: "opencode-go",
    model: "deepseek-v4.1-flash",
    variant: "max",
  });
  assert.deepEqual(normalizeModelRef({ providerID: "p", model: "m", variant: "high" }), {
    providerID: "p",
    model: "m",
    variant: "high",
  });
  assert.deepEqual(normalizeModelRef({ providerID: "p", id: "m" }), {
    providerID: "p",
    model: "m",
    variant: "",
  });
  assert.equal(normalizeModelRef(""), null);
  assert.equal(normalizeModelRef("bare-model"), null);
  assert.equal(normalizeModelRef({ model: "m" }), null);
});

test("resolveAgentModel uses the agent's model and variant from normalized config", () => {
  let call = null;
  const resolved = resolveAgentModel({
    directory: "/repo",
    agent: "plan",
    bin: "/fake/opencode",
    execFileImpl: (bin, args, options) => {
      call = { bin, args, options };
      return JSON.stringify([
        {
          type: "document",
          path: "/home/.config/opencode/opencode.json",
          info: {
            model: { providerID: "p", model: "default", variant: "" },
            agents: {
              plan: { model: { providerID: "p", model: "plan-model", variant: "max" } },
              auto: { model: "q/auto-model#high" },
            },
          },
        },
      ]);
    },
  });
  assert.deepEqual(call.args, ["debug", "config"]);
  assert.equal(call.options.cwd, "/repo");
  assert.equal(call.bin, "/fake/opencode");
  assert.deepEqual(resolved, { providerID: "p", model: "plan-model", variant: "max" });
});

test("resolveAgentModel honors later config documents and legacy agent maps", () => {
  const resolved = resolveAgentModel({
    directory: "/repo",
    agent: "auto",
    execFileImpl: () => JSON.stringify([
      {
        type: "document",
        path: "/global",
        info: { agent: { auto: { model: "p/global-auto#max" } } },
      },
      {
        type: "document",
        path: "/project",
        info: { agents: { auto: { model: { providerID: "p", model: "project-auto", variant: "high" } } } },
      },
    ]),
  });
  assert.deepEqual(resolved, { providerID: "p", model: "project-auto", variant: "high" });
});

test("resolveAgentModel falls back to the top-level model and tolerates failures", () => {
  const top = resolveAgentModel({
    directory: "/repo",
    agent: "unknown",
    execFileImpl: () => JSON.stringify([
      { type: "document", path: "/global", info: { model: "p/default#max", agents: {} } },
    ]),
  });
  assert.deepEqual(top, { providerID: "p", model: "default", variant: "max" });

  assert.equal(resolveAgentModel({ agent: "", execFileImpl: () => "[]" }), null);
  assert.equal(resolveAgentModel({ agent: "plan", execFileImpl: () => { throw new Error("no binary"); } }), null);
  assert.equal(resolveAgentModel({ agent: "plan", execFileImpl: () => "not json" }), null);
  assert.equal(resolveAgentModel({ agent: "plan", execFileImpl: () => JSON.stringify({}) }), null);
});
