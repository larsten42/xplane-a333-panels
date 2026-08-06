// Named formatters for numeric readout widgets (baro window, and later FCU's
// altitude/speed/heading/V-S windows) — each takes the readout's raw dataref
// values (keyed the same as the profile's `datarefs` object) plus the full
// readout profile entry (for formats like positionLabel that need more than
// just the raw numbers, e.g. encoder.positions) and returns display text.
// Kept separate from efis-adapter.js so new formats don't require touching
// the subscription/state-tracking logic.

const INHG_PER_HPA = 1 / 33.8639;

function isBaroHpa(values) {
  return Number(values.unit) !== 0; // confirmed live 2026-08-06: 1 = hPa, 0 = inHg
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
};
