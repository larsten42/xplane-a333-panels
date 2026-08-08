// Named formatters for numeric readout widgets (baro window, and later FCU's
// altitude/speed/heading/V-S windows) — each takes the readout's raw dataref
// values (keyed the same as the profile's `datarefs` object) plus the full
// readout profile entry (for formats like positionLabel that need more than
// just the raw numbers, e.g. encoder.positions) and returns display text.
// Kept separate from efis-adapter.js so new formats don't require touching
// the subscription/state-tracking logic.

// Exported so efis-panel.js can format the QNH seven-seg widget itself
// (it needs the digits and the hPa/inHg conversion without the literal "."
// this module's own baro() format embeds — see its own comment).
export const INHG_PER_HPA = 1 / 33.8639;

function isBaroHpa(values) {
  return Number(values.unit) !== 0; // confirmed live 2026-08-06: 1 = hPa, 0 = inHg
}

// Shared by SPD and HDG: managed (FMS-computed target) shows as dots
// instead of a number, gated by a "selected" dataref that's 1 when a value
// has been manually chosen, 0 when managed (confirmed live 2026-08-07 for
// both vnav_speed_window_open and hdg_window_open). Trailing "•" kept even
// in the numeric case to match the structural placeholder every other FCU
// window still shows (see index.html's "888•"-style static digits) —
// that's what the dot turns out to mean once real data replaces it.
function dotsOrDigits(values, digitCount) {
  if (Number(values.selected) === 0) return "•".repeat(digitCount);
  return `${String(Math.round(Number(values.value))).padStart(digitCount, "0")}•`;
}

export const READOUT_FORMATS = {
  baro(values) {
    if (Number(values.std) !== 0) return "STD";
    const inHg = Number(values.value);
    if (isBaroHpa(values)) return String(Math.round(inHg / INHG_PER_HPA)).padStart(4, "0");
    return inHg.toFixed(2);
  },
  // For detent selectors (ND mode, range, ...): the readout's "value" is a
  // clamped 0-based index, encoder.positions supplies the label per index.
  positionLabel(values, readout) {
    const positions = readout.encoder?.positions ?? [];
    return positions[Math.round(Number(values.value))] ?? "?";
  },
  fcuSpeed(values) {
    return dotsOrDigits(values, 3);
  },
  fcuHeading(values) {
    return dotsOrDigits(values, 3);
  },
  // ALT has no managed/selected distinction like SPD/HDG do (none given —
  // the altitude target is always shown as a number), so this is just
  // fixed-width zero-padding, no dots case.
  fcuAltitude(values) {
    return `${String(Math.round(Number(values.value))).padStart(5, "0")}•`;
  },
  // V/S window: dashes when no vertical-speed target is active at all
  // (vvi_fpa_window_open === 0 — different shape than SPD/HDG's managed
  // dots, this is "nothing selected" rather than "FMS is flying it"),
  // otherwise a signed 4-digit value. No separate dataref for FPA
  // (degrees) mode's own value was given yet, so this always reads as
  // fpm — worth revisiting once that's available.
  fcuVerticalSpeed(values) {
    if (Number(values.shown) === 0) return "-----";
    const v = Math.round(Number(values.value));
    return `${v >= 0 ? "+" : "-"}${String(Math.abs(v)).padStart(4, "0")}`;
  },
  // For readouts that exist only so their dataref gets subscribed — the
  // caller reads the raw value via getReadoutValue() directly and never
  // renders this text (e.g. TRK_FPA_MODE, whose value drives fcu.setMode()
  // rather than any digit window). _connectReadout requires *some* valid
  // format to resolve a readout at all, so this is the trivial one.
  raw(values) {
    return String(values.value ?? "");
  },
};

// Per-format encoder step size, in the same units as the readout's
// underlying `value` dataref — the display resolution differs by unit
// (1 hPa vs. 0.01 inHg), so a fixed step feels wrong in one of the two
// (a 1 hPa step is a 0.03 inHg jump — way coarser than the display's own
// 0.01 resolution). Kept next to READOUT_FORMATS since both need to agree
// on the same unit interpretation.
export const READOUT_STEP_SIZES = {
  baro(values) {
    return isBaroHpa(values) ? INHG_PER_HPA : 0.01;
  },
  // ALT's knob steps by 100ft or 1000ft depending on the concentric ring
  // position (confirmed live 2026-08-08: alt_step_knob_pos 0 = 100ft step,
  // 1 = 1000ft step — same dataref the ring toggle commands set).
  fcuAltitude(values) {
    return Number(values.ring) !== 0 ? 1000 : 100;
  },
};
