# Architecture

Technical details behind [X-Plane A330 Panels](README.md): how it works,
building it from source, extending it to another aircraft, and what's
still missing.

## How it works

```
  tablet browser              tools/mcdu-server.js             X-Plane 12
┌──────────────────┐  ws/http  ┌──────────────────┐  ws/http  ┌──────────────────┐
│ index.html +      │◄────────►│  static files +   │◄────────►│ built-in Web API │
│ src/*.js + vendor/ │ port 5173│  /api/* proxy     │ localhost│  (REST + WS)     │
│ (MCDU/EFIS/FCU UI) │          │  (REST + WS relay)│  :8086   └──────────────────┘
└──────────────────┘          └──────────────────┘
```

See "Project layout" below for what's actually in `src/`/`vendor/`.

`tools/mcdu-server.js` runs once, on the same machine as X-Plane, and does
two things: serves the app's static files, and forwards everything under
`/api/` (REST and WebSocket) to X-Plane over `localhost`. The browser only
ever talks to whatever host and port served it the page — it never needs
X-Plane's address directly, which is what lets a tablet connect without any
setup beyond opening a URL.

All three panels share this one connection and one `XPlaneClient` instance
(`src/xplane-client.js`); each panel just has its own adapter translating
between the page's DOM and X-Plane's datarefs/commands. `mcdu-adapter.js`
decodes the CDU's character-grid datarefs into a screen model. `efis-adapter.js`
maps named buttons/readouts/toggle switches from a profile onto plain scalar
datarefs and commands — genuinely EFIS-agnostic under the hood, so the same
class is reused as-is for the FCU's profile too. Neither `mcdu-adapter.js`
nor any `efis-adapter.js` instance knows the others exist.

EFIS and FCU both render through `vendor/fcu-instruments.js` — a
third-party, dependency-free Web Components library (native custom
elements, no build step) that defines `<efis-panel>` and `<fcu-panel>` and
their constituent knobs/buttons/levers/displays. `src/efis-panel.js` and
`src/fcu-panel.js` are the glue: they hold all the X-Plane-specific
knowledge and wire a profile-driven `EfisAdapter` to that library's
imperative JS API (`window.efis`/`window.fcuPanel`/`window.fcu`). The
vendored file itself is never edited — see `vendor/README.md` for how to
bring in an updated bundle. MCDU still renders through its own
hand-written DOM (`mcdu-screen.js`/`mcdu-keypad.js`), not this library.

For the full X-Plane Web API protocol reference — endpoints, message
formats, the CDU dataref layout, and some rough edges we ran into along the
way — see `docs/xplane-web-api-notes.md`.

## Operator console

`http://<server>:<port>/console` — a status page for whoever's running the
sim on the host machine, separate from the tablet-facing panels
themselves. `tools/mcdu-server.js` opens it in a browser automatically on
startup (set `MCDU_NO_OPEN_CONSOLE=1` to skip that, e.g. running headless).
Shows:

- Server status, version, uptime, and port.
- Whether X-Plane is reachable (a fresh check against `/api/capabilities`
  on every page load — not a cached/background poll), its reported
  version, and whether `XPLANE_HOST`/`XPLANE_PORT` are non-default.
- Every bound network interface as a clickable link and a QR code (skipped
  for `localhost` itself — nothing to usefully scan there), for pointing a
  tablet at the right address without typing it in.
- Currently connected clients — IP and which panel was selected when they
  connected (not live-tracked after that, since all three panels share one
  websocket connection per tab; see `xplane-client.js`'s `connectSocket()`).

`console.html`/`css/console.css`/`src/console.js` render it, polling
`tools/mcdu-server.js`'s own `/console/status.json` every few seconds —
not an X-Plane endpoint, just this server's internal state. QR codes are
rendered client-side as SVG from `vendor/qrcode-generator.js`'s module
matrix (see `vendor/README.md`), not the vendored library's own default
output, so they match the page's look.

## Progressive Web App

`manifest.webmanifest` + `icons/icon.svg` give the MCDU/EFIS/FCU page
(`index.html`, not the operator console) a proper icon and name for
Android's Chrome "Add to Home Screen" — confirmed on a real device:
without HTTPS (see below), Chrome doesn't treat this as an installable
PWA, so "Add to Home Screen" falls back to a plain bookmark shortcut. It
gets the right icon and label, but tapping it opens a normal Chrome tab,
address bar and all — not the standalone, chrome-less window a real
installed PWA gets. That fallback ignores `display: standalone` in the
manifest entirely; there's no partial credit for having a manifest
without also clearing the installability bar.

This is the manifest half only, deliberately — a full installable PWA
(the standalone launch, a real "Install app" prompt, offline caching via
a service worker) requires a secure context: HTTPS, or the literal
`localhost` origin. A tablet always reaches this app over the host
machine's LAN IP (that's the whole point of it being a separate device —
see "How it works" above), never `localhost`, so that requirement can't
be met without adding real HTTPS. A self-signed certificate would
technically work but needs manually trusting on every device it's used
from, which cuts directly against this app's "just open a URL" design —
not pursued for that reason. See the Roadmap below.

