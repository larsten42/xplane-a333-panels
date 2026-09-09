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

**2026-08-30 `rate-drag` attribute on `<fcu-knob>` (hand-patched here,
needs relaying upstream to Design so the next bundle keeps it)**: added
for RMP+ACP's tune knob after direct user feedback that even a
quadrupled-sensitivity `drag-step` (14px default → 7 → 4) still felt
"unbearably slow" for a real frequency retune — a fixed px-per-detent
model fundamentally can't cover both "change frequency by a lot" and
"nudge by one step" without either being glacially slow or dangerously
twitchy somewhere in between. `rate-drag="true"` replaces that entire
gesture with a spring-centered rate control instead: hold away from
the pointer-down position to fire steps continuously, faster the further
out you hold past a small dead zone (quadratic ease-in, so it's still
precise just past the dead zone), release or return within the dead zone
to stop. Entirely separate code path from the default drag-step gesture
— every other knob using the old model is untouched, and the two are
mutually exclusive per knob (this is a full gesture replacement, not a
tweak to the existing one).

One thing this does *not* do, on purpose, worth knowing before reusing it
elsewhere: no cap-lean visual — a caller's own `onTurn` handler may
already own `cap.style.transform` for its own reasons (RMP's tune knob
freezes the cap and spins a separate bezel to visually decouple coarse
from fine mode), which a lean effect would otherwise flicker against
every tick.

`rate-max-hz` defaults to 5/sec, on the theory that a caller whose
`onTurn` fires a *command* per tick (ToLiss's RMP tuning, no writable
frequency dataref to write to instead) needed to stay under X-Plane's own
~6.5/sec command-coalescing throttle (every command this app fires holds
"active" for a fixed 150ms — `XPlaneClient.activateCommand`'s own default
`duration`). **That theory doesn't hold for ToLiss's own commands
specifically** — confirmed live 2026-08-30 by firing `RMP1FreqUpSml` 30
times at ~33/sec (30ms apart) and seeing the resulting frequency change
match or exceed the naive full-count expectation, not fall short of it;
no evidence of dropped/coalesced steps at that rate at all. The ~6.5/sec
caution is real for at least one of X-Plane's own *native* step commands
(`stby_com1_fine_up_833`, documented in `radio-panel-generic.json`'s own
notes) — it just doesn't automatically transfer to every plugin-defined
command, and apparently doesn't for this one. RMP's own `rate-max-hz`
override (below) reflects this; the 5/sec default here stays conservative
for whatever the *next* caller turns out to be, until proven otherwise
for that command too.

