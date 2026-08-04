# X-Plane 12 Web API — reference notes

These notes summarize the parts of X-Plane's built-in Web API that this project
relies on. They were compiled from the official X-Plane Developer docs in
August 2026. **If something here disagrees with what your sim actually does,
trust your sim and the live docs** — this file is a snapshot, not a spec.

Primary sources:
- https://developer.x-plane.com/article/x-plane-web-api/
- https://developer.x-plane.com/article/datarefs-for-the-cdu-screen/
- https://developer.x-plane.com/2025/01/sdk-update-web-api-v2/
- https://www.x-plane.com/kb/x-plane-12-1-2-release-notes/

## Enabling it

Settings → Network in X-Plane. The web server (REST + WebSocket) has been
**on by default since X-Plane 12.1.2** (17 Jul 2024). It can be turned off
via "Disable Incoming Traffic". Default port is **8086** (not 8080 — that's
the old X-Plane 11 web UI port and is not used by this API). A different port
can be set by launching X-Plane with `--web_server_port=NNNN`.

No authentication is required for localhost/LAN connections as of this
writing; remote/authenticated access is called out as a possible future
addition, not something available today.

In testing, X-Plane's Web API also needed **Allow incoming connections**
turned on (Settings → Network) before it would accept connections at all —
including from `tools/mcdu-server.js` running on the same machine, talking
to it over `localhost`. That's not what the setting's name/docs would
suggest, and the exact mechanism isn't confirmed (could be X-Plane gating
the whole Web API behind that flag rather than just non-loopback binds,
could be OS firewall behavior). Practical guidance: turn it on regardless
of where the proxy runs relative to X-Plane. See README "How it fits
together" for what the proxy does and doesn't buy you given this.

## Versioning

X-Plane serves multiple API versions side by side:

| Version | Available since | Adds |
|---|---|---|
| v1 | 12.1.1 | datarefs (list/get/set) |
| v2 | 12.1.4 | commands (list/activate/subscribe) |
| v3 | 12.4.0 | flight init/config endpoints |

`GET http://<host>:8086/api/capabilities` (no version segment) reports the
X-Plane version and the API versions it supports. This app targets **v2**
(datarefs + commands is all an MCDU needs) and calls `/api/capabilities`
at connect time to confirm the sim actually speaks it.

## REST endpoints (base `http://<host>:8086/api/v2`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/datarefs` | List datarefs. Supports `?filter[name]=exact.name` (repeatable) — **exact match only**, not substring. |
| GET | `/datarefs/count` | Count of registered datarefs |
| GET | `/datarefs/{id}/value` | Read a dataref's current value |
| PATCH | `/datarefs/{id}/value` | Write a dataref's value |
| GET | `/commands` | List commands. Same `filter[name]` semantics as datarefs. |
| GET | `/commands/count` | Count of registered commands |
| POST | `/command/{id}/activate` | Fire a command once |

Responses: `{ "data": ... }` on success, `{ "error_code": ..., "error_message": ... }`
on failure.

**Important:** `filter[name]` is exact-match, so it's only useful once you
already know the precise dataref/command name. To *discover* names you don't
already know (e.g. browsing for the right `sim/FMS/...` command), you have to
pull the full list and filter client-side — see `tools/smoke-test.mjs`,
which does exactly that.

## WebSocket (base `ws://<host>:8086/api/v2`)

Every message: `{ "req_id": <int>, "type": "<op>", "params": {...} }`.
Every reply: `{ "req_id": <int>, "type": "result", "success": bool, ... }`.

Subscribing to dataref updates streams pushes at **10 Hz**:

```jsonc
// subscribe
{ "req_id": 1, "type": "dataref_subscribe_values",
  "params": { "datarefs": [ { "id": 1223 }, { "id": 1224, "index": [0,1,2] } ] } }

// unsolicited push, arrives ~10x/sec while subscribed
{ "type": "dataref_update_values",
  "data": { "1223": <value>, "1224": [<v0>,<v1>,<v2>] } }
```

Writing a dataref over the socket:

```jsonc
{ "req_id": 2, "type": "dataref_set_values",
  "params": { "datarefs": [ { "id": 88491, "value": 6 } ] } }
```

Commands (v2+) can be driven the same way, which is what this project uses
for MCDU keypresses (more explicitly documented than the REST `/activate`
body shape):

```jsonc
{ "req_id": 3, "type": "command_set_is_active",
  "params": { "commands": [ { "id": 501, "is_active": true, "duration": 0.15 } ] } }
```

