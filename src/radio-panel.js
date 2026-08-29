// Wires the vendored radio-stack component (vendor/radio.js — see
// vendor/README.md) to the real X-Plane adapter. Mirrors fcu-panel.js's
// structure: this file owns all the radio-specific glue, the vendored file
// is never edited.
//
// Standby tuning writes the standby frequency dataref directly (confirmed
// live 2026-08-11 that com1_standby_frequency_hz_833/nav1_standby_frequency_hz/
// dme_standby_frequency_hz/adf1_standby_frequency_hz all take a direct write
// immediately, see radio-panel-generic.json's _note_on_standby_tuning) via
// EfisAdapter's adjustReadoutValue()/beginAdjust()/endAdjust() — the same
// optimistic-write-with-drag-suppression pattern the FCU/EFIS baro knob
// already uses. An earlier version of this file fired the discrete
// stby_*_coarse/fine_up/down step commands instead, paced to dodge
// X-Plane's command_set_is_active coalescing — that turned out to be the
// wrong tool for a fast knob drag: even generously paced, a fast drag would
// queue far more presses than could drain within the debounce window, so
// the display kept visibly stepping for a while after the user's finger
// had already left the knob. A direct write has no such pacing to do.
//
// The panel's own onFreq(u, band, pair) only hands back its own guessed new
// value, not a raw turn direction — pair's *magnitude* isn't used for
// anything, only its sign (compared against the adapter's own current
// value) to recover which way the knob turned. nextStandbyRaw() below is
// what actually computes the real next value, using each band's true
// wraparound behaviour confirmed live 2026-08-11 (see its own comment) —
// real 2-ring radios keep the fine (kHz) ring and coarse (MHz) ring
// independent of each other, which the panel's own naive
// current+direction*step arithmetic didn't respect.

const LEVER_ID_TO_BAND = {
  "aud-com1": "COM1",
  "aud-com2": "COM2",
  "aud-nav1": "NAV1",
  "aud-nav2": "NAV2",
  "aud-adf1": "ADF1",
  "aud-adf2": "ADF2",
  "aud-dme": "DME",
};

// The panel's seven-seg display expects every band's active/standby value
// pre-scaled to the same "freq * 1000" shape (6 digits, decimal at index 3
// — confirmed live 2026-08-11 e.g. COM1's _833 dataref: 118505 = 118.505).
// COM1/COM2 already come out of the sim that way via the _833 datarefs, and
// ADF1/ADF2 are bare kHz integers with no decimal at all — neither needs scaling.
// NAV1/NAV2/DME only carry 2 real decimal digits (confirmed live: raw 10815
// = 108.15, not 108.150), so those need x10 to land on the same 6-digit/
// 3-decimal shape without losing or fabricating precision.
const DISPLAY_SCALE = { NAV1: 10, NAV2: 10, DME: 10 };
const scaleFor = (band) => DISPLAY_SCALE[band] ?? 1;

// Real per-press step sizes in each band's own *raw* dataref units (i.e.
// before DISPLAY_SCALE) — confirmed live 2026-08-11 by firing each step
// command in isolation and reading the resulting dataref delta.
const STEP = {
  COM1: { coarse: 1000, fine: 5 },
  COM2: { coarse: 1000, fine: 5 },
  NAV1: { coarse: 100, fine: 5 },
  NAV2: { coarse: 100, fine: 5 },
  DME: { coarse: 100, fine: 5 },
  ADF1: { coarse: 100, fine: 1 },
  ADF2: { coarse: 100, fine: 1 },
};