**2026-08-30 dead zone/max-rate distances made relative to the knob's own
size, not fixed pixels — a real bug, not a tuning problem**: the first
`rate-drag` implementation used fixed pixel thresholds (`rate-deadzone`
8px, `rate-max-px` 90px) measured against raw `e.clientY` deltas. Those
are always real, unscaled screen pixels — but this app scales whole
panels down via CSS `transform` to fit smaller viewports (tablets
especially), and a fixed 90px threshold can end up *larger than the
entire visible knob* once scaled down, making max rate practically
unreachable without dragging a finger well past the knob's own edge.
Live-reported as "it works, but it's still very slow" even with
`rate-max-hz` cranked to 180 — raising the rate ceiling did nothing
because the drag never got anywhere near the (too-large) distance
threshold that was supposed to unlock it, so nearly every real drag
stayed deep in the slow end of the curve regardless of how high the
ceiling went. `rate-deadzone`/`rate-max-px` are gone; replaced with
`rate-deadzone-frac`/`rate-max-frac` (defaults `0.05`/`0.35`), fractions
of the knob's own `getBoundingClientRect().height` measured fresh at
*each* `pointerdown` (not cached once at connect time), so a mid-session
rescale (window resize, the app's own FIT toggle) is picked up on the
next press without needing the page reloaded.

**2026-08-30 the real bug: synchronous multi-step bursts collapse on
X-Plane's side, so a *higher* `rate-max-hz` was making things worse, not
faster**: even after the distance fix above, max rate still felt
"extremely slow" — cranking `rate-max-hz` to 180 changed nothing
perceptible. `rateTick`'s accumulator was firing every step the rate math
said was due in a given animation-frame tick via a tight `while` loop —
at 180/sec and 60fps that's 3 `self._turnCb()` calls per tick, fired
synchronously with no real time between them at all. Confirmed live via
a raw REST test completely outside this component: 60 command activations
fired with no pacing (parallel requests, essentially simultaneous)
registered only 4 real steps, while the exact same command paced at a
real 30/sec (33ms apart) registered all of them (see `radio-panel.js`'s
sibling investigation, or just: X-Plane appears to collapse multiple
same-command activations arriving in one processing pass down to one
effective step, independent of each activation's own `duration`). A
synchronous same-tick burst is exactly that pathological case — so
raising `rate-max-hz` just meant *more* steps got requested per burst and
*more* of them got silently dropped, not that more real steps landed.
Fixed two ways: `rateTick` now fires at most one real step per animation
frame (`requestAnimationFrame`'s own ~60Hz cadence paces delivery), and
`rate-max-hz` is now enforced as a real minimum elapsed-time gap between
fires (`RATE_MIN_INTERVAL_MS = 1000 / RATE_MAX_HZ`), not just an input to
the curve math the burst could blow straight through. The accumulator is
also clamped to at most one pending step (not left to build an unbounded
backlog at a high requested rate), so easing off the drag responds to the
*current* displacement immediately instead of continuing to fire out a
stale backlog. `rmp-tune`'s own `rate-max-hz` dropped from the untested
180 stress-test value back down to `30` — the exact rate directly
confirmed clean with real pacing; worth raising again later if 30 still
feels slow, but only after testing whatever higher value the same way,
not by assuming higher is safe.

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

**2026-08-30 tune knob drag-step lowered, twice**: both units' tune
`<fcu-knob>` now sets `drag-step="4"` (was relying on
`fcu-instruments.js`'s own default of 14px) — first dropped to 7, then to
4 after that still felt like it needed too much drag distance per detent,
per direct user feedback both times. This is a plain value in `unit()`'s
own markup template, not a new attribute/behavior — a config tweak, not a
hand-patch needing anything relayed upstream. Applies to *both* MHz
(coarse ring) and kHz (fine boss) grab zones equally: unit() builds one
physical `<fcu-knob>` per radio unit, and `src/radio-panel.js`
distinguishes coarse/fine by where the pointer grabbed it (see its own
`pickRing()`), not by two separate knob elements each with their own
`drag-step` — there's no way to speed up one grab zone's detent-per-px
sensitivity without the other on this component. If a genuinely
kHz-only tweak is ever wanted, the right lever is
`src/radio-panel.js`'s own fine-mode step size (`nextStandbyRaw()`'s
`step.fine`), not this attribute.

**To update when a new bundle arrives:** same process as fcu-instruments.js
above — copy both `fcu-instruments.js` and `radio.js` from the new bundle
over these two files (re-apply the `drag-step="4"` tweak above if the new
bundle's markup doesn't have it), reload and sanity-check all three panels
(the shared library file affects FCU/EFIS too), and check
`src/radio-panel.js` against the new bundle's own integration doc if any
method names/signatures moved.

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

**2026-08-30 SEL annunciator, reddish (from Design, partially applied)**:
`RmpPanel.api.setSel(on)`'s lit state reworked to glow semi-dim red across
the whole round annunciator face (a new `background`/`box-shadow` on the
`[data-sel]` container itself, not just the legend text/dot), and the
legend/dot color shifted from plain amber toward red-orange — applied
as-given, no regressions found in that part. **One line from Design's own
diff deliberately not applied**: `connectedCallback()` calling
`api.setSel(flag(this, 'sel', true))` right after `_paint()`, defaulting
the indicator to *lit* at construction time. `src/rmp-panel.js`'s own
`refresh()` already calls `setSel()` with the real confirmed value on
every single refresh cycle (including the first one), so this default
does nothing useful for this app's integration — worse, since
`adapter.connect()` resolves dataref/command ids over the network before
that first real `refresh()` can run, this would make the SEL annunciator
visibly flash on at full brightness on every page load/reconnect before
snapping to its real state a moment later, which the previous
implicit-`false`-until-set behavior didn't do. Needs relaying back to
Design: either drop that line, or default to `false`.

**2026-08-30 tune knob drag-step lowered, then superseded by
`rate-drag`**: `rmp-tune` (the RMP's own tune knob, coarse ring + fine
boss, same shape as radio.js's tune knobs) briefly matched radio.js's own
`drag-step="4"` tweak, but that whole model — however low `drag-step`
goes — still fundamentally trades off "fast for a big change" against
"precise for a small one," and a real retune still felt "unbearably
slow." Switched to `rate-drag="true"` instead (see
`fcu-instruments.js`'s own entry above for the full mechanism and its
caveats) — `rmp-tune` no longer has a `drag-step` attribute at all.
`radio.js`'s tune knobs are intentionally **not** switched over yet —
they weren't the ones reported as too slow, and radio.js's own internal
`_wireKnobs()`/`_tune()` coarse/fine handling hasn't been checked for the
same `onTurn`-frequency assumptions `rate-drag`'s design leans on, so
flipping it there without that check first risked a real regression
rather than a proven fix. `radio.js` and `rmp.js` each carry their own
knob markup, so a fix (or gap) in one doesn't reach the other.

**2026-08-30 `rate-max-hz`/`rate-max-frac`, tuned in several wrong
directions before landing here**: `fcu-instruments.js`'s own 5/sec
default for `rate-drag` was written on the assumption that any
command-firing `onTurn` needed to stay under X-Plane's command-coalescing
throttle — confirmed live the same day that ToLiss's own
`AirbusFBW/RMP1FreqUpSml` doesn't actually need that specific caution
(see `fcu-instruments.js`'s own entry above for the test). Raised to 18,
still felt "slow AF" live; raised further to 180 as a stress test
specifically to see if *any* value helped, which it didn't — that turned
out to be because a higher requested rate was making a real bug in the
component *worse*, not because the value itself was too conservative
(see `fcu-instruments.js`'s own two entries above: the
fixed-vs-scaled-panel distance issue, then the synchronous-burst-collapse
issue underneath it). With both of those fixed, a raw paced REST test
confirmed 60/sec still delivers cleanly (30 presses at ~16.7ms spacing
registered all of them) — settled on `rate-max-hz="50"` as a margin under
that tested-clean ceiling, not the ceiling itself. Also dropped
`rate-max-frac` from the original 0.35 to `0.18`: even at 30/sec, a
report of "100kHz taking 3-4 real seconds" (≈6-7 effective steps/sec)
implied a real drag was landing well short of the distance needed to
reach anywhere near max rate, not that max rate itself was too low —
halving the distance needed makes the fast end of the curve reachable
with a much more casual drag.

**2026-08-30 the actual final answer: `duration`, not this component at
all**: still reported as the same speed after both fixes above — the real
knob-side console log this time showed it correctly firing right at the
configured max rate with real, properly-paced gaps between fires. So the
bottleneck was never in this component; it was downstream, in
`XPlaneClient.activateCommand()`'s own default 150ms `duration`, which
turns out to create a real ~6.5/sec ceiling on repeated activations of the
*same* command over the websocket (see
`docs/xplane-web-api-notes.md`'s own new section on this — a real X-Plane
API behavior, not specific to this component or this knob). Fixed at the
source: `EfisAdapter.press()` now takes an optional `durationSeconds`,
and `src/rmp-panel.js`'s tune-knob press passes `0.025` instead of the
default — tested clean at a real 25/sec with that duration. `rate-max-hz`
here dropped from `50` to `25` to match the rate actually validated with
that shorter duration, not because 50 was itself unsafe *for this
component* — the real ceiling was always about the command layer
underneath it, not the drag gesture generating the calls.

**2026-08-30 one more layer down: a real command queue, not just a
rate ceiling**: 25/sec delivered every step (confirmed above), but a
follow-up report — "moving from fast back to center, a lot of buffered
turns still continue" — turned out to be real too, and independent of
this component entirely: a raw script test (fire a burst at a sustained
rate, stop, then keep sampling the real dataref) showed X-Plane's own
command queue keeps *draining* for a while after the last activation is
sent, not just processing each one instantly. Measured directly: 25/sec
sustained for 1s leaves ~430ms (3-4 steps) of continued movement after
stopping; 15/sec leaves ~236ms; 10/sec leaves **zero** — stops the
instant input stops. This is a genuine, unavoidable trade-off (max speed
vs. instant-stop feel), not a bug anywhere in this app's own code, and
not something a shorter `duration` or a different accumulator can fix —
it's downstream of everything this app controls. Given a direct choice
between "faster but has real momentum/coast" and "slower but stops
exactly when you let go," `rate-max-hz` here is now `10` — a live user
call favoring predictability over top speed, not a technical default.
Revisit if the trade-off preference ever changes, informed by the same
measurements above rather than re-discovering them.

**2026-08-30 final feel pass, after VHF1/VHF2 went direct-write**: with
VHF1/VHF2's own speed problem fixed at the dataref layer instead (see
`ARCHITECTURE.md`'s RMP+ACP section), the queue-draining trade-off above
now only applies to the command-based channels (VHF3/HF1/HF2/backup
NAV) — so a live "make it feel good now that it actually works" pass
bumped things up a little: `rate-deadzone-frac`/`rate-max-frac` both ×1.5
(`0.05`→`0.075`, `0.18`→`0.27`) for a slightly larger, easier-to-hit
gesture zone, and `rate-max-hz` `10`→`13` — still comfortably inside the
"no coast on release" territory measured above for the command-based
channels, while giving VHF1/VHF2's now-unlimited direct write a bit more
headroom too.

**2026-08-30 a fourth zone: `rate-turbo-frac`, flat 2x `rate-max-hz`
beyond it**: a live request for "one more, even faster range" — rather
than extending the existing quadratic curve further (which would make
the whole curve's fast end more sensitive, harder to land precisely on
the already-tuned max), this is a distinct fourth zone past
`rate-max-frac`'s own distance (default `rate-max-frac × 1.6`, own
attribute `rate-turbo-frac`): a flat `rate-max-hz × 2` the moment you
cross it, not a continuation of the ramp. `RATE_MIN_INTERVAL_MS` is now
based on the turbo rate specifically, not `rate-max-hz`, so the pacing
gate itself doesn't become the thing blocking turbo from actually
reaching double speed. Worth knowing: this doubles the effective rate
for the *command-based* channels too (VHF3/HF1/HF2/backup NAV), not just
VHF1/VHF2's unlimited direct write — at `rate-max-hz="13"`, turbo means
26/sec for those channels, back in the range where the queue-draining
trade-off measured earlier reappears (extrapolating from the 15/sec →
236ms and 25/sec → 430ms data points, expect something similar around
26/sec). That's presumably an acceptable trade for a deliberate
reach-far gesture rather than the default speed, but it hasn't been
independently re-measured at exactly this rate — do that first if the
coast on a turbo-then-release for those channels ever gets reported as
surprising.

**2026-08-30, same day, `rate-turbo-mult`**: a follow-up live request
("make the fastest zone 2x as fast") needed to speed up *only* the turbo
zone, not the whole curve — bumping `rate-max-hz` itself would also raise
the ceiling of the normal (non-turbo) range, changing how the knob feels
well before you reach turbo. `RATE_TURBO_HZ` was hardcoded as
`RATE_MAX_HZ × 2`; generalized to `RATE_MAX_HZ × rate-turbo-mult` (default
`2`, so every existing caller is unaffected) and set `rate-turbo-mult="4"`
on the RMP's own tune knob specifically — `rate-max-hz="13"` unchanged, so
turbo goes from 26/sec to 52/sec while the rest of the curve stays exactly
where it was. Worth noting on top of the paragraph above: 52/sec on the
command-based channels (VHF3/HF1/HF2/backup NAV, and now COM2 too — see
`config/profiles/rmp-acp-toliss-airbus.json`'s own COM2 history for why
COM2 ended up command-only after all) is well past the two data points the
queue-draining trade-off was measured at (15/sec → 236ms coast, 25/sec →
430ms coast) — expect a longer coast on release than either of those,
unmeasured at this specific rate.

**2026-09-09, coarse/fine asymmetry — fixed in src/rmp-panel.js, not
here**: a live report that the MHz (coarse) ring felt "pretty sensitive
and fast" once the kHz (fine) ring's own feel was dialed in traces back to
this component having no concept of "coarse ring" vs "fine ring" at all —
`rateTick`'s accumulator fires ticks at one shared rate regardless of
which ring the drag started on, and RMP's own `onTurn` handler is what
decides whether a tick means a small kHz step or a whole-MHz one. Same
tick rate, much bigger real value change per tick in coarse mode — tuning
`rate-max-hz` for a good kHz feel necessarily made MHz feel proportionally
faster, not a bug in this file. Deliberately NOT fixed here (no
`rate-coarse-mult`-style attribute added) since this component has no way
to know which ring a tick belongs to in the first place — RMP's own
`onTurn` already does, so it just drops every other tick while in coarse
mode instead, halving the MHz ring's effective rate with zero changes to
this file. See src/rmp-panel.js's own comment at that drop for the detail.

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
