# vendor/

Third-party libraries, used as-is. Nothing in here is ours to edit — if
something about a vendored file needs to change, that change belongs on
the upstream side, not here, so an update stays a plain file swap instead
of a merge.

## fcu-instruments.js

The FCU/EFIS panel component library ("Claude Design"'s vanilla build —
native Web Components, zero dependencies, no build step; see its own top
comment). Defines `<fcu-panel>`, `<efis-panel>`, and their constituent
pieces (`<fcu-knob>`, `<seven-seg>`, etc.) as custom elements, each exposing
an imperative JS API (`window.fcuPanel`, `window.fcu`, `window.efis`) that
`src/fcu-panel.js` and `src/efis-panel.js` wire up to the real X-Plane
adapters.

**To update when a new bundle arrives:**

1. Drop the new bundle wherever's convenient (e.g. `frontend-bundle/`,
   gitignored, not part of the app).
2. Copy just the library file over this one:
   `cp frontend-bundle/vanilla/fcu-instruments.js vendor/fcu-instruments.js`
3. Reload and sanity-check the FCU/EFIS panels.
4. If the new version renamed or restructured any button/knob/lever ids,
   or changed method names/signatures, `src/fcu-panel.js` and/or
   `src/efis-panel.js` will need matching updates — check their own top
   comments for the exact API surface each depends on, and diff the new
   bundle's `INTEGRATION.md` against the previous one to see what moved.

That's the whole process — no build step, no merge, nothing else in the
app should need to change unless the component API itself changed.

## qrcode-generator.js

[Kazuhiko Arase's `qrcode-generator`](https://github.com/kazuhikoarase/qrcode-generator)
(MIT), the readable (non-minified) `js/dist/qrcode.js` build, fetched
2026-08-09. Pure encoding logic, no DOM/canvas rendering of its own — a
plain `<script>` tag defines a global `qrcode(typeNumber, errorCorrectionLevel)`
function; `console.js` calls `.addData()`/`.make()` then reads the module
matrix via `.getModuleCount()`/`.isDark(row, col)` and draws its own SVG
from it, so the QR codes on the operator console match the page's own
look rather than the library's default HTML/table output (which this
build doesn't even include — that's in the non-`dist` source, not vendored
here since it's unused). To update: re-fetch
`https://raw.githubusercontent.com/kazuhikoarase/qrcode-generator/master/js/dist/qrcode.js`
over this file; the public API has been stable for years.
