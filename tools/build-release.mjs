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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");

// Relative to ROOT. Directories are copied recursively as-is.
const INCLUDE = [
  "index.html",
  "console.html",
  "manifest.webmanifest",
  "icons/icon.svg",
  "package.json", // read by tools/mcdu-server.js to show the app version on the operator console — not shipped in the SEA build, see build-sea.mjs
  "css/mcdu.css",
  "css/console.css",
  "vendor/fcu-instruments.js",
  "vendor/qrcode-generator.js",
  "fonts/B612Mono-Regular.ttf",
  "fonts/OFL.txt",
  "config/profiles/default-fms.json",
  "config/profiles/b738-fms.json",
  "config/profiles/efis-a333.json",
  "config/profiles/fcu-a333.json",
  "src/app.js",
  "src/mcdu-adapter.js",
  "src/mcdu-keypad.js",
  "src/mcdu-screen.js",
  "src/xplane-client.js",
  "src/efis-adapter.js",
  "src/efis-panel.js",
  "src/fcu-panel.js",
  "src/readout-formats.js",
  "src/panel-autoscale.js",
  "src/console.js",
  "tools/mcdu-server.js",
];

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