// Real standby range per band, in raw units — a final safety clamp so a
// fast drag can never write a value the sim wouldn't accept. COM1/COM2's
// max is 136990, *not* 136975 — the vendored component's own BANDS table
// assumed 975, but walking the real fine_up_833 command through the 136
// decade live (2026-08-11, re-confirmed 2026-08-27) showed it reaches
// 136980/136985/136990 exactly like every other decade (see comFineStep()
// below for the real skip pattern); 975 was simply wrong.
const RAW_RANGE = {
  COM1: { min: 118000, max: 136990 },
  COM2: { min: 118000, max: 136990 },
  NAV1: { min: 10800, max: 11795 },
  NAV2: { min: 10800, max: 11795 },
  DME: { min: 10800, max: 11795 },
  ADF1: { min: 190, max: 1750 },
  ADF2: { min: 190, max: 1750 },
};
const clamp = (value, band) => {
  const range = RAW_RANGE[band];
  return range ? Math.min(range.max, Math.max(range.min, value)) : value;
};
const mod = (n, m) => ((n % m) + m) % m;

// Valid fine-offset span *within* one coarse digit, for bands with a plain
// uniform fine grid (confirmed live 2026-08-11: NAV1 walked a full 0-95
// decade with no gaps, wrapping cleanly at 95->00; ADF's ones_tens pair
// likewise wraps cleanly at 99->00 without touching the hundreds digit).
// COM1/COM2 are handled separately below — their real 8.33kHz grid isn't
// uniform.
const FINE_SPAN = { NAV1: 100, NAV2: 100, DME: 100, ADF1: 100, ADF2: 100 };

// COM's real 8.33kHz channel grid isn't a uniform every-5 sequence within
// one MHz — X-Plane's own stby_com1_fine_up/down_833 commands skip one
// specific position every 25 raw units, confirmed *twice* live now
// (2026-08-11 originally, re-confirmed 2026-08-27 after a detour below):
// e.g. ...,890,900,905,910,915,925,930,... (900 is kept, 920 is skipped).
//
// 2026-08-27 correction-of-a-correction: a user report ("kHz doesn't
// always match the 8.33 logic") plus the UK CAA's own published "8.33 kHz
// Frequency and Channel Display Table" (CAP 1573) looked like a strong
// case that this was backwards — CAP 1573's real-world channel designators
// use +5/+10/+15kHz within each 25kHz block and never the block boundary
// itself (+0, which the document says selects legacy 25kHz mode instead).
// That was briefly shipped as a "fix" here. It was wrong for this
// function's actual job: walking the *real* fine_up_833/fine_down_833
// commands live through 80 steps (both directions, decade wraps included)
// showed X-Plane's own simulated 8.33kHz stepping does NOT follow CAP
// 1573's real-world table — it keeps the block-boundary position and
// skips a different one instead (see the sequence above). X-Plane's own
// COM radio simulation apparently doesn't implement the real ICAO/CAA
// channel designator convention exactly; this app's job is to mirror
// what X-Plane actually does with the frequency it actually tunes, not
// what a real aircraft's radio would display for the same nominal
// channel, so matching X-Plane's real behavior is the correct choice here
// even though it disagrees with CAP 1573. (This likely also explains the
// original user report: if X-Plane's own simulated frequency doesn't
// match the real-world channel table for some values, no amount of
// correctness in *this app's reproduction* of X-Plane's behavior closes
// that gap — it's a difference between X-Plane's simulation and a real
// radio, not a bug in mirroring X-Plane.)
//
// Modeled as raw 5kHz-aligned "slots" (200 per MHz — 1000kHz / 5kHz — of
// which 160 are valid, matching the 4-of-every-5 pattern above) rather
// than a compacted valid-only index, so a *current* value that isn't
// itself one of the 160 valid stops (e.g. whatever arbitrary default
// X-Plane itself starts a fresh COM standby frequency at, before this app
// ever writes to it) still steps sensibly — comFineStep() just walks
// forward/backward one raw slot at a time until it lands on a valid one,
// handling "starting from an invalid position" for free instead of
// needing a separate directional-snap rule for it.
function isValidComSlot(slot) {
  return mod(slot, 5) !== 4; // the one skipped position every 25kHz (5 slots) — confirmed live 2026-08-27, see this section's own comment above
}
function comFineStep(offsetKhz, dir) {
  const slotsPerMHz = 200; // 1000kHz / 5kHz; the MHz digit itself is handled by the caller
  let slot = mod(Math.round(offsetKhz / 5) + dir, slotsPerMHz);
  while (!isValidComSlot(slot)) slot = mod(slot + dir, slotsPerMHz);
  return slot * 5;
}

