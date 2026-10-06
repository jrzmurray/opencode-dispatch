#!/usr/bin/env node
/**
 * Drift check for an installed opencode-dispatch script dir.
 * Usage: opencode-install-check.mjs [<installed-scripts-dir>] [<source-checkout>]
 * Defaults: this script's own dir; the checkout recorded in the install stamp
 * (.opencode-dispatch-install.json, written by install.sh). Prints findings,
 * exits 1 on drift / missing stamp, 0 when the install matches the checkout.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(process.argv[2] || path.dirname(fileURLToPath(import.meta.url)));
const stampPath = path.join(dir, ".opencode-dispatch-install.json");
let stamp;
try { stamp = JSON.parse(fs.readFileSync(stampPath, "utf8")); }
catch { console.log(`no install stamp at ${stampPath} (not installed, or installed by an older install.sh)`); process.exit(1); }

const src = path.resolve(process.argv[3] || stamp.sourceRepo || "");
if (!stamp.sourceRepo && !process.argv[3]) { console.log("install stamp has no source checkout recorded"); process.exit(1); }
if (!fs.existsSync(path.join(src, "scripts"))) { console.log(`cannot verify: source checkout not found at ${src}`); process.exit(1); }

let drift = false;
let head = "unknown";
try { head = execFileSync("git", ["-C", src, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch {}
console.log(`installed from: ${stamp.sourceSha}\ncheckout HEAD:  ${head}`);
if (stamp.sourceSha !== head) { console.log("drift: installed SHA differs from the checkout"); drift = true; }
for (const f of stamp.files || []) {
  const inst = path.join(dir, f), from = path.join(src, "scripts", f);
  if (!fs.existsSync(inst)) { console.log(`missing: ${inst}`); drift = true; }
  else if (!fs.existsSync(from) || !fs.readFileSync(inst).equals(fs.readFileSync(from))) { console.log(`differs: ${inst}`); drift = true; }
}
console.log(drift ? "DRIFT: re-run ./install.sh from the opencode-dispatch checkout" : `up to date: ${dir}`);
process.exit(drift ? 1 : 0);
