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
│ (all panel UIs)   │          │  (REST + WS relay)│  :8086   └──────────────────┘
└──────────────────┘          └──────────────────┘
```

See "Project layout" below for what's actually in `src/`/`vendor/`.

`tools/mcdu-server.js` runs once, on the same machine as X-Plane, and does
two things: serves the app's static files, and forwards everything under
`/api/` (REST and WebSocket) to X-Plane over `localhost`. The browser only
ever talks to whatever host and port served it the page — it never needs
X-Plane's address directly, which is what lets a tablet connect without any
setup beyond opening a URL.

All five panels share this one connection and one `XPlaneClient` instance
(`src/xplane-client.js`); each panel just has its own adapter translating
between the page's DOM and X-Plane's datarefs/commands. `mcdu-adapter.js`
decodes the CDU's character-grid datarefs into a screen model. `efis-adapter.js`
maps named buttons/readouts/toggle switches from a profile onto plain scalar
datarefs and commands — genuinely EFIS-agnostic under the hood, so the same
class is reused as-is for the FCU's and Radio's profiles too. Neither
`mcdu-adapter.js` nor any `efis-adapter.js` instance knows the others exist.

EFIS, FCU, Radio, and RMP+ACP all render through `vendor/fcu-instruments.js`
— a third-party, dependency-free Web Components library (native custom
elements, no build step) that defines `<efis-panel>`, `<fcu-panel>`, and
their constituent knobs/buttons/levers/displays; `vendor/radio.js` builds
`<radio-panel>` and `vendor/rmp.js` builds `<rmp-panel>`/`<acp-panel>` from
those same primitives. `src/efis-panel.js`, `src/fcu-panel.js`,
`src/radio-panel.js`, and `src/rmp-panel.js` are the glue: they hold all
the X-Plane-specific knowledge and wire a profile-driven `EfisAdapter` to
that library's imperative JS API (`window.efis`/`window.fcuPanel`/
`window.fcu`/`window.radioPanel`/`window.rmpPanel`/`window.acpPanel`). The
vendored files are meant to stay a plain drop-in copy — see
`vendor/README.md` for how to bring in an updated bundle — but a couple of
small, deliberately minimal gaps have been hand-patched directly into them
rather than worked around here, each documented in `vendor/README.md` with
a note that it needs relaying upstream to Design so the next bundle keeps
it. MCDU still renders through its own hand-written DOM
(`mcdu-screen.js`/`mcdu-keypad.js`), not this library.

For the full X-Plane Web API protocol reference — endpoints, message
formats, the CDU dataref layout, and some rough edges we ran into along the
way — see `docs/xplane-web-api-notes.md`. For every dataref/command each
panel actually uses, see `docs/dataref-inventory.md`.

## Operator console

`http://<server>:<port>/console` — a status page for whoever's running the
sim on the host machine, separate from the tablet-facing panels
themselves. `tools/mcdu-server.js` opens it in a browser automatically on
startup (set `MCDU_NO_OPEN_CONSOLE=1` to skip that, e.g. running headless).
Shows:

- Server status, version, uptime, and port.
- Whether X-Plane is reachable (a fresh check against `/api/capabilities`
  on every page load — not a cached/background poll), its reported
  version, its response time, and whether `XPLANE_HOST`/`XPLANE_PORT` are
  non-default. "Recheck now" forces an immediate check outside the poll
  cadence (with an explicit "Checking…" state) — mostly useful for
  distinguishing "down" from "up but slow to respond," which otherwise
  looks identical to a plain reachable/unreachable boolean.
- Every bound network interface as a clickable link and a QR code (skipped
  for `localhost` itself — nothing to usefully scan there), for pointing a
  tablet at the right address without typing it in.