// Whether the coarse ring wraps around at the band's own edges (COM/NAV/
// DME, confirmed live: 136.500 coarse-up -> 118.500 and 117.90 coarse-up
// -> 108.90, keeping the kHz offset) or just clamps there (ADF: confirmed
// live 1690 coarse-up -> 1750, not a wrap — its real 190-1750 range isn't
// a clean multiple of its own 100-unit coarse step, so "keep the other
// digits, wrap this one" doesn't apply the way it does for the others).
const COARSE_WRAPS = new Set(["COM1", "COM2", "NAV1", "NAV2", "DME"]);

/**
 * The real next standby value for one knob turn, matching how the actual
 * X-Plane commands behave (confirmed live 2026-08-11, see the comments on
 * the tables above) rather than the vendored panel's own naive
 * current+direction*step arithmetic — which carried fine-tune overflow
 * into the MHz/hundreds digit, and hard-stopped at the band edges instead
 * of wrapping. Both were flagged as wrong by real end-user feedback ("not
 * how most avionics behave"). Exported so rmp-panel.js's tuning knob (which
 * drives the same COM1/COM2 standby datarefs, just from a different panel)
 * doesn't need to reproduce the 8.33kHz grid logic a second time.
 */
export function nextStandbyRaw(band, current, mode, dir) {
  const step = STEP[band];
  if (!step) return current;
  const coarseUnit = step.coarse;

  if (mode === "fine") {
    const coarseDigit = Math.floor(current / coarseUnit) * coarseUnit;
    const offset = current - coarseDigit;
    let nextOffset;
    if (band === "COM1" || band === "COM2") {
      nextOffset = comFineStep(offset, dir);
    } else {
      nextOffset = mod(offset + dir * step.fine, FINE_SPAN[band] ?? coarseUnit);
    }
    return clamp(coarseDigit + nextOffset, band);
  }

  // coarse
  const offset = current - Math.floor(current / coarseUnit) * coarseUnit;
  if (!COARSE_WRAPS.has(band)) return clamp(current + dir * coarseUnit, band);

  const range = RAW_RANGE[band];
  const minDigit = Math.floor(range.min / coarseUnit) * coarseUnit;
  const maxDigit = Math.floor(range.max / coarseUnit) * coarseUnit;
  const span = maxDigit - minDigit + coarseUnit;
  const coarseDigit = Math.floor(current / coarseUnit) * coarseUnit;
  const nextDigit = minDigit + mod(coarseDigit - minDigit + dir * coarseUnit, span);
  return nextDigit + offset; // always within range by construction — offset <= coarseUnit-1 and nextDigit is a real MHz/hundreds digit
}

/** Blanks the radio panel with no adapter involved — see blankFcuPanel() for why (the vendored component's own baked-in SEED frequencies would otherwise read as live data before a connection exists). */
export function blankRadioPanel() {
  const rp = window.radioPanel;
  if (!rp) return;
  for (const id of ["r1a", "r1s", "r2a", "r2s"]) rp.display(id)?.clear();
  for (const id of Object.keys(LEVER_ID_TO_BAND)) rp.setAudio(id, false);
}

