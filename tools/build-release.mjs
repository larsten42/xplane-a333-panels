#!/usr/bin/env node
// Assembles the minimum set of files someone actually needs to run this
// (not develop it) into dist/ — e.g. to zip up for a forum post. Excludes
// dev/diagnostic tools (tools/mock-xplane-server/, tools/smoke-test.mjs),
// docs, package.json/lockfile (nothing in the runtime path needs npm — see
// README "Zero dependencies, on purpose"), and anything git/editor-specific.
//
// Usage: node tools/build-release.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SHIPPED_ASSETS, assertNoMissingImports } from "./shipped-assets.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

// Relative to ROOT. Directories are copied recursively as-is.
// package.json is read by tools/mcdu-server.js to show the app version on
// the operator console — not shipped in the SEA build (build-sea.mjs),
// which embeds the version at build time instead — see that file's own
// getServerVersion(). tools/mcdu-server.js itself is the one thing in
// SHIPPED_ASSETS's sibling list (build-sea.mjs's ASSETS) that does NOT
// belong here: there, it's the SEA's own main script, not a served asset;
// here, it's exactly what someone downloading this zip actually runs.
const INCLUDE = [...SHIPPED_ASSETS, "package.json", "tools/mcdu-server.js"];

assertNoMissingImports((rel) => fs.readFileSync(path.join(ROOT, rel), "utf8"));

fs.rmSync(DIST, { recursive: true, force: true });

let totalBytes = 0;
for (const rel of INCLUDE) {
  const src = path.join(ROOT, rel);
  const dest = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  totalBytes += fs.statSync(dest).size;
}

console.log(`Wrote ${INCLUDE.length} files (${(totalBytes / 1024).toFixed(0)} KB) to ${DIST}`);
console.log("Zip that folder — e.g.:");
console.log(`  cd ${ROOT} && zip -r xplane-a333-panels.zip dist`);