- Currently connected clients — IP and which panel was selected when they
  connected (not live-tracked after that, since all five panels share one
  websocket connection per tab; see `xplane-client.js`'s `connectSocket()`).
- Recent disconnects (last 20) — added after a user (relayed as "Jerry")
  reported random connection trouble with nothing concrete to go on. Each
  entry records how long the connection lasted and a best-effort *reason*
  (which side noticed trouble first: the tablet's own socket erroring, a
  clean client-initiated close, or X-Plane's end of the proxy closing) —
  see `tools/mcdu-server.js`'s upgrade handler, which sets a per-connection
  `disconnectReason` from whichever side notices first and reads it once
  in a single consolidated "close" handler. The connected-clients list
  alone only ever shows *now*; this is what lets a pattern (e.g. every
  drop from the same IP, or every drop tagged "X-Plane connection error")
  show up after the fact.

`console.html`/`css/console.css`/`src/console.js` render it, polling
`tools/mcdu-server.js`'s own `/console/status.json` every few seconds —
not an X-Plane endpoint, just this server's internal state. QR codes are
rendered client-side as SVG from `vendor/qrcode-generator.js`'s module
matrix (see `vendor/README.md`), not the vendored library's own default
output, so they match the page's look.

## Connection diagnostics and auto-reconnect

`src/xplane-client.js` auto-reconnects its websocket on any unexpected
close, with exponential backoff (1s, 2s, 4s, ... capped at 30s) — added
alongside the operator console's "Recent disconnects" above, for the same
"random connection trouble" report. Before this, a dropped connection just
sat in the `closed` state until someone noticed and clicked the
(relabeled) "Reconnect" button, which builds an entirely new
`XPlaneClient`/websocket from scratch; that manual path still exists as a
hard-reset fallback, but most drops now recover on their own. `closeSocket()`
sets an internal flag that suppresses the retry loop — not currently called
anywhere in this app (nothing explicitly disconnects today), so in
practice every close is treated as worth retrying.

Reconnecting means a brand-new websocket, which X-Plane's API knows
nothing about — every dataref/command subscription from before the drop
is silently gone from X-Plane's side even though `_datarefListeners`/
`_commandListeners` (and now `_datarefIndexById`, added to remember each
dataref's subscribed `index` for this exact purpose) still hold every
registered callback. `_resubscribeAll()` replays a fresh
`dataref_subscribe_values`/`command_subscribe_is_active` request for
everything on reconnect, so adapters (McduAdapter, EfisAdapter, ...) don't
need to know a reconnect happened at all — their callbacks just start
receiving values again.

A new `onDiagnostic` callback on `XPlaneClient` (alongside the existing
`onStatusChange`) carries a running narrative — reconnect attempts and
their backoff delay, websocket close codes, and request failures that
were previously only a `console.warn` — into `src/app.js`'s new
diagnostics panel (the "Diagnostics" button next to the connection
status). That panel shows a live timestamped log plus a snapshot
(browser online/offline, `navigator.connection` type where supported) and
a "Copy diagnostics" button, so a report like "it doesn't connect
sometimes" can come back with actual log lines instead of a vague
description — devtools access isn't a realistic ask on a tablet. The log
is module-level in `app.js`, not tied to one `XPlaneClient` instance, so
it survives across manual Reconnect clicks too.

## Progressive Web App

`manifest.webmanifest` + `icons/icon.svg` give the MCDU/EFIS/FCU/Radio/
RMP+ACP page
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
server only covers the MCDU screen dataref today — EFIS, FCU, Radio, and
RMP+ACP all need a real X-Plane instance to test against (see "Known
limitations" below).

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

- The FCU panel is still a work in progress: every button, knob, and
  display is wired to a real command/dataref and usable, but it's had less
  real-flight mileage than MCDU/EFIS and a couple of annunciators (LVLCH)
  have no confirmed driving dataref yet — see the Roadmap below for the
  current list.
- RMP+ACP on the **stock A330** is the least complete profile of the two:
  it covers VHF1/VHF2 (COM1/COM2) only, deliberately scoped down from the
  real unit's full channel set for its first pass. What's wired there is
  live-verified, including the real coarse/fine 8.33kHz-grid tuning
  behavior shared with the Radio panel and the ACP's per-channel listen
  toggle — but VHF3/HF1/HF2/AM/NAV/VOR/LS/ADF/BFO on the RTP and the ACP's
  INT/CAB/PA/nav-reception rows aren't wired yet, and ACP reception volume
  can't actually reach the sim (X-Plane's own Web API rejects the write —
  see "ACP reception volume" under RMP+ACP's own Interface entry below).
  The **ToLiss** profile has since grown well past this same starting
  point and covers all of the above — see its own Interface subsection.
- MCDU supports the stock A330 and 737-800, plus an experimental ToLiss
  Airbus profile (an **Aircraft** selector picks which); EFIS and FCU are
  Airbus-only — Boeing's real hardware is
  an MCP, not an FCU, with its own different EFIS control panel, so
  porting those is a new panel design, not a profile swap. Selecting the
  737 (or **Generic**) greys out the EFIS/FCU/MCDU panel options that
  don't apply rather than leaving them clickable into an all-unresolved
  panel. Add-on airliners (Zibo 737, FlightFactor, ToLiss, ...) need their
  own profile too, for any panel — they replace the default systems/
  avionics wholesale, entirely different namespace (see below). Buttons/
  keys whose command doesn't resolve are disabled rather than silently
  failing, so a missing/wrong profile entry is obvious rather than
  confusing.
- The Radio panel's transponder mode (OFF/STANDBY/ON/ALT/TEST/GROUND/
  TA_ONLY/TA_RA — a live-confirmed 8-state enum) isn't wired yet; a
  dedicated XPDR row is planned once it's decided how that collapses onto
  a simple control. There's also no audio-select entry for XPDR — X-Plane
  has no `monitor_audio_xpdr`-shaped command, a real model gap rather than
  an oversight here.
- The 737-800 MCDU has no wired brightness control — the real hardware
  has a rotary knob there, and nothing obviously matching it turned up in
  a live dataref/command scan (unlike the Airbus, which uses a plain
  press-up/down command pair). Left unwired rather than guessed.
- `npm run mock`'s mock X-Plane server only implements the stock aircraft's
  MCDU screen dataref shape — EFIS's, FCU's, Radio's, and RMP+ACP's
  buttons/readouts/knobs/levers, and ToLiss's entirely different MCDU
  screen shape, aren't mocked yet, so testing any of those needs a real
  X-Plane instance.
- Brightness and annunciator-light datarefs were found alongside the MCDU
  keypad mapping but aren't wired into the interface yet.
- No multi-tablet coordination beyond X-Plane's own CDU1/2/3 split, no
  offline/PWA support yet. Dropped connections do now auto-reconnect with
  backoff — see "Connection diagnostics and auto-reconnect" above.
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

**ToLiss Airbus profile** (`mcdu-toliss-airbus.json`): a genuinely
different screen shape from the stock A330's, not just different names —
`src/mcdu-adapter.js`'s `connect()` branches into a completely separate
path (`_connectColoredLinesScreen()`/`_recomputeColoredRow()`) the moment
`profile.screen.kind === "coloredLines"`, so this and `default-fms.json`
share no code at runtime; changing one can't regress the other (confirmed
by diff, not just by design, when this was built).

- **The real shape**: ToLiss exposes each screen row as one or two
  "sources" (a large-font and small-font variant of the same physical
  row — e.g. `cont3`/`scont3` — confirmed live to be mutually exclusive),
  each split across up to 7 separate same-length plain-text datarefs, one
  per color letter. Rendering a row means overlaying every color's text
  onto a blank line, character by character — confirmed live only one
  color ever has a real character at a given position, the rest hold
  spaces. This is plain base64-encoded ASCII text (decode, trim the
  trailing NUL, done), not the stock aircraft's byte-array-plus-style-
  bitfield pair.
- **Live-verified 2026-08-28**: read a real INIT page and F-PLN page
  through the actual `McduAdapter` (no browser needed — it has no DOM
  dependency at all) and confirmed the rendered text matched exactly;
  confirmed the keypad end-to-end by pressing individual key commands to
  type into the scratchpad and watching it accumulate live, then clearing
  it with 3 presses of CLR (one character removed per press, matching a
  real Airbus CDU). Every key in the profile resolved — zero unresolved.
- **Color mapping is the one open, lower-confidence gap**: `g` (green)
  and `w` (white) are confirmed live against real content; `a`/`y`
  (amber/yellow) and `b` (assumed to be Airbus's cyan-ish "blue") are
  standard-convention guesses not yet seen live; `s` is the least
  confident — seen only on a small page-number readout, suggesting a
  dim/small white variant rather than a distinct hue. None of this
  affects functionality, only which CSS color class a character gets —
  see the profile's own `_note_provenance`.
- **No reverse/flash/underline** — no dataref for any of those was found
  for this screen, so ToLiss MCDU text always renders plain.
- **Box-glyph placeholder**: a real Airbus MCDU shows a row of small amber
  boxes for a mandatory field not yet entered (e.g. an empty `CO RTE` or
  `FROM/TO` on INIT/A). ToLiss encodes that as literal repeated `E`
  characters, but only in the `s` color — confirmed live 2026-08-29 by
  reading the raw `cont1s`/`label1w` dataref bytes behind a live "EEEEEE"
  report. This is contextual, not a universal "E means box" rule: a real
  typed E (e.g. in the scratchpad) still renders as E, and `s` is also
  used for legitimate small text elsewhere (a page-number readout).
  `mcdu-adapter.js`'s `_recomputeColoredRow()` special-cases only the
  exact `(char="E", colorLetter="s")` pair, substituting a box glyph
  (`▯`) in amber — see the profile's own `_note_on_box_placeholder`.
- **Bracket-style mandatory-field placeholder**: a second `s`-channel
  symbol, alongside the box glyph above. On the TAKEOFF PERF page,
  not-yet-entered numeric fields (V1/VR/FLAPS-THS/TRANS ALT-style)
  render as e.g. `[ ]/[ ]` rather than a row of boxes. Confirmed live
  2026-08-29 that the raw bytes are literal `A`/`B` in the `s` color
  (`cont3s` = `"...A B A B"`) — `A` is the left bracket half, `B` the
  right. `mcdu-adapter.js`'s `SYMBOL_FONT_GLYPHS` table maps `E`→▯ and
  `A`/`B`→`[`/`]` for the `s` channel only; real letters A/B still
  render as themselves in every other color — see the profile's own
  `_note_on_bracket_placeholder`.
- **Degree symbol**: another classic Airbus/Boeing CDU font quirk — a
  literal backtick byte (`` ` ``, 0x60) means °, not an actual backtick.
  Confirmed live 2026-08-29 on the PROG page's BRG/DIST field (raw
  `cont4w` was `" ---\`  /----.-"`, i.e. `"---°/----.-"`). Unlike the
  box glyph above, this remap isn't color-specific — `decodeColoredChars()`
  replaces every backtick with ° regardless of color, since a literal
  backtick has no legitimate use on an MCDU screen.
- **Page-number readout looks like arrows, but isn't a bug**: the small
  `23`-style readout in the title's top-right corner (page 2 of 3) is
  literal ASCII digits on the wire (confirmed live) — ToLiss's own
  cockpit texture just renders that field in a small stylized font that
  can look like a pair of left/right arrows. This app's decoding and
  rendering are already correct; nothing was changed for it.
- **Real Airbus keypad, not the stock profile's**: ToLiss's actual key
  set doesn't include CLB/CRZ/DES/HOLD/EXEC/FIX/LEGS/DEP_ARR (Boeing CDU
  concepts the stock default-FMS profile happens to also expose) and
  swaps the stock profile's simple PREV/NEXT/UP/DOWN for a real 4-way
  SLEW_UP/DOWN/LEFT/RIGHT cluster — new logical key names, not a reuse of
  the stock ones, so both profiles keep their own real keys' shape. See
  the profile's own `_note_on_keypad`.

### EFIS

- **Rotary knobs** (ND mode, map range, baro): click-drag vertically to
  turn, snapping to detents for ND mode/range — a fixed px-per-detent
  threshold (`drag-step`, see `vendor/README.md`'s `fcu-instruments.js`
  entry), not angle-following, so a slightly wobbly touch doesn't
  register. A short tap on the baro knob pulls (engage STD); press-and-hold
  (~400ms) pushes (revert to the selected QNH).
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

### Radio

- **Two independent units** (upper/lower), each with its own active/
  standby seven-segment pair, tuning knob, and ACT/STBY swap button —
  matching two real radios stacked in one panel. Each unit's own selector
  is a *fixed* subset, not a shared 6-position dial: unit 1 is COM1/NAV1/
  ADF1, unit 2 is COM2/NAV2/ADF2/DME (DME is a single physical unit shared
  by the whole panel, not DME1/DME2 — see the profile's own description
  for the live-confirmed dataref evidence).
- **Tuning knob**: grab distance from center picks coarse (MHz, outer
  ring) vs fine (kHz, inner boss) per gesture, with a lit legend showing
  which is active. Press-and-hold (~400ms) swaps, same as the dedicated
  button. Writes the standby frequency dataref directly rather than
  stepping through commands — see `src/radio-panel.js`'s own top comment
  for why (X-Plane's command coalescing made discrete step commands feel
  laggy and imprecise on a fast drag; a direct write doesn't have that
  problem). The fine and coarse rings are independent, matching real
  2-ring radios: fine wraps the kHz offset within its own MHz without
  ever touching the MHz digit, and coarse wraps the MHz digit around at
  the band edges (136.500 → coarse up → 118.500) instead of hard-stopping
  — both confirmed live against the real X-Plane commands, including
  COM's non-uniform real 8.33kHz channel grid within each MHz (see
  `nextStandbyRaw()`'s own comment for the exact pattern). All knobs are
  press-and-drag-vertically, not point-at-the-detent — see `vendor/README.md`'s
  `fcu-instruments.js` entry for the touch-sensitivity tuning this shares
  with the FCU/EFIS knobs.
- **Audio select row**: seven two-position switches (COM1/COM2/NAV1/NAV2/
  ADF1/ADF2/DME) below both units, tap-to-flip.
- **MIC SEL**: a two-position lever between the COM1/COM2 audio switches
  picking which radio transmits (`sim/audio_panel/transmit_audio_com{1,2}`
  — one-shot select commands, not toggles). Its state dataref
  (`audio_com_selection`) isn't a clean 0/1 enum — confirmed live it read
  6 for COM1 and 7 for COM2 in one session, with other bits already set by
  the aircraft's own baseline state — so it's read by parity (odd = COM2)
  rather than an exact-match toggle, which wouldn't tolerate that baseline
  shifting.
- **Generic aircraft option**: unlike EFIS/FCU/MCDU, this panel's dataref/
  command mapping lives under X-Plane's own generic radio-stack namespace
  (see "Adding support for another aircraft" below), so it's never
  disabled by the **Aircraft** selector — including the dedicated
  **Generic** option, for using it without also connecting an Airbus/737
  MCDU.

### RMP+ACP

Airbus A330 (stock), plus an **experimental** profile for the ToLiss
Airbus add-on (see its own subsection below) — the stock/default
aircraft's own RTP (X-Plane's name for the real-hardware RMP) + ACP,
Captain's side, **VHF1/VHF2 only for now** — see
`config/profiles/rmp-acp-a333.json`'s own description for the full
reasoning and what's still unwired. Everything below describes the stock
A330 profile specifically unless noted otherwise.

- **Channel select**: VHF1/VHF2 pushbuttons pick which underlying radio
  (COM1/COM2) the shared active/standby display and tuning knob currently
  target — a green caret marks the selected one. Confirmed live the RTP's
  own tuning isn't a separate frequency store: turning its knob while VHF2
  is selected writes the same `com2_standby_frequency_hz_833` dataref the
  Radio panel already uses directly, so the tuning knob here reuses that
  same direct-write path rather than the RTP's own step commands.
- **Tuning knob**: the whole coarse/fine behavior is ported wholesale from
  the Radio panel rather than reimplemented — this delivery's RMP tune
  knob is the same kind of plain, ring-less `<fcu-knob>` the Radio panel's
  own tune knobs are, so `src/rmp-panel.js` bolts on the identical
  grab-near-center(fine)/grab-near-edge(coarse) gesture `vendor/radio.js`
  implements internally, plus `src/radio-panel.js`'s exact `nextStandbyRaw()`
  for the real 8.33kHz-grid fine stepping and coarse-ring wraparound at the
  band edges.
- **Transfer key**: swaps the selected channel's active/standby, same
  `laminar/A333/rtp_L/freq_txfr/sel_switch` command a real transfer key
  fires.
- **Power lever**: on/off, confirmed live `off_status` is 1 when off (0
  when on) — modeled inverted so "lit" reads as "powered on".
- **ACP transmit-select**: VHF1/VHF2 keys, confirmed live mutually
  exclusive on the sim side (`mic_status1`/`mic_status2`).
- **ACP reception volume**: VHF1/VHF2 pots (drag) read the sim's live level
  fine, but writing one currently doesn't reach the sim — X-Plane's Web API
  rejects fractional writes to these specific `double`-typed datarefs with
  an "incompatible_data" error (confirmed live against this build's
  X-Plane 12.4.3; a known-good `float`-typed dataref accepts the same kind
  of write fine), so this looks like a sim-side bug rather than anything
  fixable here. Left wired anyway in case a future X-Plane patch resolves
  it — see the profile's `_gap_acp_volume_write`.
- **ACP listen toggle**: tapping (not dragging) a VHF1/VHF2 volume pot
  fires the real `listen_press00`/`listen_press01` command for that
  channel and lights the lamp only once the sim confirms it via
  `listen_status` (a 16-element array dataref, index 0 = VHF1/index 1 =
  VHF2) — never an unconfirmed local guess. Needed a small hand-patch to
  `<acp-knob>` (an `onTap()` hook — see `vendor/README.md`'s `rmp.js`
  entry) since the delivered component only had a self-contained
  tap-toggles-its-own-lamp gesture with nothing to intercept.
- **Minimap** (`src/rmp-minimap.js`, small floating widget under the FIT/
  full-screen buttons): for a narrow/tall viewport (a phone in portrait)
  where the RMP and ACP halves don't both comfortably fit at a readable
  size. Tapping a section shows/hides that half (at least one always
  stays visible — hiding the last one is refused, with a brief color
  pulse so the tap still visibly registers); dragging anywhere on the map
  scrolls the stack, mapping the drag position directly to a scroll
  position rather than a relative pan. This is also *why* RMP+ACP's two
  halves size differently from every other autoscaled panel: each is
  fit to *width* only and sized to its own scaled result (`panel-
  autoscale.js`'s "content" mode, `.scalable-panel--stack` in
  css/mcdu.css) instead of being forced to share a fixed half of the
  container — an equal split doesn't mean anything once either half can
  be hidden, and `#panel-rmp` scrolls (`overflow-y: auto`) instead of
  clipping when the stack is taller than the viewport.
- **Not wired yet**: VHF3/HF1/HF2/AM/NAV/VOR/LS/ADF/BFO on the RTP, and the
  ACP's INT/CAB/PA/nav-reception rows.

**ToLiss Airbus profile** (`rmp-acp-toliss-airbus.json`): started as a
first pass built by name-matching against a supplied dataref/command
listing (`docs/toliss-a340/{datarefs,commands}.txt`), scoped to VHF1/VHF2
only; has since grown to cover every channel the vendored `<rmp-panel>`/
`<acp-panel>` UI already has real buttons for on the RMP side — VHF1/
VHF2/VHF3, HF1/HF2, and the STBY NAV backup functions VOR/LS/ADF — plus,
on the ACP side, transmit-select lit state for VHF1/VHF2/VHF3/HF1/HF2/
INT/CAB/PA and listen-toggle lamps for all of those plus LS/MKR/VOR1/
VOR2/ADF1/ADF2, all live-verified against a running ToLiss A330
(2026-08-29/30). See `CONTRIBUTING.md` if you can help close out what's
still open. Real, mechanical differences from the stock profile, not just
different names for the same shapes:

- **Tuning is command-based, not direct-write**: writability of the
  readouts' own datarefs under ToLiss isn't confirmed (or what validation
  a write would get), unlike the stock A330's standby datarefs. The tune
  knob instead fires RMP1FreqUp/DownLrg (coarse) and RMP1FreqUp/DownSml
  (fine) directly, one press per detent — `src/rmp-panel.js` checks
  `EfisAdapter.hasWritableEncoder(name)` per readout and falls back to
  this path when there's no writable encoder, rather than assuming every
  profile can offer one.
- **Every channel aliases the same dataref pair on purpose**: ToLiss's
  RMP1 acts as a single display/tune surface shared across whichever
  channel is currently selected, not independent per-channel storage the
  way the stock A330's RTP is (a routing layer over separate underlying
  radios) — confirmed live across every mode listed above (selecting a
  different channel changes what the shared datarefs show; tuning only
  ever affects whichever channel is currently selected). `COM1`, `COM2`,
  `VHF3`, `HF1`, `HF2`, `NAV_VOR`, `NAV_LS`, and `NAV_ADF` are all really
  just "the one RMP1 display, currently showing channel X" — see the
  profile's own `_note_on_architecture`.
- **Reads pre-formatted display strings, not a scaled number** — the
  profile's biggest architectural difference from the stock A330, found
  in two stages. First: a live report of "considerable misalignment"
  against ToLiss's own cockpit display led to discovering that ToLiss's
  own `AirbusFBW/RMP1Freq`/`RMP1StbyFreq` (the obvious-by-name choice) are
  a higher-precision *internal* value on ToLiss's native 6.25kHz grid, not
  what's actually shown — the plain `sim/cockpit2/radios/actuators/
  com1_..._833` datarefs (same ones `radio-panel-generic.json` uses for
  default aircraft) turned out to be the real ground truth, holding that
  internal value quantized down to the classic 5kHz grid before display.
  That fix worked for VHF, but only for VHF — X-Plane's core sim only
  simulates VHF COM radios, so HF/backup-nav have no such generic-dataref
  mirror at all. Second stage, once HF/backup-nav were in scope:
  `AirbusFBW/RMP1/ActiveWindowString`/`StandbyWindowString` (base64+NUL-
  terminated text, same convention as the MCDU screen — see
  `mcdu-adapter.js`) turned out to be pre-formatted display strings that
  work identically across *every* mode, including ones no scaled number
  could represent at all — ADF's whole-kHz value with no decimal point,
  and VOR/ILS's standby window showing a channel/course indicator (e.g.
  `" C/000"`) instead of a frequency. Every readout below declares
  `windowString: true` and reads this pair instead of `com1_..._833` now
  — see the profile's own `_note_on_window_string` for the full story,
  including why the com1_..._833 fix (kept working for VHF, just
  superseded) doesn't generalize.
- **`src/rmp-panel.js`'s `paintWindowString()`** renders a display string
  directly onto a `<seven-seg>`'s own `segdisplay` object (`.set()`/
  `.setDecimal()`), bypassing `rmp.setFreq()` entirely — that function
  hardcodes a "6-digit MHz.MHz, decimal always after digit 3" shape that
  only some of these strings have. The decimal point's position (or its
  absence) is read from the string itself: extracted and stripped before
  calling `.set()`, then `.setDecimal(i, true)` is called for that digit
  index, or no decimal is lit at all when the string has none. Characters
  with no seven-segment glyph (VOR/ILS's `/` course separator) render as a
  blank digit — `fcu-instruments.js`'s own `glyph()` already falls back
  gracefully rather than throwing — an acceptable approximation of
  hardware this app's plain 7-segment display can't fully reproduce.
- **Swap key flash, fixed**: bypassing `rmp.setFreq()` (above) had a side
  effect — `vendor/rmp.js`'s own transfer key does its own optimistic
  local swap-and-repaint straight from its internal `freq[]` array on
  click (`_transfer()`), which is only ever kept current by `setFreq()`.
  Never calling `setFreq()` left `freq[]` frozen at its construction-time
  default (`121825`/`126375`) forever, so every physical swap-key press
  briefly flashed that unrelated default before this file's own
  `syncDisplay()` (triggered once the sim's real swap lands) corrected it
  — confirmed live 2026-08-30 as the cause of a reported "strange
  frequency" flash. Fixed by also calling `setFreq()` with a numeric
  approximation of the window string (digits only, decimal point and
  letters stripped) right alongside the real `paintWindowString()` call —
  its own numeric repaint runs and is immediately overwritten in the same
  tick on every *normal* refresh (no visible flash there), but now leaves
  `freq[]` close enough that a physical click's optimistic repaint shows
  something reasonable instead of a stale, unrelated value. Not a perfect
  substitute (vendor's numeric path always shows a decimal point, which
  isn't correct for e.g. ADF's whole-kHz value) — but a stray decimal
  point for one transient frame is a far smaller gap than an unrelated
  frequency.
- **Channel select, confirmed live for every mode**: `RMP1SelFunc` reads
  `0`=VHF1, `1`=VHF2, `2`=VHF3, `3`=HF1, `4`=HF2, `6`=VOR, `7`=LS/ILS,
  `9`=ADF — confirmed by firing every select command in turn and watching
  it land on an exact, stable value each time, with the displayed
  frequency changing to match (`8` was never observed; possibly MLS or
  another mode this profile doesn't cover). `src/rmp-panel.js`'s channel-
  detection in `refresh()` was generalized from a hardcoded VHF1-vs-VHF2
  check into a search over every `CHANNEL_TO_SEL_BUTTON` entry for
  whichever one reports lit.
- **`AirbusFBW/RMP1Lights`, one shared 16-element array behind AM/BFO, and
  a real subscription-conflict bug along the way**: `AM`
  (`AirbusFBW/AMCapt`, a real command, real UI button) was confirmed live
  to leave `RMP1SelFunc` completely unchanged regardless of which channel
  was selected before pressing it — not a distinguishable channel, just a
  mode (AM vs. SSB reception) on top of whichever HF channel is currently
  selected, matching real HF radio behavior. `BFO` similarly never moved
  `RMP1SelFunc` or anything in the `DRAIMS1` namespace. Both turned out to
  have real state in `RMP1Lights`, found by asking a user to toggle each
  switch directly and diff the full array before/after: `AM` is index 6,
  `BFO` is index 11 (both confirmed by exactly one index differing between
  an off/on pair, no need to reverse-engineer the rest of the array).
  **The bug**: `AM_PRESS`/`BFO_PRESS` were first wired with their own
  `stateDataref`/`stateIndex` directly on the button (the same mechanism
  `NAV_PRESS` correctly uses against a *different*, single-purpose
  dataref) — but `xplane-client.js`'s `subscribeDataref()` only sends one
  actual subscribe request per dataref id; the first caller's `index`
  wins for every other subscriber sharing that id (documented on that
  method already, violated here anyway). With two buttons wanting
  different slices of the same `RMP1Lights` id, plus a whole-array
  `RMP1_LIGHTS` readout added at the same time for an unrelated attempt at
  the SEL indicator (see below), confirmed live 2026-08-30 that the
  readout came back as a one-element array instead of the full 16 —
  silently narrowed to whichever button connected first. Fixed by
  consolidating both onto the one shared `RMP1_LIGHTS` readout (fetched
  once, indexed twice in `src/rmp-panel.js`'s `refresh()`) instead of
  separate per-button subscriptions — `AM_PRESS`/`BFO_PRESS` are
  command-only again (no `stateDataref`), and their carets are driven
  directly via `setCaret()`, not through `selectChannel()`, since neither
  is part of the main row's mutually-exclusive channel selection. See the
  profile's own `_note_on_am` and `_note_on_bfo`.
- **The round "SEL" indicator — four attempts so far, none independently
  confirmed live yet**: means "another RMP is also controlling this same
  function" — nothing to do with which channel or backup-nav mode is
  selected on *this* RMP alone. History (so a fifth attempt, if this one's
  also wrong, doesn't repeat any of them): (1) a recognized channel
  selected + RMP powered — wrong. (2) `RMP1Lights[13]`, derived from a
  cross-comparison that looked convincing (1 for every normal selection,
  0 only in one ambiguous backup-nav moment) — a coincidental correlation,
  not causal, wrong. (3) `RMP1SelFunc == RMP2SelFunc || RMP1SelFunc == RMP3SelFunc`,
  given directly by a user as "this kind of logic" — tried live by that
  same user and also wrong, reason unconfirmed. (4) current:
  `AirbusFBW/RMP1Lights_Raw` — a genuinely *different* dataref from
  `RMP1Lights` (both exist, both 16-element `float_array`s, different live
  values), "4th from Right" per the user, i.e. index 12 of 16. New
  `RMP1_LIGHTS_RAW` readout exposes the whole array; `src/rmp-panel.js`
  reads index 12 directly with the plain default threshold
  (`value >= 0.5`). Explicitly not yet cross-checked against the real
  cockpit — see the profile's own `_note_on_sel_indicator` for what a
  proper confirmation needs (a live on/off pair, not a single snapshot).
- **The STBY NAV row's "NAV" master key has its own real state, found
  after "NAV" was initially lumped in with AM/BFO above as a dead end**: a
  live report that "the backup nav LEDs are not working properly" led to
  `AirbusFBW/DRAIMS/NavBackupMode`, a 2-element array whose index 0 is a
  clean, repeatable binary toggle that flips exactly when `BackupNavPress`
  is pressed. Its polarity was initially guessed wrong — shipped as
  `litValue: 0` (assumed "0 = backup nav engaged, light it") — caught by
  a live cross-check against the real cockpit: with the
  dataref reading `[1, 0]` and `RMP1SelFunc`/the displayed frequency both
  confirming completely normal VHF1 operation, the real NAV caret was
  independently confirmed lit at that exact moment, meaning `1` (not `0`)
  is the lit state. `NAV_PRESS` now declares `stateDataref`/
  `stateIndex: 0`/`litValue: 1` — a new `EfisAdapter` button capability,
  `stateIndex`, for a button whose lit state lives at one element of an
  array dataref rather than being its own scalar (parallel to how
  `litValue`/`invert` already work; only the read path differs, reusing
  `subscribeDataref`'s existing `index` param).
  On a real RMP, the NAV master lamp and whichever VOR/LS/ADF submode is
  active light *simultaneously* (two independent lamps), not a single
  mutually-exclusive selection the way the main channel row works —
  `vendor/rmp.js`'s `selectChannel()` can only ever mark one caret 'sel'
  at a time, so NAV's caret is now driven directly via its lower-level
  `setCaret()` instead, alongside (not replacing) `selectChannel()`'s own
  handling of whichever VOR/LS/ADF submode caret. See the profile's own
  `_note_on_nav_backup_mode` for the full story, including why VOR/LS/ADF
  submode *selection* itself (which appeared fully reliable in earlier
  testing) wasn't touched here — it didn't reproduce via synthetic command
  presses in this later session, but there's no evidence the reading
  mechanism itself is wrong, only that this retest couldn't trigger a
  transition to re-check it.
- **ACP reception volume, resolved**: `VOL_VHF1`/`VOL_VHF2` use the plain
  `sim/cockpit2/radios/actuators/audio_volume_com1`/`com2`. Confirmed live
  2026-08-30: plain `0.0`-`1.0` floats, writable, and fractional writes
  round-trip correctly — notably *better* than the stock A330's own
  `volume_pos_0`/`1`, which `rmp-acp-a333.json`'s own
  `_gap_acp_volume_write` documents as failing on any fractional write.
  Mapped `VOL_VHF1`→`com1`/`VOL_VHF2`→`com2` directly rather than
  following the RMP's single-display-surface model — a real ACP has one
  independent physical volume knob per radio regardless of which one the
  RMP is currently tuning, and these two datarefs are confirmed
  genuinely independent of each other. Not extended to VHF3/HF1/HF2 —
  no equivalent generic volume dataref confirmed for those yet.
- **Listen-toggle lit state, resolved**: `AirbusFBW/DRAIMS1/ListenStates`
  is a read-only 10-element array (order VHF1, VHF2, VHF3, HF1, HF2, INT,
  CAB, LS, MKR, VOR1 — INT reads `1` by default, the rest `0`) — confirmed
  live 2026-08-30 by toggling `ListenVHF1`/`ListenVHF2` and watching only
  their own index flip, independently of each other and of the constant
  INT slot. `listenToggles` below declares `stateDataref`/`stateIndex`
  (0/1) for `vhf1`/`vhf2`, using the same grouped-index subscription
  mechanism `rmp-acp-a333.json`'s own listen toggles already use. Not
  extended to VHF3/HF1/HF2 (index 2 onward) — same VHF1/VHF2-only scope
  as MIC/volume above.
- **RMP power, resolved**: `AirbusFBW/RMP1Switch` — confirmed live
  2026-08-30 to be a directly writable dataref with no toggle command
  anywhere in the aircraft's command list at all. Writing it produces a
  real effect (a non-frequency sentinel value on the display while off, a
  real frequency again once back on). Wired via a new `EfisAdapter` button
  shape, `writeToggle: true` (see the "Adding support for another
  aircraft" section above) since there's no command to fire.
- **The green "selected channel" caret stayed lit with the unit powered
  off**: the same freeze behavior behind the SEL-indicator and NAV-caret
  fixes above — `RMP1SelFunc` doesn't reset when `RTP_POWER` goes off, it
  just freezes at whichever channel was last selected — meant
  `selectChannel()` kept being called with that frozen channel forever,
  painting its caret green even with the real display blank. Fixed by
  passing a sentinel channel id (`"__off__"`, matching no real
  `vendor/rmp.js` caret) to `selectChannel()` whenever `RTP_POWER` isn't
  lit — every caret falls through to its unselected state, blanking all
  of them rather than leaving one stuck. Confirmed live across a full
  power off/on cycle.
- **Panel backlight, and the seven-segs staying lit on power-off**:
  `vendor/rmp.js`'s `RmpPanel.setBacklight()` already existed (it's what
  makes `selectChannel()`'s non-selected carets paint amber-lit instead of
  dim silkscreen-white) but was never actually being called from anywhere
  — every caret but the selected channel's own had been rendering as if
  permanently unpowered since this panel was first built. Neither
  `RmpPanel` nor `AcpPanel` has a panel-*wide* backlight method the way
  `fcu-instruments.js`'s own `<efis-panel>`/`<fcu-panel>` do (their shared
  `applyBacklight()`/`panelApi().setBacklight()` — see "How it works"
  above) even though `vendor/rmp.js`'s own `cap()` captions use the exact
  same `data-cap="1"` marker that mechanism looks for — plausibly the same
  author's convention, just never wired up for RMP/ACP. Rather than a
  third vendor hand-patch, `src/rmp-panel.js`'s new `applyPanelGlow(root,
  on)` reimplements the same idea at the app level, reaching only through
  each panel's own public `root`/`button()`/`knob()` accessors: dims/lights
  every `[data-cap]` caption directly, and delegates to each
  `<fcu-led-button>`'s own `setBacklight()` (covers RMP's channel-name
  legends and ACP's CALL/MECH/ATT/VOICE/RESET/PA legends, the same
  mechanism `fcu-instruments.js`'s `applyBacklight()` uses internally) and
  the tune knob's `setGlow()`. A `prefers-reduced-motion`-respecting CSS
  transition on `color`/`text-shadow`/`filter`/`border-top-color`, scoped
  to `rmp-panel`/`acp-panel`'s own `[data-cap]`/`[data-label]`/
  `[data-caret]` elements (`css/mcdu.css`), turns the power-off transition
  into a quick fade rather than an instant snap — a plain inline-style
  change still transitions as long as a rule names the property first, so
  no class toggle was needed. Separately, `AirbusFBW/RMP1/
  ActiveWindowString`/`StandbyWindowString` freeze at their last value on
  power-off (the same freeze-on-power-off pattern as `RMP1SelFunc`/
  `RMP1Lights_Raw` above) — `refresh()` now explicitly blanks both
  seven-segs via `rmp.display(...).clear()` whenever `RTP_POWER` isn't lit,
  instead of leaving the last-tuned frequency frozen on screen.
- **A live report that the physical HF1 button "doesn't seem to work"**:
  this profile's own testing (firing `AirbusFBW/HF1Capt` through the same
  API surface a working physical press would use) shows the command and
  its dataref effects are real and correct — `RMP1SelFunc` reliably reads
  `3` and the display shows a genuine HF frequency. If ToLiss's own 3D
  click-spot for that button is unresponsive, that looks like a ToLiss-
  side hit-testing issue, not something wrong with the command/dataref or
  fixable from this app — see the profile's own `_note_on_hf1_caveat`.
- **MIC transmit-select lit state, resolved, and extended well past
  VHF1/VHF2**: `ACP1Switch`, the only candidate tried live 2026-08-29, was
  confirmed to *not* track mic-select state. `AirbusFBW/ACP1Lights_Raw`
  (a 16-element `float_array`) is the real one — but its index order
  isn't simply the VHF1..PA channel list applied in sequence: firing
  every `ACP1/*Press` command in isolation found `PA` at index 9, not 15
  where a first pass (naive positional mapping) had put it. `VHF3Press`
  never moved any index at all across two tries — plausibly correct
  rather than broken, since ToLiss's VHF3 is a datalink/ACARS channel
  with no voice transmission to select. `MIC_VHF1`/`VHF2`/`VHF3`/`HF1`/
  `HF2`/`INT`/`CAB`/`PA` are all plain command-only buttons (no
  `stateDataref`) — their lit state is read off a single shared
  `ACP1_LIGHTS_RAW` readout and indexed directly in `src/rmp-panel.js`'s
  `refresh()` (its own `MIC_LIGHT_INDEX`), the same subscription-conflict
  reasoning as the `AM_PRESS`/`BFO_PRESS` fix above — 8 buttons each
  declaring their own `stateIndex` against this one array id would
  silently break all but the first to connect. See the profile's own
  `_note_on_mic_lights` for the full per-index confirmation.
- **`listenToggles`, profile-driven and extended from 2 channels to 13**:
  this mechanism used to be hardcoded in `src/rmp-panel.js` for the stock
  A330 specifically; adding the ToLiss profile meant generalizing it into
  a profile-declared array (channel, optional command, optional
  stateDataref/stateIndex — `command` was made independently optional
  during this expansion, since most of the newly-added channels have a
  confirmed lamp but no discoverable toggle command at all) that
  `wireListenToggles()` resolves directly against the adapter's client.
  ToLiss's own listen state moved from `AirbusFBW/DRAIMS1/ListenStates`
  (a working 10-element array, confirmed for VHF1/VHF2) to
  `AirbusFBW/ACP1KnobPush` — a *writable* 16-element array, confirmed to
  mirror `ListenStates` exactly for VHF1/VHF2 while covering VHF3/HF1/
  HF2/INT/CAB/LS/MKR/VOR1/VOR2/ADF1/ADF2/SAT1/SAT2/PA that `ListenStates`
  doesn't. Being writable looked like it might let a listen toggle be
  driven by a direct write instead of a command (the same idea behind
  `RTP_POWER`'s `writeToggle` button shape) — tried and confirmed *not*
  supported: X-Plane's `dataref_set_values` rejects a single-element
  write to an array dataref with `incompatible_data`, needing the whole
  array's worth of values at once. So this still goes through
  `ListenVHF1`/`2`/`3` (the only `Listen*` commands that exist at all)
  and stays a read-only lamp for the other 10 channels wired. See the
  stock profile's own `_note_on_listen_toggle` and ToLiss's own
  `_note_on_listen_state`.

### Shared

- **Aircraft selector**: switches which MCDU profile loads (Airbus A330 /
  Boeing 737-800), plus a **Generic** option with no MCDU/EFIS/FCU at all
  — see "Adding support for another aircraft" below. Selecting the 737 or
  Generic disables the panel options that don't apply (see "Known
  limitations"); the currently-selected panel falls back to Radio if it
  becomes disabled. Takes effect on the next Connect/Reconnect, not live.
- **Panel selector**: switches the main content between MCDU, EFIS, FCU,
  Radio, and RMP+ACP, top bar included, without dropping the connection.
- **Full screen**: the button in the top-right hides the connection
  controls, for flying without clutter on screen.
- **Auto-scale** (EFIS/FCU/Radio/RMP+ACP only): a "FIT" toggle in the
  top-right scales the active panel to fill the available window space
  (recomputed on resize); toggling it off shows the panel at its native
  pixel size. Persists across reloads, one shared preference across all
  panels.

## Adding support for another aircraft

Each panel type reads its dataref/command mapping from its own profile
under `config/profiles/`. The app itself isn't A330-specific under the
hood — MCDU currently ships two verified profiles, EFIS/FCU one each.

**MCDU is usually a low-effort add for any of X-Plane's own default
aircraft** (not add-on airliners — see below): the default FMS/CDU is one
shared program Laminar reuses across their own aircraft, not implemented
per-airframe, so the `sim/FMS`/`sim/FMS2`/`sim/CDU3` command set and the
`fms_cdu{n}_text_line{n}` screen datarefs are typically identical between
them. `config/profiles/b738-fms.json` is a real example, added this way:
confirmed live (firing `sim/FMS/index` and `sim/FMS/fpln` against a
running B738 and reading back the resulting CDU page titles) that the
keys and screen were the exact same generic system as the A330's, so the
new profile only needed a different `keypadLayout` (the 737's bezel is
laid out differently — 6 columns instead of 7 on the function rows, no
dedicated brightness buttons, a smaller utility block) plus a couple of
`label` overrides on shared keys whose 737 keycap text differs from the
Airbus's (e.g. `FPLN`'s command is identical, but the real keycap says
"RTE" on the 737 versus "F-PLN" on the Airbus — `McduAdapter.getKeyLabel()`
reads an optional per-key `label` field for exactly this, falling back to
`mcdu-keypad.js`'s own shared default label map when a profile doesn't
specify one). Wire a new profile into the **Aircraft** selector via
`app.js`'s `AIRCRAFT_MCDU_PROFILES` map.

**Add-on airliners (Zibo 737, FlightFactor, ToLiss, PMDG, ...) are a
different story** — they replace the default systems/avionics wholesale
with their own custom implementation under an entirely different
namespace (`laminar/B738/...`-style paths won't even exist the same way),
so none of the above shortcuts apply; expect to discover everything from
scratch with `tools/discover.mjs` the way the original A330 profiles were
built. `config/profiles/efis-toliss-airbus.json` is a first pass at this
for ToLiss's Airbus EFIS — unlike every other profile in this repo, it was
built by name-matching against a public dataref/command list rather than
a live session (none was available), so its own `_note`/`_gap_*` fields
flag exactly what's confirmed vs. deduced vs. genuinely missing (the LS
button, BRG1/BRG2 selector, and baro unit-ring toggle had no plausible
match at all). Wire into `AIRCRAFT_EFIS_PROFILES` in `app.js` the same way
as `efis-a333.json`; verify every row with `tools/discover.mjs` before
trusting it. Note this only covers EFIS — the Radio panel still assumes a
data/interaction shape ToLiss doesn't share, so porting it needs real
code changes, not just a profile. RMP+ACP and MCDU both turned out to be
portable after all, despite starting from the same kind of stock-A330-
specific assumptions as the Radio panel:

- RMP+ACP — see `rmp-acp-toliss-airbus.json` and its own interface
  subsection above for what `src/rmp-panel.js` needed to become
  profile-driven (writable-encoder detection, listenToggles, display
  scale) to make that work as a profile swap instead of a code change.
- MCDU — ToLiss's screen genuinely *is* a different shape (many small
  per-line/per-color text datarefs, not one text-plus-style-bitfield pair
  per line), so this one did need a real code addition, not just a
  profile — but a strictly additive one: `mcdu-adapter.js`'s `connect()`
  branches into an entirely separate path when `profile.screen.kind`
  says so, so `default-fms.json`/`b738-fms.json` share no code at
  runtime with `mcdu-toliss-airbus.json` and can't be affected by it. See
  the MCDU interface subsection above.

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
  whether it's lit. Five extra shapes, all documented in
  `efis-adapter.js`'s own top comment: `litValue` (several buttons sharing
  one dataref between mutually-exclusive states, e.g. FCU's AP1/AP2),
  `onCommands`/`offCommands` (one logical press needing more than one
  command, chosen by current state, e.g. FCU's A/THR), no `stateDataref`
  at all (a button with no light of its own on the real hardware, e.g.
  FCU's HDG-TRK mode toggle), `writeToggle: true` instead of a `command`
  (for a button with no toggle command anywhere at all, only a plain
  writable `stateDataref` — added for ToLiss's RMP power switch,
  `AirbusFBW/RMP1Switch`, which has no command in the aircraft's command
  list at all; `press()` writes the opposite of the current lit state
  directly, same invert handling as the read side), and `stateIndex` (for
  a button whose lit state lives at one element of an array dataref
  rather than being its own scalar — added for ToLiss's RMP backup-nav
  "NAV" master key, `AirbusFBW/DRAIMS/NavBackupMode[0]`; combines with
  `litValue`/`invert` exactly like a scalar `stateDataref` would).
- `toggleSwitches` — several named positions sharing one state dataref,
  each position its own command and expected enum value (EFIS's BRG1/BRG2).
- `readouts` — one or more datarefs formatted into display text (see
  `readout-formats.js`), optionally paired with an `encoder` (a rotary
  knob: either a directly writable dataref, or a paced sequence of
  increment/decrement commands for detent selectors) and/or `commands`
  (named push/pull commands, resolved as `"<readoutName>.<key>"`). A baro-
  style encoder's ring/arc unit toggle can be either a command pair
  (`unitArc.startCommand`/`endCommand`, pressed via `commands`) or a
  directly writable dataref (`unitArc.writeDataref`, written via
  `EfisAdapter.setReadoutUnit()`) — `efis-panel.js`'s `wireBaroKnob()`
  picks whichever the profile actually has, added for
  `efis-toliss-airbus.json`'s `AirbusFBW/BaroUnitCapt` (confirmed writable,
  unlike the stock A330's command-pair baro ring).
- **A real bug in `efis-panel.js`'s own MODE/RANGE knob wiring, found via
  ToLiss**: `wireDetentKnob()` takes a `hasWriteDataref` flag to decide
  between the write path (`adjustReadoutValue`) and the paced-command path
  (`setReadoutIndex`) — but the call site hardcoded `false` for MODE and
  `true` for RANGE, correct for the stock A330 (whose MODE genuinely has
  no writable dataref) but wrong the moment a profile disagrees. Confirmed
  live 2026-08-30 that ToLiss's own MODE (`AirbusFBW/NDmodeCapt`) *is*
  directly writable — turning the knob from the web UI did nothing at all,
  because the hardcoded `false` sent it down the paced-command path, and
  ToLiss's profile has no increment/decrement commands for MODE to fire.
  Fixed by passing `adapter.hasWritableEncoder(name)` instead of a
  hardcoded literal at both call sites — reads the actual profile instead
  of assuming every aircraft matches the stock A330's shape, the same
  category of fix as the `writeToggle`/`stateIndex` additions elsewhere in
  this document.

For an EFIS/FCU of a genuinely different aircraft (own button/knob/lever
set, not just an Airbus-family variant): duplicate the relevant profile,
find the real dataref/command names with `tools/discover.mjs` (or the
older `tools/smoke-test.mjs`), and if the physical layout differs from the
A330's too, you'd also need your own panel — either a new profile-driven
consumer of the vendored library's lower-level pieces (`<fcu-knob>`,
`<fcu-led-button>`, etc. — see `vendor/README.md`), or a fully custom one.

**Radio** (`radio-panel-generic.json`) is the one panel that isn't
per-aircraft — it lives under X-Plane's own generic `sim/radios`/
`sim/audio_panel`/`sim/transponder` namespaces, the same "shared program
across Laminar's own default aircraft" situation as MCDU's `sim/FMS`, so
one profile is expected to work for any default aircraft with the
standard radio stack (confirmed against the stock King Air C90 and the
A330/737-800; re-verify before trusting it unchanged on another). It's
still `EfisAdapter`-shaped, `readouts`/`buttons` same as EFIS/FCU, but
tuning uses `readouts[].encoder` (a directly-writable standby-frequency
dataref, `valueKey: "standby"`) rather than paced step commands — see
`src/radio-panel.js`'s own top comment for why a direct write won over
firing `stby_*_coarse/fine_up/down` commands for this particular knob.

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
index.html                        the page — MCDU + EFIS + FCU + Radio + RMP+ACP markup, Panel selector
console.html                      operator console page — see "Operator console" above
manifest.webmanifest              PWA manifest for index.html — see "Progressive Web App" above
icons/icon.svg                    app icon, referenced by the manifest and both pages' favicons
css/mcdu.css                      MCDU look, plus the shared panel-switching/autoscale layout
css/console.css                   operator console's own plain UI look, not linked to mcdu.css
fonts/                            B612 Mono — see "Fonts" above
vendor/
  fcu-instruments.js                 third-party FCU+EFIS+Radio component library, used as-is — see vendor/README.md
  radio.js                           third-party <radio-panel> element, built on the above — see vendor/README.md
  rmp.js                              third-party <rmp-panel>/<acp-panel> elements, built on the above — see vendor/README.md
  qrcode-generator.js                third-party QR encoder, used as-is — see vendor/README.md
src/
  xplane-client.js                 REST + WebSocket wrapper around X-Plane's Web API
  app.js                            wires everything together: connection UI, Panel selector
  mcdu-adapter.js                    dataref bytes -> screen model, key name -> command
  mcdu-screen.js                      renders the screen model to DOM
  mcdu-keypad.js                       builds keypad buttons from a profile, wires presses
  efis-adapter.js                    named buttons/readouts/toggle switches -> datarefs/commands
                                        (also reused as-is for the FCU/Radio profiles — see its own top comment)
  efis-panel.js                       wires an EfisAdapter to vendor/fcu-instruments.js's <efis-panel>
  fcu-panel.js                         wires an EfisAdapter to vendor/fcu-instruments.js's <fcu-panel>
  radio-panel.js                        wires an EfisAdapter to vendor/radio.js's <radio-panel>
  rmp-panel.js                           wires an EfisAdapter to vendor/rmp.js's <rmp-panel>/<acp-panel>
  rmp-minimap.js                          floating widget to show/hide/scroll RMP+ACP's two stacked halves on a small screen
  readout-formats.js                   per-readout display-text formatting (QNH, mode/range labels, FCU windows)
  panel-autoscale.js                   fits <efis-panel>/<fcu-panel>/<radio-panel>/<rmp-panel>/<acp-panel> to their container via a computed CSS transform
  console.js                           polls/renders the operator console — no X-Plane/adapter concepts at all
config/profiles/
  default-fms.json                  MCDU dataref/command mapping for the stock A330's FMS
  b738-fms.json                     MCDU dataref/command mapping for the stock 737-800's FMS
  mcdu-toliss-airbus.json           MCDU mapping for the ToLiss Airbus add-on — live-verified 2026-08-28, different screen shape (see mcdu-adapter.js), see its own _note_provenance
  efis-a333.json                    EFIS dataref/command mapping for the stock EFIS (Airbus only)
  efis-toliss-airbus.json           EFIS mapping for the ToLiss Airbus add-on — deduced, not live-verified, see its own _note/_gap_* fields
  fcu-a333.json                     FCU dataref/command mapping for the stock FCU (Airbus only)
  radio-panel-generic.json          Radio dataref/command mapping — aircraft-generic, not Airbus/737-specific
  rmp-acp-a333.json                 RMP+ACP dataref/command mapping for the stock A330's RTP/ACP — VHF1/VHF2 only so far, see its own _note_on_*/_gap_* fields
  rmp-acp-toliss-airbus.json        RMP+ACP mapping for the ToLiss Airbus add-on — deduced, not live-verified, see its own _note_provenance/_gap_* fields
docs/xplane-web-api-notes.md      protocol reference notes + sources
docs/dataref-inventory.md         every dataref/command each panel actually uses, derived from config/profiles/
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
- RMP+ACP, **stock A330 profile only**: VHF3/HF1/HF2/AM/NAV/VOR/LS/ADF/BFO
  on the RTP, and the ACP's INT/CAB/PA/nav-reception rows (the ToLiss
  profile already covers all of these).
- ToLiss RMP+ACP's SEL indicator (`AirbusFBW/RMP1Lights_Raw[12]`) has only
  a soft user confirmation ("I think we have it now"), not an
  independently verified on/off pair the way NAV/BFO/AM got — see its own
  Interface subsection for the four earlier guesses this one replaced.
- ToLiss RMP+ACP: indices 7/8/10/11/12/13/14 of `AirbusFBW/ACP1Lights_Raw`
  (presumably LS/MKR/VOR2/ADF1/ADF2/SAT1/SAT2) are unconfirmed and unwired
  — low priority, since the vendored UI has no MIC key for most of them
  anyway.
- ACP reception volume writes are currently rejected by X-Plane itself
  (confirmed live "incompatible_data" error on these specific
  `double`-typed datarefs) — likely an X-Plane Web API bug, not fixable
  here; see `config/profiles/rmp-acp-a333.json`'s `_gap_acp_volume_write`.
- EFIS/FCU/Radio/RMP+ACP support in the mock server, so all four can be
  developed/tested without a running X-Plane instance too.
- Transponder mode/on-off on the Radio panel, once it's decided how the
  real 8-state mode enum collapses onto a simple control.
- Profile picker in the UI instead of a hardcoded default, per panel.
- A way to save a confirmed-working profile without hand-editing JSON.
- Full offline-installable PWA (a service worker, not just the manifest —
  see "Progressive Web App" below for why that's a bigger step than it
  sounds).
