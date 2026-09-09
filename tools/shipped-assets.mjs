// The set of static assets tools/mcdu-server.js's serveStatic() resolves
// URLs against — shared by build-release.mjs (the zero-dependency zip) and
// build-sea.mjs (the single-file executables) so there's exactly one list
// to keep in sync with reality, not two.
//
// Previously each build script hand-maintained its own copy of this list,
// with only a comment asking whoever adds a new src/ file to remember to
// update both. That failed silently in practice: src/safe-storage.js
// (added 2026-09-05) was added to neither, so it was missing from every
// v0.6.2 release artifact — the zip and all three platform executables —
// while src/app.js (which imports it) shipped fine. Since ES module
// imports are static, the browser's entire app.js module failed to load
// at all, with no visible error: the Connect button (wired at the bottom
// of that module) simply never got its click handler attached. Confirmed
// live 2026-09-09 against a real v0.6.2 install. One shared list can't
// drift between the two build scripts the way two separate ones did.
export const SHIPPED_ASSETS = [
  "index.html",
  "console.html",
  "manifest.webmanifest",
  "icons/icon.svg",
  "css/mcdu.css",
  "css/console.css",
  "vendor/fcu-instruments.js",
  "vendor/radio.js",
  "vendor/rmp.js",
  "vendor/qrcode-generator.js",
  "fonts/B612Mono-Regular.ttf",
  "fonts/OFL.txt",
  "config/profiles/default-fms.json",
  "config/profiles/mcdu-toliss-airbus.json",
  "config/profiles/b738-fms.json",
  "config/profiles/efis-a333.json",
  "config/profiles/efis-toliss-airbus.json",
  "config/profiles/fcu-a333.json",
  "config/profiles/radio-panel-generic.json",
  "config/profiles/rmp-acp-a333.json",
  "config/profiles/rmp-acp-toliss-airbus.json",
  "src/app.js",
  "src/mcdu-adapter.js",
  "src/mcdu-keypad.js",
  "src/mcdu-screen.js",
  "src/xplane-client.js",
  "src/efis-adapter.js",
  "src/efis-panel.js",
  "src/fcu-panel.js",
  "src/radio-panel.js",
  "src/rmp-panel.js",
  "src/rmp-minimap.js",
  "src/readout-formats.js",
  "src/panel-autoscale.js",
  "src/safe-storage.js",
  "src/wake-lock.js",
  "src/console.js",
];

// Cheap, real protection against this recurring: every relative import
// across the files actually being shipped must itself be in the list.
// Doesn't catch every possible omission (a file that's fetched by path at
// runtime rather than statically imported, e.g. a profile JSON, wouldn't
// be caught this way), but static `import`/`export ... from` is exactly
// the mechanism that turned one missing file into the *entire app*
// failing to load, so it's the failure mode most worth guarding against.
// Both build scripts call this right after copying/collecting files.
export function assertNoMissingImports(readFileForAsset) {
  const shipped = new Set(SHIPPED_ASSETS);
  const importRe = /(?:from|import)\s+["']\.\/([a-zA-Z0-9_-]+\.js)["']/g;
  for (const rel of SHIPPED_ASSETS) {
    if (!rel.endsWith(".js") || !rel.startsWith("src/")) continue;
    const contents = readFileForAsset(rel);
    for (const match of contents.matchAll(importRe)) {
      const importedRel = `src/${match[1]}`;
      if (!shipped.has(importedRel)) {
        throw new Error(
          `${rel} imports "./${match[1]}" but src/${match[1]} isn't in SHIPPED_ASSETS (tools/shipped-assets.mjs) — it would silently be missing from the built package.`
        );
      }
    }
  }
}
