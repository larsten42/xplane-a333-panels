#!/usr/bin/env node
// Builds a single-file executable for the current platform — no Node
// install required to run it — using Node's built-in `--build-sea`
// (stable-ish since v25.5; see package.json's engines). Every static asset
// tools/mcdu-server.js serves gets embedded straight into the binary via
// the SEA "assets" mechanism (see that file's serveStatic()), so the result
// really is one file: nothing needs to sit next to it on disk. Works
// because mcdu-server.js only imports Node built-ins (see its own top
// comment on "zero npm dependencies") — a SEA's injected main script can't
// load anything else from the filesystem, so there's no bundler step needed
// for the server logic itself, only for the assets it hands out over HTTP.
//
// Usage: node tools/build-sea.mjs [output-path]
//   Already runnable immediately after this on the machine that built it —
//   chmod +x and (on macOS) an ad-hoc codesign both happen automatically
//   below. Only relevant if the binary then moves to another machine, e.g.
//   downloaded from a GitHub Release in a browser: browsers don't preserve
//   the execute bit, and macOS additionally quarantines anything downloaded
//   from the internet regardless of this ad-hoc signature (that's a
//   Gatekeeper check, separate from — and not satisfied by — a signature
//   that isn't from a paid Apple Developer ID) — see README.md's "Getting
//   started" for the xattr/chmod a downloaded copy needs.
//   Cross-platform builds (e.g. building linux/win binaries from macOS) work
//   too if you pass a matching platform's `executable` — not done here, see
//   .github/workflows/release.yml, which instead builds natively on each OS.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_DIR = path.join(ROOT, "build-sea");

// Same relative paths tools/mcdu-server.js's serveStatic() resolves URLs
// against — keep this in sync with build-release.mjs's INCLUDE (that list
// also has "tools/mcdu-server.js" itself, which doesn't belong here: it's
// this build's *main* script, not a served asset).
const ASSETS = [
  "index.html",
  "css/mcdu.css",
  "css/efis.css",
  "fonts/B612Mono-Regular.ttf",
  "fonts/B612-Regular.ttf",
  "fonts/B612-Bold.ttf",
  "fonts/OFL.txt",
  "fonts/DSEG7Modern-Bold.ttf",
  "fonts/DSEG-OFL.txt",
  "config/profiles/default-fms.json",
  "config/profiles/efis-a333.json",
  "src/app.js",
  "src/mcdu-adapter.js",
  "src/mcdu-keypad.js",
  "src/mcdu-screen.js",
  "src/xplane-client.js",
  "src/efis-adapter.js",
  "src/efis-panel.js",
  "src/readout-formats.js",
  "src/rotary-encoder.js",
  "src/rotary-scale.js",
  "src/compass-scale.js",
  "src/arc-toggle.js",
  "src/detent-angles.js",
];

const platform = process.platform;
const defaultName = platform === "win32" ? "mcdu-server-win.exe" : `mcdu-server-${platform}-${process.arch}`;
const outputPath = path.resolve(process.argv[2] ?? path.join(ROOT, "dist-sea", defaultName));

fs.rmSync(BUILD_DIR, { recursive: true, force: true });
fs.mkdirSync(BUILD_DIR, { recursive: true });
fs.mkdirSync(path.dirname(outputPath), { recursive: true });

const assets = {};
for (const rel of ASSETS) assets[rel] = path.join(ROOT, rel);

const seaConfig = {
  main: path.join(ROOT, "tools", "mcdu-server.js"),
  mainFormat: "module",
  output: outputPath,
  disableExperimentalSEAWarning: true,
  assets,
};
const configPath = path.join(BUILD_DIR, "sea-config.json");
fs.writeFileSync(configPath, JSON.stringify(seaConfig, null, 2));

fs.rmSync(outputPath, { force: true });
execFileSync(process.execPath, ["--build-sea", configPath], { stdio: "inherit" });
fs.chmodSync(outputPath, 0o755);

if (platform === "darwin") {
  execFileSync("codesign", ["--sign", "-", outputPath], { stdio: "inherit" });
}

console.log(`Built ${outputPath} (${(fs.statSync(outputPath).size / 1024 / 1024).toFixed(1)} MB)`);