The icon is a single SVG (no PNG variants) — Android/Chrome, the
explicitly-targeted platform, handles SVG manifest icons natively, and
its content is kept inside the ~80%-diameter safe zone Android's
maskable-icon spec expects. iOS Safari's PWA/manifest support is weaker
and wasn't a goal here; if it becomes one, that's the point PNG fallbacks
would be worth adding.

## Trying it without X-Plane running

```sh
npm install && npm run mock   # starts a mock X-Plane Web API on :8086
node tools/mcdu-server.js      # in another terminal
```

This starts a small stand-in server that mimics enough of the Web API to
click through the MCDU, useful for confirming everything's wired up before
pointing it at a real sim. You should see "MCDU MOCK SERVER" on line 1 and
be able to type on the scratchpad line using the on-screen keypad. The mock
server only covers the MCDU screen dataref today — EFIS and FCU both need a
real X-Plane instance to test against (see "Known limitations" below).

## Building a distributable copy

```sh
npm run build:release
```

Copies the files needed to run the app (not the dev tools or docs) into
`dist/`. Zip that folder to share a self-contained copy — the only
requirement on the other end is Node.js.

To build the no-Node-required single-file executable instead (for the
current OS only — see `.github/workflows/release.yml` for how all three
platforms get built on tag push):

```sh
node tools/build-sea.mjs
```

