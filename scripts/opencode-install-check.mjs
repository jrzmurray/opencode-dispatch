#!/usr/bin/env node
/**
 * Drift check for an installed opencode-dispatch script dir.
 * Usage: opencode-install-check.mjs [<installed-scripts-dir>] [<source-checkout>]
 * Defaults: this script's own dir; the checkout recorded in the install stamp
 * (.opencode-dispatch-install.json, written by profile installs). Drift is
 * BYTE content of the installed scripts (and the installed Claude commands,
 * when the stamp records them); the source SHA is reported as info only, so a
 * new unrelated commit in the checkout is not drift. Generated Codex skills
 * and the hook registration are not compared. No stamp (repo-scope install, or
 * run from the checkout) is informational: exit 0. Exit 1 only on drift.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(process.argv[2] || path.dirname(fileURLToPath(import.meta.url)));
const stampPath = path.join(dir, ".opencode-dispatch-install.json");
let stamp;
try { stamp = JSON.parse(fs.readFileSync(stampPath, "utf8")); }
catch { console.log("no stamp (repo-scope install or checkout) - drift check skipped"); process.exit(0); }

const src = path.resolve(process.argv[3] || stamp.sourceRepo || "");
if (!stamp.sourceRepo && !process.argv[3]) { console.log("install stamp has no source checkout recorded"); process.exit(1); }
if (!fs.existsSync(path.join(src, "scripts"))) { console.log(`cannot verify: source checkout not found at ${src}`); process.exit(1); }

let drift = false;
let head = "unknown";
try { head = execFileSync("git", ["-C", src, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch {}
console.log(`installed from: ${stamp.sourceSha}\ncheckout HEAD:  ${head}` + (stamp.sourceSha !== head ? "  (info: checkout has moved on; only content differences count as drift)" : ""));
for (const f of stamp.files || []) {
  const inst = path.join(dir, f), from = path.join(src, "scripts", f);
  if (!fs.existsSync(inst)) { console.log(`missing: ${inst}`); drift = true; }
  else if (!fs.existsSync(from) || !fs.readFileSync(inst).equals(fs.readFileSync(from))) { console.log(`differs: ${inst}`); drift = true; }
}
if (stamp.commandsDir && fs.existsSync(path.join(src, "commands", "opencode"))) {
  for (const f of fs.readdirSync(path.join(src, "commands", "opencode")).filter((n) => n.endsWith(".md"))) {
    const inst = path.join(stamp.commandsDir, f), from = path.join(src, "commands", "opencode", f);
    if (!fs.existsSync(inst)) { console.log(`missing: ${inst}`); drift = true; }
    else if (!fs.readFileSync(inst).equals(fs.readFileSync(from))) { console.log(`differs: ${inst}`); drift = true; }
  }
}
console.log(drift ? "DRIFT: re-run ./install.sh from the opencode-dispatch checkout" : `up to date: ${dir}`);
process.exit(drift ? 1 : 0);
