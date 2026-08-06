// Shared angle math for detent selectors (mode/range knobs, the bearing-
// pointer selector) and their surrounding printed scales — kept in one
// place so a knob's pointer and its scale's tick marks/labels can never
// disagree about where a given position actually points.

// Mode/range: index 2 is straight up (0°), 45° per step either side —
// fixed numbers, not spread across positions.length, because it's the
// physical angle on the real panel that matters, not an even distribution.
const MODE_RANGE_DEFAULTS = { upIndex: 2, degPerPosition: 45 };

export function angleForIndex(index, { upIndex, degPerPosition } = MODE_RANGE_DEFAULTS) {
  return (index - (upIndex ?? MODE_RANGE_DEFAULTS.upIndex)) * (degPerPosition ?? MODE_RANGE_DEFAULTS.degPerPosition);
}

/** A point at the given radius/angle from (cx, cy) — 0° = straight up, positive = clockwise, matching the knob pointer's own rotate() convention. */
export function pointAt(cx, cy, radius, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  return [cx + radius * Math.sin(rad), cy - radius * Math.cos(rad)];
}