Uses Node's built-in `--build-sea` (Node ≥25.5), embedding every static
asset directly into the binary via [`node:sea`](https://nodejs.org/api/single-executable-applications.html) —
nothing needs to sit next to it on disk. Already runnable immediately
after this on the machine that built it — `build-sea.mjs` handles
`chmod +x` and (on macOS) an ad-hoc `codesign` itself. If the binary then
moves to another machine, see README.md's "Getting started" for the
xattr/chmod a downloaded copy needs — those only apply to a file that
actually crossed the network (e.g. a browser download), not a local build.

If X-Plane runs on a different machine than `mcdu-server.js`, set the
`XPLANE_HOST`/`XPLANE_PORT` environment variables before starting it. That
machine will also need **Allow incoming connections** on and its Web API
port reachable from the `mcdu-server.js` machine.

To check connectivity directly, or see exactly what's on the CDU screen
right now:

```sh
node tools/smoke-test.mjs                     # localhost:8086 by default
node tools/smoke-test.mjs 192.168.1.50 8086   # or a specific host
```

`tools/discover.mjs <keyword> [host] [port]` is the more general version —
searches X-Plane's full live command/dataref list for a keyword, useful when
wiring up a new profile.

## Known limitations

- The FCU panel is the newest of the three and still a work in progress:
  every button, knob, and display is wired to a real command/dataref and
  usable, but it's had less real-flight mileage than MCDU/EFIS and a
  couple of annunciators (LVLCH) have no confirmed driving dataref yet —
  see the Roadmap below for the current list.
- Only the stock/default X-Plane FMS and EFIS are supported today. Add-on
  airliners need their own profile (see below); buttons/keys whose command
  doesn't resolve are disabled rather than silently failing, so a missing
  profile is obvious rather than confusing.
- `npm run mock`'s mock X-Plane server only implements the MCDU screen
  dataref — EFIS's and FCU's buttons, readouts, and knobs/levers aren't
  mocked yet, so testing either panel needs a real X-Plane instance.
- Brightness and annunciator-light datarefs were found alongside the MCDU
  keypad mapping but aren't wired into the interface yet.
- No automatic reconnect, no multi-tablet coordination beyond X-Plane's own
  CDU1/2/3 split, no offline/PWA support yet.
- MCDU rendering assumes one style byte per character, which holds for
  plain ASCII; multi-byte glyphs like ° could in principle misalign (not
  observed in practice).

## Interface

### MCDU

- **Keypad**: laid out and sized to match the real bezel, not a generic
  grid.
- **Key style**: a selector switches between Flat, Bevel, and Deboss
  looks — cosmetic only, persists across reloads.
- **Keyboard input**: once connected and the MCDU panel is active, your
  physical keyboard drives the alpha/numeric keys, plus `.`, `/`, `-`, and
  Backspace (→ CLR). Scoped to the MCDU panel only — switching to EFIS or
  FCU releases the keyboard.

### EFIS

- **Rotary knobs** (ND mode, map range, baro): click-drag vertically to
  turn, snapping to detents for ND mode/range. A short tap on the baro
  knob pulls (engage STD); press-and-hold (~400ms) pushes (revert to the
  selected QNH).
- **Bearing-pointer levers** (BRG1/BRG2): drag or tap a third to swing the
  lever between ADF/OFF/VOR.
- **Baro concentric ring**: the outer ring around the baro knob is a
  direct two-position click target — click either half to select in Hg or
  hPa outright, rather than toggling.
- **LED buttons** (CSTR/WPT/VOR.D/NDB/ARPT/FD/LS): press to toggle; lit
  state reads as a 3-bar LED segment, matching the real hardware's
  segmented indicator rather than one solid block.

### FCU

- **Rotary knobs** (SPD, HDG, ALT, V/S): click-drag vertically to turn. A
  short tap pulls, press-and-hold (~400ms) pushes — SPD/HDG/V/S each pull
  to select/engage and push to revert to managed; ALT's push behavior
  additionally depends on whether it's currently in managed or selected
  mode (see `fcu-panel.js`'s own comments for the exact command sequence
  each combination fires).
- **ALT knob's concentric ring**: same direct two-position click target as
  EFIS's baro ring, but for the 100ft/1000ft step size.
- **LED buttons** (AP1/AP2/A-THR/LOC/ALT/APPR) and **round buttons**
  (SPD-MACH/HDG-TRK-V-S-FPA mode/METRIC ALT): press to toggle or fire.
- **Display**: SPD/HDG/ALT/V-S seven-segment windows, with managed-mode
  dots and the HDG-TRK/V-S-FPA mode annunciator all driven from live
  datarefs. V/S shows dashes when no vertical target is active.

### Shared

- **Panel selector**: switches the main content between MCDU, EFIS, and
  FCU, top bar included, without dropping the connection.
- **Full screen**: the button in the top-right hides the connection
  controls, for flying without clutter on screen.
- **Auto-scale** (EFIS/FCU only): a "FIT" toggle in the top-right scales
  the active panel to fill the available window space (recomputed on
  resize); toggling it off shows the panel at its native pixel size.
  Persists across reloads, one shared preference for both panels.

## Adding support for another aircraft

Each panel type reads its dataref/command mapping from its own profile
under `config/profiles/`. The app itself isn't A330-specific under the
hood — it currently just ships one verified aircraft's worth of profiles.

**MCDU** (`default-fms.json`-shaped) has four parts:

- `screen` — line/column count and the dataref name template for the text
  and style arrays.
- `commandPrefixByCdu` — the command namespace prefix for each CDU
  position, composed with each key's `command` suffix.
- `keys` — logical key names, each mapped to a command suffix or a full
  `commandTemplate` for aircraft-specific commands that don't follow the
  prefix pattern.
- `keypadLayout` — the physical bezel layout, as a 2D array of key names
  per block, placed to match a photo of the real hardware.

**EFIS** and **FCU** (`efis-a333.json`/`fcu-a333.json`-shaped) share the
same profile format, read by the same `EfisAdapter` class — EFIS uses
`toggleSwitches` (which FCU has no use for) and FCU uses a couple of
button/readout shapes EFIS doesn't need, but both are the same three top-
level parts, all keyed by a display name:

- `buttons` — normally a `command` to press and a `stateDataref` reflecting
  whether it's lit. Three extra shapes, all documented in
  `efis-adapter.js`'s own top comment: `litValue` (several buttons sharing
  one dataref between mutually-exclusive states, e.g. FCU's AP1/AP2),
  `onCommands`/`offCommands` (one logical press needing more than one
  command, chosen by current state, e.g. FCU's A/THR), and no
  `stateDataref` at all (a button with no light of its own on the real
  hardware, e.g. FCU's HDG-TRK mode toggle).
- `toggleSwitches` — several named positions sharing one state dataref,
  each position its own command and expected enum value (EFIS's BRG1/BRG2).
- `readouts` — one or more datarefs formatted into display text (see
  `readout-formats.js`), optionally paired with an `encoder` (a rotary
  knob: either a directly writable dataref, or a paced sequence of
  increment/decrement commands for detent selectors) and/or `commands`
  (named push/pull commands, resolved as `"<readoutName>.<key>"`).

To add e.g. the Zibo 737: duplicate the relevant profile(s), point the
dataref templates and command names at `laminar/B738/...`, and switch which
profile `src/app.js` loads for that panel. `tools/discover.mjs` (or the
older `tools/smoke-test.mjs`) will help you find the real dataref and
command names for a new aircraft. If the new aircraft's EFIS/FCU differ
structurally from the A330's (different button/knob/lever set), you'd also
need your own layout — either a new profile-driven consumer of the
vendored library's lower-level pieces (`<fcu-knob>`, `<fcu-led-button>`,
etc. — see `vendor/README.md`), or a fully custom panel.

## Fonts

**B612 Mono** — the real font Airbus commissioned (with ENAC/Intactile
DESIGN, 2010–2012) for aircraft cockpit displays, not a generic lookalike —
later open-sourced under the SIL Open Font License via the Eclipse
Polarsys project. Used for the CDU's own CRT-style text; only the regular
weight, since the CDU's "large" style bit is a size difference on the real
display, not a bold one. Bundled locally in `fonts/` (with its OFL license
file, `fonts/OFL.txt`) so the app works with no internet access.

EFIS and FCU don't use a bundled font at all — both render through
`vendor/fcu-instruments.js` (see "How it works" above), whose own
seven-segment digits are CSS `clip-path` shapes and printed labels are
generic Helvetica/Arial. The proportional B612 sibling and DSEG7 Modern
(a seven-segment font) were both bundled early on for the pre-vendored
EFIS UI and are gone now that that UI is — if a from-scratch custom panel
ever replaces the vendored library, both are worth re-evaluating.

## Project layout

```
index.html                        the page — MCDU + EFIS + FCU markup, Panel selector
console.html                      operator console page — see "Operator console" above
manifest.webmanifest              PWA manifest for index.html — see "Progressive Web App" above
icons/icon.svg                    app icon, referenced by the manifest and both pages' favicons
css/mcdu.css                      MCDU look, plus the shared panel-switching/autoscale layout
css/console.css                   operator console's own plain UI look, not linked to mcdu.css
fonts/                            B612 Mono — see "Fonts" above
vendor/
  fcu-instruments.js                 third-party FCU+EFIS component library, used as-is — see vendor/README.md
  qrcode-generator.js                third-party QR encoder, used as-is — see vendor/README.md
src/
  xplane-client.js                 REST + WebSocket wrapper around X-Plane's Web API
  app.js                            wires everything together: connection UI, Panel selector
  mcdu-adapter.js                    dataref bytes -> screen model, key name -> command
  mcdu-screen.js                      renders the screen model to DOM
  mcdu-keypad.js                       builds keypad buttons from a profile, wires presses
  efis-adapter.js                    named buttons/readouts/toggle switches -> datarefs/commands
                                        (also reused as-is for the FCU profile — see its own top comment)
  efis-panel.js                       wires an EfisAdapter to vendor/fcu-instruments.js's <efis-panel>
  fcu-panel.js                         wires an EfisAdapter to vendor/fcu-instruments.js's <fcu-panel>
  readout-formats.js                   per-readout display-text formatting (QNH, mode/range labels, FCU windows)
  panel-autoscale.js                   fits <efis-panel>/<fcu-panel> to their container via a computed CSS transform
  console.js                           polls/renders the operator console — no X-Plane/adapter concepts at all
config/profiles/
  default-fms.json                  MCDU dataref/command mapping for the stock FMS
  efis-a333.json                    EFIS dataref/command mapping for the stock EFIS
  fcu-a333.json                     FCU dataref/command mapping for the stock FCU
docs/xplane-web-api-notes.md      protocol reference notes + sources
tools/
  mcdu-server.js                     serves the app + proxies /api/* to X-Plane
  build-release.mjs                  assembles the zero-dependency dist/ zip
  build-sea.mjs                      builds the no-Node-required single-file executable
  mock-xplane-server/               fake X-Plane Web API for offline MCDU development
  smoke-test.mjs                     dumps live CDU screen + scans commands/datarefs on a real sim
  discover.mjs                       keyword search over a real sim's full command/dataref list
```

## Roadmap

- LVLCH on the FCU display has no confirmed driving dataref yet.
- HDG's managed/selected display doesn't dash out like SPD's does yet —
  not yet confirmed whether it should.
- BRG1/BRG2's underlying dataref (`EFIS_1_selection_pilot`/`_2_`) can read
  a value (`2`) the current ADF/OFF/VOR mapping doesn't account for —
  cause not yet identified.
- The baro concentric ring's click target on the vendored EFIS knob is
  quite small — a Design polish item, not an instrumentation gap.
- EFIS/FCU support in the mock server, so both panels can be
  developed/tested without a running X-Plane instance too.
- Profile picker in the UI instead of a hardcoded default, per panel.
- A way to save a confirmed-working profile without hand-editing JSON.
- Full offline-installable PWA (a service worker, not just the manifest —
  see "Progressive Web App" below for why that's a bigger step than it
  sounds).
- Automatic reconnect on dropped connections.