export function wireRadioPanel(adapter) {
  const rp = window.radioPanel;
  if (!rp) {
    console.error(
      "[radio-panel] window.radioPanel not found — is <radio-panel> in the page, and vendor/radio.js loaded before this runs?"
    );
    return;
  }

  // How long to wait after the last onFreq before treating a drag as over
  // — same value and reasoning as fcu-panel.js/efis-panel.js's own knobs.
  const DRAG_END_DEBOUNCE_MS = 200;
  // band -> pending drag-end timeout id, present only while a drag is
  // considered still in progress for that band.
  const dragEndTimers = new Map();

  const syncUnit = (u) => {
    const band = rp.band(u);
    if (adapter.unresolved.has(band)) return;
    const scale = scaleFor(band);
    const active = (Number(adapter.getReadoutValue(band, "active")) || 0) * scale;
    const standby = (Number(adapter.getReadoutValue(band, "standby")) || 0) * scale;
    rp.setFreq(u, active, standby);
  };

  rp.onBand((u) => syncUnit(u));

  rp.onFreq((u, band, pair) => {
    if (adapter.unresolved.has(band)) return;
    const step = STEP[band];
    if (!step) return;

    const scale = scaleFor(band);
    const currentRaw = Number(adapter.getReadoutValue(band, "standby")) || 0;
    const mode = rp.tuneMode(u) === "coarse" ? "coarse" : "fine";

    // The panel's own guessed pair[1] wraps using radio.js's own
    // whole-band min/max (not our real per-decade wraparound — see
    // nextStandbyRaw()'s own comment), so right at an edge it can land on
    // the *opposite* side of the real current value — a plain sign
    // comparison there would misread the turn as reversed (confirmed live
    // 2026-08-12: 118.000 fine-down not wrapping, 136MHz fine-up not
    // wrapping, coarse only wrapping in one direction — all the same root
    // cause). Every band's own step constant now exactly matches our real
    // measured one (see STEP above), so a genuine, non-wrapped turn's
    // delta is always exactly +-(step*scale); any other magnitude means
    // the panel's own wrap kicked in and the sign needs inverting.
    const rawDelta = pair[1] - currentRaw * scale;
    const expectedDelta = step[mode] * scale;
    const dir = Math.abs(rawDelta) === expectedDelta ? Math.sign(rawDelta) : -Math.sign(rawDelta);

    const nextRaw = nextStandbyRaw(band, currentRaw, mode, dir);
    const deltaRaw = nextRaw - currentRaw;

    if (!dragEndTimers.has(band)) adapter.beginAdjust(band);
    else clearTimeout(dragEndTimers.get(band));
    dragEndTimers.set(
      band,
      setTimeout(() => {
        dragEndTimers.delete(band);
        adapter.endAdjust(band);
      }, DRAG_END_DEBOUNCE_MS)
    );

    if (deltaRaw !== 0) adapter.adjustReadoutValue(band, deltaRaw);
    // adjustReadoutValue() already updates the adapter's own optimistic
    // value and fires onReadoutChange -> refresh() -> syncUnit(u) below, so
    // the display picks up the accurate new value immediately without any
    // extra repaint call here.
  });

  rp.onSwap((u, band) => {
    if (!adapter.unresolved.has(band)) adapter.press(`${band}.swap`);
  });

  rp.onAudio((id, on) => {
    const band = LEVER_ID_TO_BAND[id];
    if (!band || !adapter.isAvailable(band)) return;
    if (adapter.isLit(band) !== on) adapter.press(band);
  });

  // audio_com_selection isn't a clean 0/1 enum (confirmed live 2026-08-12:
  // 6 for COM1, 7 for COM2 in this session — see radio-panel-generic.json's
  // MIC_SEL._note) — only its parity means "which COM", so this reads it
  // that way rather than as an exact-match toggle.
  rp.onMic((n) => {
    if (adapter.unresolved.has("MIC_SEL")) return;
    adapter.press(n === 2 ? "MIC_SEL.selectCom2" : "MIC_SEL.selectCom1");
  });

  const refresh = () => {
    syncUnit(1);
    syncUnit(2);
    for (const [id, band] of Object.entries(LEVER_ID_TO_BAND)) {
      if (adapter.isAvailable(band)) rp.setAudio(id, adapter.isLit(band));
    }
    if (!adapter.unresolved.has("MIC_SEL")) {
      const raw = Math.round(Number(adapter.getReadoutValue("MIC_SEL", "value")) || 0);
      rp.setMic(raw % 2 === 1 ? 2 : 1);
    }
  };

  adapter.onReadoutChange = refresh;
  adapter.onStateChange = refresh;
  refresh();
}
