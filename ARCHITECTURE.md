# Architecture

Technical details behind [X-Plane A330 Panels](README.md): how it works,
building it from source, extending it to another aircraft, and what's
still missing.

## How it works

```
   tablet browser                 tools/mcdu-server.js              X-Plane 12
┌───────────────────────┐  ws/http  ┌──────────────────────┐  ws/http  ┌──────────────────┐
│ index.html + src/*.js  │◄─────────►│  static files +      │◄─────────►│ built-in Web API │
│  - xplane-client.js    │ port 5173 │  /api/* proxy        │ localhost │  (REST + WS)     │
│  - mcdu-adapter.js     │           │  (REST + WS relay)   │  :8086    └──────────────────┘
│  - mcdu-screen.js      │           └──────────────────────┘
│  - mcdu-keypad.js      │
│  - efis-adapter.js     │
│  - efis-panel.js       │
└───────────────────────┘
```

`tools/mcdu-server.js` runs once, on the same machine as X-Plane, and does
two things: serves the app's static files, and forwards everything under
`/api/` (REST and WebSocket) to X-Plane over `localhost`. The browser only
ever talks to whatever host and port served it the page — it never needs
X-Plane's address directly, which is what lets a tablet connect without any
setup beyond opening a URL.

Both panels share this one connection and one `XPlaneClient` instance
(`src/xplane-client.js`); each panel just has its own adapter translating
between the page's DOM and X-Plane's datarefs/commands — `mcdu-adapter.js`
decodes the CDU's character-grid datarefs into a screen model,
`efis-adapter.js` maps named buttons/readouts/toggle switches from a
profile onto plain scalar datarefs and commands. Neither adapter knows the
other exists.

For the full X-Plane Web API protocol reference — endpoints, message
formats, the CDU dataref layout, and some rough edges we ran into along the
way — see `docs/xplane-web-api-notes.md`.

## Trying it without X-Plane running

```sh
npm install && npm run mock   # starts a mock X-Plane Web API on :8086
node tools/mcdu-server.js      # in another terminal
```

This starts a small stand-in server that mimics enough of the Web API to
click through the MCDU, useful for confirming everything's wired up before
pointing it at a real sim. You should see "MCDU MOCK SERVER" on line 1 and
be able to type on the scratchpad line using the on-screen keypad. The mock
server only covers the MCDU screen dataref today — the EFIS panel needs a
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

- Only the stock/default X-Plane FMS and EFIS are supported today. Add-on
  airliners need their own profile (see below); buttons/keys whose command
  doesn't resolve are disabled rather than silently failing, so a missing
  profile is obvious rather than confusing.
- `npm run mock`'s mock X-Plane server only implements the MCDU screen
  dataref — the EFIS panel's buttons, readouts, and toggle switches aren't
  mocked yet, so testing that panel needs a real X-Plane instance.
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
  Backspace (→ CLR). Scoped to the MCDU panel only — switching to EFIS
  releases the keyboard.

### EFIS

- **Rotary knobs** (ND mode, map range, baro): click-drag left/right to
  turn. The baro knob distinguishes a tap (push/pull STD, toggling between
  STD and the last QNH value) from a drag (adjusts the reading).
- **Bearing-pointer toggles** (BRG1/BRG2): drag to swing the lever between
  ADF/OFF/VOR, same white-ring printed-scale look as the mode/range knobs.
- **Baro unit selector**: the small arc above the baro knob is a direct
  click target — click "in Hg" or "hPa" to select that unit outright,
  rather than toggling; a small pointer on the knob's own ring shows which
  one is currently active.
- **Legend buttons** (CSTR/WPT/VOR.D/NDB/ARPT/FD/LS): press to toggle;
  lit state reads as 3 thin horizontal bars, matching the real hardware's
  segmented indicator rather than one solid block.

### Shared

- **Panel selector**: switches the main content between MCDU and EFIS,
  top bar included, without dropping the connection.
- **Full screen**: the button in the top-right hides the connection
  controls, for flying without clutter on screen.

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

**EFIS** (`efis-a333.json`-shaped) has three parts, all keyed by a display
name:

- `buttons` — a command to press and a dataref reflecting whether it's lit
  (CSTR/WPT/VOR.D/NDB/ARPT/FD/LS).
- `toggleSwitches` — several named positions sharing one state dataref,
  each position its own command and expected enum value (BRG1/BRG2).
- `readouts` — one or more datarefs formatted into display text, optionally
  paired with an `encoder` (a rotary knob: either a directly writable
  dataref, or a paced sequence of increment/decrement commands for detent
  selectors) — covers QNH/baro, ND mode, and map range.

To add e.g. the Zibo 737: duplicate the relevant profile(s), point the
dataref templates and command names at `laminar/B738/...`, and switch which
profile `src/app.js` loads for that panel. `tools/discover.mjs` (or the
older `tools/smoke-test.mjs`) will help you find the real dataref and
command names for a new aircraft.

## Fonts

Both bundled type families are the real ones Airbus commissioned (with
ENAC/Intactile DESIGN, 2010–2012) for aircraft cockpit displays, not generic
lookalikes — later open-sourced under the SIL Open Font License via the
Eclipse Polarsys project:

- **B612 Mono** — the CDU's own CRT-style text, and the EFIS's digital
  QNH/mode readouts where a fixed-width "display" look is correct. Only the
  regular weight is used; the CDU's "large" style bit is a size difference
  on the real display, not a bold one.
- **B612** (the proportional sibling) — printed panel labels on the EFIS
  (button legends, the ND mode/range and bearing-selector scale text)
  aren't set in a monospace face on the real hardware.
- **DSEG7 Modern** (Bold) — a seven-segment digital-display font for the
  QNH window's numeric reading, separately licensed (SIL OFL) — see
  `fonts/DSEG-OFL.txt`.

All three `.ttf` files are bundled in `fonts/` (with their OFL license
files) so the app works with no internet access.

## Project layout

```
index.html                        the page — MCDU + EFIS markup, Panel selector
css/mcdu.css                      MCDU look (screen colors/styles, keypad, layout)
css/efis.css                      EFIS look (readouts, buttons, rotary knobs, scales)
fonts/                            B612 Mono, B612, DSEG7 Modern — see "Fonts" above
src/
  xplane-client.js                 REST + WebSocket wrapper around X-Plane's Web API
  app.js                            wires everything together: connection UI, Panel selector
  mcdu-adapter.js                    dataref bytes -> screen model, key name -> command
  mcdu-screen.js                      renders the screen model to DOM
  mcdu-keypad.js                       builds keypad buttons from a profile, wires presses
  efis-adapter.js                    named buttons/readouts/toggle switches -> datarefs/commands
  efis-panel.js                       renders an EfisAdapter's state into DOM, wires input
  readout-formats.js                   per-readout display-text formatting (QNH, mode/range labels)
  rotary-encoder.js                    generic drag-to-turn knob widget (mode/range, baro, BRG)
  rotary-scale.js                      printed arc+tick+label scale around mode/range knobs
  compass-scale.js                     printed ring+tick+label scale around BRG toggles
  arc-toggle.js                        small 2-position arc+label toggle (baro unit selector)
  detent-angles.js                     shared knob-angle/point-on-circle math
config/profiles/
  default-fms.json                  MCDU dataref/command mapping for the stock FMS
  efis-a333.json                    EFIS dataref/command mapping for the stock EFIS
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

- An FCU panel (speed/heading/altitude/V-S windows) — next up; reference
  photos already gathered in `docs/screenshots/`.
- EFIS support in the mock server, so that panel can be developed/tested
  without a running X-Plane instance too.
- Profile picker in the UI instead of a hardcoded default, per panel.
- A way to save a confirmed-working profile without hand-editing JSON.
- PWA manifest for home-screen installs on tablets.
- Automatic reconnect on dropped connections.
- Proper tablet auto-scaling: sizing currently follows viewport width with
  a fixed ceiling, which phones stay under but tablets exceed, so every
  element caps out at max size well before a tablet's actual screen is
  used. The fix is to scale the whole interface as one unit to fit the
  available screen (width and height) rather than scaling individual
  elements by viewport width.
