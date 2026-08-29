# Verifying the ToLiss RMP+ACP profile

`config/profiles/rmp-acp-toliss-airbus.json` started as a first pass built
by matching names against `datarefs.txt`/`commands.txt` in this folder, not
against a real running ToLiss Airbus. Most of it has since been live-checked
(2026-08-29/30) — this doc now tracks only what's still genuinely open.
This is the one file to edit for anything below.

For the general "how do I actually submit this back" mechanics (forking,
branches, pull requests), see the main [`CONTRIBUTING.md`](../../CONTRIBUTING.md)
— this doc is just the "what to check" list for this specific profile.

**How to check anything below**: load the ToLiss Airbus in X-Plane, run
this app (`node tools/mcdu-server.js`), open the RMP+ACP panel, and use it
— then compare what you see/do against what the profile currently claims.
`node tools/discover.mjs <keyword>` (e.g. `node tools/discover.mjs RMP1`)
is useful for searching the full live dataref/command list if you suspect a
name is wrong or want to look for something the static listing might have
missed.

## Already confirmed (nothing to do)

- **Channel select, every mode**: `AirbusFBW/RMP1SelFunc` reads `0`=VHF1,
  `1`=VHF2, `2`=VHF3, `3`=HF1, `4`=HF2, `6`=VOR, `7`=LS/ILS, `9`=ADF —
  confirmed live for all eight. `8` was never observed (possibly MLS or
  another mode not wired here). `AM` and the STBY NAV `NAV` master key
  were confirmed to leave `RMP1SelFunc` completely unchanged — not
  distinguishable channels in this ToLiss version, wired command-only.
- **Frequency display**: the profile reads
  `AirbusFBW/RMP1/ActiveWindowString`/`StandbyWindowString` (pre-formatted
  display text, base64+NUL-terminated) rather than a scaled number —
  confirmed live to render correctly across every mode above, including
  ones a plain frequency number can't represent (ADF's whole-kHz value
  with no decimal, VOR/ILS's course-indicator standby window). See the
  profile's own `_note_on_window_string` for the full story if this is
  ever revisited.
- **Tuning step size**: `RMP1FreqUpLrg`/`DownLrg`/`RMP1FreqUpSml`/`DownSml`
  step and wrap correctly for VHF — confirmed live. Not separately walked
  through a full grid/wraparound check for the STBY NAV backup modes
  beyond confirming the same commands change their displayed values (see
  `_note_on_tuning`). Direct-write to the standby dataref is still not
  attempted; command-based tuning works fine as-is, so this isn't
  blocking anything.
- **ACP reception volume (VHF1/VHF2 only)**:
  `sim/cockpit2/radios/actuators/audio_volume_com1`/`com2` — confirmed
  live, writable, fractional writes round-trip cleanly. Not extended to
  VHF3/HF1/HF2 — no equivalent generic volume dataref confirmed for those.
- **Listen-toggle lit state, VHF1/VHF2/VHF3 + 10 more**:
  `AirbusFBW/ACP1KnobPush` (a *writable* 16-element array) — confirmed
  live to mirror the (still real, still valid) `AirbusFBW/DRAIMS1/
  ListenStates` exactly for VHF1/VHF2, while also covering VHF3/HF1/HF2/
  INT/CAB/LS/MKR/VOR1/VOR2/ADF1/ADF2/SAT1/SAT2/PA that `ListenStates`
  doesn't. Direct writes to a single element were tried (tempting, since
  it's writable) and confirmed unsupported by X-Plane's Web API
  (`incompatible_data` — needs the whole array's worth of values). Still
  goes through commands where one exists (`ListenVHF1`/`2`/`3`, the only
  `Listen*` commands found live) and stays a read-only lamp for
  HF1/HF2/INT/CAB/LS/MKR/VOR1/VOR2/ADF1/ADF2 (no toggle command found for
  any of them).
- **RMP power**: `AirbusFBW/RMP1Switch` — a directly writable dataref with
  no toggle command anywhere in the aircraft's command list at all. Wired
  via the new `writeToggle: true` button shape (`efis-adapter.js`'s own
  top comment) since there's no command to fire.
- **BFO**: `AirbusFBW/RMP1/BackupNavBFOPress` was confirmed to leave
  `RMP1SelFunc` and every dataref in the whole `DRAIMS1` namespace
  unchanged, even from ADF mode — plausibly audio-only (matching what a
  real ADF beat-frequency-oscillator actually does), wired command-only.
- **HF1 button report**: a live report said the physical HF1 button
  "doesn't seem to work" in ToLiss's own cockpit. Firing `HF1Capt` through
  this app's own command path works correctly (`RMP1SelFunc`→`3`, real HF
  frequency shown) — if the issue persists, it looks like a ToLiss-side
  3D click-spot problem, not something fixable here. See
  `_note_on_hf1_caveat`.
- **The RMP's "SEL" and "NAV" caret/lamp indicators**: went through
  several wrong guesses each before landing on the right dataref — see
  `_note_on_sel_indicator` and `_note_on_nav_backup_mode` for the full
  history if either is ever revisited (worth reading before trying yet
  another guess).
- **MIC transmit-select lit state, VHF1/VHF2/VHF3/HF1/HF2/INT/CAB/PA**:
  `AirbusFBW/ACP1Lights_Raw` (a 16-element `float_array`) — confirmed live
  by firing every `ACP1/*Press` command in isolation. Its index order
  isn't simply the channel list applied in sequence, though — `PA` is at
  index 9, not 15, found only by testing it directly. `VHF3Press` never
  moved anything (plausibly correct: VHF3 is a datalink/ACARS channel, no
  voice transmission to select). See `_note_on_mic_lights` for the full
  per-index confirmation before trusting any index in this array that
  isn't explicitly listed there.

## Optional: confirm the unconfirmed indices in `ACP1Lights_Raw`

Not blocking anything — every index actually used is directly confirmed
(see `_note_on_mic_lights`). Indices 7/8/10/11/12/13/14 (presumably LS/
MKR/VOR2/ADF1/ADF2/SAT1/SAT2 by the channel list, but that assumption
already broke once for PA) aren't wired for MIC at all and weren't
individually tested — there's no UI slot for most of them anyway
(`vendor/rmp.js`'s `ACP_TOP` row only has CALL keys for vhf1/vhf2/vhf3/
hf1/hf2/int/cab), so this is unlikely to ever matter in practice.

## When you're done

`_note_provenance` at the top of the profile can be trimmed down further
as remaining gaps close — RMP power, MIC/listen lit state, and ACP volume
are all resolved as of this doc's last update; what's left is mostly
smaller unconfirmed details noted above rather than whole missing
features.
