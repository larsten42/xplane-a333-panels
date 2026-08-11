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
// stby_*_coarse/fine_up/down step commands instead, paced through
// queuePress() to dodge X-Plane's command_set_is_active coalescing — that
// turned out to be the wrong tool for a fast knob drag: even generously
// paced, closely-spaced command activations still occasionally coalesced or
// landed out of order (confirmed live), and a fast drag would queue far
// more presses than could drain within the debounce window, so the display
// kept visibly stepping for a while after the user's finger had already
// left the knob. A direct dataref write has no hold-duration/coalescing
// concept at all, so none of that pacing is needed.
//
// The panel's own onFreq(u, band, pair) only hands back its own guessed new
// value, not a raw turn direction — pair's *magnitude* isn't used for
// anything (the real per-press step size, confirmed live, is applied here
// instead — see STEP below); it's only compared against the adapter's own
// current value to recover which way the knob turned.

const LEVER_ID_TO_BAND = {
  "aud-com1": "COM1",
  "aud-com2": "COM2",
  "aud-nav1": "NAV1",
  "aud-nav2": "NAV2",
  "aud-adf": "ADF",
  "aud-dme": "DME",
};

// The panel's seven-seg display expects every band's active/standby value
// pre-scaled to the same "freq * 1000" shape (6 digits, decimal at index 3
// — confirmed live 2026-08-11 e.g. COM1's _833 dataref: 118505 = 118.505).
// COM1/COM2 already come out of the sim that way via the _833 datarefs, and
// ADF is a bare kHz integer with no decimal at all — neither needs scaling.
// NAV1/NAV2/DME only carry 2 real decimal digits (confirmed live: raw 10815
// = 108.15, not 108.150), so those need x10 to land on the same 6-digit/
// 3-decimal shape without losing or fabricating precision.
const DISPLAY_SCALE = { NAV1: 10, NAV2: 10, DME: 10 };
const scaleFor = (band) => DISPLAY_SCALE[band] ?? 1;

// Real per-press step sizes in each band's own *raw* dataref units (i.e.
// before DISPLAY_SCALE) — see radio-panel-generic.json's _note_on_step_sizes
// for how these were measured.
const STEP = {
  COM1: { coarse: 1000, fine: 5 },
  COM2: { coarse: 1000, fine: 5 },
  NAV1: { coarse: 100, fine: 5 },
  NAV2: { coarse: 100, fine: 5 },
  DME: { coarse: 100, fine: 5 },
  ADF: { coarse: 100, fine: 1 },
};

// Raw-unit standby range per band, so a fast drag past a band edge clamps
// instead of writing a nonsensical out-of-range frequency.
const RAW_RANGE = {
  COM1: { min: 118000, max: 136975 },
  COM2: { min: 118000, max: 136975 },
  NAV1: { min: 10800, max: 11795 },
  NAV2: { min: 10800, max: 11795 },
  DME: { min: 10800, max: 11795 },
  ADF: { min: 190, max: 1750 },
};
const clampToRange = (value, band) => {
  const range = RAW_RANGE[band];
  return range ? Math.min(range.max, Math.max(range.min, value)) : value;
};

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
    const dir = pair[1] >= currentRaw * scale ? 1 : -1;
    const mode = rp.tuneMode(u) === "coarse" ? "coarse" : "fine";
    const nextRaw = clampToRange(currentRaw + dir * step[mode], band);
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

  const refresh = () => {
    syncUnit(1);
    syncUnit(2);
    for (const [id, band] of Object.entries(LEVER_ID_TO_BAND)) {
      if (adapter.isAvailable(band)) rp.setAudio(id, adapter.isLit(band));
    }
  };

  adapter.onReadoutChange = refresh;
  adapter.onStateChange = refresh;
  refresh();
}