`duration` appears to simulate a press-then-release after N seconds, which is
exactly a CDU keypress. This project always uses this form rather than the
REST `/command/{id}/activate` endpoint, whose exact body schema wasn't
pinned down during research.

## Value encoding

Scalar numeric datarefs come back as plain JSON numbers/booleans. **Array and
"data" (byte-string) datarefs are base64-encoded** in both directions — you
must `atob()`/base64-decode on read and base64-encode on write. The CDU text
and style lines (see below) are both array datarefs, so both go through
base64.

## CDU screen datarefs

- Text: `sim/cockpit2/radios/indicators/fms_cdu{N}_text_line{L}` for
  `N ∈ {1,2,3}` (CDU 1 = captain, CDU 2 = first officer, CDU 3 = observer)
  and `L ∈ 0..15` (16 lines). UTF-8 bytes, base64-encoded over the wire.
- Style: `sim/cockpit2/radios/indicators/fms_cdu{N}_style_line{L}`, one
  unsigned byte per **character** (not per UTF-8 byte — matters for the rare
  multi-byte glyphs like °), also base64-encoded.

Style byte bit layout:

| Bits | Meaning |
|---|---|
| 7 | Large font |
| 6 | Reverse video (color applies to background, glyph renders black) |
| 5 | Flashing |
| 4 | Underscore |
| 3–0 | Color: 0 black, 1 cyan, 2 red, 3 yellow, 4 green, 5 magenta, 6 amber, 7 white |

24 columns × 16 lines is the dataref-slot max, but not every aircraft's CDU
uses all 16 rows — on the stock Airbus, `text_line14`/`text_line15` are
consistently blank in live captures (2026-08-04). Matches the standard CDU
layout: 1 title + 6 label/data pairs + 1 scratchpad = 14 rows.
`config/profiles/default-fms.json` sets `screen.lines: 14` accordingly;
rendering the full 16 just adds two rows of dead space at the bottom of the
screen. `tools/smoke-test.mjs` and `tools/mock-xplane-server/` still probe/
expose all 16 raw slots, which is correct for a diagnostic tool — it's only
the app's own rendering that should stop at 14.

## Keypress commands — confirmed live 2026-08-04

Verified with `tools/smoke-test.mjs` against a running X-Plane 12.4.3 with
the stock Airbus A330 loaded. The key set is identical across all three CDU
positions, but each lives under a **different prefix** — not a `{cdu}`
template substitution like the screen datarefs:

| CDU | command prefix |
|---|---|
| 1 (captain) | `sim/FMS` |
| 2 (first officer) | `sim/FMS2` |
| 3 (observer) | `sim/CDU3` |

Full confirmed suffix list (82 per CDU), also encoded in
`config/profiles/default-fms.json` → `keys` (suffix) +
`commandPrefixByCdu` (prefix):

- Numeric: `key_0` … `key_9`
- Alpha: `key_A` … `key_Z`, `key_space`
- Editing: `key_period`, `key_minus`, `key_slash`, `key_clear`, `key_delete`, `key_back`, `key_overfly`
- Line select: `ls_1l` … `ls_6l`, `ls_1r` … `ls_6r`
- Pages/function: `index`, `fpln`, `clb`, `crz`, `des`, `dir_intc`, `dep_arr`, `hold`, `exec`, `fix`, `airport`, `atc_comm`, `data`, `fuel_pred`, `menu`, `navrad`, `prev`, `next`, `perf`, `prog`, `sec_fpln`, `up`, `down`, `legs`
- Window: `CDU_popup`, `CDU_popout`

This command set lives under the core `sim/` namespace (not
`laminar/A333/...`), so it's very likely X-Plane's actual generic
default-FMS keyboard — shared across whichever default aircraft is loaded —
rather than something Airbus-specific. It hasn't been re-verified against a
non-Airbus default aircraft (Cessna, King Air, MD-80, ...); if you do, and
something differs, `tools/smoke-test.mjs` is exactly the tool to re-run.

Related datarefs discovered at the same time, not yet wired into the app:
`laminar/a333/MCDU{1,2,3}/bright_setting` (brightness knob) and
`laminar/A333/annun/mcdu{1,2,3}_{fail_fm,fm1,fm2,ind,line,mcdu_menu,rdy}`
(annunciator lights) — these two are Airbus-specific (`laminar/A333/...`),
unlike the keypad commands above.

