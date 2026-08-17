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

**2026-08-15 touch-sensitivity rework** (affects `<fcu-knob>` and
`<fcu-selector-knob>`, so FCU, EFIS, and Radio all feel this at once —
no `src/*.js` changes needed, the `onTurn(dir)`/`onChange(index)` API
didn't change, only the physical gesture that triggers it):
- `<fcu-knob>` (FCU's SPD/HDG/ALT/VS, EFIS's baro, Radio's tune knobs):
  turn sensitivity is now a `drag-step` px-per-detent threshold (default
  14, was a fixed 6px) with proper multi-detent catch-up on a fast drag,
  instead of firing on every few px of movement — fixes knobs feeling
  "finicky"/twitchy on touch.
- `<fcu-selector-knob>` (EFIS's ND mode/range, Radio's band selector):
  default interaction changed from angle-following (point at the detent
  you want) to the same press-and-drag-vertically model as the round
  knobs (`drag-step` default 40). The old angle-following behavior is
  still available via `drag-mode="angle"` on the element, for a panel
  that specifically wants it. Mouse-wheel direction on selector knobs
  also flipped to match the new drag convention (`deltaY>0` now steps the
  opposite way it used to).

**2026-08-15 `drag-invert` attribute (hand-patched here, needs relaying
upstream to Design so the next bundle keeps it)**: EFIS's ND mode/range
knobs and Radio's band selector both use `<fcu-selector-knob>`, but their
label layouts sweep in opposite rotational directions (EFIS's LS/VOR/NAV/
ARC/PLAN positions match a real Airbus panel photo and can't be moved;
Radio's is a new layout Design authored the other way around) — combined
with the single global "drag up = index−1" rule, that meant dragging up
spun the two knob faces in physically opposite directions. Since neither
knob face's label positions can change (EFIS for hardware accuracy,
Radio because inverting it would just move the mismatch instead of fixing
it), `drag-invert="true"` on `<fcu-selector-knob>` flips which way both
drag and wheel input walk the index, for a knob face laid out the
opposite way from the default. Applied to EFIS's `nd-mode`/`nd-range`
elements only — Radio's `sel1`/`sel2` are unaffected (no attribute, same
as before). Net effect: "drag up = clockwise, scroll down = counter-
clockwise" now holds on every selector knob in the app, regardless of
which way that particular knob's own labels are laid out.

## radio.js

The generic radio-stack panel component ("Claude Design"'s vanilla build,
same origin as fcu-instruments.js — native Web Components, zero
dependencies, no build step). Defines `<radio-panel>`, built from
fcu-instruments.js's existing primitives plus a handful of new optional
attributes added there for this panel (`panel-chassis[tone]`,
`seven-seg[bezel-tone]`, `fcu-lever[vertical]`, `fcu-knob[knurl]`,
`fcu-knob[bezel-mark]`, `fcu-knob[cap-inset]`, and the knob's
`setBezelAngle`/`turnBezel`/`getBezelAngle` methods for the concentric
coarse/fine tuning ring) — all additive and defaulted off, so they don't
affect the existing `<fcu-panel>`/`<efis-panel>` look. Exposes
`window.radioPanel`, which `src/radio-panel.js` wires to the real X-Plane
adapter. Loaded after fcu-instruments.js (it depends on those primitives
being defined first).

Also defines a MIC SEL transmit-select lever (`micSel()`/`setMic(n)`/
`onMic(fn)` on the `window.radioPanel` API, 1 = COM1 / 2 = COM2) — added
2026-08-12, reuses the existing `<fcu-lever>` primitive, no new component
type.

**2026-08-15**: each of the two units now has a *fixed* band set rather
than sharing one 6-position selector — unit 1 is COM1/NAV1/ADF1, unit 2 is
COM2/NAV2/ADF2/DME (`radioPanel.bands` became a function, `bands(u)`, to
reflect this — nothing in `src/radio-panel.js` used the old flat-array
form, so this needed no wiring change). ADF2 added throughout (tuning,
audio select). See the touch-sensitivity rework noted under
`fcu-instruments.js` above — the tuning/selector knobs here are the same
components FCU/EFIS use.

**To update when a new bundle arrives:** same process as fcu-instruments.js
above — copy both `fcu-instruments.js` and `radio.js` from the new bundle
over these two files, reload and sanity-check all three panels (the shared
library file affects FCU/EFIS too), and check `src/radio-panel.js` against
the new bundle's own integration doc if any method names/signatures moved.

## rmp.js

The Airbus RMP (Radio Management Panel)/ACP (Audio Control Panel) component
("Claude Design"'s vanilla build, same origin as fcu-instruments.js — native
Web Components, zero dependencies, no build step). Defines `<rmp-panel>` and
`<acp-panel>`, built from fcu-instruments.js's existing primitives
(`<fcu-led-button led="none">` for the legend-only Airbus pushbuttons) plus
one component type local to this file: `<acp-knob>` (continuous
reception-volume pot with a tap-to-toggle lamp). Loaded after
fcu-instruments.js, same as radio.js.

**2026-08-16 ACP row-1 rework**: the transmit/CALL row (VHF1/VHF2/VHF3/
HF1/HF2/INT/CAB, plus PA in the middle band) switched from the file's own
one-off `<acp-key>` (dark, no backlight/LED distinction) to the standard
three-stripe-LED `<fcu-led-button>` fcu-instruments.js already uses
elsewhere — `led="none"`/`backlit="false"` on VOICE/RESET/the CALL keys, so
LEDs and legend backlight are independently controllable
(`key(id).setLed(on)` for the green stripes, `key(id).setBacklight(on)` for
the amber legend). `acp.key(id)` now resolves to that `<fcu-led-button>`'s
API instead of `<acp-key>`'s — **`setLit()` is gone, it's `setLed()` now**
(`isLit()`/`onPress()` unchanged) — `src/rmp-panel.js` updated to match.
`<acp-key>` itself is still defined (for anything that referenced it
directly) but nothing in this file's own markup uses it anymore.

**2026-08-16 window globals (hand-patched here, needs relaying upstream to
Design so the next bundle keeps it)**: unlike radio.js (`window.radioPanel`)
and fcu-instruments.js (`window.fcuPanel`/`window.efis`), the delivered
`rmp.js` didn't expose `window.rmpPanel`/`window.acpPanel` — only the
`rmp-ready`/`acp-ready` custom events. Patched `connectedCallback()` in both
`RmpPanel`/`AcpPanel` to also set the window global, matching how every
other vendored panel component here already does it, so `src/rmp-panel.js`
doesn't need its own one-off ready-event listener just for this file.

**2026-08-16 `<acp-knob>` `onTap()` hook (hand-patched here, needs relaying
upstream to Design so the next bundle keeps it)**: the delivered `AcpKnob`
only exposed a self-contained tap-toggles-its-own-lamp gesture, with
nothing for wiring code to intercept — the lamp state was purely local,
with no way to drive it from a real command/dataref (needed for the ACP's
per-channel "listen" reception toggle, a 16-element array dataref — see
`config/profiles/rmp-acp-a333.json`'s `_note_on_listen_toggle`). Patched
`AcpKnob`'s `connectedCallback()` to add `onTap(fn)`, called instead of the
built-in `toggleLamp()` on a tap once a handler is registered (unregistered
knobs — every other channel's volume pot — keep the old self-toggle
behavior unchanged, so this is purely additive). `src/rmp-panel.js` uses it
to fire the real `listen_press00`/`listen_press01` commands and drive the
lamp only from the sim's confirmed `listen_status`, never an unconfirmed
local guess.

**Integration scope**: `src/rmp-panel.js` currently only wires VHF1/VHF2
(COM1/COM2) — see `config/profiles/rmp-acp-a333.json`'s own description for
what's still unwired (VHF3/HF1/HF2/AM/NAV/VOR/LS/ADF/BFO on the RTP and the
ACP's INT/CAB/PA/nav-reception rows). ACP reception volume is wired but
doesn't actually reach the sim yet — see the profile's own
`_gap_acp_volume_write`, an X-Plane Web API bug, not something fixable
here.

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