**Third-party airliners (Zibo 737, FlightFactor, ToLiss, etc.) use entirely
different, aircraft-specific datarefs/commands** (e.g. Zibo uses
`laminar/B738/...`), not the `sim/FMS*` / `fms_cdu*` namespace described
here. This scaffold targets the stock/default X-Plane FMS; a different
aircraft needs a different profile (see README "Adding support for another
aircraft").

### Re-verifying against a different aircraft

```sh
node tools/smoke-test.mjs [host] [port]   # defaults to localhost:8086
```

Dumps the live, decoded CDU1+CDU2 screen content (handy for eyeballing that
the style-byte decoding still looks right) and scans the full command/dataref
lists for anything matching `cdu`/`mcdu`/`fms`. For anything not obvious from
naming alone: there used to be an in-app Discovery panel that subscribed to a
candidate command's activation state so you could press the real key/menu
item in X-Plane and watch which one lit up (removed once the default profile
was fully verified). The same check is a few lines with the
`command_subscribe_is_active` message documented above if you need it again
for a new aircraft.

## Proxying the WebSocket: preserve frame type, not just payload

(This section describes a bug hit during an earlier iteration of
`tools/mcdu-server.js`, when it used the `ws` package. The lesson —
preserve text-vs-binary identity through a relay — is still exactly what
the current hand-rolled implementation has to get right too, just via
different mechanics; kept here because the failure mode is worth
recognizing regardless of implementation. See the next section for why
`ws` isn't used there anymore at all.)

`tools/mcdu-server.js` relays the app's websocket traffic to X-Plane over
localhost (see README "How it works"). The `ws` package's
`message` event hands you a `Buffer` for *both* text and binary frames —
there's no way to tell which from the payload alone. If you relay that
Buffer with plain `.send(data)`, `ws` defaults to sending it as a **binary**
frame. X-Plane sends its JSON messages as **text** frames, so blindly
relaying flips them to binary in transit.

The failure mode this produces is nasty specifically because it's silent:
REST calls and the initial `dataref_subscribe_values` round-trip all still
succeed (those go over their own frames/requests, unaffected). But every
subsequent `dataref_update_values` push arrives at the browser as binary,
the native `WebSocket`'s `message` event hands `xplane-client.js` a `Blob`
instead of a string, `JSON.parse()` throws, and `_handleMessage`'s
catch-and-ignore around that parse swallows it — so the screen just... never
updates, with no error anywhere. It looked like "the sim's CDU screen is
blank" right up until checking the raw dataref value over REST proved it
wasn't.

Fix at the time: `ws`'s `message` event's second argument, `isBinary`, tells
you the original frame type — pass it straight through as
`{ binary: isBinary }` on the outgoing `.send()` call, both directions. If
you're ever debugging something that looks like "subscriptions work but
updates never arrive" through a proxy like this, checking the raw REST
value against what the websocket path reports is the fastest way to tell a
silent relay bug from genuinely idle sim state — that's how this one and
the one below were both actually caught, not by inspection.

## Node's built-in WebSocket client can't talk to X-Plane reliably

`tools/mcdu-server.js` was rewritten again shortly after the fix above, this
time to drop the `ws` dependency entirely, so the app has no npm
dependencies to install. The obvious way to do the *outbound* half
— this process connecting out to X-Plane — with no dependency at all is
Node's own built-in global `WebSocket` client (stable since Node 22.4, no
import needed).

It doesn't work against X-Plane's websocket server specifically. Send it
roughly 20+ messages shortly after the connection opens — which is exactly
`McduAdapter`'s startup burst, 14 lines × (text + style) = 28
`dataref_subscribe_values` calls fired in a tight loop — and the connection
dies with close code 1006, with this on the console:

```
TypeError
    at #onSocketClose (node:internal/deps/undici/undici:16410:20)
    at Object.onSocketClose (node:internal/deps/undici/undici:16108:72)
    at failWebsocketConnection (node:internal/deps/undici/undici:15485:17)
    at Object.processResponse (node:internal/deps/undici/undici:15388:15)
```

Confirmed this is a Node/undici issue and not something specific to this
proxy by reproducing it with Node's `WebSocket` connecting **directly** to
X-Plane — no proxy in between at all, same 28-rapid-subscribes pattern,
same crash. (Node v26.6.0, X-Plane 12.4.3, 2026-08-04.) Sending the same
messages with a delay between each, or fewer of them, doesn't reliably
trigger it — which is why it wasn't obvious from a quick single-dataref
smoke test; it took reproducing the adapter's actual startup pattern to
surface.

Given that, the outbound half is hand-rolled too, reusing the same frame
encoder/parser as the inbound (server) half — see `tools/mcdu-server.js`,
`connectUpstream()`. If you're extending this and considering reaching for
Node's built-in `WebSocket` client against X-Plane again: it looks like the
right zero-dependency choice, but verify against the real burst pattern
(many messages, immediately after open) before trusting it, not just a
single round-trip.
